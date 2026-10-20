import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { PaymentResult, Terms, Trust } from '../src/types.js';
import { createPurchase } from '../src/http-client.js';
import { startProvider } from '../src/http-provider.js';
import { ServiceStore } from '../src/service-store.js';
import { prepareCall, requirementsFor } from '../src/protocol.js';
import { encodePaymentRequiredHeader, encodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { hashRequest } from '../src/canonical.js';
import { makeReceiptMessage, signReceipt } from '../src/receipt.js';

const payer = privateKeyToAccount(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const terms: Terms = {
  chainId: 84532,
  core: '0x1000000000000000000000000000000000000001',
  token: '0x2000000000000000000000000000000000000002',
  providerId: `0x${'31'.repeat(32)}`,
  policyId: `0x${'32'.repeat(32)}`,
  providerOwner: owner.address.toLowerCase() as Address,
  providerPayout: '0x3000000000000000000000000000000000000003',
  policyHash: `0x${'33'.repeat(32)}`,
  premiumBps: 700,
  stakeBps: 500,
  withholdingBps: 0,
  duration: '3600',
  poolOnlyAllowed: false,
  gross: '1000000',
  premium: '70000',
  withheld: '0',
  net: '930000',
  stakeLock: '50000',
  poolReservation: '950000',
  tokenName: 'USDC',
  tokenVersion: '2',
};
const trust: Trust = { chainId: 84532, core: terms.core, token: terms.token, providerId: terms.providerId, policyId: terms.policyId };
const transaction = `0x${'aa'.repeat(32)}` as Hex;

test('localhost registered x402 HTTP purchase retries the exact payment and serves once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assurepay-http-'));
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const url = `http://127.0.0.1:${port}/assured`;
  let handlerRuns = 0;
  let engineRuns = 0;
  const resultFor = (coverageId: Hex): PaymentResult => ({ state: 'confirmed', transaction, coverageId });
  const provider = await startProvider({
    terms,
    engine: { async settle(call) { engineRuns++; return resultFor(call.intentHash); } },
    signer: { address: owner.address, signTypedData: data => owner.signTypedData(data) },
    handler: async body => { handlerRuns++; return Uint8Array.from([...body, 0xee]); },
    journalPath: join(dir, 'service.jsonl'),
    resourceUrl: url,
    canServe: async () => true,
    prepareCall: (payment, requestHash) => prepareCall(payment, terms, requestHash, 0n, { allowExpired: true }),
  });
  try {
    const body = new Uint8Array([0, 4, 8, 255]);
    const session = await createPurchase({
      url,
      body,
      payer: { address: payer.address.toLowerCase() as Address, signTypedData: data => payer.signTypedData(data) },
      trust,
      maxGross: '1000000',
      readTerms: async (_t, gross) => { assert.equal(gross, terms.gross); return { ...terms }; },
      now: () => 1_800_000_000n,
      verifyPayment: async ({ call }) => resultFor(call.intentHash),
    });
    const first = await session.send();
    const retry = await session.retry();
    assert.equal(first.status, 200);
    assert.equal(first.paid, true);
    assert.deepEqual(first.body, new Uint8Array([0, 4, 8, 255, 0xee]));
    assert.equal(retry.status, first.status);
    assert.deepEqual(retry.body, first.body);
    assert.equal(retry.receipt?.signature, first.receipt?.signature);
    assert.equal(handlerRuns, 1);
    assert.equal(engineRuns, 1);
  } finally {
    await provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('client reads the challenge before terms and rejects a challenge over its cap', async () => {
  let reads = 0;
  let signs = 0;
  const fetcher: typeof fetch = async () => new Response(new Uint8Array(), {
    status: 402,
    headers: { 'payment-required': encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: 'https://api.example.test/assured', description: 'resource' },
      accepts: [{ ...requirementsFor(terms, `0x${'44'.repeat(32)}` as Hex), amount: '1000001' }],
    } as any) },
  });
  await assert.rejects(() => createPurchase({
    url: 'https://api.example.test/assured', body: new Uint8Array([1]),
    payer: { address: payer.address as Address, signTypedData: async data => { signs++; return payer.signTypedData(data); } },
    trust, maxGross: terms.gross,
    readTerms: async () => { reads++; return terms; },
    now: () => 1_800_000_000,
    verifyPayment: async () => ({ state: 'invalid', transaction: '', coverageId: `0x${'00'.repeat(32)}` }),
    fetch: fetcher,
    createRequestId: () => `0x${'44'.repeat(32)}` as Hex,
  }), /UNTRUSTED_PAYMENT_REQUIREMENTS/);
  assert.equal(reads, 0);
  assert.equal(signs, 0);
});

test('client rejects response byte, status, signer-bound coverage, redirect, and profile tampering', async () => {
  const url = 'https://api.example.test/assured';
  const requestId = `0x${'62'.repeat(32)}` as Hex;
  const body = new Uint8Array([1, 9, 2]);
  const requestHash = hashRequest('POST', url, 'application/octet-stream', body, requestId);
  const validBody = new Uint8Array([0xa1]);
  const cases = [
    { responseBody: new Uint8Array([0xa2]), responseStatus: 200, receiptCoverage: 'call' as const },
    { responseBody: validBody, responseStatus: 201, receiptCoverage: 'call' as const },
    { responseBody: validBody, responseStatus: 200, receiptCoverage: 'other' as const },
  ];
  for (const scenario of cases) {
    let paymentCalls = 0;
    let coverageId: Hex | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      if (!new Headers(init?.headers).has('payment-signature')) {
        return new Response(new Uint8Array(), { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader({
          x402Version: 2, resource: { url, description: 'resource' }, accepts: [requirementsFor(terms, requestHash)],
        } as any) } });
      }
      paymentCalls++;
      const receiptCoverage = scenario.receiptCoverage === 'call' ? coverageId! : `0x${'63'.repeat(32)}` as Hex;
      const message = makeReceiptMessage({ terms, coverageId: receiptCoverage, requestHash, response: validBody, status: 200, completedAt: 1_800_000_001n });
      const receipt = await signReceipt(message, { address: owner.address, signTypedData: data => owner.signTypedData(data) });
      return new Response(scenario.responseBody, { status: scenario.responseStatus, headers: {
        'payment-response': encodePaymentResponseHeader({ success: true, transaction, network: 'eip155:84532' } as any),
        'assurepay-receipt': Buffer.from(JSON.stringify(receipt)).toString('base64'),
      } });
    };
    const session = await createPurchase({
      url, body, payer: { address: payer.address as Address, signTypedData: data => payer.signTypedData(data) }, trust,
      maxGross: terms.gross, readTerms: async () => terms, now: () => 1_800_000_000,
      verifyPayment: async ({ call }) => ({ state: 'confirmed', transaction, coverageId: call.intentHash }),
      fetch: fetcher, createRequestId: () => requestId,
    });
    coverageId = session.call.intentHash;
    await assert.rejects(() => session.send(), /INVALID_RESPONSE_RECEIPT/);
    assert.equal(paymentCalls, 1);
  }

  const unsupportedFetcher: typeof fetch = async () => {
    const unsupported = structuredClone(requirementsFor(terms, requestHash)) as any;
    unsupported.extra.profile = 'unsupported-profile';
    return new Response(new Uint8Array(), { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader({
      x402Version: 2, resource: { url, description: 'resource' }, accepts: [unsupported],
    } as any) } });
  };
  await assert.rejects(() => createPurchase({
    url, body, payer: { address: payer.address as Address, signTypedData: async data => payer.signTypedData(data) }, trust,
    maxGross: terms.gross, readTerms: async () => terms, now: () => 1_800_000_000,
    verifyPayment: async () => ({ state: 'invalid', transaction: '', coverageId: `0x${'00'.repeat(32)}` }),
    fetch: unsupportedFetcher, createRequestId: () => requestId,
  }), /UNTRUSTED_PAYMENT_REQUIREMENTS/);

  await assert.rejects(() => createPurchase({
    url, body, payer: { address: payer.address as Address, signTypedData: async data => payer.signTypedData(data) }, trust,
    maxGross: terms.gross, readTerms: async () => terms, now: () => 1_800_000_000,
    verifyPayment: async () => ({ state: 'invalid', transaction: '', coverageId: `0x${'00'.repeat(32)}` }),
    fetch: async (_input, init) => {
      assert.equal(init?.redirect, 'error');
      return new Response(null, { status: 302, headers: { location: url } });
    },
    createRequestId: () => requestId,
  }), /EXPECTED_PAYMENT_CHALLENGE/);
});

test('concurrent raw paid duplicates that arrive after the durable start share the live response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assurepay-http-flight-'));
  const url = `http://127.0.0.1:${30_000 + Math.floor(Math.random() * 20_000)}/assured`;
  let handlerRuns = 0;
  let engineRuns = 0;
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const provider = await startProvider({
    terms,
    engine: { async settle(call) { engineRuns++; return { state: 'confirmed', transaction, coverageId: call.intentHash }; } },
    signer: { address: owner.address, signTypedData: data => owner.signTypedData(data) },
    handler: async body => { handlerRuns++; markEntered(); await blocked; return Uint8Array.from(body); },
    journalPath: join(dir, 'service.jsonl'),
    resourceUrl: url,
    canServe: async () => true,
    prepareCall: (payment, requestHash) => prepareCall(payment, terms, requestHash, 0n, { allowExpired: true }),
  });
  try {
    const body = new Uint8Array([7, 6, 5]);
    const requestId = `0x${'61'.repeat(32)}` as Hex;
    const purchase = await createPurchase({
      url, body, payer: { address: payer.address as Address, signTypedData: data => payer.signTypedData(data) }, trust,
      maxGross: terms.gross, readTerms: async () => terms, now: () => 1_800_000_000,
      verifyPayment: async ({ call }) => ({ state: 'confirmed', transaction, coverageId: call.intentHash }),
      createRequestId: () => requestId,
    });
    const init = { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'assurepay-request-id': requestId, 'payment-signature': encodePaymentSignatureHeader(purchase.payment) }, body: Buffer.from(body) };
    const first = fetch(url, init);
    await entered;
    const second = fetch(url, init);
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(new Uint8Array(await a.arrayBuffer()), body);
    assert.deepEqual(new Uint8Array(await b.arrayBuffer()), body);
    assert.equal(a.headers.get('assurepay-receipt'), b.headers.get('assurepay-receipt'));
    assert.equal(handlerRuns, 1);
    assert.equal(engineRuns, 1);
  } finally {
    release();
    await provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('service journal binds one context and enforces reservation then start then completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assurepay-store-'));
  const path = join(dir, 'service.jsonl');
  const coverageId = `0x${'51'.repeat(32)}` as Hex;
  const requestHash = `0x${'52'.repeat(32)}` as Hex;
  try {
    const store = await ServiceStore.open(path, 'terms-and-url-A');
    const otherCoverage = `0x${'54'.repeat(32)}` as Hex;
    const otherRequest = `0x${'55'.repeat(32)}` as Hex;
    await Promise.all([
      store.reserve(coverageId, requestHash, coverageId),
      store.reserve(otherCoverage, otherRequest, otherCoverage),
    ]);
    assert.equal(await store.reserve(`0x${'56'.repeat(32)}` as Hex, requestHash, `0x${'56'.repeat(32)}` as Hex), 'exists');
    assert.equal(await store.start(coverageId, requestHash, transaction), 'started');
    await store.complete(coverageId, requestHash, transaction, 200, `0x${'53'.repeat(32)}` as Hex, '1800000000');
    assert.equal((await ServiceStore.open(path, 'terms-and-url-A')).getByRequest(requestHash)?.state, 'completed');
    await assert.rejects(() => ServiceStore.open(path, 'terms-and-url-B'), /SERVICE_JOURNAL_CONTEXT_MISMATCH/);
    const content = await readFile(path, 'utf8');
    assert.equal(content.includes('PAYMENT-SIGNATURE'), false);
    await assert.rejects(() => store.complete(coverageId, requestHash, transaction, 200, `0x${'53'.repeat(32)}` as Hex, '1800000001'), /SERVICE_JOURNAL_STATE/);
    const badPath = join(dir, 'bad.jsonl');
    await writeFile(badPath, `${JSON.stringify({ version: 1, context: 'terms-and-url-A' })}\n${JSON.stringify({ coverageId, requestHash, state: 'reserved', intentHash: `0x${'57'.repeat(32)}` })}\n`);
    await assert.rejects(() => ServiceStore.open(badPath, 'terms-and-url-A'), /SERVICE_JOURNAL_CORRUPT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
