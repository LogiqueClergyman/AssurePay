import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeEventLog, decodeFunctionData, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, toHex, type Address, type Hex, type LocalAccount,
} from 'viem';
import { createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { createClaimsClient } from '../../developer-pilot/src/claims-client.js';
import { acquireActorLock } from '../../developer-pilot/src/action-sender.js';
import { operationPayloadHash, operationTypedData, randomNonce } from '../../claims-backend/src/index.js';
import { address, amount, exact, id, roleAddress, same, stable } from './common.js';
import { captureAccount } from './accounts.js';
import { validateProtocolConfig } from './config.js';
import { ACTION_GAS, ACTION_MAX_FEE, ACTION_PRIORITY_FEE, PREVIEW_CAP, PREVIEW_TTL_SECONDS,
  MAX_POLICY_DURATION, normalizeOperation, operationKey, planOperation, type FixedPlan } from './actions.js';
import { CORE_ABI, TOKEN_ABI } from './abi.js';
import { protocolErrorCode } from './errors.js';
import type { ActionPreview, ActionResult, Anchor, Limits, Operation, ProtocolConfig, RoleSender, SigningRole } from './types.js';

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as Address;
const UINT = /^(0|[1-9][0-9]*)$/;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 256;
const MAX_REASON_BYTES = 8192;
const APPROVAL_ABI = parseAbi(['event Approval(address indexed owner,address indexed spender,uint256 value)']);
const err = (code: string): never => { throw Error(code); };
const clone = <T>(value: T): T => structuredClone(value);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const safeUInt = (value: unknown): bigint => {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << 256n)) return err('PROTOCOL_STATE_UNAVAILABLE');
  return value;
};
const hex32 = (value: unknown): Hex => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) return err('PROTOCOL_STATE_UNAVAILABLE');
  return value as Hex;
};
const unsigned = (value: bigint): string => value.toString(10);
function readRecords(input: unknown[], role: SigningRole, actor: Address, limits: Limits, targets: { core: Address; token: Address }): JournalRecord[] {
  try { return input.map(record => normalizeRecord(record, role, actor, limits, targets)); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('PROTOCOL_JOURNAL')) throw error;
    return err('PROTOCOL_JOURNAL_INVALID');
  }
}

interface JournalRecord {
  operationId: Hex; operation: Operation['kind']; actor: Address; operationHash: Hex;
  expected: Readonly<Record<string, string | number | boolean>>;
  status: 'reserved' | 'prepared' | 'unknown' | 'success' | 'reverted';
  transaction?: Hex; to?: Address; nonce?: string; calldataHash?: Hex; gas: string;
  maxFeePerGas: string; maxPriorityFeePerGas: string; value: '0'; attempted: boolean;
  inclusion?: { number: string; hash: Hex };
}
interface Journal {
  version: 1; configHash: Hex; role: SigningRole; actor: Address;
  limits: Readonly<{ maxActionAmount: string; maxActions: number }>;
  records: JournalRecord[];
}
interface PreviewEntry {
  public: ActionPreview; operation: Operation; operationHash: Hex; stateHash: string;
  stateBinding: unknown; plan: FixedPlan;
}
type SendClient = {
  getChainId(): Promise<number>; getBlock(args: any): Promise<any>; getBytecode(args: any): Promise<Hex | undefined>;
  readContract(args: any): Promise<any>; simulateContract(args: any): Promise<any>;
  getTransactionCount(args: any): Promise<number>; getBalance(args: any): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  getTransaction(args: { hash: Hex }): Promise<any>; getTransactionReceipt(args: { hash: Hex }): Promise<any>;
  getBlockNumber?(): Promise<bigint>;
};
type Wallet = { chain?: { id?: number }; signTransaction(args: any): Promise<Hex> };

function limitSnapshot(input: Limits): Limits {
  const row = exact(input, ['maxActionAmount', 'maxActions']);
  const maxActionAmount = amount(row.maxActionAmount);
  if (BigInt(maxActionAmount) === 0n || !Number.isSafeInteger(row.maxActions) || row.maxActions < 1 || row.maxActions > 256)
    err('PROTOCOL_LIMIT');
  return Object.freeze({ maxActionAmount, maxActions: row.maxActions });
}

function publicRecord(row: JournalRecord): ActionResult {
  return Object.freeze({ operationId: row.operationId, operation: row.operation, actor: row.actor, status: row.status,
    ...(row.transaction ? { transaction: row.transaction } : {}), ...(row.inclusion ? { inclusion: { ...row.inclusion } } : {}) });
}

function expectedOperation(operation: Operation, decisionHash?: Hex): Record<string, string | number | boolean> {
  const { reason: _reason, ...publicOperation } = operation as Operation & { reason?: string };
  return { ...publicOperation, ...(decisionHash ? { decisionHash } : {}) } as Record<string, string | number | boolean>;
}

function normalizeRecord(input: unknown, role: SigningRole, actor: Address, limits: Limits, targets: { core: Address; token: Address }): JournalRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) err('PROTOCOL_JOURNAL_INVALID');
  const row = exact(input, ['operationId','operation','actor','operationHash','expected','status','gas','maxFeePerGas','maxPriorityFeePerGas','value','attempted',
    ...(['transaction','to','nonce','calldataHash','inclusion'] as const).filter(key => Object.hasOwn(input as object, key))]);
  const operations = ['registerProvider','registerPolicy','setPaused','approveCore','depositStake','withdrawStake','fundPool','finalizeClaim'];
  const statuses = ['reserved','prepared','unknown','success','reverted'];
  if (!operations.includes(row.operation) || !statuses.includes(row.status) || typeof row.expected !== 'object' || !row.expected ||
      !/^0x[0-9a-f]{64}$/.test(row.operationId) || !/^0x[0-9a-f]{64}$/.test(row.operationHash) ||
      address(row.actor) !== row.actor || row.actor !== actor || typeof row.attempted !== 'boolean' || row.value !== '0' ||
      row.gas !== ACTION_GAS[row.operation as Operation['kind']].toString() ||
      row.maxFeePerGas !== ACTION_MAX_FEE.toString() || row.maxPriorityFeePerGas !== ACTION_PRIORITY_FEE.toString()) err('PROTOCOL_JOURNAL_INVALID');
  const roleActions: Record<SigningRole, readonly Operation['kind'][]> = {
    admin: ['registerProvider','registerPolicy','setPaused','approveCore','fundPool'],
    provider: ['approveCore','depositStake','withdrawStake'], adjudicator: ['finalizeClaim'],
  };
  if (!roleActions[role].includes(row.operation as Operation['kind'])) err('PROTOCOL_JOURNAL_INVALID');
  const hasTx = row.transaction !== undefined;
  if (hasTx !== (row.to !== undefined) || hasTx !== (row.nonce !== undefined) || hasTx !== (row.calldataHash !== undefined) ||
      hasTx !== ['prepared','unknown','success','reverted'].includes(row.status) || (row.attempted !== (row.status === 'unknown' || row.status === 'success' || row.status === 'reverted')) ||
      (row.inclusion !== undefined) !== (row.status === 'success' || row.status === 'reverted')) err('PROTOCOL_JOURNAL_INVALID');
  if (hasTx && (!/^0x[0-9a-f]{64}$/.test(row.transaction) || address(row.to) !== row.to ||
      row.to !== (row.operation === 'approveCore' ? targets.token : targets.core) || !UINT.test(row.nonce) || row.nonce.length > 20 ||
      !/^0x[0-9a-f]{64}$/.test(row.calldataHash))) err('PROTOCOL_JOURNAL_INVALID');
  validateExpected(row.operation, row.expected, row.status, actor, limits, targets);
  if (row.inclusion) {
    const inclusion = exact(row.inclusion, ['number','hash']);
    if (!UINT.test(inclusion.number) || inclusion.number.length > 20 || !/^0x[0-9a-f]{64}$/.test(inclusion.hash)) err('PROTOCOL_JOURNAL_INVALID');
  }
  if (row.operation === 'finalizeClaim' && Object.hasOwn(row.expected, 'reason')) err('PROTOCOL_JOURNAL_INVALID');
  return clone(row) as JournalRecord;
}

function validateExpected(operation: Operation['kind'], input: unknown, status: JournalRecord['status'], actor: Address,
  limits: Limits, targets: { core: Address; token: Address }): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) err('PROTOCOL_JOURNAL_INVALID');
  const row = input as Record<string, unknown>;
  const base: Record<string, readonly string[]> = {
    registerProvider: ['kind','providerId','owner','payout'],
    registerPolicy: ['kind','policyId','providerId','premiumBps','stakeBps','withholdingBps','duration','poolOnlyAllowed'],
    setPaused: ['kind','paused'], approveCore: ['kind','amount'],
    depositStake: ['kind','providerId','amount'], withdrawStake: ['kind','providerId','amount'],
    fundPool: ['kind','amount'], finalizeClaim: ['kind','coverageId','outcome','refundAmount'],
  };
  const extras: Record<string, readonly string[]> = {
    registerPolicy: ['policyHash'], approveCore: ['actor','spender'], depositStake: ['actor'],
    withdrawStake: ['actor','freeStakeAfter'], fundPool: ['actor','poolAssetsBefore'], finalizeClaim: ['decisionHash'],
  };
  const extra = status === 'reserved' ? [] : extras[operation] ?? [];
  const fields = [...base[operation], ...extra];
  if (Reflect.ownKeys(row).length !== fields.length || Reflect.ownKeys(row).some(key => typeof key !== 'string' || !fields.includes(key)) || row.kind !== operation)
    err('PROTOCOL_JOURNAL_INVALID');
  if (operation === 'registerProvider') {
    id(row.providerId); address(row.owner); address(row.payout);
  } else if (operation === 'registerPolicy') {
    id(row.policyId); id(row.providerId);
    for (const key of ['premiumBps','withholdingBps']) if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0 || (row[key] as number) > 9999) err('PROTOCOL_JOURNAL_INVALID');
    if (!Number.isSafeInteger(row.stakeBps) || (row.stakeBps as number) < 0 || (row.stakeBps as number) > 10000) err('PROTOCOL_JOURNAL_INVALID');
    amount(row.duration); if (BigInt(row.duration as string) === 0n || BigInt(row.duration as string) > MAX_POLICY_DURATION || typeof row.poolOnlyAllowed !== 'boolean') err('PROTOCOL_JOURNAL_INVALID');
    if (extra.length && (typeof row.policyHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(row.policyHash))) err('PROTOCOL_JOURNAL_INVALID');
  } else if (operation === 'setPaused') {
    if (typeof row.paused !== 'boolean') err('PROTOCOL_JOURNAL_INVALID');
  } else if (operation === 'approveCore' || operation === 'depositStake' || operation === 'withdrawStake' || operation === 'fundPool') {
    const value = amount(row.amount);
    if (BigInt(value) === 0n || BigInt(value) > BigInt(limits.maxActionAmount)) err('PROTOCOL_JOURNAL_INVALID');
    if (operation !== 'approveCore' && operation !== 'fundPool') id(row.providerId);
    if (operation === 'approveCore' && extra.length && (row.actor !== actor || row.spender !== targets.core)) err('PROTOCOL_JOURNAL_INVALID');
    if ((operation === 'depositStake' || operation === 'withdrawStake' || operation === 'fundPool') && extra.length && row.actor !== actor) err('PROTOCOL_JOURNAL_INVALID');
    if (operation === 'withdrawStake' && extra.length) amount(row.freeStakeAfter);
    if (operation === 'fundPool' && extra.length) amount(row.poolAssetsBefore);
  } else if (operation === 'finalizeClaim') {
    id(row.coverageId);
    if (![0,1,2].includes(row.outcome as number)) err('PROTOCOL_JOURNAL_INVALID');
    const refund = amount(row.refundAmount);
    if (BigInt(refund) > BigInt(limits.maxActionAmount) || (row.outcome === 0 && BigInt(refund) !== 0n) || (row.outcome !== 0 && BigInt(refund) === 0n)) err('PROTOCOL_JOURNAL_INVALID');
    if (extra.length && (typeof row.decisionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(row.decisionHash) || row.decisionHash === ZERO32)) err('PROTOCOL_JOURNAL_INVALID');
  }
}

class JournalStore {
  private constructor(readonly path: string, private readonly base: Omit<Journal, 'records'>,
    private readonly targets: { core: Address; token: Address }, private value: Journal) {}
  static async open(path: string, base: Omit<Journal, 'records'>, targets: { core: Address; token: Address }): Promise<JournalStore> {
    let info;
    try { info = await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return err('PROTOCOL_JOURNAL_MISSING'); err('PROTOCOL_JOURNAL_INVALID'); }
    if (!info!.isFile() || info!.isSymbolicLink() || (info!.mode & 0o777) !== 0o600 || info!.size > MAX_JOURNAL_BYTES) err('PROTOCOL_JOURNAL_INVALID');
    let handle;
    try { handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat(); if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.size > MAX_JOURNAL_BYTES) err('PROTOCOL_JOURNAL_INVALID');
      const parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
      const row = exact(parsed, ['version','configHash','role','actor','limits','records']);
      const limits = exact(row.limits, ['maxActionAmount','maxActions']);
      if (row.version !== 1 || row.configHash !== base.configHash || row.role !== base.role || row.actor !== base.actor ||
          limits.maxActionAmount !== base.limits.maxActionAmount || limits.maxActions !== base.limits.maxActions || !Array.isArray(row.records) ||
          row.records.length > Math.min(MAX_RECORDS, base.limits.maxActions)) err('PROTOCOL_JOURNAL_CHANGED');
      const records = readRecords(row.records, base.role, base.actor, base.limits, targets);
      const ids = new Set<string>(), txs = new Set<string>();
      for (const record of records) {
        if (ids.has(record.operationId) || (record.transaction && txs.has(record.transaction))) err('PROTOCOL_JOURNAL_INVALID');
        ids.add(record.operationId); if (record.transaction) txs.add(record.transaction);
      }
      return new JournalStore(path, base, targets, { ...base, version: 1, records });
    } catch (e) { if (e instanceof Error && e.message === 'PROTOCOL_JOURNAL_CHANGED') throw e; return err('PROTOCOL_JOURNAL_INVALID'); }
    finally { await handle?.close(); }
  }
  static async initialize(path: string, base: Omit<Journal, 'records'>, targets: { core: Address; token: Address }): Promise<JournalStore> {
    const directory = join(path, '..'), markerPath = join(directory, 'actor-context.json');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0) err('PROTOCOL_STORAGE_INVALID');
    let markerInfo;
    try { markerInfo = await lstat(markerPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return err('PROTOCOL_STORAGE_INVALID');
    }
    const marker = { version: 1, configHash: base.configHash, role: base.role, actor: base.actor, limits: base.limits };
    if (markerInfo) {
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || (markerInfo.mode & 0o777) !== 0o600 || markerInfo.size > 4096) err('PROTOCOL_STORAGE_INVALID');
      let handle;
      try {
        handle = await open(markerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) err('PROTOCOL_STORAGE_INVALID');
        const saved = exact(JSON.parse(await handle.readFile('utf8')), ['version','configHash','role','actor','limits']);
        const savedLimits = exact(saved.limits, ['maxActionAmount','maxActions']);
        if (saved.version !== 1 || saved.configHash !== base.configHash || saved.role !== base.role || saved.actor !== base.actor ||
            savedLimits.maxActionAmount !== base.limits.maxActionAmount || savedLimits.maxActions !== base.limits.maxActions) err('PROTOCOL_JOURNAL_CHANGED');
      } catch (error) { if (error instanceof Error && error.message.startsWith('PROTOCOL_')) throw error; return err('PROTOCOL_STORAGE_INVALID'); }
      finally { await handle?.close(); }
      return JournalStore.open(path, base, targets);
    }
    if ((await readdir(directory)).length !== 0) err('PROTOCOL_JOURNAL_MISSING');
    let markerHandle;
    try {
      markerHandle = await open(markerPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      await markerHandle.writeFile(JSON.stringify(marker), 'utf8'); await markerHandle.sync(); await markerHandle.close(); markerHandle = undefined;
      const dirHandle = await open(directory, fsConstants.O_RDONLY); try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch { return err('PROTOCOL_STORAGE_INVALID'); }
    finally { await markerHandle?.close().catch(() => undefined); }
    return JournalStore.create(path, base, targets);
  }
  read(): Journal { return clone(this.value); }
  private async readCurrent(): Promise<Journal> {
    let info;
    try { info = await lstat(this.path); } catch { return err('PROTOCOL_JOURNAL_MISSING'); }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > MAX_JOURNAL_BYTES) err('PROTOCOL_JOURNAL_INVALID');
    let handle;
    try {
      handle = await open(this.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_JOURNAL_BYTES) err('PROTOCOL_JOURNAL_INVALID');
      const input = exact(JSON.parse(await handle.readFile('utf8')), ['version','configHash','role','actor','limits','records']);
      const limits = exact(input.limits, ['maxActionAmount','maxActions']);
      if (input.version !== this.base.version || input.configHash !== this.base.configHash || input.role !== this.base.role || input.actor !== this.base.actor ||
          limits.maxActionAmount !== this.base.limits.maxActionAmount || limits.maxActions !== this.base.limits.maxActions || !Array.isArray(input.records) ||
          input.records.length > Math.min(MAX_RECORDS, this.base.limits.maxActions)) err('PROTOCOL_JOURNAL_CHANGED');
      const records = readRecords(input.records, this.base.role, this.base.actor, this.base.limits, this.targets);
      const ids = new Set<string>(), txs = new Set<string>();
      for (const record of records) {
        if (ids.has(record.operationId) || (record.transaction && txs.has(record.transaction))) err('PROTOCOL_JOURNAL_INVALID');
        ids.add(record.operationId); if (record.transaction) txs.add(record.transaction);
      }
      return { ...this.base, records };
    } catch (error) {
      if (error instanceof Error && ['PROTOCOL_JOURNAL_CHANGED','PROTOCOL_JOURNAL_INVALID'].includes(error.message)) throw error;
      return err('PROTOCOL_JOURNAL_INVALID');
    }
    finally { await handle?.close(); }
  }
  async assertCurrent(): Promise<void> {
    const disk = await this.readCurrent();
    if (JSON.stringify(disk) !== JSON.stringify(this.value)) err('PROTOCOL_JOURNAL_CHANGED');
  }
  async save(records: JournalRecord[]): Promise<void> {
    await this.assertCurrent();
    const validated = records.map(record => normalizeRecord(record, this.base.role, this.base.actor, this.base.limits, this.targets));
    if (validated.length > Math.min(MAX_RECORDS, this.base.limits.maxActions)) err('PROTOCOL_LIMIT');
    const next: Journal = { ...this.base, version: 1, records: validated };
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES) err('PROTOCOL_JOURNAL_INVALID');
    const temp = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let file;
    try {
      const parent = await lstat(join(this.path, '..'));
      if (!parent.isDirectory() || parent.isSymbolicLink()) err('PROTOCOL_STORAGE_INVALID');
      file = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      await file.writeFile(encoded, 'utf8'); await file.sync(); await file.close(); file = undefined;
      await rename(temp, this.path);
      const dir = await open(join(this.path, '..'), fsConstants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      this.value = next;
    } catch (e) {
      await unlink(temp).catch(() => undefined);
      if (e instanceof Error && e.message.startsWith('PROTOCOL_')) throw e;
      err('PROTOCOL_STORAGE_INVALID');
    } finally { await file?.close().catch(() => undefined); }
  }
  static async create(path: string, base: Omit<Journal, 'records'>, targets: { core: Address; token: Address }): Promise<JournalStore> {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const parent = await lstat(join(path, '..'));
    if (!parent.isDirectory() || parent.isSymbolicLink()) err('PROTOCOL_STORAGE_INVALID');
    const initial: Journal = { ...base, version: 1, records: [] };
    let file;
    try { file = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      await file.writeFile(JSON.stringify(initial), 'utf8'); await file.sync();
      const dir = await open(join(path, '..'), fsConstants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      return new JournalStore(path, base, targets, initial);
    } catch { return err('PROTOCOL_JOURNAL_INVALID'); }
    finally { await file?.close().catch(() => undefined); }
  }
}

function eventMatches(operation: Operation['kind'], expected: JournalRecord['expected'], receipt: any, target: Address): boolean {
  const event = operation === 'registerProvider' ? 'ProviderRegistered' : operation === 'registerPolicy' ? 'PolicyRegistered' :
    operation === 'setPaused' ? 'PauseUpdated' : operation === 'depositStake' ? 'StakeDeposited' :
    operation === 'withdrawStake' ? 'StakeWithdrawn' : operation === 'fundPool' ? 'PoolFunded' :
    operation === 'finalizeClaim' ? 'ClaimFinalized' : 'Approval';
  const eventAbi = operation === 'approveCore' ? APPROVAL_ABI : CORE_ABI;
  for (const log of receipt.logs ?? []) {
    try {
      if (!same(log.address, target)) continue;
      const decoded = decodeEventLog({ abi: eventAbi, data: log.data, topics: log.topics });
      if (decoded.eventName !== event) continue;
      const args = decoded.args as any;
      if (operation === 'registerProvider') return same(args.providerId, expected.providerId) && same(args.owner, expected.owner) && same(args.payout, expected.payout);
      if (operation === 'registerPolicy') return same(args.policyId, expected.policyId) && same(args.providerId, expected.providerId) &&
        same(args.policyHash, expected.policyHash) && Number(args.premiumBps) === expected.premiumBps && Number(args.stakeBps) === expected.stakeBps &&
        Number(args.withholdingBps) === expected.withholdingBps && BigInt(args.duration) === BigInt(String(expected.duration)) && args.poolOnlyAllowed === expected.poolOnlyAllowed;
      if (operation === 'setPaused') return args.paused === expected.paused;
      if (operation === 'approveCore') return same(args.owner, expected.actor) && same(args.spender, expected.spender) && BigInt(args.value) === BigInt(String(expected.amount));
      if (operation === 'depositStake') return same(args.providerId, expected.providerId) && same(args.funder, expected.actor) && BigInt(args.amount) === BigInt(String(expected.amount));
      if (operation === 'withdrawStake') return same(args.providerId, expected.providerId) && same(args.owner, expected.actor) && BigInt(args.amount) === BigInt(String(expected.amount));
      if (operation === 'fundPool') return same(args.funder, expected.actor) && BigInt(args.amount) === BigInt(String(expected.amount));
      if (operation === 'finalizeClaim') return same(args.coverageId, expected.coverageId) && Number(args.outcome) === expected.outcome &&
        BigInt(args.refundAmount) === BigInt(String(expected.refundAmount)) && same(args.decisionHash, expected.decisionHash);
    } catch { /* Other token/Core logs are irrelevant. */ }
  }
  return false;
}

function callMatches(operation: Operation['kind'], expected: JournalRecord['expected'], input: Hex, config: ProtocolConfig): boolean {
  try {
    const decoded = decodeFunctionData({ abi: operation === 'approveCore' ? TOKEN_ABI : CORE_ABI, data: input });
    const args = decoded.args as readonly any[];
    const functionName = operation === 'approveCore' ? 'approve' : operation;
    if (decoded.functionName !== functionName) return false;
    switch (operation) {
      case 'registerProvider': return same(args[0], expected.providerId) && same(args[1], expected.owner) && same(args[2], expected.payout);
      case 'registerPolicy': return same(args[0], expected.policyId) && same(args[1], expected.providerId) && Number(args[2]) === expected.premiumBps &&
        Number(args[3]) === expected.stakeBps && Number(args[4]) === expected.withholdingBps && BigInt(args[5]) === BigInt(String(expected.duration)) && args[6] === expected.poolOnlyAllowed;
      case 'setPaused': return args[0] === expected.paused;
      case 'approveCore': return same(args[0], config.pilot.core) && BigInt(args[1]) === BigInt(String(expected.amount));
      case 'depositStake': case 'withdrawStake': return same(args[0], expected.providerId) && BigInt(args[1]) === BigInt(String(expected.amount));
      case 'fundPool': return BigInt(args[0]) === BigInt(String(expected.amount));
      case 'finalizeClaim': return same(args[0], expected.coverageId) && Number(args[1]) === expected.outcome &&
        BigInt(args[2]) === BigInt(String(expected.refundAmount)) && same(args[3], expected.decisionHash);
    }
  } catch { return false; }
}


export async function createRoleSender(options: {
  config: ProtocolConfig; role: SigningRole; account?: LocalAccount; directory: string; limits: Limits;
  client: any; wallet?: any;
}): Promise<RoleSender> {
  try {
    const config = validateProtocolConfig(options.config);
    const role = options.role;
    if (!['admin','provider','adjudicator'].includes(role) || typeof options.directory !== 'string' || !options.directory) err('PROTOCOL_ARGUMENT_INVALID');
    const actor = roleAddress(config, role);
    const limits = limitSnapshot(options.limits);
    const account = captureAccount(options.account, actor);
    const source = options.client as SendClient;
    const required = ['getChainId','getBlock','getBytecode','readContract','simulateContract','getTransactionCount','getBalance','sendRawTransaction','getTransaction','getTransactionReceipt'];
    if (!source || required.some(key => typeof (source as any)[key] !== 'function')) err('PROTOCOL_ARGUMENT_INVALID');
    const client = Object.freeze(Object.fromEntries(required.map(key => [key, (source as any)[key].bind(source)]))) as unknown as SendClient;
    let wallet: Wallet | undefined;
    if (options.wallet) {
      if (options.wallet.chain?.id !== 84532 || typeof options.wallet.signTransaction !== 'function') err('PROTOCOL_ACCOUNT_INVALID');
      wallet = Object.freeze({ chain: Object.freeze({ id: 84532 }), signTransaction: options.wallet.signTransaction.bind(options.wallet) });
    } else if (account) {
      const localWallet = createWalletClient({ account, chain: baseSepolia, transport: http(config.pilot.rpcUrl, { retryCount: 0, timeout: 15_000 }) });
      wallet = Object.freeze({ chain: Object.freeze({ id: 84532 }), signTransaction: localWallet.signTransaction.bind(localWallet) });
    }
    const expectedConfigHash = keccak256(new TextEncoder().encode(stable({ config, role, actor, limits })));
    const base = { version: 1 as const, configHash: expectedConfigHash, role, actor, limits } as const;
    const journalPath = join(options.directory, 'journal.json');
    const release = await acquireActorLock(actor);
    let store: JournalStore;
    const targets = { core: config.pilot.core, token: config.pilot.token };
    try { store = await JournalStore.initialize(journalPath, base, targets); }
    catch (e) { await release().catch(() => undefined); throw e; }

    const previews = new Map<Hex, PreviewEntry>();
    const tailRef: { value: Promise<unknown> } = { value: Promise.resolve() };
    let closed = false, closing = false, closePromise: Promise<void> | undefined;
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = tailRef.value.then(fn, fn); tailRef.value = next.then(() => undefined, () => undefined); return next;
    };
    const ensureOpen = () => { if (closed || closing) err('PROTOCOL_CLOSED'); };
    const getStore = async (_create: boolean) => store;
    const assertCoreContext = async (blockNumber: bigint) => {
      const [token, admin, adjudicator] = await Promise.all([
        client.readContract({ address: config.pilot.core, abi: CORE_ABI, functionName: 'token', blockNumber }),
        client.readContract({ address: config.pilot.core, abi: CORE_ABI, functionName: 'admin', blockNumber }),
        client.readContract({ address: config.pilot.core, abi: CORE_ABI, functionName: 'adjudicator', blockNumber }),
      ]);
      if (!same(token, config.pilot.token) || !same(admin, config.admin) || !same(adjudicator, config.pilot.roles.adjudicator)) err('PROTOCOL_CONTEXT_MISMATCH');
      return { token: String(token).toLowerCase() as Address, admin: String(admin).toLowerCase() as Address,
        adjudicator: String(adjudicator).toLowerCase() as Address };
    };
    const head = async () => {
      if (await client.getChainId() !== 84532) err('PROTOCOL_CONTEXT_MISMATCH');
      const block = await client.getBlock({ blockTag: 'latest' });
      if (typeof block?.number !== 'bigint' || typeof block?.timestamp !== 'bigint' || typeof block?.hash !== 'string') err('PROTOCOL_STATE_UNAVAILABLE');
      const anchor: Anchor = { number: block.number.toString(), hash: hex32(block.hash), timestamp: block.timestamp.toString() };
      await assertCoreContext(block.number);
      const [coreCode, tokenCode] = await Promise.all([
        client.getBytecode({ address: config.pilot.core, blockNumber: block.number }),
        client.getBytecode({ address: config.pilot.token, blockNumber: block.number }),
      ]);
      if (!coreCode || coreCode === '0x' || !tokenCode || tokenCode === '0x') err('PROTOCOL_CONTEXT_MISMATCH');
      const again = await client.getBlock({ blockNumber: block.number });
      if (!same(again?.hash, anchor.hash)) err('PROTOCOL_REORG');
      return { anchor, block };
    };

    async function bindState(operation: Operation, anchorBlock: bigint): Promise<{ binding: unknown; provider?: { owner: Address; payout: Address }; extra: Record<string, unknown> }> {
      const core = config.pilot.core, tokenAddress = config.pilot.token;
      const common = await assertCoreContext(anchorBlock);
      const paused = await client.readContract({ address: core, abi: CORE_ABI, functionName: 'paused', blockNumber: anchorBlock });
      let provider: { owner: Address; payout: Address } | undefined;
      let extra: Record<string, unknown> = {};
      if (operation.kind === 'registerProvider') {
        const [row, nativeBalance] = await Promise.all([
          client.readContract({ address: core, abi: CORE_ABI, functionName: 'providers', args: [operation.providerId], blockNumber: anchorBlock }),
          client.getBalance({ address: actor, blockNumber: anchorBlock }),
        ]);
        if (!Array.isArray(row) || !same(row[0], ZERO_ADDRESS)) err('PROTOCOL_PREVIEW_STALE');
        if (paused !== false) err('PROTOCOL_PREVIEW_STALE');
        extra = { nativeBalance: safeUInt(nativeBalance).toString() };
        return { binding: { ...common, paused, provider: row.map((x: unknown) => typeof x === 'bigint' ? x.toString() : x), extra }, extra };
      }
      if (operation.kind === 'registerPolicy') {
        const [rawProvider, rawPolicy, nativeBalance] = await Promise.all([
          client.readContract({ address: core, abi: CORE_ABI, functionName: 'providers', args: [operation.providerId], blockNumber: anchorBlock }),
          client.readContract({ address: core, abi: CORE_ABI, functionName: 'policies', args: [operation.policyId], blockNumber: anchorBlock }),
          client.getBalance({ address: actor, blockNumber: anchorBlock }),
        ]);
        if (!Array.isArray(rawProvider) || same(rawProvider[0], ZERO32) || !Array.isArray(rawPolicy) || !same(rawPolicy[0], ZERO32) || paused !== false)
          err('PROTOCOL_PREVIEW_STALE');
        provider = { owner: address(rawProvider[0]), payout: address(rawProvider[1]) };
        extra = { nativeBalance: safeUInt(nativeBalance).toString() };
        return { binding: { ...common, paused, provider, policy: rawPolicy.map((x: unknown) => typeof x === 'bigint' ? x.toString() : x), extra }, provider, extra };
      }
      if (operation.kind === 'setPaused') {
        if (typeof paused !== 'boolean' || paused === operation.paused) err('PROTOCOL_PREVIEW_STALE');
        return { binding: { ...common, paused }, extra };
      }
      if (operation.kind === 'approveCore') {
        const [allowance, balance] = await Promise.all([
          client.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: 'allowance', args: [actor, core], blockNumber: anchorBlock }),
          client.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: 'balanceOf', args: [actor], blockNumber: anchorBlock }),
        ]);
        if (safeUInt(allowance) === BigInt(operation.amount)) err('PROTOCOL_PREVIEW_STALE');
        extra = { allowance: safeUInt(allowance).toString(), balance: safeUInt(balance).toString() };
        return { binding: { ...common, paused, extra }, extra };
      }
      if (operation.kind === 'depositStake' || operation.kind === 'withdrawStake') {
        if (role !== 'provider' || operation.providerId !== config.pilot.providerId) err('PROTOCOL_FORBIDDEN');
        const [rawProvider, allowance, balance] = await Promise.all([
          client.readContract({ address: core, abi: CORE_ABI, functionName: 'providers', args: [operation.providerId], blockNumber: anchorBlock }),
          client.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: 'allowance', args: [actor, core], blockNumber: anchorBlock }),
          client.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: 'balanceOf', args: [actor], blockNumber: anchorBlock }),
        ]);
        if (!Array.isArray(rawProvider) || !same(rawProvider[0], actor)) err('PROTOCOL_FORBIDDEN');
        if (operation.kind === 'withdrawStake' && BigInt(rawProvider[2]) < BigInt(operation.amount)) err('PROTOCOL_PREVIEW_STALE');
        if (operation.kind === 'depositStake' && (safeUInt(allowance) < BigInt(operation.amount) || safeUInt(balance) < BigInt(operation.amount))) err('PROTOCOL_STATE_UNAVAILABLE');
        provider = { owner: address(rawProvider[0]), payout: address(rawProvider[1]) };
        extra = { allowance: safeUInt(allowance).toString(), balance: safeUInt(balance).toString(), freeStake: safeUInt(rawProvider[2]).toString(), lockedStake: safeUInt(rawProvider[3]).toString() };
        return { binding: { ...common, paused, provider: rawProvider.map((x: unknown) => typeof x === 'bigint' ? x.toString() : x), extra }, provider, extra };
      }
      if (operation.kind === 'fundPool') {
        const [allowance, balance, poolAssets, poolReserved] = await Promise.all([
          client.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: 'allowance', args: [actor, core], blockNumber: anchorBlock }),
          client.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: 'balanceOf', args: [actor], blockNumber: anchorBlock }),
          client.readContract({ address: core, abi: CORE_ABI, functionName: 'poolAssets', blockNumber: anchorBlock }),
          client.readContract({ address: core, abi: CORE_ABI, functionName: 'totalPoolReserved', blockNumber: anchorBlock }),
        ]);
        if (safeUInt(allowance) < BigInt(operation.amount) || safeUInt(balance) < BigInt(operation.amount)) err('PROTOCOL_STATE_UNAVAILABLE');
        extra = { allowance: safeUInt(allowance).toString(), balance: safeUInt(balance).toString(), poolAssets: safeUInt(poolAssets).toString(), poolReserved: safeUInt(poolReserved).toString() };
        return { binding: { ...common, paused, extra }, extra };
      }
      if (operation.kind === 'finalizeClaim') {
        const raw = await client.readContract({ address: core, abi: CORE_ABI, functionName: 'coverages', args: [operation.coverageId], blockNumber: anchorBlock });
        if (!Array.isArray(raw) || raw.length < 18 || Number(raw[13]) !== 2 || same(raw[14], ZERO32)) err('PROTOCOL_PREVIEW_STALE');
        if (operation.outcome === 2 && raw[12] !== true) err('PROTOCOL_PREVIEW_STALE');
        if (operation.outcome !== 0 && BigInt(operation.refundAmount) > BigInt(raw[5])) err('PROTOCOL_LIMIT');
        extra = { coverage: raw.map((x: unknown) => typeof x === 'bigint' ? x.toString() : x) };
        return { binding: { ...common, paused, extra }, extra };
      }
      return err('PROTOCOL_FORBIDDEN');
    }

    async function simulate(plan: FixedPlan, operation: Operation, at: bigint): Promise<void> {
      let decoded;
      try { decoded = decodeFunctionData({ abi: plan.to === config.pilot.token ? TOKEN_ABI : CORE_ABI, data: plan.data }); }
      catch { err('PROTOCOL_ARGUMENT_INVALID'); }
      try { await client.simulateContract({ address: plan.to, abi: plan.to === config.pilot.token ? TOKEN_ABI : CORE_ABI,
        functionName: decoded!.functionName as any, args: decoded!.args as any, account: actor, value: plan.value, blockNumber: at }); }
      catch { err('PROTOCOL_SIMULATION_FAILED'); }
      const block = await client.getBlock({ blockNumber: at });
      if (!block?.hash) err('PROTOCOL_STATE_UNAVAILABLE');
      return;
    }

    async function reconcileOne(s: JournalStore, row: JournalRecord): Promise<JournalRecord> {
      if (!row.transaction || !row.attempted || row.status === 'reserved' || row.status === 'prepared') return row;
      const originalHash = row.transaction;
      if (row.status === 'success' || row.status === 'reverted') {
        const { inclusion: _oldInclusion, ...withoutInclusion } = row;
        row = { ...withoutInclusion, status: 'unknown' };
        await s.save(s.read().records.map(item => item.operationId === row.operationId ? row : item));
      }
      try {
        if (await client.getChainId() !== 84532) err('PROTOCOL_CONTEXT_MISMATCH');
        const [tx, receipt] = await Promise.all([client.getTransaction({ hash: originalHash }), client.getTransactionReceipt({ hash: originalHash })]);
        if (!tx || !receipt) return row.status === 'unknown' ? row : err('PROTOCOL_REORG');
        const input = typeof tx.input === 'string' ? tx.input : tx.data;
        if (!input || tx.type !== 'eip1559' || tx.chainId !== 84532 || !same(tx.hash, row.transaction) || !same(tx.from, actor) ||
            !same(tx.to, row.to) || BigInt(tx.nonce) !== BigInt(row.nonce!) || !same(keccak256(input), row.calldataHash) ||
            BigInt(tx.value ?? 0n) !== 0n || BigInt(tx.gas) !== BigInt(row.gas) || BigInt(tx.maxFeePerGas) !== ACTION_MAX_FEE ||
            BigInt(tx.maxPriorityFeePerGas ?? 0n) !== ACTION_PRIORITY_FEE || (tx.accessList?.length ?? 0) !== 0) err('PROTOCOL_JOURNAL_CHANGED');
        if (!callMatches(row.operation, row.expected, input as Hex, config)) err('PROTOCOL_JOURNAL_CHANGED');
        if (!receipt || !['success','reverted'].includes(receipt.status) || !same(receipt.transactionHash, row.transaction) ||
            tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber)
          return row.status === 'unknown' ? row : err('PROTOCOL_REORG');
        const inclusionNumber = BigInt(receipt.blockNumber);
        const inclusionBlock = await client.getBlock({ blockNumber: inclusionNumber });
        if (!same(inclusionBlock?.hash, receipt.blockHash)) err('PROTOCOL_REORG');
        await assertCoreContext(inclusionNumber);
        let status: JournalRecord['status'] = receipt.status === 'success' ? 'success' : 'reverted';
        if (status === 'success') {
          const target = row.operation === 'approveCore' ? config.pilot.token : config.pilot.core;
          if (!eventMatches(row.operation, row.expected, receipt, target)) err('PROTOCOL_JOURNAL_CHANGED');
          if (row.operation === 'registerProvider' || row.operation === 'registerPolicy' || row.operation === 'finalizeClaim') {
            const abi = CORE_ABI;
            const functionName = row.operation === 'registerProvider' ? 'providers' : row.operation === 'registerPolicy' ? 'policies' : 'coverages';
            const args = row.operation === 'registerProvider' ? [row.expected.providerId] :
              row.operation === 'registerPolicy' ? [row.expected.policyId] : [row.expected.coverageId];
            const post = await client.readContract({ address: config.pilot.core, abi, functionName, args, blockNumber: inclusionNumber });
            if (row.operation === 'registerProvider' && (!Array.isArray(post) || !same(post[0], row.expected.owner) || !same(post[1], row.expected.payout))) err('PROTOCOL_JOURNAL_CHANGED');
            if (row.operation === 'registerPolicy' && (!Array.isArray(post) || !same(post[0], row.expected.providerId) || !same(post[1], row.expected.policyHash))) err('PROTOCOL_JOURNAL_CHANGED');
            if (row.operation === 'finalizeClaim' && (!Array.isArray(post) || !same(post[15], row.expected.decisionHash) ||
                Number(post[13]) !== (Number(row.expected.outcome) === 0 ? 4 : 3) || BigInt(post[16]) !== BigInt(String(row.expected.refundAmount)))) err('PROTOCOL_JOURNAL_CHANGED');
          }
        }
        const end = await client.getBlock({ blockNumber: inclusionNumber });
        if (!same(end?.hash, receipt.blockHash)) err('PROTOCOL_REORG');
        const updated: JournalRecord = { ...row, status, inclusion: { number: inclusionNumber.toString(), hash: String(receipt.blockHash).toLowerCase() as Hex } };
        const rows = s.read().records.map(item => item.operationId === row.operationId ? updated : item);
        await s.save(rows);
        return updated;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('PROTOCOL_')) throw error;
        return row;
      }
    }
    async function reconcileInternal(): Promise<JournalRecord[]> {
      const s = await getStore(false);
      await s.assertCurrent();
      const out: JournalRecord[] = [];
      for (const row of s.read().records) out.push(await reconcileOne(s, row));
      return out;
    }

    async function preview(operationInput: unknown): Promise<ActionPreview> {
      ensureOpen();
      const operation = normalizeOperation(role, operationInput, limits);
      const { anchor, block } = await head();
      const bound = await bindState(operation, block.number);
      const plan = planOperation(operation, actor, config, undefined, bound.provider);
      await simulate(plan, operation, block.number);
      const confirmHead = await client.getBlock({ blockNumber: block.number });
      if (!same(confirmHead?.hash, anchor.hash)) err('PROTOCOL_REORG');
      for (const [key, value] of previews) if (BigInt(anchor.timestamp) > BigInt(value.public.expiresAt)) previews.delete(key);
      if (previews.size >= PREVIEW_CAP) err('PROTOCOL_LIMIT');
      const previewId = toHex(randomBytes(32)) as Hex;
      const expiresAt = unsigned(BigInt(anchor.timestamp) + PREVIEW_TTL_SECONDS);
      const publicPreview: ActionPreview = Object.freeze({ previewId, role, actor, operation: operation.kind, review: plan.review,
        chainId: 84532, core: config.pilot.core, anchor: Object.freeze({ ...anchor }), expiresAt,
        gas: plan.gas.toString(), maxFeePerGas: ACTION_MAX_FEE.toString(), maxPriorityFeePerGas: ACTION_PRIORITY_FEE.toString() });
      previews.set(previewId, { public: publicPreview, operation, operationHash: operationKey(operation),
        stateBinding: bound.binding, stateHash: keccak256(new TextEncoder().encode(stable(bound.binding))), plan });
      return clone(publicPreview);
    }

    async function prepareDecision(operation: Extract<Operation, {kind:'finalizeClaim'}>, decisionHashNeeded?: Hex): Promise<{ plan: FixedPlan; decisionHash: Hex }> {
      if (!account) err('PROTOCOL_SIGNER_REQUIRED');
      const decision = { outcome: operation.outcome, refundAmount: operation.refundAmount, reason: operation.reason };
      const { timestamp } = (await client.getBlock({ blockTag: 'latest' }));
      if (typeof timestamp !== 'bigint') err('PROTOCOL_STATE_UNAVAILABLE');
      const message = { actor, operation: 'prepareDecision' as const, coverageId: operation.coverageId,
        payloadHash: operationPayloadHash(decision), nonce: randomNonce(), deadline: String(timestamp + 250n) };
      const typed = operationTypedData({ chainId: 84532, core: config.pilot.core, token: config.pilot.token,
        adjudicator: config.pilot.roles.adjudicator, serviceId: config.pilot.serviceId }, message);
      const signer = account ?? err('PROTOCOL_SIGNER_REQUIRED');
      const authorization = { ...message, signature: await signer.signTypedData(typed) };
      const claims = createClaimsClient({ url: config.pilot.claimsUrl });
      const prepared = await claims.prepareDecision(operation.coverageId, decision, authorization);
      if (prepared.action.chainId !== 84532 || !same(prepared.action.to, config.pilot.core) || !same(prepared.action.from, actor) ||
          prepared.action.value !== '0' || prepared.action.coverageId !== operation.coverageId) err('PROTOCOL_CONTEXT_MISMATCH');
      const observed = await client.getBlock({ blockNumber: BigInt(prepared.action.observedBlock.number) });
      if (!same(observed?.hash, prepared.action.observedBlock.hash)) err('PROTOCOL_REORG');
      const decoded = decodeFunctionData({ abi: CORE_ABI, data: prepared.action.data });
      if (decoded.functionName !== 'finalizeClaim' || decoded.args[0] !== operation.coverageId || Number(decoded.args[1]) !== operation.outcome ||
          BigInt(decoded.args[2]) !== BigInt(operation.refundAmount) || !/^0x[0-9a-f]{64}$/.test(prepared.decisionHash) || prepared.decisionHash === ZERO32 ||
          !same(decoded.args[3], prepared.decisionHash)) err('PROTOCOL_CONTEXT_MISMATCH');
      const plan = planOperation(operation, actor, config, prepared.decisionHash);
      if (!same(plan.data, prepared.action.data)) err('PROTOCOL_CONTEXT_MISMATCH');
      return { plan, decisionHash: prepared.decisionHash };
    }

    async function confirm(previewIdInput: Hex, approvalInput: Readonly<{ approved: true }>): Promise<ActionResult> {
      ensureOpen();
      const previewId = id(previewIdInput);
      const approval = exact(approvalInput, ['approved']);
      if (approval.approved !== true) err('PROTOCOL_APPROVAL_REQUIRED');
      const entry = previews.get(previewId) ?? err('PROTOCOL_PREVIEW_REQUIRED');
      previews.delete(previewId);
      const selected = entry;
      return serial(async () => {
        ensureOpen();
        const previous = await reconcileInternal();
        if (previous.some(row => !['success','reverted'].includes(row.status))) err('PROTOCOL_UNRESOLVED');
        const currentStore = await getStore(false);
        if ((currentStore?.read().records.length ?? 0) >= limits.maxActions || (currentStore?.read().records.length ?? 0) >= MAX_RECORDS) err('PROTOCOL_LIMIT');
        const originalBlock = await client.getBlock({ blockNumber: BigInt(selected.public.anchor.number) });
        if (!same(originalBlock?.hash, selected.public.anchor.hash)) err('PROTOCOL_PREVIEW_STALE');
        const current = await head();
        if (BigInt(current.anchor.timestamp) > BigInt(selected.public.expiresAt)) err('PROTOCOL_PREVIEW_EXPIRED');
        const bound = await bindState(selected.operation, BigInt(current.anchor.number));
        if (keccak256(new TextEncoder().encode(stable(bound.binding))) !== selected.stateHash) err('PROTOCOL_PREVIEW_STALE');
        let plan = planOperation(selected.operation, actor, config, undefined, bound.provider);
        let decisionHash: Hex | undefined;
        const baseGas = ACTION_GAS[selected.operation.kind];
        if (plan.gas !== baseGas) err('PROTOCOL_ARGUMENT_INVALID');
        const signerAccount = account ?? err('PROTOCOL_SIGNER_REQUIRED');
        const signerWallet = wallet ?? err('PROTOCOL_SIGNER_REQUIRED');
        const prior = await getStore(false);
        const operationId = previewId;
        const expectedBase = expectedOperation(selected.operation);
        const reserved: JournalRecord = { operationId, operation: selected.operation.kind, actor,
          operationHash: selected.operationHash, expected: expectedBase, status: 'reserved', gas: baseGas.toString(),
          maxFeePerGas: ACTION_MAX_FEE.toString(), maxPriorityFeePerGas: ACTION_PRIORITY_FEE.toString(), value: '0', attempted: false };
        const durableStore = prior ?? await getStore(true) ?? err('PROTOCOL_STORAGE_INVALID');
        await durableStore.save([...durableStore.read().records, reserved]);

        if (selected.operation.kind === 'finalizeClaim') {
          const ready = await prepareDecision(selected.operation);
          plan = ready.plan; decisionHash = ready.decisionHash;
        }
        const fresh = await head();
        const freshBinding = await bindState(selected.operation, BigInt(fresh.anchor.number));
        if (keccak256(new TextEncoder().encode(stable(freshBinding.binding))) !== selected.stateHash) err('PROTOCOL_PREVIEW_STALE');
        await simulate(plan, selected.operation, BigInt(fresh.anchor.number));
        const afterSimulation = await client.getBlock({ blockNumber: BigInt(fresh.anchor.number) });
        if (!same(afterSimulation?.hash, fresh.anchor.hash)) err('PROTOCOL_REORG');
        const actualExpected = expectedOperation(selected.operation, decisionHash);
        if (selected.operation.kind === 'registerPolicy') actualExpected.policyHash = plan.policyHash!;
        if (selected.operation.kind === 'approveCore') { actualExpected.spender = config.pilot.core; actualExpected.actor = actor; }
        if (selected.operation.kind === 'depositStake' || selected.operation.kind === 'withdrawStake') {
          actualExpected.actor = actor;
          if (selected.operation.kind === 'withdrawStake') actualExpected.freeStakeAfter = String(BigInt(freshBinding.extra.freeStake as string) - BigInt(selected.operation.amount));
        }
        if (selected.operation.kind === 'fundPool') {
          actualExpected.actor = actor; actualExpected.poolAssetsBefore = String(freshBinding.extra.poolAssets);
        }
        let nonce: number;
        const [latest, pending] = await Promise.all([
          client.getTransactionCount({ address: actor, blockTag: 'latest' }), client.getTransactionCount({ address: actor, blockTag: 'pending' }),
        ]);
        if (!Number.isSafeInteger(latest) || latest < 0 || latest !== pending) err('PROTOCOL_NONCE_BUSY');
        nonce = latest;
        const gas = plan.gas;
        if (fresh.block.baseFeePerGas === undefined || typeof fresh.block.baseFeePerGas !== 'bigint' ||
            fresh.block.baseFeePerGas + ACTION_PRIORITY_FEE > ACTION_MAX_FEE ||
            safeUInt(await client.getBalance({ address: actor, blockNumber: BigInt(fresh.anchor.number) })) < gas * ACTION_MAX_FEE) err('PROTOCOL_GAS_UNAVAILABLE');
        const beforeSign = await client.getBlock({ blockNumber: BigInt(fresh.anchor.number) });
        if (!same(beforeSign?.hash, fresh.anchor.hash)) err('PROTOCOL_REORG');
        await durableStore.assertCurrent();
        const signPlan = { account: signerAccount, chain: baseSepolia, type: 'eip1559' as const, nonce, to: plan.to, data: plan.data, value: 0n,
          gas, maxFeePerGas: ACTION_MAX_FEE, maxPriorityFeePerGas: ACTION_PRIORITY_FEE, accessList: [] };
        const raw = await signerWallet.signTransaction(signPlan);
        const afterSign = await client.getBlock({ blockNumber: BigInt(fresh.anchor.number) });
        if (!same(afterSign?.hash, fresh.anchor.hash)) err('PROTOCOL_REORG');
        let parsed: any, recovered: Address;
        try {
          parsed = parseTransaction(raw as `0x02${string}`);
          recovered = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
        } catch { err('PROTOCOL_TX_INVALID'); }
        if (parsed!.type !== 'eip1559' || parsed!.chainId !== 84532 || BigInt(parsed!.nonce) !== BigInt(nonce) ||
            !same(parsed!.to, plan.to) || !same(parsed!.data, plan.data) || BigInt(parsed!.value ?? 0n) !== 0n || BigInt(parsed!.gas) !== gas ||
            BigInt(parsed!.maxFeePerGas) !== ACTION_MAX_FEE || BigInt(parsed!.maxPriorityFeePerGas ?? 0n) !== ACTION_PRIORITY_FEE ||
            (parsed!.accessList?.length ?? 0) !== 0 || !same(recovered!, actor)) err('PROTOCOL_TX_INVALID');
        const transaction = keccak256(raw);
        const prepared: JournalRecord = { ...reserved, expected: actualExpected, status: 'prepared', transaction, to: plan.to,
          nonce: String(nonce), calldataHash: keccak256(plan.data), attempted: false };
        await durableStore.save(durableStore.read().records.map(row => row.operationId === operationId ? prepared : row));
        const attempted: JournalRecord = { ...prepared, status: 'unknown', attempted: true };
        await durableStore.save(durableStore.read().records.map(row => row.operationId === operationId ? attempted : row));
        await durableStore.assertCurrent();
        const beforeSend = await client.getBlock({ blockNumber: BigInt(fresh.anchor.number) });
        if (!same(beforeSend?.hash, fresh.anchor.hash)) err('PROTOCOL_REORG');
        try { await client.sendRawTransaction({ serializedTransaction: raw }); } catch { /* Reconcile this original locally derived hash only. */ }
        let result = attempted;
        for (let i = 0; i < 5; i++) {
          result = await reconcileOne(durableStore, result);
          if (result.status === 'success' || result.status === 'reverted') break;
          if (i < 4) await delay(200);
        }
        return publicRecord(result);
      });
    }

    async function reconcile(): Promise<readonly ActionResult[]> {
      ensureOpen();
      return serial(async () => (await reconcileInternal()).map(publicRecord));
    }
    async function close(): Promise<void> {
      if (closePromise) return closePromise;
      if (closed) return;
      closing = true;
      closePromise = (async () => { await tailRef.value; previews.clear(); await release(); closed = true; })();
      return closePromise;
    }
    return Object.freeze({ preview, confirm, reconcile, close });
  } catch (error) { throw Error(protocolErrorCode(error)); }
}
