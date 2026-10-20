import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Hex } from 'viem';

export type ServiceRecord = {
  coverageId: Hex;
  requestHash: Hex;
  state: 'reserved' | 'started' | 'completed';
  intentHash?: Hex;
  transaction?: Hex;
  status?: number;
  responseHash?: Hex;
  completedAt?: string;
};

type StoreHeader = { version: 1; context: string };
const keyOf = (coverageId: Hex, requestHash: Hex) => `${coverageId.toLowerCase()}:${requestHash.toLowerCase()}`;
const isHex32 = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
}

/** A fsynced, public-metadata-only service execution journal bound to one service context. */
export class ServiceStore {
  private readonly records = new Map<string, ServiceRecord>();
  private readonly requestKeys = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private writeTail: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string, private readonly context: string) {}

  static async open(path: string, context: string): Promise<ServiceStore> {
    if (!path || !context || context.length > 256) throw new Error('SERVICE_JOURNAL_CONTEXT');
    const store = new ServiceStore(path, context);
    let bytes: Buffer;
    try {
      const fileInfo = await lstat(path);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Error('SERVICE_JOURNAL_UNSAFE_PATH');
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      if (error instanceof Error && error.message === 'SERVICE_JOURNAL_UNSAFE_PATH') throw error;
      throw new Error('SERVICE_JOURNAL_UNAVAILABLE');
    }
    const content = bytes.toString('utf8');
    if (!content.endsWith('\n')) throw new Error('SERVICE_JOURNAL_CORRUPT');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) throw new Error('SERVICE_JOURNAL_CORRUPT');
    let header: StoreHeader;
    try {
      const raw = JSON.parse(lines[0]!) as Record<string, unknown>;
      if (!exactKeys(raw, ['version', 'context']) || raw.version !== 1 || typeof raw.context !== 'string') throw new Error();
      header = raw as StoreHeader;
    } catch { throw new Error('SERVICE_JOURNAL_CORRUPT'); }
    if (header.context !== context) throw new Error('SERVICE_JOURNAL_CONTEXT_MISMATCH');

    for (const line of lines.slice(1)) {
      let row: ServiceRecord;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (raw.state === 'reserved') {
          if (!exactKeys(raw, ['coverageId', 'requestHash', 'state', 'intentHash'])) throw new Error();
        } else if (raw.state === 'started') {
          if (!exactKeys(raw, ['coverageId', 'requestHash', 'state', 'transaction'])) throw new Error();
        } else if (raw.state === 'completed') {
          if (!exactKeys(raw, ['coverageId', 'requestHash', 'state', 'transaction', 'status', 'responseHash', 'completedAt'])) throw new Error();
        } else throw new Error();
        row = raw as ServiceRecord;
      } catch { throw new Error('SERVICE_JOURNAL_CORRUPT'); }
      if (!isHex32(row.coverageId) || !isHex32(row.requestHash) || (row.state === 'reserved' && (!isHex32(row.intentHash) || row.intentHash.toLowerCase() !== row.coverageId.toLowerCase())) ||
          (row.state !== 'reserved' && !isHex32(row.transaction)) ||
          (row.state === 'completed' && (!Number.isInteger(row.status) || row.status! < 200 || row.status! > 599 ||
            !isHex32(row.responseHash) || typeof row.completedAt !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.completedAt)))) {
        throw new Error('SERVICE_JOURNAL_CORRUPT');
      }
      const key = keyOf(row.coverageId, row.requestHash);
      const reqKey = row.requestHash.toLowerCase();
      const prior = store.requestKeys.get(reqKey);
      if (prior && prior !== key) throw new Error('SERVICE_JOURNAL_CONFLICT');
      const existing = store.records.get(key);
      if ((!existing && row.state !== 'reserved') || (existing && !(
        (existing.state === 'reserved' && row.state === 'started') ||
        (existing.state === 'started' && row.state === 'completed')
      )) || (existing?.state === 'reserved' && existing.intentHash?.toLowerCase() !== row.coverageId.toLowerCase()) ||
          (existing?.state === 'started' && existing.transaction?.toLowerCase() !== row.transaction?.toLowerCase())) {
        throw new Error('SERVICE_JOURNAL_TRANSITION');
      }
      store.records.set(key, row);
      store.requestKeys.set(reqKey, key);
    }
    return store;
  }

  get(coverageId: Hex, requestHash: Hex): ServiceRecord | undefined {
    const row = this.records.get(keyOf(coverageId, requestHash));
    return row && { ...row };
  }

  getByRequest(requestHash: Hex): ServiceRecord | undefined {
    const key = this.requestKeys.get(requestHash.toLowerCase());
    const row = key ? this.records.get(key) : undefined;
    return row && { ...row };
  }

  async reserve(coverageId: Hex, requestHash: Hex, intentHash: Hex): Promise<'reserved' | 'exists'> {
    if (!isHex32(coverageId) || !isHex32(requestHash) || !isHex32(intentHash) || coverageId.toLowerCase() !== intentHash.toLowerCase()) throw new Error('SERVICE_JOURNAL_RECORD');
    const key = keyOf(coverageId, requestHash);
    const reqKey = requestHash.toLowerCase();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prior = this.locks.get(reqKey);
    this.locks.set(reqKey, gate);
    if (prior) await prior;
    try {
      if (this.records.has(key) || this.requestKeys.has(reqKey)) return 'exists';
      const row: ServiceRecord = { coverageId, requestHash, state: 'reserved', intentHash };
      await this.persist(row);
      this.records.set(key, row);
      this.requestKeys.set(reqKey, key);
      return 'reserved';
    } finally {
      if (this.locks.get(reqKey) === gate) this.locks.delete(reqKey);
      release();
    }
  }

  async start(coverageId: Hex, requestHash: Hex, transaction: Hex): Promise<'started' | 'exists'> {
    const key = keyOf(coverageId, requestHash);
    const reqKey = requestHash.toLowerCase();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prior = this.locks.get(reqKey);
    this.locks.set(reqKey, gate);
    if (prior) await prior;
    try {
      const priorRecord = this.records.get(key);
      if (!priorRecord || priorRecord.state !== 'reserved' || priorRecord.intentHash?.toLowerCase() !== coverageId.toLowerCase()) return 'exists';
      if (!isHex32(transaction)) throw new Error('SERVICE_JOURNAL_RECORD');
      const row: ServiceRecord = { coverageId, requestHash, state: 'started', transaction };
      await this.persist(row);
      this.records.set(key, row);
      this.requestKeys.set(reqKey, key);
      return 'started';
    } finally {
      if (this.locks.get(reqKey) === gate) this.locks.delete(reqKey);
      release();
    }
  }

  async complete(coverageId: Hex, requestHash: Hex, transaction: Hex, status: number, responseHash: Hex, completedAt: string): Promise<void> {
    await this.exclusive(requestHash, async () => {
      const key = keyOf(coverageId, requestHash);
      const previous = this.records.get(key);
      if (!previous || previous.state !== 'started') throw new Error('SERVICE_JOURNAL_STATE');
      if (!isHex32(transaction) || transaction.toLowerCase() !== previous.transaction?.toLowerCase() || !Number.isInteger(status) || status < 200 || status > 599 || !isHex32(responseHash) || !/^(0|[1-9][0-9]*)$/.test(completedAt)) throw new Error('SERVICE_JOURNAL_RECORD');
      const row: ServiceRecord = { coverageId, requestHash, state: 'completed', transaction, status, responseHash, completedAt };
      await this.persist(row);
      this.records.set(key, row);
    });
  }

  private async exclusive<T>(requestHash: Hex, action: () => Promise<T>): Promise<T> {
    const reqKey = requestHash.toLowerCase();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prior = this.locks.get(reqKey);
    this.locks.set(reqKey, gate);
    if (prior) await prior;
    try { return await action(); }
    finally {
      if (this.locks.get(reqKey) === gate) this.locks.delete(reqKey);
      release();
    }
  }

  private persist(row: ServiceRecord): Promise<void> {
    const run = this.writeTail.then(() => this.persistOne(row));
    this.writeTail = run.catch(() => undefined);
    return run;
  }

  private async persistOne(row: ServiceRecord): Promise<void> {
    let handle;
    try {
      let exists = true;
      try {
        const info = await lstat(this.path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('SERVICE_JOURNAL_UNSAFE_PATH');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else throw error;
      }
      if (!exists) {
        handle = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(`${JSON.stringify({ version: 1, context: this.context } satisfies StoreHeader)}\n`, 'utf8');
      } else {
        const existing = await readFile(this.path, 'utf8');
        const firstLine = existing.split('\n', 1)[0];
        const header = firstLine ? JSON.parse(firstLine) as Record<string, unknown> : undefined;
        if (!header || !exactKeys(header, ['version', 'context']) || header.version !== 1 || header.context !== this.context) throw new Error('SERVICE_JOURNAL_CONTEXT_MISMATCH');
        handle = await open(this.path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
      }
      await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8');
      await handle.sync();
      if (!exists) {
        const directory = await open(dirname(this.path), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'SERVICE_JOURNAL_UNSAFE_PATH') throw error;
      if (error instanceof Error && error.message === 'SERVICE_JOURNAL_CONTEXT_MISMATCH') throw error;
      throw new Error('SERVICE_JOURNAL_WRITE_FAILED');
    } finally { await handle?.close().catch(() => undefined); }
  }
}
