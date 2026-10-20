import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { transact } from '../../evm-core/test/helpers/evm.js';
import { integration, safeSend } from './helpers/integration.js';

test('a simulation-to-inclusion pause produces one durable canonical revert without charging or serving', async () => {
  const f = await integration();
  try {
    const purchase = await f.purchase();
    const payerBefore = await f.f.balance(f.f.evm.payer.address);
    const coreBefore = await f.f.balance(f.f.core);
    const payoutBefore = await f.f.balance(f.terms.providerPayout);
    const globalsBefore = await f.f.globals();
    const providerBefore = await f.f.provider(f.f.providerId);

    const simulate = f.client.simulateContract.bind(f.client);
    let pauseBetweenSimulationAndSigning = true;
    f.client.simulateContract = async (request: any) => {
      const result = await simulate(request);
      if (pauseBetweenSimulationAndSigning) {
        pauseBetweenSimulationAndSigning = false;
        await transact(f.f.evm, f.f.coreAbi, f.f.core, 'setPaused', [true]);
      }
      return result;
    };

    const sendPaidRequest = () => fetch(f.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'assurepay-request-id': purchase.requestId,
        'payment-signature': encodePaymentSignatureHeader(purchase.payment),
      },
      body: new Uint8Array([1, 2, 3]),
    });

    const firstResponse = await safeSend(sendPaidRequest);
    assert.equal(firstResponse.status, 402);
    assert.equal(await safeSend(() => firstResponse.text()), 'PAYMENT_REJECTED');
    assert.equal(pauseBetweenSimulationAndSigning, false, 'the successful simulation must trigger the pause');

    const first = await f.engine.settle(purchase.call);
    assert.equal(first.state, 'reverted');
    assert.match(first.transaction, /^0x[0-9a-f]{64}$/i);
    const receipt: any = await safeSend(() => f.f.evm.publicClient.getTransactionReceipt({ hash: first.transaction }));
    assert.equal(receipt.status, 'reverted', 'the known hash must have a mined revert receipt');
    assert.equal(receipt.transactionHash === first.transaction, true, 'receipt must match the durable transaction hash');

    const secondResponse = await safeSend(sendPaidRequest);
    assert.equal(secondResponse.status, 402);
    assert.equal(await safeSend(() => secondResponse.text()), 'PAYMENT_REJECTED');
    const second = await f.engine.settle(purchase.call);
    assert.equal(second.state, 'reverted');
    assert.equal(second.transaction === first.transaction, true, 'retry must reconcile the original hash');

    assert.deepEqual(f.counts(), { signatures: 1, broadcasts: 1, relayerSignatures: 1, handlers: 0 });
    assert.equal(await f.f.authorizationUsed(purchase.call.intent.payer, purchase.call.intentHash), false);
    assert.equal(await f.f.balance(f.f.evm.payer.address), payerBefore);
    assert.equal(await f.f.balance(f.f.core), coreBefore);
    assert.equal(await f.f.balance(f.terms.providerPayout), payoutBefore);
    assert.deepEqual(await f.f.globals(), globalsBefore);
    assert.deepEqual(await f.f.provider(f.f.providerId), providerBefore);
    await f.check([]);
  } finally {
    await f.close();
  }
});
