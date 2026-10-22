import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  decodeFunctionData, encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress,
  isAddress, type Address, type Hex, type LocalAccount,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { CORE_ABI } from '../../claims-backend/src/abi.js';
import type { BackendContext, PreparedAction } from '../../claims-backend/src/types.js';

export type ActionActor = Address;
export type ActionKind = 'fileClaim' | 'finalizeClaim';
export interface ActionRecord {
  kind: ActionKind; coverageId: Hex; transaction: Hex; from: Address; to: Address; nonce: string;
  calldataHash: Hex; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; value: '0'; attempted: boolean;
  blockNumber?: string; blockHash?: Hex; status?: 'success' | 'reverted';
}
interface ActionJournal { version: 1; context: BackendContext; actor: ActionActor; records: ActionRecord[] }
type Client = {
  getChainId(): Promise<number>;
  getBlock(args: any): Promise<any>;
  readContract(args: any): Promise<any>;
  simulateContract(args: any): Promise<any>;
  getTransactionCount(args: any): Promise<number>;
  getBalance(args: any): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  getTransaction(args: { hash: Hex }): Promise<any>;
  getTransactionReceipt(args: { hash: Hex }): Promise<any>;
};
type Wallet = { chain?: { id?: number }; signTransaction(args: any): Promise<Hex> };
export interface ActionSenderOptions {
  context: BackendContext; actor: Address; client: Client; wallet?: Wallet;
  account?: LocalAccount; journalPath: string; polls?: number; delay?: number;
}

const GAS: Record<ActionKind, bigint> = { fileClaim: 100_000n, finalizeClaim: 220_000n };
const MAX_FEE = 100_000_000n;
const PRIORITY_FEE = 1_000_000n;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const err = (code: string) => new Error(code);
const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const zeroHash = `0x${'0'.repeat(64)}`;
const copy = <T>(v: T): T => structuredClone(v);

function exact(input: unknown, keys: readonly string[], code = 'ACTION_INVALID'): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw err(code);
  const row = input as Record<string, unknown>;
  const own = Reflect.ownKeys(Object.getOwnPropertyDescriptors(row));
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some((key) => !Object.getOwnPropertyDescriptor(row, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(row, key)!))) throw err(code);
  return row as Record<string, any>;
}
function contextCopy(input: BackendContext): BackendContext {
  const r = exact(input, ['chainId', 'core', 'token', 'adjudicator', 'serviceId'], 'ACTION_CONTEXT_INVALID');
  if (r.chainId !== 84532 || !isAddress(r.core) || !isAddress(r.token) || !isAddress(r.adjudicator) ||
      !HASH.test(r.serviceId)) throw err('ACTION_CONTEXT_INVALID');
  return Object.freeze({ chainId: 84532, core: r.core.toLowerCase(), token: r.token.toLowerCase(),
    adjudicator: r.adjudicator.toLowerCase(), serviceId: r.serviceId.toLowerCase() }) as BackendContext;
}
function snapshotAction(input: PreparedAction): PreparedAction & { kind: ActionKind; args: readonly unknown[] } {
  const r = exact(input, ['chainId', 'to', 'from', 'data', 'value', 'coverageId', 'observedBlock']);
  const anchor = exact(r.observedBlock, ['number', 'hash']);
  if (r.chainId !== 84532 || !isAddress(r.to) || !isAddress(r.from) || typeof r.data !== 'string' ||
      !/^0x[0-9a-fA-F]+$/.test(r.data) || r.value !== '0' || !HASH.test(r.coverageId) ||
      typeof anchor.number !== 'string' || !UINT.test(anchor.number) || !HASH.test(anchor.hash)) throw err('ACTION_INVALID');
  let decoded: any;
  try { decoded = decodeFunctionData({ abi: CORE_ABI, data: r.data as Hex }); } catch { throw err('ACTION_SELECTOR_INVALID'); }
  if (decoded.functionName !== 'fileClaim' && decoded.functionName !== 'finalizeClaim') throw err('ACTION_SELECTOR_INVALID');
  if (!Array.isArray(decoded.args) || decoded.args.length !== (decoded.functionName === 'fileClaim' ? 2 : 4) ||
      !same(decoded.args[0], r.coverageId)) throw err('ACTION_ARGUMENTS_INVALID');
  if (decoded.functionName === 'fileClaim' && (!HASH.test(decoded.args[1]) || same(decoded.args[1], zeroHash))) throw err('ACTION_ARGUMENTS_INVALID');
  if (decoded.functionName === 'finalizeClaim' && (!Number.isInteger(decoded.args[1]) || BigInt(decoded.args[1]) < 0n || BigInt(decoded.args[1]) > 2n ||
      typeof decoded.args[2] !== 'bigint' || decoded.args[2] < 0n || !HASH.test(decoded.args[3]) || same(decoded.args[3], zeroHash))) throw err('ACTION_ARGUMENTS_INVALID');
  const canonicalData = encodeFunctionData({ abi: CORE_ABI, functionName: decoded.functionName, args: decoded.args as any });
  if (!same(canonicalData, r.data)) throw err('ACTION_ARGUMENTS_INVALID');
  return Object.freeze({ chainId: 84532, to: r.to.toLowerCase(), from: r.from.toLowerCase(), data: r.data.toLowerCase(), value: '0',
    coverageId: r.coverageId.toLowerCase(), observedBlock: Object.freeze({ number: anchor.number, hash: anchor.hash.toLowerCase() }),
    kind: decoded.functionName, args: Object.freeze([...decoded.args]) }) as PreparedAction & { kind: ActionKind; args: readonly unknown[] };
}

const RECORD_KEYS = ['kind', 'coverageId', 'transaction', 'from', 'to', 'nonce', 'calldataHash', 'gas', 'maxFeePerGas',
  'maxPriorityFeePerGas', 'value', 'attempted'];
function validateRecord(input: unknown): ActionRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw err('ACTION_JOURNAL_INVALID');
  const optional = ['blockNumber', 'blockHash', 'status'].filter((key) => Object.hasOwn(input, key));
  const r = exact(input, [...RECORD_KEYS, ...optional], 'ACTION_JOURNAL_INVALID');
  if ((r.kind !== 'fileClaim' && r.kind !== 'finalizeClaim') || !HASH.test(r.coverageId) || !HASH.test(r.transaction) ||
      !ADDRESS.test(r.from) || !ADDRESS.test(r.to) || !UINT.test(r.nonce) || !HASH.test(r.calldataHash) ||
      !UINT.test(r.gas) || !UINT.test(r.maxFeePerGas) || !UINT.test(r.maxPriorityFeePerGas) || r.value !== '0' || typeof r.attempted !== 'boolean' ||
      BigInt(r.gas) !== GAS[r.kind as ActionKind] || BigInt(r.maxFeePerGas) !== MAX_FEE || BigInt(r.maxPriorityFeePerGas) !== PRIORITY_FEE ||
      (r.status !== undefined && (!r.attempted || (r.status !== 'success' && r.status !== 'reverted'))) ||
      (r.blockNumber !== undefined) !== (r.blockHash !== undefined) || (r.blockHash !== undefined) !== (r.status !== undefined) ||
      (r.blockNumber !== undefined && (!UINT.test(r.blockNumber) || !HASH.test(r.blockHash)))) throw err('ACTION_JOURNAL_INVALID');
  return copy(r) as ActionRecord;
}
function validateJournal(input: unknown, context: BackendContext, actor: ActionActor): ActionJournal {
  const r = exact(input, ['version', 'context', 'actor', 'records'], 'ACTION_JOURNAL_INVALID');
  if (r.version !== 1 || !same(r.actor, actor) || JSON.stringify(contextCopy(r.context)) !== JSON.stringify(context) || !Array.isArray(r.records) || r.records.length > 10_000) throw err('ACTION_JOURNAL_CONTEXT');
  const records = r.records.map(validateRecord);
  const txs = new Set<string>(); const actions = new Set<string>();
  for (const row of records) {
    if (row.to !== context.core || !same(row.from, actor)) throw err('ACTION_JOURNAL_INVALID');
    const key = `${row.kind}:${row.coverageId}`;
    if (txs.has(row.transaction) || actions.has(key)) throw err('ACTION_JOURNAL_INVALID');
    txs.add(row.transaction); actions.add(key);
  }
  return { version: 1, context, actor, records };
}

/** Process-wide per-account lock shared with the M6 provider composition. Stale locks fail closed. */
export async function acquireActorLock(actor: Address): Promise<() => Promise<void>> {
  if (typeof actor !== 'string' || !isAddress(actor)) throw err('ACTION_LOCK_UNAVAILABLE');
  const root = join(tmpdir(), 'assurepay-m6-84532-actor-locks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw err('ACTION_LOCK_UNAVAILABLE');
  const canonicalActor = actor.toLowerCase();
  const path = join(root, `${canonicalActor}.lock`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    const identity = await handle.stat();
    if (!identity.isFile()) throw new Error();
    await handle.writeFile(`assurepay-m6-84532-${canonicalActor}\n`, 'utf8'); await handle.sync();
    const dir = await open(root, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    const actual = await lstat(path);
    if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error();
    let released = false;
    return async () => {
      if (released) return;
      try {
        const now = await lstat(path);
        if (!now.isFile() || now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino) throw new Error();
        await unlink(path); const dir = await open(root, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
        released = true;
      } catch { throw err('ACTION_LOCK_RELEASE_FAILED'); }
      finally { await handle?.close().catch(() => undefined); handle = undefined; }
    };
  } catch {
    if (handle) {
      try { const id = await handle.stat(); const now = await lstat(path); if (now.isFile() && !now.isSymbolicLink() && now.dev === id.dev && now.ino === id.ino) await unlink(path); } catch {}
      await handle.close().catch(() => undefined);
    }
    throw err('ACTION_LOCK_UNAVAILABLE');
  }
}

class ActionStore {
  private constructor(readonly path: string, private readonly context: BackendContext, private readonly actor: ActionActor, private current: ActionJournal) {}
  static async create(path: string, context: BackendContext, actor: ActionActor): Promise<ActionStore> {
    if (!path) throw err('ACTION_JOURNAL_PATH');
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw err('ACTION_JOURNAL_UNSAFE_PATH');
    const initial: ActionJournal = { version: 1, context, actor, records: [] };
    let f;
    try {
      f = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      await f.writeFile(JSON.stringify(initial), 'utf8'); await f.sync();
      const d = await open(dirname(path), constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); }
      return new ActionStore(path, context, actor, initial);
    } catch { throw err('ACTION_JOURNAL_EXISTS_OR_UNAVAILABLE'); }
    finally { await f?.close().catch(() => undefined); }
  }
  static async open(path: string, context: BackendContext, actor: ActionActor): Promise<ActionStore> {
    try {
      const parentInfo=await lstat(dirname(path));
      if(!parentInfo.isDirectory()||parentInfo.isSymbolicLink())throw err('ACTION_JOURNAL_UNSAFE_PATH');
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 1_048_576) throw new Error();
      const f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let text: string; try {
        const opened=await f.stat();if(!opened.isFile()||(opened.mode&0o777)!==0o600||opened.size>1_048_576)throw err('ACTION_JOURNAL_INVALID');
        text = await f.readFile('utf8');
      } finally { await f.close(); }
      if (Buffer.byteLength(text) > 1_048_576) throw err('ACTION_JOURNAL_INVALID');
      return new ActionStore(path, context, actor, validateJournal(JSON.parse(text), context, actor));
    } catch (e) { if (e instanceof Error && e.message.startsWith('ACTION_JOURNAL_')) throw e; throw err('ACTION_JOURNAL_UNAVAILABLE'); }
  }
  read(): ActionJournal { return copy(this.current); }
  async append(record: ActionRecord): Promise<void> {
    if (this.current.records.some((r) => r.kind === record.kind && r.coverageId === record.coverageId)) throw err('ACTION_ALREADY_RECORDED');
    if (this.current.records.some((r) => !r.status)) throw err('ACTION_UNRESOLVED');
    await this.save({ ...this.current, records: [...this.current.records, validateRecord(record)] });
  }
  async update(record: ActionRecord): Promise<void> {
    const index = this.current.records.findIndex((r) => r.transaction === record.transaction);
    if (index < 0) throw err('ACTION_RECORD_MISSING');
    const old = this.current.records[index]!;
    for (const key of RECORD_KEYS) {
      if (key === 'attempted') {
        if (old.attempted && !record.attempted) throw err('ACTION_RECORD_CONFLICT');
      } else if ((old as any)[key] !== (record as any)[key]) throw err('ACTION_RECORD_CONFLICT');
    }
    if (old.status && (old.status !== record.status || old.blockHash !== record.blockHash || old.blockNumber !== record.blockNumber)) throw err('ACTION_RECORD_CONFLICT');
    const records = [...this.current.records]; records[index] = validateRecord(record); await this.save({ ...this.current, records });
  }
  private async save(input: ActionJournal): Promise<void> {
    const next = validateJournal(input, this.context, this.actor);
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > 1_048_576) throw err('ACTION_JOURNAL_SIZE');
    let temp = '';
    try {
      const parentInfo = await lstat(dirname(this.path));
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error();
      const info = await lstat(this.path); if (!info.isFile() || info.isSymbolicLink()) throw new Error();
      temp = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
      const f = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await f.writeFile(encoded, 'utf8'); await f.sync(); } finally { await f.close(); }
      await rename(temp, this.path); const d = await open(dirname(this.path), constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); }
      this.current = next;
    } catch { if (temp) await unlink(temp).catch(() => undefined); throw err('ACTION_JOURNAL_WRITE_FAILED'); }
  }
}

function accountSnapshot(a: LocalAccount | undefined): LocalAccount | undefined {
  if (!a || typeof a.address !== 'string') return undefined;
  const out: Record<string, any> = { address: a.address.toLowerCase() };
  for (const k of Object.keys(a)) if (k !== 'address') { const v = (a as any)[k]; out[k] = typeof v === 'function' ? v.bind(a) : v; }
  return Object.freeze(out) as LocalAccount;
}
function txMatches(record: ActionRecord, tx: any): boolean {
  const input = typeof tx?.input === 'string' ? tx.input : tx?.data;
  let decoded: any;
  try { decoded = decodeFunctionData({ abi: CORE_ABI, data: input as Hex }); } catch { return false; }
  return decoded.functionName === record.kind && same(decoded.args?.[0], record.coverageId) &&
    same(tx?.hash, record.transaction) && same(tx?.from, record.from) && same(tx?.to, record.to) && tx?.chainId === 84532 &&
    BigInt(tx?.nonce) === BigInt(record.nonce) && typeof input === 'string' && same(keccak256(input as Hex), record.calldataHash) &&
    BigInt(tx?.value ?? 0n) === 0n && BigInt(tx?.gas) === BigInt(record.gas) && BigInt(tx?.maxFeePerGas) === BigInt(record.maxFeePerGas) &&
    BigInt(tx?.maxPriorityFeePerGas ?? 0n) === BigInt(record.maxPriorityFeePerGas) && tx?.type === 'eip1559' && (tx?.accessList?.length ?? 0) === 0;
}

/** Restricted M4 claim sender. Signed bytes are process-local and sent at most once. */
export async function createActionSender(options: ActionSenderOptions) {
  const context = contextCopy(options.context); const actor = isAddress(options.actor) ? options.actor.toLowerCase() as Address : undefined;
  if (!actor) throw err('ACTION_ACTOR_INVALID');
  const polls = options.polls ?? 5; const delay = options.delay ?? 1_000;
  if (!Number.isSafeInteger(polls) || polls < 1 || polls > 20 || !Number.isSafeInteger(delay) || delay < 0 || delay > 5_000) throw err('ACTION_BOUNDS_INVALID');
  if (!options.journalPath || !options.client || ['getChainId', 'getBlock', 'readContract', 'simulateContract', 'getTransactionCount', 'getBalance',
      'sendRawTransaction', 'getTransaction', 'getTransactionReceipt'].some((k) => typeof (options.client as any)[k] !== 'function')) throw err('ACTION_CLIENT_INVALID');
  const journalPath = options.journalPath; const c = options.client;
  const client = Object.freeze({
    getChainId: c.getChainId.bind(c), getBlock: c.getBlock.bind(c), readContract: c.readContract.bind(c),
    simulateContract: c.simulateContract.bind(c), getTransactionCount: c.getTransactionCount.bind(c), getBalance: c.getBalance.bind(c),
    sendRawTransaction: c.sendRawTransaction.bind(c), getTransaction: c.getTransaction.bind(c), getTransactionReceipt: c.getTransactionReceipt.bind(c),
  }) as Client;
  const w = options.wallet; const wallet = w ? Object.freeze({ chain: w.chain ? Object.freeze({ ...w.chain }) : undefined, signTransaction: w.signTransaction.bind(w) }) as Wallet : undefined;
  const account = accountSnapshot(options.account ?? (options.wallet as any)?.account);
  const release = await acquireActorLock(actor);
  let store: ActionStore | undefined;
  try {
    const exists = await lstat(journalPath).then(() => true, (e: any) => { if (e?.code === 'ENOENT') return false; throw err('ACTION_JOURNAL_UNAVAILABLE'); });
    if (exists) store = await ActionStore.open(journalPath, context, actor);
  } catch (e) { await release().catch(() => undefined); throw e; }
  let closed = false; let closing = false; let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = tail.then(fn, fn); tail = next.then(() => undefined, () => undefined); return next; };
  const getStore = async (allowCreate: boolean) => {
    if (closed) throw err('ACTION_SENDER_CLOSED');
    if (!store) { if (!allowCreate) throw err('ACTION_JOURNAL_REQUIRED'); store = await ActionStore.create(journalPath, context, actor); }
    return store;
  };

  async function reconcileOne(s: ActionStore, record: ActionRecord): Promise<ActionRecord> {
    if (!record.attempted) return record;
    try {
      if (await client.getChainId() !== 84532) throw err('ACTION_CHAIN_MISMATCH');
      const [tx, receipt] = await Promise.all([client.getTransaction({ hash: record.transaction }), client.getTransactionReceipt({ hash: record.transaction })]);
      if (!tx || !receipt) {
        if (record.status) throw err('ACTION_CANONICALITY_UNAVAILABLE');
        return record;
      }
      if (!txMatches(record, tx) || !same(receipt.transactionHash, record.transaction) ||
          (receipt.status !== 'success' && receipt.status !== 'reverted') || tx.blockNumber !== receipt.blockNumber || !same(tx.blockHash, receipt.blockHash)) throw err('ACTION_RECONCILIATION_MISMATCH');
      const inclusion = BigInt(receipt.blockNumber);
      const block = await client.getBlock({ blockNumber: inclusion });
      if (!block?.hash || !same(block.hash, receipt.blockHash)) {
        if (record.status) throw err('ACTION_CANONICALITY_UNAVAILABLE');
        return record;
      }
      if (record.status && (record.status !== receipt.status || record.blockNumber !== BigInt(receipt.blockNumber).toString() ||
          !same(record.blockHash, receipt.blockHash))) throw err('ACTION_CANONICALITY_UNAVAILABLE');
      const [token, adjudicator, coverage] = await Promise.all([
        client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'token', blockNumber: inclusion }),
        client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'adjudicator', blockNumber: inclusion }),
        client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'coverages', args: [record.coverageId], blockNumber: inclusion }),
      ]);
      if (!same(token, context.token) || !same(adjudicator, context.adjudicator)) throw err('ACTION_RECONCILIATION_MISMATCH');
      if (!Array.isArray(coverage) || (record.kind === 'finalizeClaim' && !same(record.from, context.adjudicator)) ||
          (record.kind === 'fileClaim' && !same(record.from, coverage[0]))) throw err('ACTION_RECONCILIATION_MISMATCH');
      const decoded = decodeFunctionData({ abi: CORE_ABI, data: (tx.input ?? tx.data) as Hex });
      if (record.kind === 'fileClaim') {
        if (receipt.status === 'success' && (!same(coverage[14], decoded.args?.[1]) || ![2, 3, 4].includes(Number(coverage[13])))) throw err('ACTION_RECONCILIATION_MISMATCH');
      } else if (receipt.status === 'success') {
        const outcome = Number(decoded.args?.[1]); const refund = BigInt(decoded.args?.[2] as bigint);
        const expectedStatus = outcome === 0 ? 4 : 3;
        if (!same(coverage[15], decoded.args?.[3]) || Number(coverage[13]) !== expectedStatus ||
            BigInt(coverage[16]) !== refund || Number(coverage[17]) !== outcome) throw err('ACTION_RECONCILIATION_MISMATCH');
      } // Included reverts are authoritative; intervening state changes need no inferred revert cause.
      const finalAnchor = await client.getBlock({ blockNumber: inclusion });
      if (!same(finalAnchor?.hash, receipt.blockHash)) throw err('ACTION_CANONICALITY_UNAVAILABLE');
      if (record.status) return record;
      const updated = { ...record, blockNumber: BigInt(receipt.blockNumber).toString(), blockHash: String(receipt.blockHash).toLowerCase() as Hex, status: receipt.status };
      await s.update(updated); return updated;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('ACTION_')) throw e;
      if (record.status) throw err('ACTION_CANONICALITY_UNAVAILABLE');
      return record;
    }
  }
  async function reconcile(): Promise<ActionRecord[]> {
    if (closing || closed) throw err('ACTION_SENDER_CLOSED');
    return serial(async () => { const s = await getStore(false); const rows = s.read().records; const out: ActionRecord[] = [];
      for (const row of rows) out.push(await reconcileOne(s, row)); return out; });
  }
  async function validateAndSimulate(action: ReturnType<typeof snapshotAction>): Promise<{ head: any; from: Address }> {
    if (await client.getChainId() !== context.chainId) throw err('ACTION_CHAIN_MISMATCH');
    if (!same(action.to, context.core) || action.chainId !== context.chainId) throw err('ACTION_CONTEXT_MISMATCH');
    const observed = await client.getBlock({ blockNumber: BigInt(action.observedBlock.number) });
    if (!observed?.hash || !same(observed.hash, action.observedBlock.hash)) throw err('ACTION_OBSERVATION_REORGED');
    const head = await client.getBlock({ blockTag: 'latest' });
    if (!head?.number || !head?.hash || typeof head.timestamp !== 'bigint') throw err('ACTION_HEAD_UNAVAILABLE');
    const [canonicalHead, token, adjudicator, rawCoverage] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(head.number) }),
      client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'token', blockNumber: BigInt(head.number) }),
      client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'adjudicator', blockNumber: BigInt(head.number) }),
      client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'coverages', args: [action.coverageId], blockNumber: BigInt(head.number) }),
    ]);
    if (!canonicalHead?.hash || !same(canonicalHead.hash, head.hash)) throw err('ACTION_HEAD_REORGED');
    if (!same(token, context.token) || !same(adjudicator, context.adjudicator) || !Array.isArray(rawCoverage) || rawCoverage.length < 18) throw err('ACTION_CORE_CONTEXT_MISMATCH');
    const payer = rawCoverage[0] as Address; const gross = BigInt(rawCoverage[5]); const expiresAt = BigInt(rawCoverage[11]);
    const poolOnlyAllowed = rawCoverage[12] === true; const status = Number(rawCoverage[13]); const evidenceHash = String(rawCoverage[14]);
    if (action.kind === 'fileClaim') {
      if (!same(actor, payer) || !same(action.from, payer)) throw err('ACTION_ACTOR_MISMATCH');
      if (status !== 1 || !same(evidenceHash, zeroHash) || BigInt(head.timestamp) >= expiresAt) throw err('ACTION_STATE_INVALID');
    } else {
      if (!same(actor, context.adjudicator) || !same(action.from, context.adjudicator) || status !== 2 || same(evidenceHash, zeroHash)) throw err('ACTION_ACTOR_MISMATCH');
      const outcome = BigInt(action.args[1] as bigint | number); const refund = BigInt(action.args[2] as bigint);
      if (outcome === 0n ? refund !== 0n : refund === 0n || refund > gross) throw err('ACTION_AMOUNT_INVALID');
      if (outcome === 2n && !poolOnlyAllowed) throw err('ACTION_AMOUNT_INVALID');
    }
    await client.simulateContract({ address: context.core, abi: CORE_ABI,
      functionName: action.kind, args: action.args as any, account: action.from, value: 0n, blockNumber: BigInt(head.number) });
    const [headAgain, observedAgain] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(head.number) }), client.getBlock({ blockNumber: BigInt(action.observedBlock.number) }),
    ]);
    if (!same(headAgain?.hash, head.hash)) throw err('ACTION_HEAD_REORGED');
    if (!same(observedAgain?.hash, action.observedBlock.hash)) throw err('ACTION_OBSERVATION_REORGED');
    return { head, from: action.from };
  }
  async function submit(input: PreparedAction): Promise<ActionRecord> {
    if (closing || closed) throw err('ACTION_SENDER_CLOSED');
    const action = snapshotAction(input);
    return serial(async () => {
      const s = await getStore(true); const existing = s.read().records.find((r) => r.kind === action.kind && same(r.coverageId, action.coverageId));
      const calldataHash = keccak256(action.data);
      if (existing) {
        if (!same(existing.from, action.from) || !same(existing.to, action.to) || !same(existing.calldataHash, calldataHash)) throw err('ACTION_EXISTING_MISMATCH');
        let row = await reconcileOne(s, existing);
        for (let i = 1; i < polls && !row.status; i++) { if (i > 0) await nap(delay); row = await reconcileOne(s, row); }
        return row;
      }
      for (const prior of s.read().records) {
        const reconciled = await reconcileOne(s, prior);
        if (!reconciled.status) throw err('ACTION_UNRESOLVED');
      }
      const { head, from } = await validateAndSimulate(action);
      if (!wallet || typeof wallet.signTransaction !== 'function' || wallet.chain?.id !== context.chainId || !account || !same(account.address, from)) throw err('ACTION_SIGNER_UNAVAILABLE');
      const [latest, pending] = await Promise.all([
        client.getTransactionCount({ address: from, blockTag: 'latest' }), client.getTransactionCount({ address: from, blockTag: 'pending' }),
      ]);
      if (!Number.isSafeInteger(latest) || latest !== pending) throw err('ACTION_NONCE_UNAVAILABLE');
      const gas = GAS[action.kind];
      if (typeof head.baseFeePerGas !== 'bigint' || head.baseFeePerGas + PRIORITY_FEE > MAX_FEE ||
          await client.getBalance({ address: from, blockNumber: BigInt(head.number) }) < gas * MAX_FEE) throw err('ACTION_FEE_OR_BALANCE_UNAVAILABLE');
      const raw = await wallet.signTransaction({ account, chain: baseSepolia, type: 'eip1559', nonce: latest,
        to: context.core, data: action.data, value: 0n, gas, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIORITY_FEE, accessList: [] });
      let parsed: any; let recovered: Address;
      try { parsed = parseTransaction(raw as `0x02${string}`); recovered = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` }); } catch { throw err('ACTION_SIGNED_TRANSACTION_INVALID'); }
      if (parsed.type !== 'eip1559' || parsed.chainId !== 84532 || BigInt(parsed.nonce) !== BigInt(latest) || !same(parsed.to, context.core) ||
          !same(parsed.data, action.data) || BigInt(parsed.value ?? 0n) !== 0n || BigInt(parsed.gas) !== gas || BigInt(parsed.maxFeePerGas) !== MAX_FEE ||
          BigInt(parsed.maxPriorityFeePerGas ?? 0n) !== PRIORITY_FEE || (parsed.accessList?.length ?? 0) !== 0 || !same(recovered, from)) throw err('ACTION_SIGNED_TRANSACTION_INVALID');
      const record: ActionRecord = { kind: action.kind, coverageId: action.coverageId, transaction: keccak256(raw), from, to: context.core,
        nonce: String(latest), calldataHash, gas: gas.toString(), maxFeePerGas: MAX_FEE.toString(), maxPriorityFeePerGas: PRIORITY_FEE.toString(), value: '0', attempted: false };
      await s.append(record);
      // Make the single-attempt marker durable before crossing the network boundary.
      const attempted = { ...record, attempted: true }; await s.update(attempted);
      try { await client.sendRawTransaction({ serializedTransaction: raw }); } catch { /* reconcile only the locally derived hash */ }
      let row = attempted;
      for (let i = 0; i < polls; i++) { row = await reconcileOne(s, row); if (row.status) break; if (i + 1 < polls) await nap(delay); }
      return row;
    });
  }
  let closePromise: Promise<void> | undefined;
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    if (closed) return;
    closing = true;
    closePromise = (async () => { await tail; closed = true; await release(); })();
    return closePromise;
  }
  return Object.freeze({ submit, reconcile, close });
}
