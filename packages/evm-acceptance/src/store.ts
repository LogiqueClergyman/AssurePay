import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getContractAddress, isAddress, type Address, type Hex } from 'viem';
import type { CampaignManifest, RunConfig, StepKind, TransactionRecord } from './types.js';
import { GAS_CAPS, STEP_ORDER, stepActor, validateConfig } from './plan.js';

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) {
    throw new Error('CAMPAIGN_JOURNAL_INVALID');
  }
  return row;
};
const UINT = /^(0|[1-9][0-9]*)$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const uint = (value: unknown): value is string => typeof value === 'string' && value.length <= 78 && UINT.test(value);
const address = (value: unknown): value is Address => typeof value === 'string' && ADDRESS.test(value) && isAddress(value);
const hash = (value: unknown): value is Hex => typeof value === 'string' && HASH.test(value);
const same = (a: string | null, b: string | null) => a === null || b === null ? a === b : a.toLowerCase() === b.toLowerCase();
const RECORD_KEYS = ['kind', 'transaction', 'from', 'to', 'nonce', 'calldataHash', 'gas', 'maxFeePerGas',
  'maxPriorityFeePerGas', 'value', 'attempted'];

function validateRecord(input: unknown, kind: StepKind, config: RunConfig): TransactionRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  const optionalKeys = (['blockNumber', 'blockHash', 'status'] as const).filter((key) => Object.hasOwn(input, key));
  const row = exact(input, [...RECORD_KEYS, ...optionalKeys]);
  if (row.kind !== kind || !hash(row.transaction) || !address(row.from) ||
      (row.to !== null && !address(row.to)) || !uint(row.nonce) || !hash(row.calldataHash) || !uint(row.gas) ||
      !uint(row.maxFeePerGas) || !uint(row.maxPriorityFeePerGas) || row.value !== '0' || typeof row.attempted !== 'boolean') {
    throw new Error('CAMPAIGN_JOURNAL_INVALID');
  }
  if (Object.hasOwn(row, 'blockNumber') !== Object.hasOwn(row, 'blockHash') ||
      (Object.hasOwn(row, 'blockNumber') !== Object.hasOwn(row, 'status'))) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  if (row.blockNumber !== undefined && (!uint(row.blockNumber) || !hash(row.blockHash) ||
      (row.status !== 'success' && row.status !== 'reverted'))) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  const out = row as unknown as TransactionRecord;
  if (!same(out.from, config.roles[stepActor(out.kind)])) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  if (BigInt(out.gas) <= 0n || BigInt(out.maxFeePerGas) !== BigInt(config.maxFeePerGas) ||
      BigInt(out.maxPriorityFeePerGas) !== BigInt(config.maxPriorityFeePerGas) || BigInt(out.maxPriorityFeePerGas) > BigInt(out.maxFeePerGas)) {
    throw new Error('CAMPAIGN_JOURNAL_INVALID');
  }
  if (BigInt(out.gas) !== GAS_CAPS[kind] || (out.status !== undefined && !out.attempted)) {
    throw new Error('CAMPAIGN_JOURNAL_INVALID');
  }
  if (out.status !== undefined && (kind === 'revert' ? out.status !== 'reverted' : out.status !== 'success')) {
    throw new Error('CAMPAIGN_JOURNAL_INVALID');
  }
  return structuredClone(out);
}

function validateManifest(input: unknown, expectedConfig: RunConfig): CampaignManifest {
  const raw = exact(input, ['version', 'config', 'core', 'transactions']);
  if (raw.version !== 1 || !Array.isArray(raw.transactions) ||
      (raw.core !== null && !address(raw.core))) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  const config = validateConfig(raw.config);
  if (JSON.stringify(config) !== JSON.stringify(expectedConfig)) throw new Error('CAMPAIGN_JOURNAL_CONTEXT');
  if (raw.transactions.length > STEP_ORDER.length) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  const transactions = raw.transactions.map((row, index) => validateRecord(row, STEP_ORDER[index]!, config));
  if (transactions.length && (transactions[0]!.kind !== 'deploy' || raw.core === null)) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  if (transactions.length === 0 && raw.core !== null) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  if (transactions.length > 0) {
    const deploy = transactions[0]!;
    const derivedCore = getContractAddress({ from: deploy.from, nonce: BigInt(deploy.nonce) }).toLowerCase();
    if (deploy.to !== null || !same(raw.core as string, derivedCore)) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  }
  const nonces = new Map<string, bigint>();
  const hashes = new Set<string>();
  for (const record of transactions) {
    const actor = stepActor(record.kind);
    const last = nonces.get(actor);
    if (last !== undefined && BigInt(record.nonce) !== last + 1n) throw new Error('CAMPAIGN_JOURNAL_INVALID');
    nonces.set(actor, BigInt(record.nonce));
    if (hashes.has(record.transaction)) throw new Error('CAMPAIGN_JOURNAL_INVALID');
    hashes.add(record.transaction);
    const expectedTo = record.kind === 'deploy' ? null : record.kind === 'approve' ? config.token : raw.core as Address;
    if (!same(record.to, expectedTo)) throw new Error('CAMPAIGN_JOURNAL_INVALID');
  }
  for (let index = 0; index < transactions.length - 1; index++) {
    if (transactions[index]!.status !== 'success') throw new Error('CAMPAIGN_JOURNAL_INVALID');
  }
  return { version: 1, config, core: raw.core as Address | null, transactions };
}

/** A strict, single-process, fsynced public identity journal. It never stores calldata or signatures. */
export class CampaignStore {
  private constructor(readonly path: string, private readonly config: RunConfig, private current: CampaignManifest) {}

  static async create(path: string, configInput: RunConfig): Promise<CampaignStore> {
    const config = validateConfig(configInput);
    if (!path) throw new Error('CAMPAIGN_JOURNAL_PATH');
    const initial: CampaignManifest = { version: 1, config, core: null, transactions: [] };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let file;
    let created = false;
    try {
      file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
      await file.writeFile(JSON.stringify(initial), 'utf8');
      await file.sync();
      const directory = await open(dirname(path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      await file?.close().catch(() => undefined);
      if (created) await unlink(path).catch(() => undefined);
      throw new Error('CAMPAIGN_JOURNAL_EXISTS_OR_UNAVAILABLE');
    } finally { await file?.close().catch(() => undefined); }
    return new CampaignStore(path, config, initial);
  }

  static async open(path: string, configInput: RunConfig): Promise<CampaignStore> {
    const config = validateConfig(configInput);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error();
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: string;
      try { bytes = await handle.readFile('utf8'); } finally { await handle.close(); }
      return new CampaignStore(path, config, validateManifest(JSON.parse(bytes), config));
    } catch (error) {
      if (error instanceof Error && ['CAMPAIGN_JOURNAL_INVALID', 'CAMPAIGN_JOURNAL_CONTEXT'].includes(error.message)) throw error;
      throw new Error('CAMPAIGN_JOURNAL_UNAVAILABLE');
    }
  }

  read(): CampaignManifest { return structuredClone(this.current); }

  async append(recordInput: TransactionRecord, core: Address | null): Promise<void> {
    const expected = STEP_ORDER[this.current.transactions.length];
    if (!expected || recordInput.kind !== expected) throw new Error('CAMPAIGN_STEP_ORDER');
    const previous = this.current.transactions.at(-1);
    if (previous && previous.status !== 'success') throw new Error('CAMPAIGN_UNRESOLVED_TRANSACTION');
    const record = validateRecord(recordInput, expected, this.config);
    if (this.current.transactions.some((item) => item.transaction === record.transaction)) throw new Error('CAMPAIGN_RECORD_EXISTS');
    if (expected === 'deploy') {
      if (this.current.core !== null || !address(core)) throw new Error('CAMPAIGN_CORE_INVALID');
    } else if (!this.current.core || core !== this.current.core) throw new Error('CAMPAIGN_CORE_INVALID');
    const next = { ...this.current, core, transactions: [...this.current.transactions, record] };
    await this.save(next);
  }

  async update(kind: StepKind, patch: Partial<Pick<TransactionRecord, 'attempted' | 'blockNumber' | 'blockHash' | 'status'>>): Promise<void> {
    const index = this.current.transactions.findIndex((record) => record.kind === kind);
    if (index < 0) throw new Error('CAMPAIGN_RECORD_MISSING');
    const prior = this.current.transactions[index]!;
    if (patch.attempted === false && prior.attempted) throw new Error('CAMPAIGN_RECORD_CONFLICT');
    if (prior.status && (patch.status !== prior.status || patch.blockHash !== prior.blockHash || patch.blockNumber !== prior.blockNumber)) {
      throw new Error('CAMPAIGN_RECORD_CONFLICT');
    }
    const next = validateRecord({ ...prior, ...patch }, kind, this.config);
    const transactions = [...this.current.transactions];
    transactions[index] = next;
    await this.save({ ...this.current, transactions });
  }

  private async save(input: CampaignManifest): Promise<void> {
    const validated = validateManifest(input, this.config);
    let temp = '';
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error();
      temp = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(JSON.stringify(validated), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.path);
      const directory = await open(dirname(this.path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      this.current = validated;
    } catch {
      if (temp) await unlink(temp).catch(() => undefined);
      throw new Error('CAMPAIGN_JOURNAL_WRITE_FAILED');
    }
  }
}
