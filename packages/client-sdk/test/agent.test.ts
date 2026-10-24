import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTools } from '../src/agent.js';
import { createAgentTools as createPublicAgentTools } from '../src/index.js';
import type { Client, ClientPreview } from '../src/types.js';

const id = `0x${'1'.repeat(64)}` as `0x${string}`;
const preview = {
  requestId: id, requestHash: id, bodyHash: id, url: 'https://service.example/resource',
  payer: `0x${'2'.repeat(40)}`, serviceId: id, maxGross: '2', expiresAt: '100',
  terms: { chainId: 84532, core: `0x${'3'.repeat(40)}`, token: `0x${'4'.repeat(40)}`, providerId: id, policyId: id, policyHash: id, providerOwner: `0x${'5'.repeat(40)}`, providerPayout: `0x${'6'.repeat(40)}`, premiumBps: 1, stakeBps: 1, withholdingBps: 1, duration: '1', poolOnlyAllowed: false, gross: '2', premium: '1', withheld: '0', net: '1', stakeLock: '1', poolReservation: '0', tokenName: 'USDC', tokenVersion: '2', signature: 'private', rawTransaction: 'private' },
} as unknown as ClientPreview;

function harness(approval: (p: ClientPreview) => unknown) {
  const calls: string[] = [];
  const client = {
    async preview() { calls.push('preview'); return preview; },
    async authorize() { calls.push('authorize'); return { requestId: id, requestHash: id, coverageId: id }; },
    async send() { calls.push('send'); return { state: 'confirmed', body: new Uint8Array([1, 2]), requestId: id, requestHash: id, coverageId: id,
      status: 200, transaction: id, paymentBlock: { number: '1', hash: id },
      receipt: { chainId: '84532', core: `0x${'3'.repeat(40)}`, coverageId: id, requestHash: id, responseHash: id, status: 200, completedAt: '99', signature: 'secret' },
      receiptFingerprint: id, signature: 'secret', calldata: '0x', paymentHeader: 'secret', rawTransaction: 'raw', serializedTx: 'signed' }; },
    async retrieve() { calls.push('retrieve'); return { state: 'retrieval-required', requestId: id, requestHash: id, coverageId: id }; },
    async readState() { calls.push('state'); return { chainId: 84532, core: `0x${'3'.repeat(40)}`, token: `0x${'4'.repeat(40)}`, payer: `0x${'2'.repeat(40)}`, tokenBalanceAtomic: '3', observedBlock: { number: '1', hash: id, timestamp: '99' }, privatePath: '/secret', rawTransaction: 'raw' }; },
  } as unknown as Client;
  return { calls, tools: createAgentTools({ client, approvePayment: approval as (p: ClientPreview) => boolean }) };
}

test('tool schemas are fixed and deny unknown tool arguments', async () => {
  const { calls, tools } = harness(() => true);
  assert.deepEqual(tools.tools.map(t => t.name), ['assurepay_preview', 'assurepay_pay', 'assurepay_retrieve', 'assurepay_state']);
  assert.deepEqual(await tools.invoke('assurepay_pay', { requestId: id, approved: true }), { error: 'CLIENT_OPERATION_FAILED' });
  const hidden = { requestId: id };
  Object.defineProperty(hidden, 'approved', { value: true, enumerable: false });
  assert.deepEqual(await tools.invoke('assurepay_pay', hidden), { error: 'CLIENT_OPERATION_FAILED' });
  assert.deepEqual(await tools.invoke('assurepay_state', Object.create(null)), { error: 'CLIENT_OPERATION_FAILED' });
  assert.equal(calls.length, 0);
});

test('non-literal approval denies and consumes the adapter preview without authorize/send', async () => {
  const { calls, tools } = harness(() => 'true');
  const shown = await tools.invoke('assurepay_preview', { bodyBase64: 'AQI=' }) as Record<string, any>;
  assert.equal('signature' in shown.terms, false);
  assert.equal('rawTransaction' in shown.terms, false);
  const result = await tools.invoke('assurepay_pay', { requestId: id });
  assert.deepEqual(result, { state: 'denied', code: 'CLIENT_APPROVAL_DENIED' });
  assert.deepEqual(calls, ['preview']);
  await tools.invoke('assurepay_pay', { requestId: id });
  assert.deepEqual(calls, ['preview']);
});

test('approved call authorizes only adapter preview, consumes before callback, and returns JSON-safe body', async () => {
  let release!: (value: boolean) => void;
  const { calls, tools } = harness(() => new Promise<boolean>(resolve => { release = resolve; }));
  await tools.invoke('assurepay_preview', { bodyBase64: 'AQI=' });
  const first = tools.invoke('assurepay_pay', { requestId: id });
  await Promise.resolve();
  const second = await tools.invoke('assurepay_pay', { requestId: id });
  assert.deepEqual(second, { error: 'CLIENT_OPERATION_FAILED' });
  release(true);
  const result = await first as Record<string, unknown>;
  assert.equal(result.bodyBase64, 'AQI=');
  assert.equal('body' in result, false);
  assert.equal('signature' in result, false);
  assert.equal('calldata' in result, false);
  assert.equal('paymentHeader' in result, false);
  assert.equal('rawTransaction' in result, false);
  assert.equal('serializedTx' in result, false);
  assert.equal('rawTransaction' in result, false);
  assert.equal('paymentHeader' in result, false);
  const receipt = result.receipt as Record<string, unknown>;
  assert.equal('signature' in receipt, false);
  assert.deepEqual(calls, ['preview', 'authorize', 'send']);
});

test('base64/schema failures and private output fields fail closed or are stripped', async () => {
  const { calls, tools } = harness(() => false);
  assert.deepEqual(await tools.invoke('assurepay_preview', { bodyBase64: 'AQI', signer: 'x' }), { error: 'CLIENT_OPERATION_FAILED' });
  assert.deepEqual(await tools.invoke('assurepay_state', { extra: 1 }), { error: 'CLIENT_OPERATION_FAILED' });
  const state = await tools.invoke('assurepay_state', {}) as Record<string, unknown>;
  assert.equal('privatePath' in state, false);
  assert.deepEqual(calls, ['state']);
});

test('concurrent preview calls cannot exceed the volatile capability limit', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let previewCalls = 0;
  const client = {
    async preview() { previewCalls += 1; await gate; return { ...preview, requestId: `0x${String(previewCalls).padStart(64, '0')}` }; },
    async authorize() { return { requestId: id, requestHash: id, coverageId: id }; }, async send() { return {}; },
    async retrieve() { return {}; }, async readState() { return {}; },
  } as unknown as Client;
  const tools = createAgentTools({ client, approvePayment: () => false });
  const attempts = Array.from({ length: 40 }, (_, n) => tools.invoke('assurepay_preview', { bodyBase64: Buffer.from([n]).toString('base64') }));
  await Promise.resolve();
  assert.equal(previewCalls, 32);
  release();
  await Promise.all(attempts);
  assert.equal(previewCalls, 32);
});

test('oversized response bodies fail closed instead of exceeding the bounded tool output', async () => {
  const client = {
    async preview() { return preview; },
    async authorize() { return { requestId: id, requestHash: id, coverageId: id }; },
    async send() { return { state: 'confirmed', body: new Uint8Array(65_537), requestId: id, requestHash: id, coverageId: id }; },
    async retrieve() { return {}; }, async readState() { return {}; },
  } as unknown as Client;
  const tools = createAgentTools({ client, approvePayment: () => true });
  await tools.invoke('assurepay_preview', { bodyBase64: 'AQI=' });
  assert.deepEqual(await tools.invoke('assurepay_pay', { requestId: id }), { error: 'CLIENT_OPERATION_FAILED', requestId: id });
});

test('known request errors expose only allowlisted codes and the original request ID', async () => {
  const client = {
    async preview() { throw new Error('PREVIEW_STALE'); },
    async authorize() { return {}; }, async send() { return {}; },
    async retrieve() { throw new Error('PREVIEW_STALE'); }, async readState() { return {}; },
  } as unknown as Client;
  const tools = createAgentTools({ client, approvePayment: () => false });
  assert.deepEqual(await tools.invoke('assurepay_retrieve', { requestId: id }), { error: 'CLIENT_PREVIEW_STALE', requestId: id });
  const previewError = await tools.invoke('assurepay_preview', { bodyBase64: 'AQI=' });
  assert.deepEqual(previewError, { error: 'CLIENT_PREVIEW_STALE' });
});

test('throwing getters and proxies cannot escape safe request error handling', async () => {
  const client = {
    async preview() { return preview; }, async authorize() { return {}; }, async send() { return {}; },
    async retrieve() { throw Error('CLIENT_PREVIEW_EXPIRED'); }, async readState() { return {}; },
  } as unknown as Client;
  const tools = createAgentTools({ client, approvePayment: () => false });
  const getterArgs = Object.defineProperty({}, 'requestId', { enumerable: true, get() { throw Error('PRIVATE_GETTER_TEXT'); } });
  assert.deepEqual(await tools.invoke('assurepay_retrieve', getterArgs), { error: 'CLIENT_OPERATION_FAILED' });
  const proxyArgs = new Proxy({ requestId: id }, {
    get(target, property, receiver) {
      if (property === 'requestId') throw Error('PRIVATE_PROXY_TEXT');
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual(await tools.invoke('assurepay_retrieve', proxyArgs), { error: 'CLIENT_PREVIEW_EXPIRED', requestId: id });
});

test('public root adapter wraps constructor failures in the safe error vocabulary', () => {
  const client = Object.defineProperty({}, 'preview', { get() { throw Error('PRIVATE_CONSTRUCTOR_DETAIL'); } });
  assert.throws(() => createPublicAgentTools({ client: client as Client, approvePayment: () => false }), {
    message: 'CLIENT_OPERATION_FAILED',
  });
});
