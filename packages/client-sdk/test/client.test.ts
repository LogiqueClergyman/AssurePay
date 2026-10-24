import assert from 'node:assert/strict';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient, clientErrorCode } from '../src/index.js';
import { createPilotFixture } from '../../developer-pilot/test/helpers.js';
import { startPilotProvider } from '../../developer-pilot/src/provider.js';
import { createClients } from '../../developer-pilot/src/config.js';
import type { Client } from '../src/types.js';

test('actual client approval, durable admission, one send, original recovery and persisted caps', async () => {
  const f = await createPilotFixture(), { client, wallet } = createClients(f.config);
  let runtime: Awaited<ReturnType<typeof startPilotProvider>> | undefined;
  let sdk: Client | undefined; const ordinaryFetch = globalThis.fetch;
  let paymentSignatures = 0, dropResponse = true, dropRetrieval = false, retrievalAttempts = 0;
  const payer = { ...f.accounts.payer, async signTypedData(data: any) {
    if (data.primaryType === 'ReceiveWithAuthorization') paymentSignatures++;
    return f.accounts.payer.signTypedData(data);
  } };
  const directory = join(f.directory, 'client');
  const options = { config: f.config, maxGross: '10003', budget: { maxTotalGross: '20006', maxPayments: 2 },
    storage: { directory, key: f.keys.buyer }, payerAccount: payer };
  try {
    runtime = await startPilotProvider({ config: f.config, directory: join(f.directory, 'provider'), key: f.keys.provider,
      receiptSigner: f.accounts.provider, relayerAccount: f.accounts.relayer, client, wallet, handler: body => body });
    globalThis.fetch = async (input, init) => {
      if (String(input) === f.config.resourceUrl && new Headers(init?.headers).has('assurepay-retrieve-only')) {
        retrievalAttempts++;
        if (dropRetrieval) throw Error('TEST_RETRIEVAL_UNAVAILABLE');
      }
      const response = await ordinaryFetch(input, init);
      if (String(input) === f.config.resourceUrl && new Headers(init?.headers).has('payment-signature') && dropResponse) {
        await response.arrayBuffer(); throw Error('TEST_LOST_PAID_RESPONSE');
      }
      return response;
    };
    const guardedFetch = globalThis.fetch;
    sdk = await createClient(options); globalThis.fetch = ordinaryFetch;
    const body = new TextEncoder().encode('a,b\n1,2\n');
    const preview = await sdk.preview(body);
    assert.equal(paymentSignatures, 0);
    await assert.rejects(sdk.authorize(preview.requestId, { approved: false } as never), { message: 'CLIENT_APPROVAL_REQUIRED' });
    assert.equal(paymentSignatures, 0);
    const another = await sdk.preview(body);
    const results = await Promise.allSettled([
      sdk.authorize(preview.requestId, { approved: true }), sdk.authorize(another.requestId, { approved: true }),
    ]);
    assert.equal(results[0]!.status, 'fulfilled'); assert.equal(results[1]!.status, 'rejected');
    assert.equal(paymentSignatures, 1);
    const unknown = await sdk.send(preview.requestId);
    assert.equal(unknown.state, 'retrieval-required');
    await assert.rejects(sdk.send(preview.requestId), { message: 'CLIENT_SEND_UNAVAILABLE' });
    const blocked = await sdk.preview(body);
    await assert.rejects(sdk.authorize(blocked.requestId, { approved: true }), { message: 'CLIENT_SESSION_UNRESOLVED' });
    assert.equal(paymentSignatures, 1);
    const nonce = await client.getTransactionCount({ address: f.config.roles.relayer });
    await sdk.close(); sdk = undefined; dropResponse = false;
    globalThis.fetch = guardedFetch;
    sdk = await createClient({ ...options, payerAccount: undefined }); globalThis.fetch = ordinaryFetch;
    const recovered = await sdk.retrieve(preview.requestId);
    assert.equal(recovered.state, 'confirmed');
    assert.equal(paymentSignatures, 1);
    assert.equal(await client.getTransactionCount({ address: f.config.roles.relayer }), nonce);
    if (recovered.state !== 'confirmed') throw Error('TEST_EXPECTED_CONFIRMED');
    assert.deepEqual(recovered.body, body);
    assert.deepEqual(Object.keys(recovered.receipt).sort(), ['chainId','completedAt','core','coverageId','requestHash','responseHash','status']);
    const state = await sdk.readState(recovered.coverageId);
    assert.equal(state.tokenBalanceAtomic, '129997'); assert.equal(state.coverage?.status, 1);
    assert.equal(state.observedBlock.hash, (await client.getBlock({ blockNumber: BigInt(state.observedBlock.number) })).hash);
    // The confirmed-to-attempted guard must persist before a new retrieval.
    const retrievalsBeforeFault = retrievalAttempts;
    await chmod(join(directory, 'session.json'), 0o400);
    await assert.rejects(sdk.retrieve(preview.requestId), { message: 'CLIENT_SESSION_INVALID' });
    assert.equal(retrievalAttempts, retrievalsBeforeFault);
    await chmod(join(directory, 'session.json'), 0o600);
    dropRetrieval = true;
    assert.equal((await sdk.retrieve(preview.requestId)).state, 'retrieval-required');
    await sdk.close(); sdk = await createClient(options);
    const uncertain = await sdk.preview(body);
    await assert.rejects(sdk.authorize(uncertain.requestId, { approved: true }), { message: 'CLIENT_SESSION_UNRESOLVED' });
    assert.equal(paymentSignatures, 1);
    assert.equal((await sdk.retrieve(preview.requestId)).state, 'confirmed');
    const second = await sdk.preview(body); await sdk.authorize(second.requestId, { approved: true });
    assert.equal((await sdk.send(second.requestId)).state, 'confirmed');
    assert.equal(paymentSignatures, 2);
    const capped = await sdk.preview(body);
    await assert.rejects(sdk.authorize(capped.requestId, { approved: true }), { message: 'CLIENT_BUDGET_EXCEEDED' });
    assert.equal(paymentSignatures, 2);
    const expired = await sdk.preview(body);
    await f.evm.publicClient.request({ method: 'evm_increaseTime', params: [121] });
    await f.evm.publicClient.request({ method: 'evm_mine', params: [] });
    await assert.rejects(sdk.authorize(expired.requestId, { approved: true }), { message: 'CLIENT_PREVIEW_EXPIRED' });
    assert.equal(paymentSignatures, 2);
    await sdk.close(); sdk = undefined;
    await assert.rejects(createClient({ ...options, budget: { ...options.budget, maxTotalGross: '30009' } }), { message: 'CLIENT_SESSION_INVALID' });
    const session = join(directory, 'session.json'), backup = join(directory, 'session.saved');
    const original = await readFile(session);
    await rename(session, backup);
    await assert.rejects(createClient(options), { message: 'CLIENT_SESSION_MISSING' });
    await rename(backup, session);
    await writeFile(session, '{broken');
    await assert.rejects(createClient(options), { message: 'CLIENT_SESSION_INVALID' });
    await writeFile(session, original);
    sdk = await createClient({ ...options, payerAccount: undefined });
    assert.equal((await sdk.readState()).tokenBalanceAtomic, '119994');
  } finally {
    globalThis.fetch = ordinaryFetch;
    await sdk?.close().catch(() => undefined); await runtime?.close().catch(() => undefined); await f.close();
  }
});

test('client error vocabulary never returns arbitrary error text or second getter values', () => {
  assert.equal(clientErrorCode(Error('CLIENT_PRIVATE_KEY_CONTENT')), 'CLIENT_OPERATION_FAILED');
  let reads = 0; const hostile = Error();
  Object.defineProperty(hostile, 'message', { get() { return ++reads === 1 ? 'CLIENT_BUDGET_EXCEEDED' : '/private/content'; } });
  assert.equal(clientErrorCode(hostile), 'CLIENT_BUDGET_EXCEEDED'); assert.equal(reads, 1);
});
