import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentTools, createClient } from '../src/index.js';
import { createPilotFixture } from '../../developer-pilot/test/helpers.js';
import { startPilotProvider } from '../../developer-pilot/src/provider.js';
import { createClients } from '../../developer-pilot/src/config.js';
import type { Client } from '../src/types.js';

const idPattern = /^0x[0-9a-f]{64}$/;

test('skill host flow denies, explicitly approves once, and retrieves uncertain payment by original ID after restart', async () => {
  const f = await createPilotFixture();
  const clients = createClients(f.config);
  let runtime: Awaited<ReturnType<typeof startPilotProvider>> | undefined;
  let sdk: Client | undefined;
  const ordinaryFetch = globalThis.fetch;
  const counts = { payerSignatures: 0, relayerSignatures: 0, broadcasts: 0, handlers: 0, approvals: 0 };
  let dropPaidResponse = true, hostAllowsPayment = false;
  const payer = { ...f.accounts.payer, async signTypedData(data: any) {
    if (data.primaryType === 'ReceiveWithAuthorization') counts.payerSignatures += 1;
    return f.accounts.payer.signTypedData(data);
  } };
  const client = new Proxy(clients.client, { get(target, property) {
    if (property === 'sendRawTransaction') return async (...args: any[]) => {
      counts.broadcasts += 1; return (target as any).sendRawTransaction(...args);
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const wallet = new Proxy(clients.wallet, { get(target, property) {
    if (property === 'signTransaction') return async (...args: any[]) => {
      counts.relayerSignatures += 1; return (target as any).signTransaction(...args);
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const body = new TextEncoder().encode('host-approved exact request');
  const options = { config: f.config, maxGross: '10003', budget: { maxTotalGross: '10003', maxPayments: 1 },
    storage: { directory: join(f.directory, 'skill-client'), key: f.keys.buyer }, payerAccount: payer };
  try {
    runtime = await startPilotProvider({ config: f.config, directory: join(f.directory, 'skill-provider'), key: f.keys.provider,
      receiptSigner: f.accounts.provider, relayerAccount: f.accounts.relayer, wallet: wallet as any, client: client as any,
      handler: async requestBody => { counts.handlers += 1; return Uint8Array.from(requestBody); } });
    globalThis.fetch = async (input, init) => {
      const response = await ordinaryFetch(input, init);
      if (String(input) === f.config.resourceUrl && new Headers(init?.headers).has('payment-signature') && dropPaidResponse) {
        await response.arrayBuffer(); throw Error('TEST_LOST_PAID_RESPONSE');
      }
      return response;
    };
    sdk = await createClient(options); globalThis.fetch = ordinaryFetch;
    const host = createAgentTools({ client: sdk, approvePayment: preview => {
      counts.approvals += 1;
      assert.equal(Object.isFrozen(preview), true);
      assert.equal(Object.isFrozen(preview.terms), true);
      return hostAllowsPayment;
    } });
    assert.deepEqual(host.tools.map(tool => tool.name), ['assurepay_preview', 'assurepay_pay', 'assurepay_retrieve', 'assurepay_state']);

    const deniedPreview = await host.invoke('assurepay_preview', { bodyBase64: Buffer.from(body).toString('base64') }) as Record<string, unknown>;
    assert.equal(typeof deniedPreview.requestId, 'string');
    assert.equal(counts.payerSignatures, 0);
    const denied = await host.invoke('assurepay_pay', { requestId: deniedPreview.requestId }) as Record<string, unknown>;
    assert.deepEqual(denied, { state: 'denied', code: 'CLIENT_APPROVAL_DENIED' });
    assert.equal(counts.payerSignatures, 0);
    assert.equal(counts.broadcasts, 0);
    assert.equal(counts.handlers, 0);

    const approvedPreview = await host.invoke('assurepay_preview', { bodyBase64: Buffer.from(body).toString('base64') }) as Record<string, unknown>;
    assert.equal(typeof approvedPreview.requestId, 'string');
    hostAllowsPayment = true;
    const uncertain = await host.invoke('assurepay_pay', { requestId: approvedPreview.requestId }) as Record<string, unknown>;
    assert.equal(uncertain.state, 'retrieval-required');
    assert.equal(uncertain.requestId, approvedPreview.requestId);
    assert.equal(counts.payerSignatures, 1);
    assert.equal(counts.handlers, 1);
    assert.equal('signature' in uncertain, false);
    assert.equal('paymentHeader' in uncertain, false);
    assert.equal(counts.approvals, 2);

    const relayerNonce = await clients.client.getTransactionCount({ address: f.config.roles.relayer });
    await sdk.close(); sdk = undefined; dropPaidResponse = false;
    sdk = await createClient({ ...options, payerAccount: undefined });
    const recoveryHost = createAgentTools({ client: sdk, approvePayment: () => { throw Error('recovery must not ask for approval'); } });
    const recovered = await recoveryHost.invoke('assurepay_retrieve', { requestId: approvedPreview.requestId }) as Record<string, unknown>;
    assert.equal(recovered.state, 'confirmed');
    assert.equal(recovered.requestId, approvedPreview.requestId);
    assert.equal(recovered.bodyBase64, Buffer.from(body).toString('base64'));
    assert.equal(idPattern.test(String(recovered.receiptFingerprint)), true);
    assert.equal('signature' in recovered, false);
    assert.equal('rawTransaction' in recovered, false);
    assert.equal('serializedTx' in recovered, false);
    assert.equal('paymentHeader' in recovered, false);
    assert.equal('signature' in (recovered.receipt as Record<string, unknown>), false);
    assert.equal(counts.payerSignatures, 1);
    assert.equal(counts.handlers, 1);
    assert.equal(counts.broadcasts, 1);
    assert.equal(await clients.client.getTransactionCount({ address: f.config.roles.relayer }), relayerNonce);
    const state = await recoveryHost.invoke('assurepay_state', { coverageId: recovered.coverageId }) as Record<string, any>;
    assert.equal(state.coverage.coverageId, recovered.coverageId);
    assert.equal(typeof state.observedBlock.hash, 'string');
  } finally {
    globalThis.fetch = ordinaryFetch;
    await sdk?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await f.close();
  }
});
