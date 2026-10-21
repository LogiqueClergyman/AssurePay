import { getContractAddress, keccak256, parseTransaction, recoverTransactionAddress,
  type Address, type Hex, type LocalAccount } from 'viem';
import { lstat } from 'node:fs/promises';
import { baseSepolia } from 'viem/chains';
import { CampaignStore } from './store.js';
import { GAS_CAPS, STEP_ORDER, budgetSummary, stepActor, validateConfig } from './plan.js';
import type { Actor, CampaignManifest, RunConfig, StepKind, StepSpec, TransactionRecord } from './types.js';

type OpaqueAccounts = Record<Actor, LocalAccount>;
type PublicClient = {
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: Address; blockTag: 'latest' | 'pending' }): Promise<number>;
  getBalance(args: { address: Address }): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  getTransaction(args: { hash: Hex }): Promise<any>;
  getTransactionReceipt(args: { hash: Hex }): Promise<any>;
  getBlock(args: { blockNumber: bigint }): Promise<any>;
};
type Wallet = { chain?: { id?: number }; signTransaction(args: any): Promise<Hex> };
export interface CampaignSenderOptions {
  config: RunConfig;
  client: PublicClient;
  wallet?: Wallet;
  accounts?: OpaqueAccounts;
  journalPath: string;
  polls?: number;
  delay?: number;
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  a === null || a === undefined ? b === null || b === undefined : b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase();
const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const noRaw = () => new Error('CAMPAIGN_TRANSACTION_INVALID');
function atomic(value: unknown): bigint | undefined {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

const SPEC_KEYS = ['kind', 'actor', 'to', 'data'] as const;
function snapshotSpec(input: unknown): StepSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('CAMPAIGN_STEP_INVALID');
  const raw = input as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== SPEC_KEYS.length || keys.some((key) => typeof key !== 'string' ||
      !SPEC_KEYS.includes(key as typeof SPEC_KEYS[number]) || !descriptors[key as keyof typeof descriptors]?.enumerable ||
      !('value' in descriptors[key as keyof typeof descriptors]!))) throw new Error('CAMPAIGN_STEP_INVALID');
  if (typeof raw.kind !== 'string' || !STEP_ORDER.includes(raw.kind as StepKind) ||
      typeof raw.actor !== 'string' || typeof raw.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw.data) ||
      (raw.to !== null && (typeof raw.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.to)))) {
    throw new Error('CAMPAIGN_STEP_INVALID');
  }
  return Object.freeze({ kind: raw.kind as StepKind, actor: raw.actor as Actor,
    to: raw.to === null ? null : raw.to.toLowerCase() as Address, data: raw.data.toLowerCase() as Hex });
}

function snapshotAccount(input: LocalAccount | undefined): LocalAccount | undefined {
  if (!input || typeof input.address !== 'string') return undefined;
  const result: Record<string, unknown> = { address: input.address.toLowerCase() };
  for (const key of Object.keys(input)) {
    if (key === 'address') continue;
    const value = (input as any)[key];
    result[key] = typeof value === 'function' ? value.bind(input) : value;
  }
  return Object.freeze(result) as unknown as LocalAccount;
}

function roleAux(config: RunConfig, actor: Actor): bigint {
  return BigInt(budgetSummary(config).roles[actor].auxiliaryWei);
}

function targetFor(manifest: CampaignManifest, kind: StepKind): Address | null {
  if (kind === 'deploy') return null;
  if (kind === 'approve') return manifest.config.token;
  if (!manifest.core) throw new Error('CAMPAIGN_CORE_UNAVAILABLE');
  return manifest.core;
}

function nextKind(manifest: CampaignManifest): StepKind {
  const kind = STEP_ORDER[manifest.transactions.length];
  if (!kind) throw new Error('CAMPAIGN_COMPLETE');
  return kind;
}

function assertReadyForNewStep(manifest: CampaignManifest, kind: StepKind): void {
  if (nextKind(manifest) !== kind) throw new Error('CAMPAIGN_STEP_ORDER');
  for (const row of manifest.transactions) {
    if (row.status !== 'success' && !(row.kind === 'revert' && row.status === 'reverted')) {
      throw new Error('CAMPAIGN_UNRESOLVED_TRANSACTION');
    }
  }
  if (manifest.transactions.some((row) => row.kind === 'revert')) throw new Error('CAMPAIGN_COMPLETE');
}

function validateSpec(spec: StepSpec, manifest: CampaignManifest): void {
  if (!spec || !STEP_ORDER.includes(spec.kind) || spec.kind !== nextKind(manifest) ||
      spec.actor !== stepActor(spec.kind) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(spec.data)) throw new Error('CAMPAIGN_STEP_INVALID');
  if (!same(spec.to, targetFor(manifest, spec.kind))) throw new Error('CAMPAIGN_TARGET_INVALID');
}

function rpcIdentityMatches(record: TransactionRecord, tx: any): boolean {
  const to = typeof tx.to === 'string' ? tx.to as Address : null;
  const input = typeof tx.input === 'string' ? tx.input : tx.data;
  return same(tx.hash, record.transaction) && same(tx.from, record.from) && same(to, record.to) &&
    tx.chainId === 84532 && BigInt(tx.nonce) === BigInt(record.nonce) &&
    typeof input === 'string' && keccak256(input as Hex).toLowerCase() === record.calldataHash.toLowerCase() &&
    BigInt(tx.value ?? 0n) === 0n && BigInt(tx.gas) === BigInt(record.gas) &&
    BigInt(tx.maxFeePerGas) === BigInt(record.maxFeePerGas) &&
    BigInt(tx.maxPriorityFeePerGas ?? 0n) === BigInt(record.maxPriorityFeePerGas);
}

async function rawIdentityMatches(record: TransactionRecord, tx: any, raw: Hex): Promise<boolean> {
  const recovered = await recoverTransactionAddress({ serializedTransaction: raw as any }).catch(() => undefined);
  const to = typeof tx.to === 'string' ? tx.to as Address : null;
  return same(keccak256(raw), record.transaction) && same(recovered, record.from) && same(to, record.to) &&
    tx.chainId === 84532 && BigInt(tx.nonce) === BigInt(record.nonce) &&
    typeof tx.data === 'string' && keccak256(tx.data as Hex).toLowerCase() === record.calldataHash.toLowerCase() &&
    BigInt(tx.value ?? 0n) === 0n && BigInt(tx.gas) === BigInt(record.gas) &&
    BigInt(tx.maxFeePerGas) === BigInt(record.maxFeePerGas) &&
    BigInt(tx.maxPriorityFeePerGas ?? 0n) === BigInt(record.maxPriorityFeePerGas) &&
    (tx.accessList?.length ?? 0) === 0 && tx.type === 'eip1559';
}

/** Bounded campaign sender. Raw signed transactions remain in this process only. */
export async function createCampaignSender(options: CampaignSenderOptions) {
  // Copy caller-owned values before asynchronous journal initialization begins.
  const config = validateConfig(options.config);
  const polls = options.polls ?? 5;
  const delay = options.delay ?? 1_000;
  const journalPath = options.journalPath;
  const clientInput = options.client;
  const client = Object.freeze({
    getChainId: clientInput.getChainId.bind(clientInput),
    getTransactionCount: clientInput.getTransactionCount.bind(clientInput),
    getBalance: clientInput.getBalance.bind(clientInput),
    sendRawTransaction: clientInput.sendRawTransaction.bind(clientInput),
    getTransaction: clientInput.getTransaction.bind(clientInput),
    getTransactionReceipt: clientInput.getTransactionReceipt.bind(clientInput),
    getBlock: clientInput.getBlock.bind(clientInput),
  }) as PublicClient;
  const walletInput = options.wallet;
  const wallet = walletInput ? Object.freeze({
    chain: walletInput.chain ? Object.freeze({ ...walletInput.chain }) : undefined,
    signTransaction: walletInput.signTransaction.bind(walletInput),
  }) as Wallet : undefined;
  const inputAccounts = options.accounts;
  const accounts = inputAccounts ? Object.freeze({
    relayer: snapshotAccount(inputAccounts.relayer), payer: snapshotAccount(inputAccounts.payer),
    provider: snapshotAccount(inputAccounts.provider), adjudicator: snapshotAccount(inputAccounts.adjudicator),
  }) as Partial<OpaqueAccounts> : undefined;
  if (!Number.isSafeInteger(polls) || polls < 1 || polls > 20 || !Number.isSafeInteger(delay) || delay < 0 || delay > 5_000) {
    throw new Error('CAMPAIGN_SENDER_BOUNDS');
  }
  const exists = await lstat(journalPath).then(() => true, (error: any) => {
    if (error?.code === 'ENOENT') return false;
    throw new Error('CAMPAIGN_JOURNAL_UNAVAILABLE');
  });
  const store = exists ? await CampaignStore.open(journalPath, config) : await CampaignStore.create(journalPath, config);
  const prepared = new Map<StepKind, Hex>();
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };

  async function assertNetwork(): Promise<void> {
    if (await client.getChainId() !== config.chainId || config.chainId !== 84532) throw new Error('CAMPAIGN_CHAIN_MISMATCH');
  }

  async function checkRoleBudget(actor: Actor, kind: StepKind, manifest: CampaignManifest): Promise<void> {
    if (actor === 'provider') return;
    const roleBudget = budgetSummary(config).roles[actor];
    const target = BigInt(roleBudget.targetWei);
    const roleSteps = STEP_ORDER.slice(manifest.transactions.length).filter((step) => stepActor(step) === actor);
    const gasRemaining = roleSteps.reduce((sum, step) => sum + GAS_CAPS[step] * BigInt(config.maxFeePerGas), 0n);
    let executionSpent = 0n;
    let auxiliarySpent = 0n;
    for (const record of manifest.transactions.filter((item) => same(item.from, config.roles[actor]) && item.status)) {
      const receipt = await client.getTransactionReceipt({ hash: record.transaction });
      const gasUsed = atomic(receipt?.gasUsed);
      const effectiveGasPrice = atomic(receipt?.effectiveGasPrice);
      if (!receipt || !same(receipt.transactionHash, record.transaction) || gasUsed === undefined ||
          effectiveGasPrice === undefined || gasUsed > BigInt(record.gas) ||
          effectiveGasPrice > BigInt(record.maxFeePerGas)) throw new Error('CAMPAIGN_BUDGET_RECONCILIATION');
      executionSpent += gasUsed * effectiveGasPrice;
      const l1Fee = atomic(receipt.l1Fee) ?? 0n;
      const operatorFee = atomic(receipt.operatorFee) ?? 0n;
      auxiliarySpent += l1Fee + operatorFee;
    }
    const auxiliaryAllowance = roleAux(config, actor);
    if (auxiliarySpent > auxiliaryAllowance) throw new Error('CAMPAIGN_ROLE_BUDGET');
    const spent = executionSpent + auxiliarySpent;
    const auxiliaryRemaining = auxiliaryAllowance - auxiliarySpent;
    const balance = await client.getBalance({ address: config.roles[actor] });
    if (balance + spent > target || balance < gasRemaining + auxiliaryRemaining || !roleSteps.includes(kind)) {
      throw new Error('CAMPAIGN_ROLE_BUDGET');
    }
  }

  async function prepareUnsafe(spec: StepSpec): Promise<Hex> {
    const manifest = store.read();
    assertReadyForNewStep(manifest, spec.kind);
    validateSpec(spec, manifest);
    await assertNetwork();
    for (const prior of manifest.transactions) {
      const reconciled = await observeUnsafe(prior.kind);
      if (!reconciled.status || reconciled.blockHash !== prior.blockHash || reconciled.blockNumber !== prior.blockNumber ||
          reconciled.status !== prior.status) throw new Error('CAMPAIGN_UNRESOLVED_TRANSACTION');
    }
    const account = accounts?.[spec.actor];
    if (!account || !wallet || wallet.chain?.id !== config.chainId || typeof wallet.signTransaction !== 'function') {
      throw new Error('CAMPAIGN_SIGNER_UNAVAILABLE');
    }
    for (const actor of ['relayer', 'payer', 'provider', 'adjudicator'] as const) {
      const mapped = accounts?.[actor];
      if (mapped && (!mapped.address || !same(mapped.address, config.roles[actor]))) throw new Error('CAMPAIGN_ACCOUNT_MISMATCH');
    }
    const expectedFrom = config.roles[spec.actor];
    if (!same(account.address, expectedFrom)) throw new Error('CAMPAIGN_ACCOUNT_MISMATCH');
    await checkRoleBudget(spec.actor, spec.kind, manifest);
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: expectedFrom, blockTag: 'latest' }),
      client.getTransactionCount({ address: expectedFrom, blockTag: 'pending' }),
    ]);
    if (!Number.isSafeInteger(latest) || !Number.isSafeInteger(pending) || latest !== pending) throw new Error('CAMPAIGN_EXTERNAL_NONCE');
    const prior = manifest.transactions.filter((row) => same(row.from, expectedFrom)).at(-1);
    if (prior && BigInt(latest) !== BigInt(prior.nonce) + 1n) throw new Error('CAMPAIGN_EXTERNAL_NONCE');
    const gas = GAS_CAPS[spec.kind];
    const maxFeePerGas = BigInt(config.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(config.maxPriorityFeePerGas);
    const raw = await wallet.signTransaction({
      account, chain: baseSepolia, type: 'eip1559', nonce: latest,
      to: spec.to ?? undefined, data: spec.data, value: 0n, gas,
      maxFeePerGas, maxPriorityFeePerGas, accessList: [],
    });
    let tx: any;
    let recovered: Address;
    try { tx = parseTransaction(raw as any); recovered = await recoverTransactionAddress({ serializedTransaction: raw as any }); }
    catch { throw noRaw(); }
    const signedTo = typeof tx.to === 'string' ? tx.to as Address : null;
    const fieldsMatch = tx.type === 'eip1559' && tx.chainId === config.chainId &&
      BigInt(tx.nonce) === BigInt(latest) && same(signedTo, spec.to) &&
      typeof tx.data === 'string' && tx.data.toLowerCase() === spec.data.toLowerCase() &&
      BigInt(tx.value ?? 0n) === 0n && BigInt(tx.gas) === gas &&
      BigInt(tx.maxFeePerGas) === maxFeePerGas && BigInt(tx.maxPriorityFeePerGas ?? 0n) === maxPriorityFeePerGas &&
      (tx.accessList?.length ?? 0) === 0 && same(recovered, expectedFrom);
    if (!fieldsMatch) throw noRaw();
    const transaction = keccak256(raw);
    const core = spec.kind === 'deploy'
      ? getContractAddress({ from: expectedFrom, nonce: BigInt(latest) }).toLowerCase() as Address
      : manifest.core;
    const record: TransactionRecord = {
      kind: spec.kind, transaction, from: expectedFrom, to: spec.to, nonce: String(latest),
      calldataHash: keccak256(spec.data), gas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(), value: '0', attempted: false,
    };
    await store.append(record, core);
    prepared.set(spec.kind, raw);
    return raw;
  }

  async function broadcastUnsafe(kind: StepKind, raw: Hex): Promise<Hex> {
    const record = store.read().transactions.find((item) => item.kind === kind);
    let signed: any;
    try { signed = parseTransaction(raw as any); } catch { throw noRaw(); }
    if (!record || record.attempted || prepared.get(kind) !== raw || !await rawIdentityMatches(record, signed, raw)) {
      throw new Error('CAMPAIGN_BROADCAST_NOT_PREPARED');
    }
    // Persist the one-attempt marker before the network call. A crash after this point
    // is reconciled by hash and never sends these signed bytes again.
    await store.update(kind, { attempted: true });
    prepared.delete(kind);
    try {
      const returned = await client.sendRawTransaction({ serializedTransaction: raw });
      if (!same(returned, record.transaction)) return record.transaction;
    } catch { /* the locally derived hash remains the only recovery handle */ }
    return record.transaction;
  }

  async function observeUnsafe(kind: StepKind): Promise<TransactionRecord> {
    const record = store.read().transactions.find((item) => item.kind === kind);
    if (!record) throw new Error('CAMPAIGN_RECORD_MISSING');
    const unavailable = () => {
      if (record.status) throw new Error('CAMPAIGN_CANONICALITY_UNAVAILABLE');
      return record;
    };
    await assertNetwork();
    try {
      const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash: record.transaction }),
        client.getTransactionReceipt({ hash: record.transaction }),
      ]);
      if (!tx || !receipt || !rpcIdentityMatches(record, tx) ||
          !same(receipt.transactionHash, record.transaction) ||
          (receipt.status !== 'success' && receipt.status !== 'reverted') ||
          tx.blockNumber !== receipt.blockNumber || !same(tx.blockHash, receipt.blockHash)) return unavailable();
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (!block?.hash || !same(block.hash, receipt.blockHash)) {
        if (record.status) throw new Error('CAMPAIGN_CANONICALITY_UNAVAILABLE');
        return record;
      }
      if (kind !== 'revert' && receipt.status !== 'success') throw new Error('CAMPAIGN_UNEXPECTED_REVERT');
      if (kind === 'revert' && receipt.status !== 'reverted') throw new Error('CAMPAIGN_EXPECTED_REVERT');
      if (kind === 'deploy' && !same(receipt.contractAddress, store.read().core)) throw new Error('CAMPAIGN_DEPLOYMENT_ADDRESS');
      if (record.status && (record.blockNumber !== BigInt(receipt.blockNumber).toString() ||
          !same(record.blockHash, receipt.blockHash) || record.status !== receipt.status)) {
        throw new Error('CAMPAIGN_CANONICALITY_UNAVAILABLE');
      }
      await store.update(kind, { blockNumber: BigInt(receipt.blockNumber).toString(), blockHash: receipt.blockHash.toLowerCase(), status: receipt.status });
      return store.read().transactions.find((item) => item.kind === kind)!;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CAMPAIGN_')) throw error;
      if (record.status) throw new Error('CAMPAIGN_CANONICALITY_UNAVAILABLE');
      return record;
    }
  }

  return Object.freeze({
    prepare(input: StepSpec): Promise<Hex> { const spec = snapshotSpec(input); return serial(() => prepareUnsafe(spec)); },
    broadcast(kind: StepKind, raw: Hex): Promise<Hex> { return serial(() => broadcastUnsafe(kind, raw)); },
    async submit(input: StepSpec): Promise<TransactionRecord> {
      const spec = snapshotSpec(input);
      return serial(async () => {
        const existing = store.read().transactions.find((item) => item.kind === spec.kind);
        if (existing) {
          if (spec.actor !== stepActor(spec.kind) || !same(spec.to, existing.to) ||
              keccak256(spec.data).toLowerCase() !== existing.calldataHash.toLowerCase()) {
            throw new Error('CAMPAIGN_EXISTING_STEP_MISMATCH');
          }
          let observed = existing;
          for (let i = 0; i < polls && !observed.status; i++) {
            observed = await observeUnsafe(spec.kind);
            if (!observed.status && i + 1 < polls) await nap(delay);
          }
          return observed;
        }
        const raw = await prepareUnsafe(spec);
        const transaction = await broadcastUnsafe(spec.kind, raw);
        let record = store.read().transactions.find((item) => item.kind === spec.kind)!;
        for (let i = 0; i < polls; i++) {
          record = await observeUnsafe(spec.kind);
          if (record.status) break;
          if (i + 1 < polls) await nap(delay);
        }
        if (!same(transaction, record.transaction)) throw new Error('CAMPAIGN_TRANSACTION_MISMATCH');
        return record;
      });
    },
    observe(kind: StepKind): Promise<TransactionRecord> { return serial(() => observeUnsafe(kind)); },
    read(): CampaignManifest { return store.read(); },
  });
}
