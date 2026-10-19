import { lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  decodeFunctionData, encodeDeployData, encodeFunctionData, keccak256, parseAbi, parseTransaction,
  type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { compileContracts } from './compiler.js';
import { DEMO_TERMS, demoConfiguration } from './demo.js';
import { createSession, readSession, recordPrepared, type PublicSession, type PublicTransactionKind } from './journal.js';
import { createEvmDriver } from './evm-driver.js';
import { createRegisteredFlow } from './flow.js';
import { hashIntent, type Intent } from './intent.js';
import { NATIVE_USDC, runPreflight } from './preflight.js';
import { PUBLIC_GAS_CAPS, type PublicConfig } from './public-config.js';
import { prepareCoreCall, SPIKE_CORE_ABI } from './call.js';
import { verifyPublicAdmissionRevert, verifyPublicDeployment, verifyPublicSuccess, type ProofReader } from './public-proof.js';

const TOKEN_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ADMIN_ABI = parseAbi(['function setAdmissionEnabled(bool)', 'function admissionEnabled() view returns (bool)']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ReadClient = Omit<ProofReader, 'getBlock'> & {
  getBlock(args?: { blockNumber?: bigint }): Promise<any>;
  getBalance(args: { address: Address; blockNumber: bigint }): Promise<bigint>;
  getTransactionCount(args: { address: Address; blockTag?: 'pending' | 'latest'; blockNumber?: bigint }): Promise<number>;
  call(args: any): Promise<any>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
};
type SendWallet = WalletClient;

export type PublicRunResult = {
  ok: boolean;
  code: string;
  transactions: readonly { kind: string; transaction: Hex; ok: boolean; code: string; publicMetadata?: PublicMetadata }[];
};

export type PublicMetadata = {
  blockNumber?: string;
  blockHash?: Hex;
  gasUsed?: string;
  effectiveGasPrice?: string;
  calldataBytes?: number;
  l1FeeWei: string;
  operatorFeeWei: string;
  confirmationPolicy: 'canonical-inclusion-minimum-1';
};

function fail(code: string, transactions: PublicRunResult['transactions'] = []): PublicRunResult {
  return { ok: false, code, transactions };
}

function recordFor(kind: PublicTransactionKind, transactionHash: Hex, from: Address, to: Address | null,
  nonce: bigint, calldata: Hex, intentHash?: Hex) {
  return { kind, chainId: 84532 as const, transactionHash, from: from.toLowerCase() as Address,
    to: to === null ? null : to.toLowerCase() as Address, nonce: nonce.toString(),
    calldataHash: keccak256(calldata), ...(intentHash ? { intentHash } : {}) };
}

async function submitOnce(options: {
  kind: PublicTransactionKind; to: Address | null; data: Hex; gas: bigint;
  relayer: LocalAccount; wallet: SendWallet; client: ReadClient; journalPath: string;
  intentHash?: Hex; polls: number; pollDelayMs: number;
  maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  checkBudget: () => Promise<bigint>; expectedNonce: () => bigint;
  advanceNonce: (nonce: bigint) => void;
}) {
  const expectedNonce = options.expectedNonce();
  await options.checkBudget();
  const [pendingNonce, confirmedNonce] = await Promise.all([
    options.client.getTransactionCount({ address: options.relayer.address, blockTag: 'pending' }),
    options.client.getTransactionCount({ address: options.relayer.address, blockTag: 'latest' }),
  ]);
  if (BigInt(pendingNonce) !== expectedNonce || BigInt(confirmedNonce) !== expectedNonce) {
    throw new Error('M1_EXTERNAL_NONCE');
  }
  const request = await options.wallet.prepareTransactionRequest({
    account: options.relayer, chain: baseSepolia, to: options.to ?? undefined,
    data: options.data, value: 0n, gas: options.gas, type: 'eip1559',
    maxFeePerGas: options.maxFeePerGas, maxPriorityFeePerGas: options.maxPriorityFeePerGas,
  });
  const txNonce = BigInt(request.nonce as string | number | bigint);
  if (txNonce !== expectedNonce || request.chainId !== 84532 ||
      request.to?.toLowerCase() !== options.to?.toLowerCase() ||
      request.data?.toLowerCase() !== options.data.toLowerCase() || request.value !== 0n ||
      request.gas !== options.gas || request.maxFeePerGas !== options.maxFeePerGas ||
      request.maxPriorityFeePerGas !== options.maxPriorityFeePerGas) throw new Error('M1_PREPARED_TRANSACTION_MISMATCH');
  const raw = await options.wallet.signTransaction({ ...request, account: options.relayer, chain: baseSepolia });
  const hash = keccak256(raw);
  const signed = parseTransaction(raw) as Record<string, unknown>;
  if (signed.chainId !== 84532 || typeof signed.nonce !== 'number' ||
      BigInt(signed.nonce) !== expectedNonce ||
      (typeof signed.to === 'string' ? signed.to.toLowerCase() : null) !== (options.to?.toLowerCase() ?? null) ||
      typeof signed.data !== 'string' || signed.data.toLowerCase() !== options.data.toLowerCase() ||
      (signed.value ?? 0n) !== 0n ||
      signed.gas !== options.gas || signed.maxFeePerGas !== options.maxFeePerGas ||
      (signed.maxPriorityFeePerGas ?? 0n) !== options.maxPriorityFeePerGas || signed.type !== 'eip1559') {
    throw new Error('M1_SIGNED_TRANSACTION_MISMATCH');
  }
  await recordPrepared(options.journalPath, recordFor(options.kind, hash, options.relayer.address,
    options.to, txNonce, options.data, options.intentHash));
  options.advanceNonce(expectedNonce + 1n);
  try { await options.client.sendRawTransaction({ serializedTransaction: raw }); } catch { /* reconcile by locally derived hash */ }
  for (let i = 0; i < options.polls; i++) {
    try {
      const receipt = await options.client.getTransactionReceipt({ hash });
      if (receipt && receipt.transactionHash.toLowerCase() === hash.toLowerCase()) return { hash, receipt };
    } catch { /* bounded read-only retry for the same hash */ }
    if (i + 1 < options.polls) await sleep(options.pollDelayMs);
  }
  return { hash, receipt: null };
}

async function verifyAdminDisable(client: ProofReader, session: PublicSession, core: Address,
  record: PublicSession['transactions'][number], minimumConfirmations = 1n): Promise<boolean> {
  try {
    if (await client.getChainId() !== 84532 || record.kind !== 'admission' || record.to?.toLowerCase() !== core.toLowerCase()) return false;
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: record.transactionHash }),
      client.getTransactionReceipt({ hash: record.transactionHash }),
    ]);
    const expectedData = encodeFunctionData({ abi: ADMIN_ABI, functionName: 'setAdmissionEnabled', args: [false] });
    const height = receipt.blockNumber as bigint;
    const block = await client.getBlock({ blockNumber: height });
    const state = await client.readContract({ abi: ADMIN_ABI, address: core, functionName: 'admissionEnabled', args: [], blockNumber: height });
    if (receipt.status !== 'success' || tx.hash.toLowerCase() !== record.transactionHash.toLowerCase() ||
      tx.to?.toLowerCase() !== core.toLowerCase() || tx.from.toLowerCase() !== session.config.relayer.toLowerCase() ||
      tx.input.toLowerCase() !== expectedData.toLowerCase() || keccak256(tx.input).toLowerCase() !== record.calldataHash.toLowerCase() ||
      tx.value !== 0n || tx.chainId !== 84532 || tx.blockNumber !== height || tx.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      !block || block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() || state !== false ||
      await client.getBlockNumber() < height + minimumConfirmations - 1n) return false;
    return (await client.getBlock({ blockNumber: height })).hash?.toLowerCase() === receipt.blockHash.toLowerCase();
  } catch { return false; }
}

async function publicMetadata(client: ProofReader, transaction: Hex, calldataBytes?: number): Promise<PublicMetadata> {
  const output: PublicMetadata = { l1FeeWei: 'unavailable', operatorFeeWei: 'unavailable',
    confirmationPolicy: 'canonical-inclusion-minimum-1' };
  try {
    const receipt = await client.getTransactionReceipt({ hash: transaction });
    if (typeof receipt.blockNumber === 'bigint') output.blockNumber = receipt.blockNumber.toString();
    if (typeof receipt.blockHash === 'string') output.blockHash = receipt.blockHash as Hex;
    if (typeof receipt.gasUsed === 'bigint') output.gasUsed = receipt.gasUsed.toString();
    if (typeof receipt.effectiveGasPrice === 'bigint') output.effectiveGasPrice = receipt.effectiveGasPrice.toString();
    if (typeof receipt.l1Fee === 'bigint') output.l1FeeWei = receipt.l1Fee.toString();
    if (typeof receipt.operatorFee === 'bigint') output.operatorFeeWei = receipt.operatorFee.toString();
    if (calldataBytes !== undefined) output.calldataBytes = calldataBytes;
    else {
      const tx = await client.getTransaction({ hash: transaction });
      if (typeof tx.input === 'string') output.calldataBytes = Math.max(0, (tx.input.length - 2) / 2);
    }
  } catch { /* absence is represented explicitly; raw RPC errors never escape */ }
  return output;
}

async function inspectRecordedHash(client: ProofReader, session: PublicSession,
  record: PublicSession['transactions'][number]): Promise<{ code: string; metadata: PublicMetadata }> {
  try {
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: record.transactionHash }),
      client.getTransactionReceipt({ hash: record.transactionHash }),
    ]);
    const metadata = await publicMetadata(client, record.transactionHash, Math.max(0, (tx.input.length - 2) / 2));
    const blockNumber = receipt.blockNumber as bigint;
    const block = await client.getBlock({ blockNumber });
    const gasCap = BigInt(session.config.budget.gasCaps[record.kind]);
    const settlementIntent = record.kind === 'success' || record.kind === 'revert'
      ? calldataIntentHash(tx.input) : undefined;
    const code = await client.getCode({ address: session.config.relayer, blockNumber });
    const matches = tx.hash.toLowerCase() === record.transactionHash.toLowerCase() &&
      tx.from.toLowerCase() === session.config.relayer.toLowerCase() &&
      (tx.to === null ? record.to === null : tx.to.toLowerCase() === record.to?.toLowerCase()) &&
      tx.value === 0n && tx.chainId === 84532 && BigInt(tx.nonce) === BigInt(record.nonce) &&
      keccak256(tx.input).toLowerCase() === record.calldataHash.toLowerCase() &&
      typeof tx.gas === 'bigint' && tx.gas <= gasCap && typeof tx.maxFeePerGas === 'bigint' &&
      tx.maxFeePerGas <= BigInt(session.config.budget.maxFeePerGasAtomic) &&
      typeof tx.maxPriorityFeePerGas === 'bigint' &&
      tx.maxPriorityFeePerGas <= BigInt(session.config.budget.maxPriorityFeePerGasAtomic) &&
      ((record.kind === 'success' || record.kind === 'revert')
        ? !!record.intentHash && settlementIntent?.toLowerCase() === record.intentHash.toLowerCase()
        : record.intentHash === undefined) && (code === '0x' || code === undefined) &&
      tx.blockNumber === blockNumber && tx.blockHash.toLowerCase() === receipt.blockHash.toLowerCase() &&
      receipt.transactionHash.toLowerCase() === record.transactionHash.toLowerCase() &&
      typeof block.hash === 'string' && block.hash.toLowerCase() === receipt.blockHash.toLowerCase();
    if (!matches) return { code: 'RECORDED_TRANSACTION_UNPROVEN', metadata };
    return { code: receipt.status === 'success' ? 'RECORDED_SUCCESS_UNPROVEN' : 'RECORDED_REVERT_UNPROVEN', metadata };
  } catch {
    return { code: 'RECORDED_TRANSACTION_PENDING', metadata: await publicMetadata(client, record.transactionHash) };
  }
}

function calldataIntentHash(data: Hex): Hex | undefined {
  try {
    const decoded = decodeFunctionData({ abi: SPIKE_CORE_ABI, data });
    if (decoded.functionName !== 'settleAssured') return undefined;
    const raw = decoded.args[0] as Record<string, unknown>;
    const intent: Intent = {
      chainId: String(raw.chainId), core: String(raw.core).toLowerCase() as Address,
      token: String(raw.token).toLowerCase() as Address, payer: String(raw.payer).toLowerCase() as Address,
      providerId: raw.providerId as Hex, policyId: raw.policyId as Hex, policyHash: raw.policyHash as Hex,
      requestHash: raw.requestHash as Hex, gross: String(raw.gross), payerSalt: raw.payerSalt as Hex,
      validAfter: String(raw.validAfter), validBefore: String(raw.validBefore),
    };
    return hashIntent(intent);
  } catch { return undefined; }
}

async function auditCompleteJournal(client: ProofReader, session: PublicSession,
  core: Address): Promise<boolean> {
  const records = ['deploy', 'success', 'admission', 'revert'].map(kind =>
    session.transactions.find(record => record.kind === kind));
  if (records.some(record => !record)) return false;
  const caps = session.config.budget.gasCaps;
  const order: Array<{ block: bigint; index: bigint; nonce: bigint }> = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    try {
      const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash: record.transactionHash }),
        client.getTransactionReceipt({ hash: record.transactionHash }),
      ]);
      const kind = record.kind;
      const expectedTo = kind === 'deploy' ? null : core;
      const cap = BigInt(caps[kind]);
      const hashMatches = tx.hash.toLowerCase() === record.transactionHash.toLowerCase() &&
        tx.from.toLowerCase() === session.config.relayer.toLowerCase() &&
        (expectedTo === null ? tx.to === null : tx.to?.toLowerCase() === expectedTo.toLowerCase()) &&
        record.to?.toLowerCase() === expectedTo?.toLowerCase() &&
        tx.value === 0n && tx.chainId === 84532 && BigInt(tx.nonce) === BigInt(record.nonce) &&
        keccak256(tx.input).toLowerCase() === record.calldataHash.toLowerCase() &&
        typeof tx.gas === 'bigint' && tx.gas <= cap && typeof tx.maxFeePerGas === 'bigint' &&
        tx.maxFeePerGas <= BigInt(session.config.budget.maxFeePerGasAtomic) &&
        typeof tx.maxPriorityFeePerGas === 'bigint' &&
        tx.maxPriorityFeePerGas <= BigInt(session.config.budget.maxPriorityFeePerGasAtomic) &&
        tx.blockNumber === receipt.blockNumber && tx.blockHash.toLowerCase() === receipt.blockHash.toLowerCase() &&
        (kind === 'revert' ? receipt.status === 'reverted' : receipt.status === 'success') &&
        typeof receipt.gasUsed === 'bigint' && receipt.gasUsed <= tx.gas;
      if (!hashMatches) return false;
      if ((kind === 'success' || kind === 'revert') &&
          (!record.intentHash || calldataIntentHash(tx.input)?.toLowerCase() !== record.intentHash.toLowerCase())) return false;
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return false;
      const code = await client.getCode({ address: session.config.relayer, blockNumber: receipt.blockNumber });
      if (code !== '0x' && code !== undefined) return false;
      order.push({ block: receipt.blockNumber, index: BigInt(receipt.transactionIndex), nonce: BigInt(tx.nonce) });
    } catch { return false; }
  }
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && order[i]!.nonce !== order[i - 1]!.nonce + 1n) return false;
    if (i > 0 && (order[i]!.block < order[i - 1]!.block ||
      (order[i]!.block === order[i - 1]!.block && order[i]!.index <= order[i - 1]!.index))) return false;
  }
  return true;
}

/** Read-only reconciliation for an existing journal. It never accesses a signer. */
export async function recoverPublicRun(client: ProofReader, journalPath: string, minimumConfirmations = 1n): Promise<PublicRunResult> {
  let session: PublicSession;
  try { session = await readSession(journalPath); } catch { return fail('JOURNAL_UNAVAILABLE'); }
  const byKind = new Map(session.transactions.map(record => [record.kind, record]));
  const results: { kind: string; transaction: Hex; ok: boolean; code: string; publicMetadata?: PublicMetadata }[] = [];
  let core: Address | undefined;
  const deploymentRecord = byKind.get('deploy');
  if (deploymentRecord) {
    const deployment = await verifyPublicDeployment(client, { transaction: deploymentRecord.transactionHash,
      relayer: session.config.relayer, providerPayout: session.config.providerPayout, minimumConfirmations });
    if (deployment.ok) core = deployment.core as Address;
    results.push({ kind: 'deploy', transaction: deploymentRecord.transactionHash, ok: deployment.ok,
      code: deployment.ok ? deployment.code : (await inspectRecordedHash(client, session, deploymentRecord)).code,
      publicMetadata: await publicMetadata(client, deploymentRecord.transactionHash) });
  }
  for (const kind of ['success', 'admission', 'revert'] as const) {
    const record = byKind.get(kind);
    if (!record) continue;
    const inspected = await inspectRecordedHash(client, session, record);
    let ok = false;
    let code = inspected.code;
    if (core && kind === 'success') {
      const proof = await verifyPublicSuccess(client, { transaction: record.transactionHash, core, payer: session.config.payer,
        relayer: session.config.relayer, providerPayout: session.config.providerPayout,
        calldataHash: record.calldataHash, minimumConfirmations });
      ok = proof.ok; if (ok) code = proof.code;
    } else if (core && kind === 'admission') {
      ok = await verifyAdminDisable(client, session, core, record, minimumConfirmations);
      if (ok) code = 'PUBLIC_ADMISSION_DISABLED_VERIFIED';
    } else if (core && kind === 'revert') {
      const proof = await verifyPublicAdmissionRevert(client, { transaction: record.transactionHash, core,
        payer: session.config.payer, relayer: session.config.relayer, providerPayout: session.config.providerPayout,
        calldataHash: record.calldataHash, minimumConfirmations });
      ok = proof.ok; if (ok) code = proof.code;
    }
    results.push({ kind, transaction: record.transactionHash, ok, code,
      publicMetadata: await publicMetadata(client, record.transactionHash) });
  }
  const complete = ['deploy', 'success', 'admission', 'revert'].every(kind => results.some(item => item.kind === kind && item.ok)) &&
    !!core && await auditCompleteJournal(client, session, core);
  return complete ? { ok: true, code: 'PUBLIC_RUN_RECONCILED', transactions: results } : fail('RUN_INCOMPLETE_OR_PENDING', results);
}

export async function publicJournalExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    // Only a definite missing path permits a new run. Permission and I/O errors
    // must take the read-only recovery path and fail closed.
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT');
  }
}

/** Adapter from viem's `account` call option to the preflight reader's `from`. */
export function createPublicPreflightAdapter(client: ReadClient) {
  return {
    getChainId: () => client.getChainId(),
    getBlock: (args?: { blockNumber?: bigint }) => client.getBlock(args),
    getCode: (args: { address: Address; blockNumber: bigint }) => client.getCode(args),
    async call(args: { from?: Address; to: Address; data: Hex; blockNumber: bigint; gas: bigint }): Promise<Hex> {
      const { from, ...call } = args;
      const result = await client.call({ ...call, ...(from ? { account: from } : {}) });
      if (!result || typeof result.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(result.data)) {
        throw new Error('M1_READ_CALL');
      }
      return result.data as Hex;
    },
  };
}

export type PublicExecutionOptions = {
  config: PublicConfig; payer: LocalAccount; relayer: LocalAccount; client: ReadClient; wallet: SendWallet;
  journalPath: string; preflight?: (client: ReadClient) => Promise<{ ok: boolean }>;
  createSalt?: () => Hex; receiptPolls?: number; pollDelayMs?: number;
};

/** One bounded four-transaction public run. Every recovery path is read-only. */
async function runPublicExecutionInner(options: PublicExecutionOptions): Promise<PublicRunResult> {
  const { config, payer, relayer, client, wallet, journalPath } = options;
  if (await publicJournalExists(journalPath)) return recoverPublicRun(client, journalPath);
  if (config.mode !== 'execute') return fail('EXECUTION_NOT_ENABLED');
  if (payer.address.toLowerCase() !== config.payer.toLowerCase() || relayer.address.toLowerCase() !== config.relayer.toLowerCase()) {
    return fail('SIGNER_ADDRESS_MISMATCH');
  }
  const polls = options.receiptPolls ?? 5;
  const delay = options.pollDelayMs ?? 1_000;
  if (!Number.isSafeInteger(polls) || polls < 1 || polls > 20 || !Number.isSafeInteger(delay) || delay < 0 || delay > 5_000) {
    return fail('INVALID_POLL_BUDGET');
  }
  // RPC receipt/transaction/state views can converge at different times.
  // These retries only read proofs; they never prepare or submit transactions.
  const proofRead = async <T>(read: () => Promise<T>, accepted: (result:T) => boolean): Promise<T> => {
    let result = await read();
    for(let i=1;i<polls&&!accepted(result);i++) { await sleep(delay); result=await read(); }
    return result;
  };
  const reader = createPublicPreflightAdapter(client);
  const preflight = await (options.preflight ?? (async () => runPreflight(reader)))(client);
  if (!preflight.ok) return fail('PREFLIGHT_FAILED');
  let initialNonce: bigint;
  try {
    if (await client.getChainId() !== 84532) return fail('CHAIN_MISMATCH');
    const initialBlock = await client.getBlock();
    if (initialBlock.number === null || initialBlock.hash === null) return fail('BALANCE_PREFLIGHT_FAILED');
    const [payerBalance, nativeBalance, confirmedNonce, pendingNonce] = await Promise.all([
      client.readContract({ address: NATIVE_USDC, abi: TOKEN_ABI, functionName: 'balanceOf', args: [payer.address], blockNumber: initialBlock.number }),
      client.getBalance({ address: relayer.address, blockNumber: initialBlock.number }),
      client.getTransactionCount({ address: relayer.address, blockNumber: initialBlock.number }),
      client.getTransactionCount({ address: relayer.address, blockTag: 'pending' }),
    ]);
    if (payerBalance < 200n) return fail('PAYER_BALANCE_LOW');
    const requiredNative = config.budget.maxTotalGas * config.budget.maxFeePerGasAtomic + config.budget.maxL1FeeWei;
    if (nativeBalance < requiredNative) return fail('RELAYER_BALANCE_LOW');
    if (nativeBalance > requiredNative) return fail('RELAYER_BALANCE_EXCESS');
    if (confirmedNonce !== pendingNonce) return fail('RELAYER_NONCE_UNAVAILABLE');
    initialNonce = BigInt(confirmedNonce);
    if ((await client.getBlock({ blockNumber: initialBlock.number })).hash?.toLowerCase() !== initialBlock.hash.toLowerCase()) {
      return fail('BALANCE_PREFLIGHT_BLOCK_CHANGED');
    }
  } catch { return fail('BALANCE_PREFLIGHT_FAILED'); }

  let session: PublicSession;
  try { session = await createSession(journalPath, config); }
  catch { return fail('JOURNAL_CREATE_FAILED'); }
  const results: { kind: string; transaction: Hex; ok: boolean; code: string; publicMetadata?: PublicMetadata }[] = [];
  let expectedNonce = initialNonce;
  let lastObservedBalance = config.budget.maxTotalGas * config.budget.maxFeePerGasAtomic + config.budget.maxL1FeeWei;
  const checkBudget = async () => {
    const block = await client.getBlock();
    if (block.number === null || block.hash === null) throw new Error('M1_BALANCE_BLOCK');
    const balance = await client.getBalance({ address: relayer.address, blockNumber: block.number });
    if ((await client.getBlock({ blockNumber: block.number })).hash?.toLowerCase() !== block.hash.toLowerCase()) {
      throw new Error('M1_BALANCE_BLOCK');
    }
    if (balance > lastObservedBalance) throw new Error('M1_EXTERNAL_FUNDING');
    lastObservedBalance = balance;
    return balance;
  };
  const nonce = () => expectedNonce;
  const advanceNonce = (next: bigint) => { expectedNonce = next; };
  const artifact = compileContracts().AssuranceCoreSpike!;
  const creation = encodeDeployData({ ...artifact, args: [NATIVE_USDC, config.providerPayout,
    DEMO_TERMS.providerId, DEMO_TERMS.policyId, DEMO_TERMS.policyHash] });
  const feeOptions = { maxFeePerGas: config.budget.maxFeePerGasAtomic,
    maxPriorityFeePerGas: config.budget.maxPriorityFeePerGasAtomic };
  const deployment = await submitOnce({ kind: 'deploy', to: null, data: creation, gas: PUBLIC_GAS_CAPS.deploy,
    relayer, wallet, client, journalPath, polls, pollDelayMs: delay, checkBudget, expectedNonce: nonce, advanceNonce, ...feeOptions });
  if (!deployment.receipt || deployment.receipt.status !== 'success' || !deployment.receipt.contractAddress) {
    return fail('DEPLOYMENT_UNCONFIRMED', [{ kind: 'deploy', transaction: deployment.hash, ok: false, code: 'RECEIPT_UNAVAILABLE' }]);
  }
  const core = deployment.receipt.contractAddress as Address;
  const deploymentProof = await proofRead(()=>verifyPublicDeployment(client, { transaction: deployment.hash,
    relayer: relayer.address, providerPayout: config.providerPayout }), result=>result.ok);
  results.push({ kind: 'deploy', transaction: deployment.hash, ok: deploymentProof.ok, code: deploymentProof.code,
    publicMetadata: await publicMetadata(client, deployment.hash, (creation.length - 2) / 2) });
  if (!deploymentProof.ok) return fail('DEPLOYMENT_PROOF_FAILED', results);

  const configuration = demoConfiguration(core, config.providerPayout);
  let activeCallData: Hex | undefined;
  const driver = createEvmDriver({ publicClient: client as unknown as PublicClient, walletClient: wallet,
    account: relayer, gasLimit: PUBLIC_GAS_CAPS.success,
    maxFeePerGas: config.budget.maxFeePerGasAtomic, maxPriorityFeePerGas: config.budget.maxPriorityFeePerGasAtomic,
    async beforeBroadcast(record) {
      if (BigInt(record.nonce) !== expectedNonce || !activeCallData) throw new Error('M1_EXTERNAL_NONCE');
      await recordPrepared(journalPath, recordFor('success', record.transaction, relayer.address, core,
        BigInt(record.nonce), activeCallData, record.intentHash));
      advanceNonce(expectedNonce + 1n);
    },
  });
  const flow = await createRegisteredFlow({ configuration, payer: { address: payer.address,
    signTypedData: data => payer.signTypedData(data as never) }, driver: {
      ...driver,
    async prepareCall(call) {
      await checkBudget();
      const [pending, confirmed] = await Promise.all([
        client.getTransactionCount({ address: relayer.address, blockTag: 'pending' }),
        client.getTransactionCount({ address: relayer.address, blockTag: 'latest' }),
      ]);
      if (BigInt(pending) !== expectedNonce || BigInt(confirmed) !== expectedNonce) {
        throw new Error('M1_EXTERNAL_NONCE');
      }
      activeCallData = call.data;
      return driver.prepareCall(call);
    },
      async verifySuccess(receipt, call, payment) {
        const proof = await proofRead(()=>verifyPublicSuccess(client, { transaction: receipt.transactionHash, core,
          payer: config.payer, relayer: config.relayer, providerPayout: config.providerPayout,
          calldataHash: keccak256(call.data) }), result=>result.ok);
        if (!proof.ok) throw new Error('M1_PUBLIC_PROOF_PENDING');
        return true;
      },
    }, createSalt: options.createSalt ?? (() => `0x${randomBytes(32).toString('hex')}` as Hex),
  });
  const payment = await flow.purchase();
  let settled = await flow.settleBeforeService(payment);
  for(let i=1;i<polls&&!settled.success&&settled.transaction;i++) {
    await sleep(delay);
    settled=await flow.settleBeforeService(payment);
  }
  if (!settled.success) return fail('SUCCESS_SETTLEMENT_UNCONFIRMED', settled.transaction ? [
    { kind: 'success', transaction: settled.transaction as Hex, ok: false, code: settled.errorReason ?? 'PENDING' },
  ] : results);
  const successRecord = (await readSession(journalPath)).transactions.find(record => record.kind === 'success');
  if (!successRecord) return fail('SUCCESS_RECORD_MISSING', results);
  results.push({ kind: 'success', transaction: settled.transaction as Hex, ok: true, code: 'PUBLIC_SUCCESS_VERIFIED',
    publicMetadata: await publicMetadata(client, settled.transaction as Hex) });

  const adminData = encodeFunctionData({ abi: ADMIN_ABI, functionName: 'setAdmissionEnabled', args: [false] });
  const admission = await submitOnce({ kind: 'admission', to: core, data: adminData, gas: PUBLIC_GAS_CAPS.admission,
    relayer, wallet, client, journalPath, polls, pollDelayMs: delay, checkBudget, expectedNonce: nonce, advanceNonce, ...feeOptions });
  if (!admission.receipt || admission.receipt.status !== 'success') return fail('ADMISSION_UNCONFIRMED', results);
  const admissionRecord = (await readSession(journalPath)).transactions.find(record => record.kind === 'admission');
  if (!admissionRecord || !await proofRead(()=>verifyAdminDisable(client, session, core, admissionRecord), result=>result)) return fail('ADMISSION_PROOF_FAILED', results);
  results.push({ kind: 'admission', transaction: admission.hash, ok: true, code: 'PUBLIC_ADMISSION_DISABLED_VERIFIED',
    publicMetadata: await publicMetadata(client, admission.hash, (adminData.length - 2) / 2) });

  const payment2 = await flow.purchase();
  const payload = payment2.payload as { intent: Intent; intentHash: Hex; signature: Hex };
  const now = await client.getBlock().then(block => block.timestamp);
  const call = await prepareCoreCall(payment2, configuration, now);
  const revertData = call.data;
  const reverted = await submitOnce({ kind: 'revert', to: core, data: revertData, gas: PUBLIC_GAS_CAPS.revert,
    relayer, wallet, client, journalPath, intentHash: payload.intentHash, polls, pollDelayMs: delay,
    checkBudget, expectedNonce: nonce, advanceNonce, ...feeOptions });
  if (!reverted.receipt || reverted.receipt.status !== 'reverted') return fail('ADMISSION_REVERT_UNCONFIRMED', results);
  const rollback = await proofRead(()=>verifyPublicAdmissionRevert(client, { transaction: reverted.hash, core, payer: config.payer,
    relayer: config.relayer, providerPayout: config.providerPayout, calldataHash: keccak256(revertData) }), result=>result.ok);
  results.push({ kind: 'revert', transaction: reverted.hash, ok: rollback.ok, code: rollback.code,
    publicMetadata: await publicMetadata(client, reverted.hash, (revertData.length - 2) / 2) });
  if (!rollback.ok) return fail('ROLLBACK_PROOF_FAILED', results);
  const reconciled = await recoverPublicRun(client, journalPath, 1n);
  return reconciled.ok ? { ...reconciled, code: 'PUBLIC_RUN_COMPLETE' } : reconciled;
}

export async function runPublicExecution(options: PublicExecutionOptions): Promise<PublicRunResult> {
  try { return await runPublicExecutionInner(options); }
  catch { return fail('RUN_STOPPED_RECONCILE'); }
}
