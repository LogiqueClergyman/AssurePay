import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { authorizePurchase, createPurchase, createPurchasePreview } from '../src/http-client.js';
import { requirementsFor } from '../src/protocol.js';
import { hashRequest } from '../src/canonical.js';
import type { Terms, Trust } from '../src/types.js';

const account = privateKeyToAccount(generatePrivateKey());
const terms: Terms = { chainId: 84532, core: '0x1000000000000000000000000000000000000001', token: '0x2000000000000000000000000000000000000002',
  providerId: `0x${'31'.repeat(32)}`, policyId: `0x${'32'.repeat(32)}`, providerOwner: '0x3000000000000000000000000000000000000003',
  providerPayout: '0x4000000000000000000000000000000000000004', policyHash: `0x${'33'.repeat(32)}`, premiumBps: 700, stakeBps: 500,
  withholdingBps: 0, duration: '3600', poolOnlyAllowed: false, gross: '1000000', premium: '70000', withheld: '0', net: '930000',
  stakeLock: '50000', poolReservation: '950000', tokenName: 'USDC', tokenVersion: '2' };
const trust: Trust = { chainId: 84532, core: terms.core, token: terms.token, providerId: terms.providerId, policyId: terms.policyId };
const id = `0x${'44'.repeat(32)}` as Hex;
const tx = `0x${'aa'.repeat(32)}` as Hex;
function challenge(body: Uint8Array, amount = terms.gross): Response {
  const requestHash = hashRequest('POST', 'https://api.example.test/assured', 'application/octet-stream', body, id);
  return new Response(new Uint8Array(), { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader({ x402Version: 2,
    resource: { url: 'https://api.example.test/assured' }, accepts: [{ ...requirementsFor(terms, requestHash), amount }] } as any) } });
}
function args(fetcher: typeof fetch, requestId = id) {
  return { url: 'https://api.example.test/assured', body: new Uint8Array([1, 2, 3]), payer: account.address.toLowerCase() as Address,
    trust, maxGross: terms.gross, readTerms: async () => ({ ...terms }), fetch: fetcher, createRequestId: () => requestId };
}

test('unsigned preview does not sign; authorization re-challenges same id/body and signs once', async () => {
  const seen: Array<{ id: string | null; body: number[]; paid: boolean }> = [];
  let signs = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ id: headers.get('assurepay-request-id'), body: Array.from(new Uint8Array(init?.body as ArrayBuffer)), paid: headers.has('payment-signature') });
    return challenge(new Uint8Array(init?.body as Uint8Array));
  };
  const preview = await createPurchasePreview(args(fetcher));
  assert.equal(signs, 0);
  assert.equal(seen.length, 1);
  const session = await authorizePurchase(preview, { payer: { address: account.address as Address, async signTypedData(data) { signs++; return account.signTypedData(data); } },
    readTerms: async () => ({ ...terms }), now: () => 1_800_000_000n,
    verifyPayment: async ({ call }) => ({ state: 'confirmed', transaction: tx, coverageId: call.intentHash }), fetch: fetcher });
  assert.equal(signs, 1);
  assert.deepEqual(seen.map(x => x.id), [id, id]);
  assert.deepEqual(seen.map(x => x.body), [[1, 2, 3], [1, 2, 3]]);
  assert.deepEqual(seen.map(x => x.paid), [false, false]);
  assert.equal(session.requestId, id);
});

test('authorization rejects changed quote and mutated preview before signing', async () => {
  let signs = 0;
  let challengeCount = 0;
  const fetcher: typeof fetch = async (_url, init) => { challengeCount++; return challenge(new Uint8Array(init?.body as Uint8Array), challengeCount === 1 ? terms.gross : '999999'); };
  const preview = await createPurchasePreview(args(fetcher));
  await assert.rejects(authorizePurchase(preview, { payer: { address: account.address as Address, async signTypedData(data) { signs++; return account.signTypedData(data); } },
    readTerms: async () => ({ ...terms }), now: () => 1_800_000_000n,
    verifyPayment: async ({ call }) => ({ state: 'confirmed', transaction: tx, coverageId: call.intentHash }), fetch: fetcher }), /PREVIEW_STALE/);
  assert.equal(signs, 0);
  assert.equal(challengeCount, 2);
  const stableFetcher: typeof fetch = async (_url, init) => challenge(new Uint8Array(init?.body as Uint8Array));
  const changed = await createPurchasePreview(args(stableFetcher));
  changed.body[0] = 9;
  await assert.rejects(authorizePurchase(changed, { payer: { address: account.address as Address, async signTypedData(data) { signs++; return account.signTypedData(data); } },
    readTerms: async () => ({ ...terms }), now: () => 1_800_000_000n,
    verifyPayment: async ({ call }) => ({ state: 'confirmed', transaction: tx, coverageId: call.intentHash }), fetch: stableFetcher }), /PREVIEW_STALE/);
  assert.equal(signs, 0);
});

test('legacy createPurchase still validates one challenge and signs without a second challenge', async () => {
  let challenges = 0, signs = 0;
  const fetcher: typeof fetch = async (_url, init) => { challenges++; return challenge(new Uint8Array(init?.body as Uint8Array)); };
  await createPurchase({ ...args(fetcher), payer: { address: account.address as Address, async signTypedData(data) { signs++; return account.signTypedData(data); } },
    now: () => 1_800_000_000n, verifyPayment: async ({ call }) => ({ state: 'confirmed', transaction: tx, coverageId: call.intentHash }) });
  assert.equal(challenges, 1);
  assert.equal(signs, 1);
});

test('purchase and preview capture caller callbacks before awaiting the challenge', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let originalRead = 0, replacementRead = 0, originalSign = 0, replacementSign = 0, originalClock = 0, replacementFetch = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    entered(); await gate;
    return challenge(new Uint8Array(init?.body as Uint8Array));
  };
  const previewOptions = args(fetcher) as ReturnType<typeof args> & { readTerms: (trust: Trust, gross: string) => Promise<Terms> };
  previewOptions.readTerms = async () => { originalRead++; return { ...terms }; };
  const pendingPreview = createPurchasePreview(previewOptions);
  await ready;
  previewOptions.readTerms = async () => { replacementRead++; return { ...terms }; };
  release();
  await pendingPreview;
  assert.equal(originalRead, 1);
  assert.equal(replacementRead, 0);

  let enteredPurchase!: () => void, releasePurchase!: () => void;
  const purchaseReady = new Promise<void>(resolve => { enteredPurchase = resolve; });
  const purchaseGate = new Promise<void>(resolve => { releasePurchase = resolve; });
  const capturedFetch: typeof fetch = async (_url, init) => {
    enteredPurchase(); await purchaseGate;
    return challenge(new Uint8Array(init?.body as Uint8Array));
  };
  const options = { ...args(capturedFetch), payer: { address: account.address as Address, async signTypedData(data: any) { originalSign++; return account.signTypedData(data); } },
    now: async () => { originalClock++; return 1_800_000_000n; },
    verifyPayment: async ({ call }: any) => ({ state: 'confirmed' as const, transaction: tx, coverageId: call.intentHash }) };
  const pendingPurchase = createPurchase(options);
  await purchaseReady;
  options.payer.signTypedData = async () => { replacementSign++; return `0x${'11'.repeat(65)}` as Hex; };
  options.now = async () => { replacementSign++; throw new Error('mutated clock'); };
  options.fetch = async () => { replacementFetch++; throw new Error('mutated fetch'); };
  releasePurchase();
  await pendingPurchase;
  assert.equal(originalSign, 1);
  assert.equal(replacementSign, 0);
  assert.equal(originalClock, 1);
  assert.equal(replacementFetch, 0);
});
