import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from 'viem';
import { readTerms, verifySettlement } from '../src/chain.js';
import { PaymentStore, safeTermsHash, type PaymentRecord } from '../src/payment-store.js';
import type { Terms, Trust } from '../src/types.js';

const addr = (n: string) => `0x${n.padStart(40, '0')}` as Address;
const id = (n: string) => `0x${n.padStart(64, '0')}` as Hex;
const trust: Trust = { chainId: 84532, core: addr('c0'), token: addr('70'), providerId: id('1'), policyId: id('2') };
const typehash = keccak256(new TextEncoder().encode('AssuredPolicyV1(bytes32 providerId,bytes32 policyId,address providerOwner,address providerPayout,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)'));
const domainTypehash = keccak256(new TextEncoder().encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const domain = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32,uint256,address'),
  [domainTypehash, keccak256(new TextEncoder().encode('USDC')), keccak256(new TextEncoder().encode('2')), 84532n, trust.token]));
const owner = addr('a1'), payout = addr('a2');
const policyHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32,address,address,uint16,uint16,uint16,uint64,bool'),
  [typehash, trust.providerId, trust.policyId, owner, payout, 500, 2500, 1000, 3600n, true]));

function mockReader(overrides: Record<string, unknown> = {}) {
  return {
    async getChainId() { return 84532; },
    async getBlock(args: any) { return args.blockTag ? { number: 8n, hash: id('8') } : { number: 8n, hash: id('8') }; },
    async getCode() { return '0x6001'; },
    async readContract(args: any) {
      const key = args.functionName;
      const values: Record<string, unknown> = {
        token: trust.token,
        providers: [owner, payout, 0n, 0n],
        policies: [trust.providerId, policyHash, 500, 2500, 1000, 3600n, true],
        quoteSettlement: [500n, 950n, 8550n, 2500n, 10000n],
        name: 'USDC', version: '2', decimals: 6, DOMAIN_SEPARATOR: domain,
      };
      return Object.hasOwn(overrides, key) ? overrides[key] : values[key];
    },
  };
}

test('readTerms returns a policy-verified integer quote from one canonical block', async () => {
  const terms = await readTerms(mockReader(), trust, '10000');
  assert.equal(terms.policyHash, policyHash);
  assert.equal(terms.gross, '10000');
  assert.equal(terms.premium, '500');
  assert.equal(terms.withheld, '950');
  assert.equal(terms.net, '8550');
  assert.equal(terms.poolReservation, '10000');
  assert.equal(terms.duration, '3600');
});

test('readTerms rejects wrong domain, noncanonical amount, and a policy hash mismatch', async () => {
  await assert.rejects(readTerms(mockReader(), trust, '010000'), { message: 'CHAIN_TERMS_INVALID' });
  await assert.rejects(readTerms(mockReader({ name: 'Other Token' }), trust, '10000'), { message: 'CHAIN_TERMS_INVALID' });
  await assert.rejects(readTerms(mockReader({ decimals: 18 }), trust, '10000'), { message: 'CHAIN_TERMS_INVALID' });
  await assert.rejects(readTerms(mockReader({ DOMAIN_SEPARATOR: id('9') }), trust, '10000'), { message: 'CHAIN_TERMS_INVALID' });
  await assert.rejects(readTerms(mockReader({ quoteSettlement: [50n, 995n, 8955n, 2500n, 10000n] }), trust, '10000'), { message: 'CHAIN_TERMS_INVALID' });
  await assert.rejects(readTerms(mockReader({ policies: [trust.providerId, id('9'), 500, 2500, 1000, 3600n, true] }), trust, '10000'), { message: 'CHAIN_TERMS_INVALID' });
  await assert.rejects(readTerms(mockReader(), { ...trust, chainId: 1 } as unknown as Trust, '10000'), { message: 'CHAIN_TERMS_INVALID' });
});

function testTerms(): Terms {
  return { ...trust, providerOwner: owner, providerPayout: payout, policyHash,
    premiumBps: 500, stakeBps: 2500, withholdingBps: 1000, duration: '3600', poolOnlyAllowed: true,
    gross: '10000', premium: '500', withheld: '950', net: '8550', stakeLock: '2500', poolReservation: '10000',
    tokenName: 'USDC', tokenVersion: '2' };
}

test('payment store durably records public identity and rejects replacement or context tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assurepay-store-'));
  try {
    const path = join(dir, 'payments.json');
    const terms = testTerms();
    const namespace = { chainId: 84532, core: trust.core, token: trust.token, relayer: addr('a3'), termsHash: safeTermsHash(terms) };
    const store = new PaymentStore(path, namespace);
    const record: PaymentRecord = { version: 1, chainId: 84532, core: trust.core, token: trust.token,
      relayer: addr('a3'), intentHash: id('3'), calldataHash: id('4'), nonce: '7', transaction: id('5'),
      termsHash: namespace.termsHash, terms, status: 'prepared', coverageId: id('3') };
    await store.create(record);
    assert.deepEqual(await new PaymentStore(path, namespace).get(id('3')), record);
    const raw = await readFile(path, 'utf8');
    assert.equal(raw.includes('signature'), false);
    assert.equal(raw.includes('signedBytes'), false);
    await assert.rejects(store.create(record), { message: 'PAYMENT_ALREADY_RECORDED' });
    await assert.rejects(store.update({ ...record, transaction: id('6') }), { message: 'PAYMENT_JOURNAL_MISMATCH' });
    await assert.rejects(new PaymentStore(path, { ...namespace, relayer: addr('a4') }).get(id('3')), { message: 'PAYMENT_JOURNAL_UNAVAILABLE' });
    const injected = { ...record, unexpected: 'field' } as PaymentRecord;
    await assert.rejects(store.create({ ...injected, intentHash: id('6'), coverageId: id('6') }), { message: 'PAYMENT_JOURNAL_UNAVAILABLE' });
    await assert.rejects(store.update({ ...record, terms: { ...terms, gross: '9999' } }), { message: 'PAYMENT_JOURNAL_MISMATCH' });
    await store.update({ ...record, status: 'confirmed', blockNumber: '8', blockHash: id('8') });
    await assert.rejects(store.update({ ...record, status: 'pending', blockNumber: '8', blockHash: id('8') }), { message: 'PAYMENT_JOURNAL_MISMATCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('payment store rejects a symlinked journal instead of following it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assurepay-store-link-'));
  try {
    const target = join(dir, 'target.json'), path = join(dir, 'payments.json');
    await writeFile(target, '{}');
    await symlink(target, path);
    const terms = testTerms();
    const namespace = { chainId: 84532, core: trust.core, token: trust.token, relayer: addr('a3'), termsHash: safeTermsHash(terms) };
    await assert.rejects(new PaymentStore(path, namespace).list(), { message: 'PAYMENT_JOURNAL_UNAVAILABLE' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('settlement verification binds the full transaction receipt and exact financial logs', async () => {
  const terms = testTerms();
  const relayer = addr('a3'), payer = addr('a4'), hash = id('5'), coverageId = id('3'), blockHash = id('8');
  const call = { intent: { chainId: '84532', core: terms.core, token: terms.token, payer, providerId: terms.providerId,
    policyId: terms.policyId, policyHash: terms.policyHash, requestHash: id('6'), gross: terms.gross, payerSalt: id('7'),
    validAfter: '1', validBefore: '9999999999' }, intentHash: coverageId, signature: '0x' as Hex, to: terms.core, data: '0x1234' as Hex };
  const topic = (value: Hex) => value;
  const addressTopic = (value: Address) => encodeAbiParameters(parseAbiParameters('address'), [value]);
  const logs = [
    { address: terms.core, topics: [topic(keccak256(new TextEncoder().encode('CoverageOpened(bytes32,address,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint64)'))), coverageId, addressTopic(payer), terms.providerId],
      data: encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint64'),
        [terms.policyId, call.intent.requestHash, 10000n, 500n, 950n, 8550n, 2500n, 10000n, 3680n]) },
    { address: terms.token, topics: [keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')), addressTopic(payer), addressTopic(terms.core)], data: encodeAbiParameters(parseAbiParameters('uint256'), [10000n]) },
    { address: terms.token, topics: [keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')), addressTopic(terms.core), addressTopic(terms.providerPayout)], data: encodeAbiParameters(parseAbiParameters('uint256'), [8550n]) },
    { address: terms.token, topics: [keccak256(new TextEncoder().encode('AuthorizationUsed(address,bytes32)')), addressTopic(payer), coverageId], data: '0x' },
  ];
  let receiptHash = hash;
  const client = {
    async getChainId() { return 84532; },
    async getTransaction() { return { hash, to: terms.core, from: relayer, input: call.data, value: 0n, chainId: 84532,
      nonce: 7n, blockNumber: 8n, blockHash }; },
    async getTransactionReceipt() { return { transactionHash: receiptHash, blockNumber: 8n, blockHash, status: 'success', logs }; },
    async getBlock() { return { hash: blockHash, timestamp: 80n }; },
    async getBlockNumber() { return 8n; },
    async readContract({ functionName }: any) { return functionName === 'authorizationState' ? true : [payer, terms.providerId,
      terms.policyId, terms.policyHash, call.intent.requestHash, 10000n, 500n, 950n, 2500n, 10000n, 80n, 3680n, true, 1, id('0'), id('0'), 0n, 0]; },
  };
  assert.equal((await verifySettlement(client, terms, call, hash, relayer, 1, 7n)).state, 'confirmed');
  receiptHash = id('9');
  assert.equal((await verifySettlement(client, terms, call, hash, relayer, 1, 7n)).state, 'pending');
});
