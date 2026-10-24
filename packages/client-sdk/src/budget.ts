import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';

export type RequestState = 'reserved' | 'authorized' | 'attempted' | 'confirmed';
export interface BudgetRequest {
  requestId: Hex; requestHash: Hex; coverageId: Hex; gross: string; state: RequestState;
}
interface Session { version: 1; namespace: Hex; requests: BudgetRequest[] }
export function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78 || BigInt(value) >= 1n << 256n)
    throw Error('CLIENT_LIMIT_INVALID');
  return value;
}
export function requestId(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw Error('CLIENT_REQUEST_INVALID');
  return value as Hex;
}
function exact(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw Error('CLIENT_SESSION_INVALID');
  return value as Record<string, any>;
}
export class Budget {
  private constructor(private readonly path: string, private readonly directory: string,
    private readonly namespace: Hex, private readonly maxGross: string,
    private readonly total: string, private readonly count: number, private current: Session) {}
  static async open(directory: string, namespace: Hex, maxGross: string, total: string, count: number): Promise<Budget> {
    const path = join(directory, 'session.json');
    const budget = new Budget(path, directory, namespace, maxGross, total, count, { version: 1, namespace, requests: [] });
    try { await lstat(path); budget.current = budget.validate(JSON.parse(await budget.read())); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('CLIENT_SESSION_INVALID');
      // An existing buyer/claim/temp file proves this is not an empty new session.
      if ((await readdir(directory)).some(name => name !== 'client.lock')) throw Error('CLIENT_SESSION_MISSING');
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(budget.current)); await file.sync(); }
      finally { await file.close(); }
      await budget.syncDirectory();
    }
    return budget;
  }
  private validate(input: unknown): Session {
    const raw = exact(input, ['version', 'namespace', 'requests']);
    if (raw.version !== 1 || raw.namespace !== this.namespace || !Array.isArray(raw.requests) || raw.requests.length > this.count)
      throw Error('CLIENT_SESSION_INVALID');
    const ids = new Set<string>(), coverages = new Set<string>(); let total = 0n;
    const requests = raw.requests.map((input: unknown): BudgetRequest => {
      const row = exact(input, ['requestId', 'requestHash', 'coverageId', 'gross', 'state']);
      const id = requestId(row.requestId), hash = requestId(row.requestHash), coverage = requestId(row.coverageId), gross = amount(row.gross);
      if (ids.has(id) || coverages.has(coverage) || BigInt(gross) < 2n || BigInt(gross) > BigInt(this.maxGross) ||
          !['reserved', 'authorized', 'attempted', 'confirmed'].includes(row.state)) throw Error('CLIENT_SESSION_INVALID');
      ids.add(id); coverages.add(coverage); total += BigInt(gross);
      return { requestId: id, requestHash: hash, coverageId: coverage, gross, state: row.state };
    });
    if (total > BigInt(this.total)) throw Error('CLIENT_SESSION_INVALID');
    return { version: 1, namespace: this.namespace, requests };
  }
  private async read(): Promise<string> {
    const stat = await lstat(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > 1_048_576) throw Error('CLIENT_SESSION_INVALID');
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.size > 1_048_576 || (opened.mode & 0o777) !== 0o600) throw Error('CLIENT_SESSION_INVALID');
      const bytes = await file.readFile();
      if (bytes.length > 1_048_576) throw Error('CLIENT_SESSION_INVALID');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { await file.close(); }
  }
  private async syncDirectory(): Promise<void> {
    const file = await open(this.directory, constants.O_RDONLY);
    try { await file.sync(); } finally { await file.close(); }
  }
  private async save(next: Session): Promise<void> {
    this.validate(next);
    const disk = this.validate(JSON.parse(await this.read()));
    if (JSON.stringify(disk) !== JSON.stringify(this.current)) throw Error('CLIENT_SESSION_CHANGED');
    const temp = join(this.directory, `.session-${randomBytes(12).toString('hex')}.tmp`);
    try {
      const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path); await this.syncDirectory(); this.current = structuredClone(next);
    } catch { await unlink(temp).catch(() => undefined); throw Error('CLIENT_SESSION_WRITE_FAILED'); }
  }
  get(id: Hex): BudgetRequest {
    const row = this.current.requests.find(row => row.requestId === id);
    if (!row) throw Error('CLIENT_REQUEST_UNKNOWN');
    return { ...row };
  }
  assertAdmission(): void {
    if (this.current.requests.some(row => row.state !== 'confirmed')) throw Error('CLIENT_SESSION_UNRESOLVED');
  }
  async reserve(row: Omit<BudgetRequest, 'state'>): Promise<void> {
    this.assertAdmission();
    amount(row.gross);
    if (BigInt(row.gross) < 2n || BigInt(row.gross) > BigInt(this.maxGross)) throw Error('CLIENT_BUDGET_EXCEEDED');
    if (this.current.requests.some(old => old.requestId === row.requestId)) throw Error('CLIENT_REQUEST_REUSED');
    const used = this.current.requests.reduce((n, request) => n + BigInt(request.gross), 0n);
    if (this.current.requests.length >= this.count || used + BigInt(row.gross) > BigInt(this.total)) throw Error('CLIENT_BUDGET_EXCEEDED');
    await this.save({ ...this.current, requests: [...this.current.requests, { ...row, state: 'reserved' }] });
  }
  async mark(id: Hex, state: RequestState): Promise<void> {
    const row = this.get(id);
    if (state === 'authorized' && row.state !== 'reserved' || state === 'attempted' && row.state === 'reserved')
      throw Error('CLIENT_REQUEST_STATE_INVALID');
    await this.save({ ...this.current, requests: this.current.requests.map(old => old.requestId === id ? { ...old, state } : old) });
  }
}
