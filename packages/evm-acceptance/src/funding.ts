import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  encodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { budgetSummary, PUBLIC_CHAIN_ID, validateConfig } from './plan.js';
import type { Actor, RunConfig } from './types.js';

export const PUBLIC_FUNDING_SCOPE = 'm5-fund-campaign-roles-once' as const;
export const FUNDING_GAS = 21_000n;
export const FUNDING_MAX_FEE_PER_GAS = 100_000_000n;
export const FUNDING_PRIORITY_FEE_PER_GAS = 1_000_000n;
export const FUNDING_AUXILIARY_RESERVE = 1_000_000_000_000n;
export const MAX_FUNDING_TRANSFERS = 3;
export const BASE_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f' as Address;

const TRANSFER_GAS_WEI = FUNDING_GAS * FUNDING_MAX_FEE_PER_GAS;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const GPO_ABI = [{
  type: 'function', name: 'getL1Fee', stateMutability: 'view',
  inputs: [{ name: '_data', type: 'bytes' }], outputs: [{ type: 'uint256' }],
}] as const;

export type FundableActor = 'relayer' | 'payer' | 'adjudicator';
const FUNDABLE_ACTORS: readonly FundableActor[] = ['relayer', 'payer', 'adjudicator'];

export interface FundingClient {
  getChainId(): Promise<number>;
  getBlock(args?: any): Promise<{ number: bigint | null; hash: Hex | null; baseFeePerGas?: bigint | null }>;
  getCode(args: any): Promise<Hex | undefined>;
  getBalance(args: any): Promise<bigint>;
  getTransactionCount(args: any): Promise<number>;
  getTransaction(args: any): Promise<any>;
  getTransactionReceipt(args: any): Promise<any>;
  readContract(args: any): Promise<unknown>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
}

export interface FundingWallet {
  signTransaction(args: any): Promise<Hex>;
}

export interface FundingTransferPlan {
  actor: FundableActor;
  from: Address;
  to: Address;
  nonce: string;
  valueWei: string;
  targetWei: string;
  beforeBalanceWei: string;
  gas: '21000';
  maxFeePerGas: '100000000';
  maxPriorityFeePerGas: '1000000';
  auxiliaryReserveWei: string;
}

export interface FundingRoleSnapshot {
  actor: FundableActor;
  address: Address;
  balanceWei: string;
  targetWei: string;
  shortfallWei: string;
  excessWei: string;
  nonce: string;
}

export interface FundingPlan {
  version: 1;
  mode: 'local' | 'public';
  chainId: 84532;
  runId: Hex;
  vault: Address;
  observationBlock: { number: string; hash: Hex };
  roles: Readonly<Record<FundableActor, FundingRoleSnapshot>>;
  vaultBalanceWei: string;
  vaultNonce: string;
  transfers: readonly FundingTransferPlan[];
  gasAllowanceWei: string;
  auxiliaryAllowanceWei: string;
  totalFeeAllowanceWei: string;
  transferValueWei: string;
  requiredVaultWei: string;
  vaultShortfallWei: string;
  ready: boolean;
  code: string;
}

export interface FundingRecord {
  actor: FundableActor;
  transaction: Hex;
  from: Address;
  to: Address;
  nonce: string;
  valueWei: string;
  targetWei: string;
  beforeBalanceWei: string;
  gas: '21000';
  maxFeePerGas: '100000000';
  maxPriorityFeePerGas: '1000000';
  auxiliaryFeeWei: string;
  actualGasUsed?: string;
  effectiveGasPriceWei?: string;
  actualAuxiliaryFeeWei?: string;
  feeSource?: 'vault_balance_delta';
  l1FeeWei?: string | 'unavailable';
  operatorFeeWei?: string | 'unavailable';
  data: '0x';
  attempted: true;
  blockNumber?: string;
  blockHash?: Hex;
  status?: 'success' | 'reverted';
}

export interface FundingReport {
  ok: boolean;
  code: string;
  state: 'planned' | 'complete' | 'pending' | 'blocked';
  mode: 'local' | 'public';
  plan: FundingPlan;
  transactions: readonly FundingRecord[];
}

export interface BuildFundingPlanOptions {
  config: RunConfig;
  client: FundingClient;
  vault: Address;
}

export interface FundCampaignOptions {
  config: RunConfig;
  client: FundingClient;
  wallet?: FundingWallet;
  account?: LocalAccount;
  plan: FundingPlan;
  journalPath: string;
  execute?: boolean;
  publicScope?: string;
  polls?: number;
  delay?: number;
  estimateAuxFee?: (rawSignedTransaction: Hex) => Promise<bigint>;
}

export interface ReconcileFundingOptions {
  config: RunConfig;
  client: FundingClient;
  journalPath: string;
  vault: Address;
}

interface FundingJournal {
  version: 1;
  context: { mode: 'local' | 'public'; chainId: 84532; runId: Hex; vault: Address; roles: RunConfig['roles'] };
  plan: FundingPlan;
  transactions: FundingRecord[];
}

const same = (left: string | null | undefined, right: string | null | undefined): boolean =>
  left === null || left === undefined ? right === null || right === undefined :
    right !== null && right !== undefined && left.toLowerCase() === right.toLowerCase();
const fixedError = (code: string): Error => new Error(`M5_FUNDING_${code}`);
const uint = (value: unknown): value is string => typeof value === 'string' && value.length <= 78 && UINT_RE.test(value);
const address = (value: unknown): value is Address => typeof value === 'string' && ADDRESS_RE.test(value) && value !== ZERO;
const hash = (value: unknown): value is Hex => typeof value === 'string' && HASH_RE.test(value);
const isEmptyCode = (value: Hex | undefined): boolean => value === undefined || value === '0x';
const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function exactObject(value: unknown, keys: readonly string[], code = 'JOURNAL_INVALID'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fixedError(code);
  const obj = value as Record<string, unknown>;
  const own = Reflect.ownKeys(obj);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(obj, key))) throw fixedError(code);
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw fixedError(code);
  }
  return obj;
}

function freezePlan(plan: FundingPlan): FundingPlan {
  for (const actor of FUNDABLE_ACTORS) Object.freeze(plan.roles[actor]);
  Object.freeze(plan.roles);
  for (const transfer of plan.transfers) Object.freeze(transfer);
  Object.freeze(plan.transfers);
  Object.freeze(plan.observationBlock);
  return Object.freeze(plan);
}

function fundingFees(transfers: number): { gas: bigint; auxiliary: bigint; total: bigint } {
  const count = BigInt(transfers);
  const gas = count * TRANSFER_GAS_WEI;
  const auxiliary = count * FUNDING_AUXILIARY_RESERVE;
  return { gas, auxiliary, total: gas + auxiliary };
}

async function anchoredBlock(client: FundingClient) {
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number === null || block.hash === null) throw fixedError('BLOCK_UNAVAILABLE');
  return { number: block.number, hash: block.hash };
}

async function assertAnchor(client: FundingClient, block: { number: bigint; hash: Hex }): Promise<void> {
  const current = await client.getBlock({ blockNumber: block.number });
  if (!current.hash || !same(current.hash, block.hash)) throw fixedError('BLOCK_CHANGED');
}

function validatePlanContext(input: FundingPlan, config: RunConfig, vault: Address): FundingPlan {
  exactObject(input, ['version', 'mode', 'chainId', 'runId', 'vault', 'observationBlock', 'roles', 'vaultBalanceWei',
    'vaultNonce', 'transfers', 'gasAllowanceWei', 'auxiliaryAllowanceWei', 'totalFeeAllowanceWei', 'transferValueWei',
    'requiredVaultWei', 'vaultShortfallWei', 'ready', 'code'], 'PLAN_INVALID');
  exactObject(input.observationBlock, ['number', 'hash'], 'PLAN_INVALID');
  exactObject(input.roles, FUNDABLE_ACTORS, 'PLAN_INVALID');
  if (!input || input.version !== 1 || input.mode !== config.mode || input.chainId !== PUBLIC_CHAIN_ID ||
      !same(input.runId, config.runId) || !same(input.vault, vault) ||
      !uint(input.observationBlock?.number) ||
      !hash(input.observationBlock?.hash)) throw fixedError('PLAN_CONTEXT');
  const budgets = budgetSummary(config);
  if (!uint(input.vaultBalanceWei) || !uint(input.vaultNonce)) throw fixedError('PLAN_INVALID');
  let excessFound = false;
  for (const actor of FUNDABLE_ACTORS) {
    const row = input.roles[actor];
    exactObject(row, ['actor', 'address', 'balanceWei', 'targetWei', 'shortfallWei', 'excessWei', 'nonce'], 'PLAN_INVALID');
    if (!row || row.actor !== actor || !same(row.address, config.roles[actor]) ||
        !uint(row.balanceWei) || !uint(row.targetWei) || !uint(row.shortfallWei) || !uint(row.excessWei) ||
        BigInt(row.targetWei) !== BigInt(budgets.roles[actor].targetWei) ||
        BigInt(row.shortfallWei) !== (BigInt(row.balanceWei) < BigInt(row.targetWei) ? BigInt(row.targetWei) - BigInt(row.balanceWei) : 0n) ||
        BigInt(row.excessWei) !== (BigInt(row.balanceWei) > BigInt(row.targetWei) ? BigInt(row.balanceWei) - BigInt(row.targetWei) : 0n) ||
        !uint(row.nonce)) throw fixedError('PLAN_INVALID');
    if (BigInt(row.excessWei) > 0n) excessFound = true;
  }
  if (!Array.isArray(input.transfers) || input.transfers.length > MAX_FUNDING_TRANSFERS) throw fixedError('PLAN_INVALID');
  const expected = FUNDABLE_ACTORS.filter((actor) => BigInt(input.roles[actor].shortfallWei) > 0n);
  if (input.transfers.length !== expected.length) throw fixedError('PLAN_INVALID');
  input.transfers.forEach((tx, index) => {
    exactObject(tx, ['actor', 'from', 'to', 'nonce', 'valueWei', 'targetWei', 'beforeBalanceWei', 'gas',
      'maxFeePerGas', 'maxPriorityFeePerGas', 'auxiliaryReserveWei'], 'PLAN_INVALID');
    const actor = expected[index]!;
    if (tx.actor !== actor || !same(tx.from, vault) || !same(tx.to, config.roles[actor]) ||
        !uint(tx.nonce) || BigInt(tx.nonce) !== BigInt(input.vaultNonce) + BigInt(index) ||
        tx.valueWei !== input.roles[actor].shortfallWei || tx.targetWei !== input.roles[actor].targetWei ||
        tx.beforeBalanceWei !== input.roles[actor].balanceWei || tx.gas !== '21000' ||
        tx.maxFeePerGas !== '100000000' || tx.maxPriorityFeePerGas !== '1000000' ||
        tx.auxiliaryReserveWei !== FUNDING_AUXILIARY_RESERVE.toString()) throw fixedError('PLAN_INVALID');
  });
  const transferValue = expected.reduce((sum, actor) => sum + BigInt(input.roles[actor].shortfallWei), 0n);
  const fees = fundingFees(expected.length);
  const required = transferValue + fees.total;
  const shortfall = required > BigInt(input.vaultBalanceWei) ? required - BigInt(input.vaultBalanceWei) : 0n;
  const ready = !excessFound && shortfall === 0n;
  const code = excessFound ? 'role_balance_excess' : shortfall > 0n ? 'vault_funding_insufficient' : 'ready';
  if (input.gasAllowanceWei !== fees.gas.toString() || input.auxiliaryAllowanceWei !== fees.auxiliary.toString() ||
      input.totalFeeAllowanceWei !== fees.total.toString() || input.transferValueWei !== transferValue.toString() ||
      input.requiredVaultWei !== required.toString() || input.vaultShortfallWei !== shortfall.toString() ||
      input.ready !== ready || input.code !== code) throw fixedError('PLAN_INVALID');
  return input;
}

/** Validate a detached public plan using the same rules as the bounded sender. */
export function validateFundingPlan(input: unknown, configInput: RunConfig, vault: Address): FundingPlan {
  const config=validateConfig(configInput);
  return freezePlan(validatePlanContext(structuredClone(input) as FundingPlan,config,vault));
}

/** Builds an exact, read-only plan for funding only the three gas-spending EOAs. */
export async function buildFundingPlan(options: BuildFundingPlanOptions): Promise<FundingPlan> {
  let config: RunConfig;
  try { config = validateConfig(options.config); } catch { throw fixedError('CONFIG_INVALID'); }
  const vault = typeof options.vault === 'string' && /^0x[0-9a-fA-F]{40}$/.test(options.vault) && options.vault.toLowerCase() !== ZERO
    ? options.vault.toLowerCase() as Address : undefined;
  if (!vault || Object.values(config.roles).some((role) => same(role, vault)) || same(config.token, vault)) {
    throw fixedError('VAULT_INVALID');
  }
  try {
    if (await options.client.getChainId() !== PUBLIC_CHAIN_ID) throw fixedError('CHAIN');
    const block = await anchoredBlock(options.client);
    const participants: Address[] = [vault, ...FUNDABLE_ACTORS.map((actor) => config.roles[actor])];
    const [codes, balances, latestNonces, pendingNonces] = await Promise.all([
      Promise.all(participants.map((participant) => options.client.getCode({ address: participant, blockNumber: block.number }))),
      Promise.all(participants.map((participant) => options.client.getBalance({ address: participant, blockNumber: block.number }))),
      Promise.all(participants.map((participant) => options.client.getTransactionCount({ address: participant, blockTag: 'latest' }))),
      Promise.all(participants.map((participant) => options.client.getTransactionCount({ address: participant, blockTag: 'pending' }))),
    ]);
    await assertAnchor(options.client, block);
    if (codes.some((code) => !isEmptyCode(code))) throw fixedError('ACCOUNT_CODE');
    if (latestNonces.some((nonce, index) => nonce !== pendingNonces[index])) throw fixedError('PENDING_NONCE');

    const budget = budgetSummary(config);
    const vaultBalance = balances[0]!;
    const vaultNonce = latestNonces[0]!;
    const roleRows = {} as Record<FundableActor, FundingRoleSnapshot>;
    FUNDABLE_ACTORS.forEach((actor, index) => {
      const balance = balances[index + 1]!;
      const target = BigInt(budget.roles[actor].targetWei);
      roleRows[actor] = Object.freeze({
        actor,
        address: config.roles[actor],
        balanceWei: balance.toString(),
        targetWei: target.toString(),
        shortfallWei: balance < target ? (target - balance).toString() : '0',
        excessWei: balance > target ? (balance - target).toString() : '0',
        nonce: latestNonces[index + 1]!.toString(),
      });
    });
    const actorsWithExcess = FUNDABLE_ACTORS.filter((actor) => BigInt(roleRows[actor].excessWei) > 0n);
    const shortActors = FUNDABLE_ACTORS.filter((actor) => BigInt(roleRows[actor].shortfallWei) > 0n);
    const allowance = fundingFees(shortActors.length);
    const transferValue = shortActors.reduce((sum, actor) => sum + BigInt(roleRows[actor].shortfallWei), 0n);
    const requiredVault = transferValue + allowance.total;
    const vaultShortfall = requiredVault > vaultBalance ? requiredVault - vaultBalance : 0n;
    const transfers: FundingTransferPlan[] = shortActors.map((actor, index) => ({
      actor,
      from: vault,
      to: config.roles[actor],
      nonce: (BigInt(vaultNonce) + BigInt(index)).toString(),
      valueWei: roleRows[actor].shortfallWei,
      targetWei: roleRows[actor].targetWei,
      beforeBalanceWei: roleRows[actor].balanceWei,
      gas: '21000',
      maxFeePerGas: '100000000',
      maxPriorityFeePerGas: '1000000',
      auxiliaryReserveWei: FUNDING_AUXILIARY_RESERVE.toString(),
    }));
    const ready = actorsWithExcess.length === 0 && vaultShortfall === 0n;
    const plan: FundingPlan = {
      version: 1,
      mode: config.mode,
      chainId: PUBLIC_CHAIN_ID,
      runId: config.runId,
      vault,
      observationBlock: { number: block.number.toString(), hash: block.hash.toLowerCase() as Hex },
      roles: roleRows,
      vaultBalanceWei: vaultBalance.toString(),
      vaultNonce: vaultNonce.toString(),
      transfers,
      gasAllowanceWei: allowance.gas.toString(),
      auxiliaryAllowanceWei: allowance.auxiliary.toString(),
      totalFeeAllowanceWei: allowance.total.toString(),
      transferValueWei: transferValue.toString(),
      requiredVaultWei: requiredVault.toString(),
      vaultShortfallWei: vaultShortfall.toString(),
      ready,
      code: actorsWithExcess.length ? 'role_balance_excess' : vaultShortfall ? 'vault_funding_insufficient' : 'ready',
    };
    return freezePlan(plan);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('M5_FUNDING_')) throw error;
    throw fixedError('RPC_UNAVAILABLE');
  }
}

function sameContext(plan: FundingPlan, config: RunConfig): boolean {
  return plan.mode === config.mode && plan.chainId === config.chainId && same(plan.runId, config.runId) &&
    same(plan.roles.relayer.address, config.roles.relayer) && same(plan.roles.payer.address, config.roles.payer) &&
    same(plan.roles.adjudicator.address, config.roles.adjudicator);
}

function recordKeys(row: Record<string, unknown>): void {
  const base = ['actor', 'transaction', 'from', 'to', 'nonce', 'valueWei', 'targetWei', 'beforeBalanceWei',
    'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'auxiliaryFeeWei', 'data', 'attempted'];
  const feeKeys = ['actualGasUsed', 'effectiveGasPriceWei', 'actualAuxiliaryFeeWei', 'feeSource', 'l1FeeWei', 'operatorFeeWei'].filter((key) => Object.hasOwn(row, key));
  const optional = ['blockNumber', 'blockHash', 'status'].filter((key) => Object.hasOwn(row, key));
  exactObject(row, [...base, ...feeKeys, ...optional]);
  if (feeKeys.length !== 0 && (feeKeys.length !== 6 || row.feeSource !== 'vault_balance_delta')) throw fixedError('JOURNAL_INVALID');
  if (Object.hasOwn(row, 'blockNumber') !== Object.hasOwn(row, 'blockHash') ||
      Object.hasOwn(row, 'blockNumber') !== Object.hasOwn(row, 'status')) throw fixedError('JOURNAL_INVALID');
  if (Object.hasOwn(row, 'blockNumber') !== (feeKeys.length === 6)) throw fixedError('JOURNAL_INVALID');
}

function validateRecord(input: unknown, transfer: FundingTransferPlan): FundingRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fixedError('JOURNAL_INVALID');
  const row = input as Record<string, unknown>;
  recordKeys(row);
  if (!FUNDABLE_ACTORS.includes(row.actor as FundableActor) || row.actor !== transfer.actor || !hash(row.transaction) ||
      !address(row.from) || !address(row.to) || !uint(row.nonce) || !uint(row.valueWei) || !uint(row.targetWei) ||
      !uint(row.beforeBalanceWei) || row.gas !== '21000' || row.maxFeePerGas !== '100000000' ||
      row.maxPriorityFeePerGas !== '1000000' || !uint(row.auxiliaryFeeWei) || row.data !== '0x' || row.attempted !== true ||
      !same(row.from, transfer.from) || !same(row.to, transfer.to) || row.nonce !== transfer.nonce ||
      row.valueWei !== transfer.valueWei || row.targetWei !== transfer.targetWei || row.beforeBalanceWei !== transfer.beforeBalanceWei || row.gas !== transfer.gas ||
      row.maxFeePerGas !== transfer.maxFeePerGas || row.maxPriorityFeePerGas !== transfer.maxPriorityFeePerGas ||
      BigInt(row.auxiliaryFeeWei) > FUNDING_AUXILIARY_RESERVE) throw fixedError('JOURNAL_INVALID');
  if (row.blockNumber !== undefined && (!uint(row.blockNumber) || !hash(row.blockHash) ||
      row.status !== 'success' && row.status !== 'reverted')) throw fixedError('JOURNAL_INVALID');
  if (row.actualGasUsed !== undefined && (!uint(row.actualGasUsed) || BigInt(row.actualGasUsed) > FUNDING_GAS ||
      !uint(row.effectiveGasPriceWei) || BigInt(row.effectiveGasPriceWei) > FUNDING_MAX_FEE_PER_GAS ||
      row.actualAuxiliaryFeeWei !== undefined && (!uint(row.actualAuxiliaryFeeWei) || BigInt(row.actualAuxiliaryFeeWei) > FUNDING_AUXILIARY_RESERVE) ||
      row.l1FeeWei !== undefined && row.l1FeeWei !== 'unavailable' && !uint(row.l1FeeWei) ||
      row.operatorFeeWei !== undefined && row.operatorFeeWei !== 'unavailable' && !uint(row.operatorFeeWei))) throw fixedError('JOURNAL_INVALID');
  return structuredClone(row) as unknown as FundingRecord;
}

function validateJournal(input: unknown, config: RunConfig, plan: FundingPlan): FundingJournal {
  const row = exactObject(input, ['version', 'context', 'plan', 'transactions']);
  if (row.version !== 1 || !Array.isArray(row.transactions)) throw fixedError('JOURNAL_INVALID');
  const context = exactObject(row.context, ['mode', 'chainId', 'runId', 'vault', 'roles']);
  if (context.mode !== config.mode || context.chainId !== PUBLIC_CHAIN_ID || !same(context.runId as string, config.runId) ||
      !same(context.vault as string, plan.vault) || JSON.stringify(context.roles) !== JSON.stringify(config.roles)) {
    throw fixedError('JOURNAL_CONTEXT');
  }
  const storedPlan = row.plan as FundingPlan;
  validatePlanContext(storedPlan, config, plan.vault);
  if (!sameContext(storedPlan, config) || storedPlan.transfers.length > MAX_FUNDING_TRANSFERS ||
      row.transactions.length > storedPlan.transfers.length) throw fixedError('JOURNAL_INVALID');
  const records = row.transactions.map((record, index) => validateRecord(record, storedPlan.transfers[index]!));
  if (new Set(records.map((record) => record.transaction)).size !== records.length) throw fixedError('JOURNAL_INVALID');
  for (let index = 0; index < records.length - 1; index++) {
    if (!records[index]!.status) throw fixedError('JOURNAL_INVALID');
  }
  return { version: 1, context: context as FundingJournal['context'], plan: storedPlan, transactions: records };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeInitial(path: string, journal: FundingJournal): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await syncDirectory(dirname(path));
  } catch {
    await handle?.close().catch(() => undefined);
    throw fixedError('JOURNAL_EXISTS_OR_UNAVAILABLE');
  }
}

async function saveJournal(path: string, journal: FundingJournal): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw fixedError('JOURNAL_UNAVAILABLE');
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof Error && error.message.startsWith('M5_FUNDING_')) throw error;
    throw fixedError('JOURNAL_WRITE_FAILED');
  }
}

async function readJournal(path: string, config: RunConfig, plan: FundingPlan): Promise<FundingJournal | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw fixedError('JOURNAL_UNAVAILABLE');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let content: string;
    try { content = await handle.readFile('utf8'); } finally { await handle.close(); }
    return validateJournal(JSON.parse(content), config, plan);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') return undefined;
    if (error instanceof Error && error.message.startsWith('M5_FUNDING_')) throw error;
    throw fixedError('JOURNAL_UNAVAILABLE');
  }
}

/** Reads and reconciles only identities already recorded; this path has no signer or send call. */
export async function reconcileFunding(options: ReconcileFundingOptions): Promise<FundingReport> {
  let config: RunConfig;
  try { config = validateConfig(options.config); } catch { throw fixedError('CONFIG_INVALID'); }
  if (!options.journalPath || options.journalPath.length > 4096 || typeof options.vault !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(options.vault) || options.vault.toLowerCase() === ZERO) throw fixedError('JOURNAL_PATH');
  let stored: unknown;
  try {
    const stat = await lstat(options.journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw fixedError('JOURNAL_UNAVAILABLE');
    const handle = await open(options.journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { stored = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('M5_FUNDING_')) throw error;
    throw fixedError('JOURNAL_UNAVAILABLE');
  }
  const root = exactObject(stored, ['version', 'context', 'plan', 'transactions']);
  const plan = validatePlanContext(structuredClone(root.plan) as FundingPlan, config, options.vault.toLowerCase() as Address);
  const journal = await readJournal(options.journalPath, config, plan);
  if (!journal) throw fixedError('JOURNAL_UNAVAILABLE');
  if (await options.client.getChainId() !== PUBLIC_CHAIN_ID) throw fixedError('CHAIN');
  let current = journal;
  for (const record of [...journal.transactions]) {
    let known: Awaited<ReturnType<typeof verifyKnown>>;
    try { known = await verifyKnown(options.client, record); }
    catch { return report(plan, current, 'pending', 'known_hash_reconciliation_unavailable'); }
    if (!known) return report(plan, current, 'pending', 'known_hash_unresolved');
    if (record.status) {
      if (record.blockNumber !== BigInt(known.receipt.blockNumber).toString() || !same(record.blockHash, known.receipt.blockHash) ||
          record.status !== known.receipt.status) throw fixedError('JOURNAL_RECEIPT_CONFLICT');
      await assertMeasuredRecord(options.client, current, current.transactions.indexOf(record), record, known.receipt);
    } else {
      current = await confirmJournal(options.client, options.journalPath, current, record, known.receipt);
    }
    if (known.receipt.status !== 'success') return report(plan, current, 'blocked', 'known_transaction_reverted');
  }
  const complete = current.transactions.length === plan.transfers.length && current.transactions.every((row) => row.status === 'success');
  if (complete && current.transactions.length) {
    const head = await anchoredBlock(options.client);
    const [vaultBalance, ...roleBalances] = await Promise.all([
      options.client.getBalance({ address: plan.vault, blockNumber: head.number }),
      ...FUNDABLE_ACTORS.map((actor) => options.client.getBalance({ address: config.roles[actor], blockNumber: head.number })),
    ]);
    await assertAnchor(options.client, head);
    const values = current.transactions.reduce((sum, row) => sum + BigInt(row.valueWei), 0n);
    const fees = current.transactions.reduce((sum, row) => sum + BigInt(row.actualGasUsed!) *
      BigInt(row.effectiveGasPriceWei!) + BigInt(row.actualAuxiliaryFeeWei!), 0n);
    if (vaultBalance !== BigInt(plan.vaultBalanceWei) - values - fees ||
        roleBalances.some((balance, index) => balance !== BigInt(plan.roles[FUNDABLE_ACTORS[index]!].targetWei))) {
      throw fixedError('FINAL_BALANCE_MISMATCH');
    }
  }
  return report(plan, current, complete ? 'complete' : 'pending', complete ? 'funding_complete' : 'known_records_only');
}

async function appendJournal(path: string, journal: FundingJournal, record: FundingRecord): Promise<FundingJournal> {
  const index = journal.transactions.length;
  if (index >= journal.plan.transfers.length || record.actor !== journal.plan.transfers[index]!.actor) throw fixedError('JOURNAL_ORDER');
  const next = { ...journal, transactions: [...journal.transactions, record] };
  await saveJournal(path, next);
  return next;
}

async function measuredFeeFields(client: FundingClient, journal: FundingJournal, index: number, record: FundingRecord, receipt: any) {
  const blockNumber = BigInt(receipt.blockNumber);
  if (blockNumber === 0n) throw fixedError('FEE_BALANCE_ANCHOR');
  const prior = journal.transactions.slice(0, index);
  if (prior.some((row) => row.status !== 'success' || row.actualGasUsed === undefined ||
      row.effectiveGasPriceWei === undefined || row.actualAuxiliaryFeeWei === undefined)) throw fixedError('PRIOR_FEE_UNAVAILABLE');
  const priorValues = prior.reduce((sum, row) => sum + BigInt(row.valueWei), 0n);
  const priorFees = prior.reduce((sum, row) => sum + BigInt(row.actualGasUsed!) * BigInt(row.effectiveGasPriceWei!) + BigInt(row.actualAuxiliaryFeeWei!), 0n);
  const expectedBefore = BigInt(journal.plan.vaultBalanceWei) - priorValues - priorFees;
  const [before, after, anchor] = await Promise.all([
    client.getBalance({ address: record.from, blockNumber: blockNumber - 1n }),
    client.getBalance({ address: record.from, blockNumber }),
    client.getBlock({ blockNumber }),
  ]);
  if (before !== expectedBefore || !anchor.hash || !same(anchor.hash, receipt.blockHash)) throw fixedError('VAULT_BALANCE_RECONCILIATION');
  const gasUsed = BigInt(receipt.gasUsed);
  const effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? receipt.gasPrice);
  const totalFee = before - after - (receipt.status === 'success' ? BigInt(record.valueWei) : 0n);
  const executionFee = gasUsed * effectiveGasPrice;
  if (totalFee < executionFee) throw fixedError('FEE_BALANCE_RECONCILIATION');
  const auxiliary = totalFee - executionFee;
  if (auxiliary > FUNDING_AUXILIARY_RESERVE) throw fixedError('AUXILIARY_FEE_LIMIT');
  const l1Fee = receipt.l1Fee == null ? 'unavailable' : BigInt(receipt.l1Fee).toString();
  const operatorFee = receipt.operatorFee == null ? 'unavailable' : BigInt(receipt.operatorFee).toString();
  const knownAuxiliary = (l1Fee === 'unavailable' ? 0n : BigInt(l1Fee)) +
    (operatorFee === 'unavailable' ? 0n : BigInt(operatorFee));
  if (auxiliary < knownAuxiliary) throw fixedError('FEE_COMPONENT_MISMATCH');
  return { actualGasUsed: gasUsed.toString(), effectiveGasPriceWei: effectiveGasPrice.toString(),
    actualAuxiliaryFeeWei: auxiliary.toString(), feeSource: 'vault_balance_delta' as const, l1FeeWei: l1Fee, operatorFeeWei: operatorFee };
}

async function confirmJournal(client: FundingClient, path: string, journal: FundingJournal, record: FundingRecord, receipt: any): Promise<FundingJournal> {
  const index = journal.transactions.findIndex((item) => item.transaction === record.transaction);
  if (index < 0) throw fixedError('JOURNAL_RECORD_MISSING');
  const measuredFees = await measuredFeeFields(client, journal, index, record, receipt);
  const confirmed = validateRecord({
    ...record,
    blockNumber: BigInt(receipt.blockNumber).toString(),
    blockHash: String(receipt.blockHash).toLowerCase(),
    status: receipt.status === 'success' ? 'success' : 'reverted',
    ...measuredFees,
  }, journal.plan.transfers[index]!);
  const transactions = [...journal.transactions];
  transactions[index] = confirmed;
  const next = { ...journal, transactions };
  await saveJournal(path, next);
  return next;
}

async function assertMeasuredRecord(client: FundingClient, journal: FundingJournal, index: number, record: FundingRecord, receipt: any): Promise<void> {
  const measured = await measuredFeeFields(client, journal, index, record, receipt);
  for (const key of ['actualGasUsed', 'effectiveGasPriceWei', 'actualAuxiliaryFeeWei', 'feeSource', 'l1FeeWei', 'operatorFeeWei'] as const) {
    if (record[key] !== measured[key]) throw fixedError('JOURNAL_FEE_CONFLICT');
  }
}

function report(plan: FundingPlan, journal?: FundingJournal, state: FundingReport['state'] = 'planned', code = plan.code): FundingReport {
  return Object.freeze({
    ok: state === 'complete' || state === 'planned' && plan.ready,
    code,
    state,
    mode: plan.mode,
    plan,
    transactions: Object.freeze(journal?.transactions.map((record) => Object.freeze({ ...record })) ?? []),
  });
}

function assertSignedFields(raw: Hex, transfer: FundingTransferPlan, vault: Address): void {
  const transaction = parseTransaction(raw);
  if (transaction.type !== 'eip1559' || transaction.chainId !== PUBLIC_CHAIN_ID ||
      transaction.to === null || !same(transaction.to, transfer.to) || transaction.nonce !== Number(transfer.nonce) ||
      transaction.value !== BigInt(transfer.valueWei) || transaction.gas !== FUNDING_GAS ||
      transaction.maxFeePerGas !== FUNDING_MAX_FEE_PER_GAS ||
      transaction.maxPriorityFeePerGas !== FUNDING_PRIORITY_FEE_PER_GAS || (transaction.data ?? '0x') !== '0x' ||
      (transaction.accessList?.length ?? 0) !== 0) throw fixedError('SIGNED_FIELDS');
  void vault;
}

async function verifyKnown(client: FundingClient, record: FundingRecord): Promise<{ receipt: any; actualAuxiliaryFee: bigint } | undefined> {
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: record.transaction }),
    client.getTransactionReceipt({ hash: record.transaction }),
  ]);
  if (!receipt) return undefined;
  const txInput = transaction?.input ?? transaction?.data;
  if (!transaction) throw fixedError('TRANSACTION_MISSING');
  if (!same(transaction.hash, record.transaction)) throw fixedError('TRANSACTION_HASH');
  if (!same(transaction.from, record.from) || !same(transaction.to, record.to)) throw fixedError('TRANSACTION_ACTOR');
  if (transaction.chainId !== null && transaction.chainId !== PUBLIC_CHAIN_ID) throw fixedError('TRANSACTION_CHAIN');
  if (transaction.nonce == null || transaction.value == null) throw fixedError('TRANSACTION_VALUE_NONCE_MISSING');
  if (BigInt(transaction.nonce) !== BigInt(record.nonce) || BigInt(transaction.value) !== BigInt(record.valueWei)) throw fixedError('TRANSACTION_VALUE_NONCE');
  if (transaction.gas == null) throw fixedError('TRANSACTION_GAS_MISSING');
  if (BigInt(transaction.gas) !== FUNDING_GAS) throw fixedError('TRANSACTION_GAS');
  if (transaction.maxFeePerGas === null || transaction.maxFeePerGas === undefined) throw fixedError('TRANSACTION_MAX_FEE_MISSING');
  if (transaction.maxPriorityFeePerGas === null || transaction.maxPriorityFeePerGas === undefined) throw fixedError('TRANSACTION_PRIORITY_FEE_MISSING');
  if (BigInt(transaction.maxFeePerGas) !== FUNDING_MAX_FEE_PER_GAS ||
      BigInt(transaction.maxPriorityFeePerGas) !== FUNDING_PRIORITY_FEE_PER_GAS || txInput !== '0x') throw fixedError('TRANSACTION_FIELDS');
  if (!same(receipt.transactionHash, record.transaction) || !same(receipt.from, record.from) ||
      !same(receipt.to, record.to) || !receipt.blockHash || receipt.blockNumber === null ||
      (receipt.status !== 'success' && receipt.status !== 'reverted')) throw fixedError('RECEIPT_IDENTITY');
  if (transaction.blockHash && !same(transaction.blockHash, receipt.blockHash) ||
      transaction.blockNumber != null && BigInt(transaction.blockNumber) !== BigInt(receipt.blockNumber)) throw fixedError('RECEIPT_IDENTITY');
  if (receipt.gasUsed == null || BigInt(receipt.gasUsed) > FUNDING_GAS ||
      (receipt.effectiveGasPrice ?? receipt.gasPrice) == null ||
      BigInt(receipt.effectiveGasPrice ?? receipt.gasPrice) > FUNDING_MAX_FEE_PER_GAS) throw fixedError('RECEIPT_FEE_CAP');
  const block = await client.getBlock({ blockNumber: BigInt(receipt.blockNumber) });
  if (!block.hash || !same(block.hash, receipt.blockHash)) throw fixedError('BLOCK_CHANGED');
  const actualAuxiliaryFee = receipt.l1Fee == null || receipt.operatorFee == null ? 0n : BigInt(receipt.l1Fee) + BigInt(receipt.operatorFee);
  if (actualAuxiliaryFee > FUNDING_AUXILIARY_RESERVE) throw fixedError('AUXILIARY_FEE_LIMIT');
  return { receipt, actualAuxiliaryFee };
}

function contextFor(config: RunConfig, plan: FundingPlan): FundingJournal['context'] {
  return { mode: config.mode, chainId: PUBLIC_CHAIN_ID, runId: config.runId, vault: plan.vault, roles: config.roles };
}

/** Funds only exact shortfalls. Public execution is scope-gated; tests execute the same path on local Anvil. */
export async function fundCampaign(options: FundCampaignOptions): Promise<FundingReport> {
  let config: RunConfig;
  try { config = validateConfig(options.config); } catch { throw fixedError('CONFIG_INVALID'); }
  const plan = validatePlanContext(structuredClone(options.plan), config, options.plan.vault);
  if (!sameContext(plan, config)) throw fixedError('PLAN_CONTEXT');
  if (!options.journalPath || options.journalPath.length > 4096) throw fixedError('JOURNAL_PATH');
  if (!Number.isSafeInteger(options.polls ?? 5) || (options.polls ?? 5) < 1 || (options.polls ?? 5) > 20 ||
      !Number.isSafeInteger(options.delay ?? 100) || (options.delay ?? 100) < 0 || (options.delay ?? 100) > 5_000) {
    throw fixedError('POLL_BOUNDS');
  }
  if (options.estimateAuxFee && config.mode !== 'local') throw fixedError('PUBLIC_ESTIMATOR_OVERRIDE');
  if (config.mode === 'public' && options.execute && options.publicScope !== PUBLIC_FUNDING_SCOPE) {
    return report(plan, undefined, 'blocked', 'public_scope_required');
  }
  if (!options.execute || !plan.ready) return report(plan, undefined, 'planned', options.execute ? plan.code : 'check_only');
  if (!options.account && !options.wallet) throw fixedError('SIGNER_REQUIRED');
  const signerAddress = (options.account?.address ?? (options as { account?: { address: Address } }).account?.address)?.toLowerCase();
  if (!signerAddress || !same(signerAddress, plan.vault)) throw fixedError('SIGNER_MISMATCH');
  if (await options.client.getChainId() !== PUBLIC_CHAIN_ID) throw fixedError('CHAIN');

  const context = contextFor(config, plan);
  let journal = await readJournal(options.journalPath, config, plan);
  if (journal && JSON.stringify(journal.context) !== JSON.stringify(context)) throw fixedError('JOURNAL_CONTEXT');
  if (!journal) {
    if (plan.transfers.length === 0) return report(plan, undefined, 'complete', 'no_shortfalls');
    journal = { version: 1, context, plan, transactions: [] };
    await writeInitial(options.journalPath, journal);
  }
  const executionPlan = journal.plan;
  const polls = options.polls ?? 5;
  const delay = options.delay ?? 100;

  for (let index = 0; index < executionPlan.transfers.length; index++) {
    const transfer = executionPlan.transfers[index]!;
    let record = journal.transactions[index];
    if (record) {
      let known: Awaited<ReturnType<typeof verifyKnown>>;
      try { known = await verifyKnown(options.client, record); } catch {
        return report(executionPlan, journal, 'pending', 'known_hash_reconciliation_unavailable');
      }
      if (!known) return report(executionPlan, journal, 'pending', 'known_hash_unresolved');
      if (record.blockNumber && (record.blockNumber !== BigInt(known.receipt.blockNumber).toString() ||
          !same(record.blockHash, known.receipt.blockHash) || record.status !== known.receipt.status)) {
        throw fixedError('JOURNAL_RECEIPT_CONFLICT');
      }
      if (record.status) await assertMeasuredRecord(options.client, journal, index, record, known.receipt);
      if (!record.blockNumber) {
        journal = await confirmJournal(options.client, options.journalPath, journal, record, known.receipt);
        record = journal.transactions[index]!;
      }
      if (known.receipt.status !== 'success') return report(executionPlan, journal, 'blocked', 'known_transaction_reverted');
      continue;
    }

    if (index > 0 && journal.transactions[index - 1]?.status !== 'success') throw fixedError('PREVIOUS_TRANSFER_UNRESOLVED');
    const currentBlock = await anchoredBlock(options.client);
    const [vaultBalance, recipientBalance, vaultCode, recipientCode, latestNonce, pendingNonce,
      recipientLatestNonce, recipientPendingNonce] = await Promise.all([
      options.client.getBalance({ address: transfer.from, blockNumber: currentBlock.number }),
      options.client.getBalance({ address: transfer.to, blockNumber: currentBlock.number }),
      options.client.getCode({ address: transfer.from, blockNumber: currentBlock.number }),
      options.client.getCode({ address: transfer.to, blockNumber: currentBlock.number }),
      options.client.getTransactionCount({ address: transfer.from, blockTag: 'latest' }),
      options.client.getTransactionCount({ address: transfer.from, blockTag: 'pending' }),
      options.client.getTransactionCount({ address: transfer.to, blockTag: 'latest' }),
      options.client.getTransactionCount({ address: transfer.to, blockTag: 'pending' }),
    ]);
    await assertAnchor(options.client, currentBlock);
    if (!isEmptyCode(vaultCode) || !isEmptyCode(recipientCode)) throw fixedError('ACCOUNT_CODE');
    if (latestNonce !== pendingNonce || BigInt(latestNonce) !== BigInt(transfer.nonce) ||
        recipientLatestNonce !== recipientPendingNonce || BigInt(recipientLatestNonce) !== BigInt(executionPlan.roles[transfer.actor].nonce)) {
      throw fixedError('NONCE_CHANGED');
    }
    const expectedRecipient = BigInt(transfer.beforeBalanceWei);
    if (recipientBalance !== expectedRecipient) throw fixedError('RECIPIENT_BALANCE_CHANGED');
    if (journal.transactions.some((item) => item.status === 'success' &&
        (item.actualGasUsed === undefined || item.actualAuxiliaryFeeWei === undefined))) {
      return report(executionPlan, journal, 'blocked', 'actual_fee_fields_unavailable');
    }
    const priorFees = journal.transactions.reduce((sum, item) => sum + (item.status === 'success'
      ? BigInt(item.actualGasUsed!) * BigInt(item.effectiveGasPriceWei!) + BigInt(item.actualAuxiliaryFeeWei!) : 0n), 0n);
    const priorValues = journal.transactions.reduce((sum, item) => sum + BigInt(item.valueWei), 0n);
    const expectedVault = BigInt(executionPlan.vaultBalanceWei) - priorValues - priorFees;
    if (vaultBalance !== expectedVault) throw fixedError('VAULT_BALANCE_CHANGED');
    if (vaultBalance < BigInt(transfer.valueWei) + TRANSFER_GAS_WEI + FUNDING_AUXILIARY_RESERVE) {
      throw fixedError('VAULT_FEE_BALANCE');
    }
    if (currentBlock.number !== null) {
      const base = (await options.client.getBlock({ blockNumber: currentBlock.number })).baseFeePerGas;
      if (base === null || base === undefined || base + FUNDING_PRIORITY_FEE_PER_GAS > FUNDING_MAX_FEE_PER_GAS) {
        throw fixedError('FEE_CAP');
      }
    }

    const fields = {
      chainId: PUBLIC_CHAIN_ID,
      nonce: Number(transfer.nonce),
      to: transfer.to,
      value: BigInt(transfer.valueWei),
      data: '0x' as const,
      gas: FUNDING_GAS,
      maxFeePerGas: FUNDING_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: FUNDING_PRIORITY_FEE_PER_GAS,
      type: 'eip1559' as const,
    };
    let raw: Hex;
    if (options.wallet) {
      raw = await options.wallet.signTransaction({ ...fields, chain: baseSepolia, account: options.account });
    } else {
      raw = await options.account!.signTransaction(fields);
    }
    assertSignedFields(raw, transfer, plan.vault);
    const recovered = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` }).catch(() => undefined);
    if (!recovered || !same(recovered, plan.vault)) throw fixedError('SIGNER_MISMATCH');

    let auxiliaryFee: bigint;
    if (config.mode === 'local') {
      auxiliaryFee = options.estimateAuxFee ? await options.estimateAuxFee(raw) : FUNDING_AUXILIARY_RESERVE;
    } else {
      auxiliaryFee = BigInt(await options.client.readContract({
        address: BASE_GAS_PRICE_ORACLE,
        abi: GPO_ABI,
        functionName: 'getL1Fee',
        args: [raw],
        blockNumber: currentBlock.number,
      }) as bigint);
    }
    if (auxiliaryFee < 0n || auxiliaryFee > FUNDING_AUXILIARY_RESERVE) throw fixedError('AUXILIARY_FEE_LIMIT');
    if (vaultBalance < BigInt(transfer.valueWei) + TRANSFER_GAS_WEI + auxiliaryFee) throw fixedError('VAULT_FEE_BALANCE');

    const transactionHash = keccak256(raw);
    record = {
      actor: transfer.actor,
      transaction: transactionHash,
      from: plan.vault,
      to: transfer.to,
      nonce: transfer.nonce,
      valueWei: transfer.valueWei,
      targetWei: transfer.targetWei,
      beforeBalanceWei: transfer.beforeBalanceWei,
      gas: '21000',
      maxFeePerGas: '100000000',
      maxPriorityFeePerGas: '1000000',
      auxiliaryFeeWei: auxiliaryFee.toString(),
      data: '0x',
      attempted: true,
    };
    journal = await appendJournal(options.journalPath, journal, record);
    try { await options.client.sendRawTransaction({ serializedTransaction: raw }); } catch { /* reconcile this hash only */ }
    let known: { receipt: any; actualAuxiliaryFee: bigint } | undefined;
    for (let attempt = 0; attempt < polls; attempt++) {
      try { known = await verifyKnown(options.client, record); } catch (error) {
        if (error instanceof Error && error.message.startsWith('M5_FUNDING_')) throw error;
        return report(executionPlan, journal, 'pending', 'known_hash_reconciliation_unavailable');
      }
      if (known) break;
      if (attempt + 1 < polls) await nap(delay);
    }
    if (!known) return report(executionPlan, journal, 'pending', 'known_hash_unresolved');
    journal = await confirmJournal(options.client, options.journalPath, journal, record, known.receipt);
    if (known.receipt.status !== 'success') return report(executionPlan, journal, 'blocked', 'known_transaction_reverted');
  }

  const finalBlock = await anchoredBlock(options.client);
  const finalBalances = await Promise.all(FUNDABLE_ACTORS.map((actor) => options.client.getBalance({
    address: config.roles[actor], blockNumber: finalBlock.number,
  })));
  await assertAnchor(options.client, finalBlock);
  for (let index = 0; index < FUNDABLE_ACTORS.length; index++) {
    const actor = FUNDABLE_ACTORS[index]!;
    if (finalBalances[index] !== BigInt(executionPlan.roles[actor].targetWei)) throw fixedError('TARGET_MISMATCH');
  }
  if (journal && journal.transactions.length) {
    if (journal.transactions.some((item) => item.status !== 'success' || item.actualGasUsed === undefined ||
        item.effectiveGasPriceWei === undefined || item.actualAuxiliaryFeeWei === undefined)) {
      return report(executionPlan, journal, 'blocked', 'actual_fee_fields_unavailable');
    }
    const actualValues = journal.transactions.reduce((sum, item) => sum + BigInt(item.valueWei), 0n);
    const actualFees = journal.transactions.reduce((sum, item) => sum + BigInt(item.actualGasUsed!) *
      BigInt(item.effectiveGasPriceWei!) + BigInt(item.actualAuxiliaryFeeWei!), 0n);
    const vaultFinal = await options.client.getBalance({ address: executionPlan.vault, blockNumber: finalBlock.number });
    await assertAnchor(options.client, finalBlock);
    if (vaultFinal !== BigInt(executionPlan.vaultBalanceWei) - actualValues - actualFees) throw fixedError('VAULT_BALANCE_RECONCILIATION');
  }
  return report(executionPlan, journal, 'complete', 'funding_complete');
}
