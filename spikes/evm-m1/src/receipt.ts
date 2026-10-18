import {
  decodeEventLog, parseAbi, toEventSelector,
  type Address, type Hex,
} from 'viem';
import { hashIntent, type Intent } from './intent.js';
import type { PreparedCoreCall } from './call.js';
import type { ProfileConfiguration } from './profile.js';

const CORE_EVENTS = parseAbi([
  'event CoverageOpened(bytes32 indexed coverageId,address indexed payer,bytes32 indexed providerId,bytes32 policyId,bytes32 requestHash,uint256 gross,uint256 net,uint256 premium)',
]);
const TOKEN_EVENTS = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
]);
const CORE_STATE_ABI = parseAbi([
  'function coverages(bytes32 coverageId) view returns (address payer,bytes32 requestHash,uint256 gross)',
]);
const TOKEN_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
]);

const COVERAGE_TOPIC = toEventSelector(CORE_EVENTS[0]);
const TRANSFER_TOPIC = toEventSelector(TOKEN_EVENTS[0]);
const AUTHORIZATION_USED_TOPIC = toEventSelector(TOKEN_EVENTS[1]);
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface ReceiptReadClient {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<any>;
  getTransaction(args: { hash: Hex }): Promise<any>;
  getBlock(args: { blockNumber: bigint }): Promise<any>;
  getBlockNumber(): Promise<bigint>;
  readContract(args: {
    abi: readonly unknown[];
    address: Address;
    functionName: string;
    args: readonly unknown[];
    blockNumber: bigint;
  }): Promise<any>;
}

export interface SettlementReceiptExpectation {
  call: PreparedCoreCall;
  configuration: ProfileConfiguration;
  intent: Intent;
  relayer: Address;
  transaction: Hex;
  minimumConfirmations?: bigint;
}

export interface SettlementReceiptResult {
  ok: boolean;
  code: string;
  transaction: Hex;
  blockNumber?: bigint;
  blockHash?: Hex;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  calldataBytes?: number;
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function asBytes32(value: unknown): value is Hex {
  return typeof value === 'string' && HASH_RE.test(value);
}

function baseResult(expectation: SettlementReceiptExpectation, code: string, extra: Partial<SettlementReceiptResult> = {}) {
  const result: SettlementReceiptResult = {
    ok: code === 'VERIFIED',
    code,
    transaction: expectation.transaction,
  };
  if (typeof expectation.call?.data === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(expectation.call.data)) {
    result.calldataBytes = (expectation.call.data.length - 2) / 2;
  }
  for (const field of ['blockNumber', 'blockHash', 'gasUsed', 'effectiveGasPrice'] as const) {
    if (extra[field] !== undefined) result[field] = extra[field] as never;
  }
  return result;
}

function expectationMatches(expected: SettlementReceiptExpectation): boolean {
  const { call, configuration, intent, relayer } = expected;
  const { bindings, providerPayout } = configuration;
  try {
    return bindings.chainId === 84532n
      && intent.chainId === '84532'
      && sameAddress(intent.core, bindings.core)
      && sameAddress(intent.token, bindings.token)
      && sameAddress(intent.payer, call.payer)
      && sameAddress(call.to, bindings.core)
      && call.intentHash.toLowerCase() === hashIntent(intent).toLowerCase()
      && /^0x[0-9a-f]{40}$/i.test(relayer)
      && relayer.toLowerCase() !== ZERO_ADDRESS
      && intent.providerId.toLowerCase() === bindings.providerId.toLowerCase()
      && intent.policyId.toLowerCase() === bindings.policyId.toLowerCase()
      && intent.policyHash.toLowerCase() === bindings.policyHash.toLowerCase()
      && intent.requestHash.toLowerCase() === bindings.requestHash.toLowerCase()
      && intent.gross === '100'
      && (bindings.gross ?? '100') === '100'
      && /^0x[0-9a-f]{40}$/i.test(providerPayout)
      && /^0x(?:[0-9a-f]{2})+$/i.test(call.data);
  } catch {
    return false;
  }
}

function decoded(log: any, abi: any): any | undefined {
  try {
    return decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
  } catch {
    return undefined;
  }
}

function matchingLogs(logs: any[], address: string, topic: Hex): any[] {
  return logs.filter(log => sameAddress(log?.address, address)
    && typeof log?.topics?.[0] === 'string'
    && log.topics[0].toLowerCase() === topic.toLowerCase());
}

function coverageMatches(args: any, expected: SettlementReceiptExpectation): boolean {
  const { call, intent } = expected;
  return args?.coverageId?.toLowerCase() === call.intentHash.toLowerCase()
    && sameAddress(args?.payer, intent.payer)
    && args?.providerId?.toLowerCase() === intent.providerId.toLowerCase()
    && args?.policyId?.toLowerCase() === intent.policyId.toLowerCase()
    && args?.requestHash?.toLowerCase() === intent.requestHash.toLowerCase()
    && args?.gross === 100n
    && args?.net === 93n
    && args?.premium === 7n;
}

function transfersMatch(logs: any[], expected: SettlementReceiptExpectation): boolean {
  if (logs.length !== 2) return false;
  const decodedTransfers = logs.map(log => decoded(log, TOKEN_EVENTS[0] ? [TOKEN_EVENTS[0]] : TOKEN_EVENTS));
  if (decodedTransfers.some(event => event?.eventName !== 'Transfer')) return false;
  const first = decodedTransfers[0]?.args;
  const second = decodedTransfers[1]?.args;
  const { intent } = expected;
  return sameAddress(first?.from, intent.payer)
    && sameAddress(first?.to, intent.core)
    && first?.value === 100n
    && sameAddress(second?.from, intent.core)
    && sameAddress(second?.to, expected.configuration.providerPayout)
    && second?.value === 93n;
}

function authorizationMatches(logs: any[], expected: SettlementReceiptExpectation): boolean {
  if (logs.length !== 1) return false;
  const event = decoded(logs[0], TOKEN_EVENTS[1] ? [TOKEN_EVENTS[1]] : TOKEN_EVENTS);
  return event?.eventName === 'AuthorizationUsed'
    && sameAddress(event.args?.authorizer, expected.intent.payer)
    && event.args?.nonce?.toLowerCase() === expected.call.intentHash.toLowerCase();
}

function coverageStateMatches(state: any, expected: SettlementReceiptExpectation): boolean {
  const payer = Array.isArray(state) ? state[0] : state?.payer;
  const requestHash = Array.isArray(state) ? state[1] : state?.requestHash;
  const gross = Array.isArray(state) ? state[2] : state?.gross;
  return sameAddress(payer, expected.intent.payer)
    && typeof requestHash === 'string' && requestHash.toLowerCase() === expected.intent.requestHash.toLowerCase()
    && gross === 100n;
}

/** Verify only public chain data; provider errors and raw RPC details never escape. */
export async function verifySettlement(
  client: ReceiptReadClient,
  expected: SettlementReceiptExpectation,
): Promise<SettlementReceiptResult> {
  const minConfirmations = expected.minimumConfirmations ?? 1n;
  if (!expectationMatches(expected) || !HASH_RE.test(expected.transaction)
      || typeof minConfirmations !== 'bigint' || minConfirmations < 1n || minConfirmations > 1000n) {
    return baseResult(expected, 'EXPECTATION_MISMATCH');
  }

  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch {
    return baseResult(expected, 'READ_FAILED');
  }
  if (chainId !== 84532) return baseResult(expected, 'CHAIN_MISMATCH');

  let receipt: any;
  try {
    receipt = await client.getTransactionReceipt({ hash: expected.transaction });
  } catch {
    return baseResult(expected, 'READ_FAILED');
  }
  if (!receipt) return baseResult(expected, 'RECEIPT_MISSING');
  const receiptMetadata: Partial<SettlementReceiptResult> = {};
  if (typeof receipt.blockNumber === 'bigint') receiptMetadata.blockNumber = receipt.blockNumber;
  if (asBytes32(receipt.blockHash)) receiptMetadata.blockHash = receipt.blockHash as Hex;
  if (typeof receipt.gasUsed === 'bigint') receiptMetadata.gasUsed = receipt.gasUsed;
  if (typeof receipt.effectiveGasPrice === 'bigint') receiptMetadata.effectiveGasPrice = receipt.effectiveGasPrice;
  if (receipt.status !== 'success') return baseResult(expected, 'RECEIPT_FAILED', receiptMetadata);
  if (typeof receipt.transactionHash !== 'string'
      || receipt.transactionHash.toLowerCase() !== expected.transaction.toLowerCase()
      || receiptMetadata.blockNumber === undefined || receiptMetadata.blockHash === undefined) {
    return baseResult(expected, 'TRANSACTION_MISMATCH', receiptMetadata);
  }
  const blockNumber = receiptMetadata.blockNumber;
  const blockHash = receiptMetadata.blockHash;

  let transaction: any;
  let block: any;
  let head: bigint;
  try {
    [transaction, block, head] = await Promise.all([
      client.getTransaction({ hash: expected.transaction }),
      client.getBlock({ blockNumber }),
      client.getBlockNumber(),
    ]);
  } catch {
    return baseResult(expected, 'READ_FAILED', receiptMetadata);
  }
  if (typeof head !== 'bigint') return baseResult(expected, 'READ_FAILED', receiptMetadata);
  let transactionChainId = 0n;
  let transactionValue: bigint | undefined;
  try {
    transactionChainId = BigInt(transaction?.chainId ?? 0n);
    if (transaction?.value !== undefined) transactionValue = BigInt(transaction.value);
  } catch {
    return baseResult(expected, 'TRANSACTION_MISMATCH', receiptMetadata);
  }
  if (!transaction || typeof transaction.hash !== 'string'
      || transaction.hash.toLowerCase() !== expected.transaction.toLowerCase()
      || !sameAddress(transaction.to, expected.configuration.bindings.core)
      || !sameAddress(transaction.from, expected.relayer)
      || typeof transaction.input !== 'string' || transaction.input.toLowerCase() !== expected.call.data.toLowerCase()
      || transactionValue !== 0n || transactionChainId !== 84532n
      || transaction.blockNumber !== blockNumber || typeof transaction.blockHash !== 'string'
      || transaction.blockHash.toLowerCase() !== blockHash.toLowerCase()) {
    return baseResult(expected, 'TRANSACTION_MISMATCH', receiptMetadata);
  }
  if (!block || block.number !== blockNumber
      || typeof block.hash !== 'string' || block.hash.toLowerCase() !== blockHash.toLowerCase()) {
    return baseResult(expected, 'NONCANONICAL_BLOCK', receiptMetadata);
  }
  if (head < blockNumber || head - blockNumber + 1n < minConfirmations) {
    return baseResult(expected, 'INSUFFICIENT_CONFIRMATIONS', receiptMetadata);
  }

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const coreLogs = matchingLogs(logs, expected.configuration.bindings.core, COVERAGE_TOPIC);
  const transferLogs = matchingLogs(logs, expected.configuration.bindings.token, TRANSFER_TOPIC);
  const authorizationLogs = matchingLogs(logs, expected.configuration.bindings.token, AUTHORIZATION_USED_TOPIC);
  const coverageEvent = coreLogs.length === 1 ? decoded(coreLogs[0], CORE_EVENTS) : undefined;
  if (coreLogs.length !== 1 || !coverageMatches(coverageEvent?.args, expected)
      || !transfersMatch(transferLogs, expected) || !authorizationMatches(authorizationLogs, expected)) {
    return baseResult(expected, 'EVENT_MISMATCH', receiptMetadata);
  }

  let authorizationState: unknown;
  let coverageState: unknown;
  try {
    [authorizationState, coverageState] = await Promise.all([
      client.readContract({
        abi: TOKEN_STATE_ABI, address: expected.configuration.bindings.token,
        functionName: 'authorizationState', args: [expected.intent.payer, expected.call.intentHash],
        blockNumber,
      }),
      client.readContract({
        abi: CORE_STATE_ABI, address: expected.configuration.bindings.core,
        functionName: 'coverages', args: [expected.call.intentHash],
        blockNumber,
      }),
    ]);
  } catch {
    return baseResult(expected, 'READ_FAILED', receiptMetadata);
  }
  if (authorizationState !== true || !coverageStateMatches(coverageState, expected)) {
    return baseResult(expected, 'STATE_MISMATCH', receiptMetadata);
  }

  let finalBlock: any;
  let finalHead: bigint;
  try {
    [finalBlock, finalHead] = await Promise.all([
      client.getBlock({ blockNumber }),
      client.getBlockNumber(),
    ]);
  } catch {
    return baseResult(expected, 'READ_FAILED', receiptMetadata);
  }
  if (!finalBlock || finalBlock.number !== blockNumber || typeof finalBlock.hash !== 'string'
      || finalBlock.hash.toLowerCase() !== blockHash.toLowerCase()) {
    return baseResult(expected, 'NONCANONICAL_BLOCK', receiptMetadata);
  }
  if (typeof finalHead !== 'bigint') return baseResult(expected, 'READ_FAILED', receiptMetadata);
  if (finalHead < blockNumber || finalHead - blockNumber + 1n < minConfirmations) {
    return baseResult(expected, 'INSUFFICIENT_CONFIRMATIONS', receiptMetadata);
  }
  return baseResult(expected, 'VERIFIED', {
    ...receiptMetadata,
    calldataBytes: (expected.call.data.length - 2) / 2,
  });
}
