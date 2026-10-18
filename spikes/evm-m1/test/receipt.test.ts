import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, parseAbi, toEventSelector, type Address, type Hex } from 'viem';
import { hashIntent, type Intent } from '../src/intent.js';
import type { PreparedCoreCall } from '../src/call.js';
import type { ProfileConfiguration } from '../src/profile.js';
import {
  verifySettlement, type ReceiptReadClient, type SettlementReceiptExpectation,
} from '../src/receipt.js';

const CORE = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const PAYER = '0x3333333333333333333333333333333333333333' as Address;
const RELAYER = '0x4444444444444444444444444444444444444444' as Address;
const PAYOUT = '0x5555555555555555555555555555555555555555' as Address;
const HASH = (nibble: string) => `0x${nibble.repeat(64)}` as Hex;
const TX_HASH = HASH('a');
const BLOCK_HASH = HASH('b');
const WRONG_HASH = HASH('c');
const PROVIDER_ID = HASH('d');
const POLICY_ID = HASH('e');
const POLICY_HASH = HASH('f');
const REQUEST_HASH = HASH('1');

const intent: Intent = {
  chainId: '84532', core: CORE, token: TOKEN, payer: PAYER,
  providerId: PROVIDER_ID, policyId: POLICY_ID, policyHash: POLICY_HASH,
  requestHash: REQUEST_HASH, gross: '100', payerSalt: HASH('2'),
  validAfter: '1000', validBefore: '1200',
};
const configuration: ProfileConfiguration = {
  bindings: {
    chainId: 84532n, core: CORE, token: TOKEN, providerId: PROVIDER_ID,
    policyId: POLICY_ID, policyHash: POLICY_HASH, requestHash: REQUEST_HASH,
  },
  providerPayout: PAYOUT, tokenName: 'USDC', tokenVersion: '2',
};
const intentHash = hashIntent(intent);
const call: PreparedCoreCall = { to: CORE, data: '0xabcdef01', intentHash, payer: PAYER };
const coverageAbi = parseAbi([
  'event CoverageOpened(bytes32 indexed coverageId,address indexed payer,bytes32 indexed providerId,bytes32 policyId,bytes32 requestHash,uint256 gross,uint256 net,uint256 premium)',
]);
const transferAbi = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const authorizationAbi = parseAbi([
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
]);

function encodeCoverage(args: {
  coverageId: Hex; payer: Address; providerId: Hex; policyId: Hex; requestHash: Hex;
  gross: bigint; net: bigint; premium: bigint;
}) {
  return {
    topics: encodeEventTopics({ abi: coverageAbi, eventName: 'CoverageOpened', args }),
    data: encodeAbiParameters([
      { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    ], [args.policyId, args.requestHash, args.gross, args.net, args.premium]),
  };
}

function encodeTransfer(args: { from: Address; to: Address; value: bigint }) {
  return {
    topics: encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args }),
    data: encodeAbiParameters([{ type: 'uint256' }], [args.value]),
  };
}

function encodeAuthorization(args: { authorizer: Address; nonce: Hex }) {
  return {
    topics: encodeEventTopics({ abi: authorizationAbi, eventName: 'AuthorizationUsed', args }),
    data: '0x' as Hex,
  };
}

function log(address: Address, encoded: { data: Hex; topics: readonly unknown[] }) {
  return {
    address, data: encoded.data, topics: [...encoded.topics] as Hex[],
    blockNumber: 10n, blockHash: BLOCK_HASH, transactionHash: TX_HASH,
    transactionIndex: 0, logIndex: 0, removed: false,
  };
}

function eventLogs() {
  const coverage = encodeCoverage({
    coverageId: intentHash, payer: PAYER, providerId: PROVIDER_ID,
    policyId: POLICY_ID, requestHash: REQUEST_HASH, gross: 100n, net: 93n, premium: 7n,
  });
  const payerTransfer = encodeTransfer({
    from: PAYER, to: CORE, value: 100n,
  });
  const providerTransfer = encodeTransfer({
    from: CORE, to: PAYOUT, value: 93n,
  });
  const authorization = encodeAuthorization({
    authorizer: PAYER, nonce: intentHash,
  });
  return [
    log(TOKEN, authorization),
    log(TOKEN, payerTransfer),
    log(TOKEN, providerTransfer),
    log(CORE, coverage),
  ];
}

function fixture() {
  const state = {
    head: 12n,
    canonicalHash: BLOCK_HASH as Hex,
    reorgOnSecondBlockRead: false,
    blockReads: 0,
    readBlockNumbers: [] as bigint[],
    nonce: true,
    coverage: [PAYER, REQUEST_HASH, 100n] as const,
    receipt: {
      transactionHash: TX_HASH, status: 'success', blockNumber: 10n, blockHash: BLOCK_HASH,
      gasUsed: 210_000n, effectiveGasPrice: 100n, logs: eventLogs(),
    } as any,
    transaction: {
      hash: TX_HASH, to: CORE, from: RELAYER, input: call.data,
      value: 0n, chainId: 84532n, blockNumber: 10n, blockHash: BLOCK_HASH,
    } as any,
  };
  const client: ReceiptReadClient = {
    async getChainId() { return 84532; },
    async getTransactionReceipt() { return state.receipt; },
    async getTransaction() { return state.transaction; },
    async getBlock({ blockNumber }) {
      state.blockReads++;
      const hash = state.reorgOnSecondBlockRead && state.blockReads > 1 ? WRONG_HASH : state.canonicalHash;
      return { number: blockNumber, hash, timestamp: 1_700_000_000n };
    },
    async getBlockNumber() { return state.head; },
    async readContract({ functionName, blockNumber }) {
      state.readBlockNumbers.push(blockNumber);
      if (functionName === 'authorizationState') return state.nonce;
      if (functionName === 'coverages') return state.coverage;
      throw new Error('UNEXPECTED_READ');
    },
  };
  const expected: SettlementReceiptExpectation = {
    call, configuration, intent, relayer: RELAYER, transaction: TX_HASH,
  };
  return { client, expected, state };
}

test('accepts the exact canonical settlement and reports only public receipt metadata', async () => {
  const { client, expected, state } = fixture();
  const result = await verifySettlement(client, expected);
  assert.deepEqual(result, {
    ok: true, code: 'VERIFIED', transaction: TX_HASH,
    blockNumber: 10n, blockHash: BLOCK_HASH, gasUsed: 210_000n,
    effectiveGasPrice: 100n, calldataBytes: 4,
  });
  assert.deepEqual(state.readBlockNumbers, [10n, 10n]);
});

test('reports absent or reverted receipts with fixed result codes', async () => {
  const missing = fixture();
  missing.state.receipt = null as any;
  assert.equal((await verifySettlement(missing.client, missing.expected)).code, 'RECEIPT_MISSING');

  const reverted = fixture();
  reverted.state.receipt.status = 'reverted';
  assert.equal((await verifySettlement(reverted.client, reverted.expected)).code, 'RECEIPT_FAILED');
});

test('requires exact transaction hash, destination, relayer, calldata, value, and chain', async () => {
  const cases: Array<(state: ReturnType<typeof fixture>['state']) => void> = [
    state => { state.transaction.to = PAYOUT; },
    state => { state.transaction.from = PAYER; },
    state => { state.transaction.input = '0x12345678'; },
    state => { state.transaction.value = 1n; },
    state => { state.transaction.chainId = 1n; },
    state => { state.transaction.blockNumber = 9n; },
    state => { state.transaction.blockHash = WRONG_HASH; },
    state => { state.transaction.hash = WRONG_HASH; },
    state => { state.receipt.transactionHash = WRONG_HASH; },
  ];
  for (const mutate of cases) {
    const sample = fixture();
    mutate(sample.state);
    assert.equal((await verifySettlement(sample.client, sample.expected)).code, 'TRANSACTION_MISMATCH');
  }
});

test('requires canonical block identity and configured confirmation depth', async () => {
  const wrongChain = fixture();
  wrongChain.client.getChainId = async () => 84531;
  assert.equal((await verifySettlement(wrongChain.client, wrongChain.expected)).code, 'CHAIN_MISMATCH');

  const initiallyNoncanonical = fixture();
  initiallyNoncanonical.state.canonicalHash = WRONG_HASH;
  assert.equal((await verifySettlement(initiallyNoncanonical.client, initiallyNoncanonical.expected)).code, 'NONCANONICAL_BLOCK');

  const reorgedDuringReads = fixture();
  reorgedDuringReads.state.reorgOnSecondBlockRead = true;
  assert.equal((await verifySettlement(reorgedDuringReads.client, reorgedDuringReads.expected)).code, 'NONCANONICAL_BLOCK');

  const shallow = fixture();
  shallow.state.head = 11n;
  assert.equal((await verifySettlement(shallow.client, { ...shallow.expected, minimumConfirmations: 3n })).code,
    'INSUFFICIENT_CONFIRMATIONS');

  const losesDepthDuringReads = fixture();
  let headReads = 0;
  losesDepthDuringReads.client.getBlockNumber = async () => (++headReads === 1 ? 12n : 10n);
  assert.equal((await verifySettlement(losesDepthDuringReads.client, {
    ...losesDepthDuringReads.expected, minimumConfirmations: 3n,
  })).code, 'INSUFFICIENT_CONFIRMATIONS');

  const unreasonableDepth = fixture();
  assert.equal((await verifySettlement(unreasonableDepth.client, {
    ...unreasonableDepth.expected, minimumConfirmations: 1001n,
  })).code, 'EXPECTATION_MISMATCH');
});

test('rejects missing, extra, malformed, or mismatched settlement logs', async () => {
  const cases: Array<(state: ReturnType<typeof fixture>['state']) => void> = [
    state => { state.receipt.logs = state.receipt.logs.filter((item: any) => item.address !== CORE); },
    state => { state.receipt.logs.push(state.receipt.logs[1]); },
    state => { state.receipt.logs[1].data = '0x'; },
    state => { state.receipt.logs = state.receipt.logs.filter((item: any) => !(item.address === TOKEN
      && item.topics[0] === toEventSelector(authorizationAbi[0]!))); },
    state => { state.receipt.logs[3] = log(CORE, encodeCoverage({
      coverageId: WRONG_HASH, payer: PAYER, providerId: PROVIDER_ID,
      policyId: POLICY_ID, requestHash: REQUEST_HASH, gross: 100n, net: 93n, premium: 7n,
    })); },
    state => { state.receipt.logs[2] = log(TOKEN, encodeTransfer({
      from: CORE, to: PAYOUT, value: 92n,
    })); },
    state => { state.receipt.logs[0] = log(TOKEN, encodeAuthorization({
      authorizer: PAYER, nonce: WRONG_HASH,
    })); },
  ];
  for (const mutate of cases) {
    const sample = fixture();
    mutate(sample.state);
    assert.equal((await verifySettlement(sample.client, sample.expected)).code, 'EVENT_MISMATCH');
  }
});

test('requires nonce and coverage state at the receipt block', async () => {
  const nonceMissing = fixture();
  nonceMissing.state.nonce = false;
  assert.equal((await verifySettlement(nonceMissing.client, nonceMissing.expected)).code, 'STATE_MISMATCH');

  const coverageWrong = fixture();
  coverageWrong.state.coverage = [PAYOUT, REQUEST_HASH, 100n];
  assert.equal((await verifySettlement(coverageWrong.client, coverageWrong.expected)).code, 'STATE_MISMATCH');

  const unreadable = fixture();
  unreadable.client.readContract = async () => { throw new Error('raw rpc diagnostics'); };
  const result = await verifySettlement(unreadable.client, unreadable.expected);
  assert.equal(result.code, 'READ_FAILED');
  assert.equal('message' in result, false);
});

test('rejects expectations that are internally inconsistent before reading chain state', async () => {
  const { client, expected } = fixture();
  const result = await verifySettlement(client, {
    ...expected,
    call: { ...expected.call, intentHash: WRONG_HASH },
  });
  assert.equal(result.code, 'EXPECTATION_MISMATCH');
});
