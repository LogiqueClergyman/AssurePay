import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { Address, Hex } from 'viem';
import { hashRequest } from '../../x402-assurance/src/canonical.js';
import { requirementsFor } from '../../x402-assurance/src/protocol.js';
import { readTerms } from '../../x402-assurance/src/chain.js';
import { createBuyer } from '../src/buyer.js';
import { trustFor } from '../src/config.js';
import { createPilotFixture } from './helpers.js';

test('buyer preview is unsigned, isolated, and its request ID can be authorized only once', async () => {
  const fixture = await createPilotFixture();
  const { evm, directory, config, keys } = fixture;
  const trust = trustFor(config);
  const terms = await readTerms(evm.publicClient, trust, config.gross);
  let challengeCalls = 0, signatures = 0;
  let entered!: () => void, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    challengeCalls++;
    const id = new Headers(init?.headers).get('assurepay-request-id') as Hex;
    const body = Uint8Array.from(init?.body as Uint8Array);
    if (challengeCalls === 2) { entered(); await blocked; }
    const requestHash = hashRequest('POST', String(input), 'application/octet-stream', body, id);
    return new Response(new Uint8Array(), { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader({ x402Version: 2,
      resource: { url: config.resourceUrl }, accepts: [requirementsFor(terms, requestHash)] } as any) } });
  };
  const buyer = await createBuyer({ binding: { url: config.resourceUrl, trust, maxGross: config.gross, payer: evm.payer.address },
    directory: join(directory, 'buyer-preview'), key: keys.buyer, client: evm.publicClient, relayer: evm.owner.address,
    payerSigner: { address: evm.payer.address as Address, async signTypedData(data) { signatures++; return evm.payer.signTypedData(data); } }, fetch: fetcher });
  try {
    const body = new Uint8Array([2, 4, 8]);
    const preview = await buyer.preview(body);
    assert.equal(signatures, 0);
    preview.body[0] = 99;
    const first = buyer.authorize(preview.requestId);
    await ready;
    await assert.rejects(() => buyer.authorize(preview.requestId), /BUYER_PREVIEW_UNAVAILABLE/);
    release();
    const authorized = await first;
    assert.equal(signatures, 1);
    assert.equal(challengeCalls, 2);
    assert.equal(authorized.requestId, preview.requestId);
    assert.notEqual(authorized.coverageId, `0x${'00'.repeat(32)}`);
    await assert.rejects(() => buyer.authorize(preview.requestId), /BUYER_PREVIEW_UNAVAILABLE/);
    for (let index = 0; index < 32; index++) await buyer.preview(new Uint8Array([index]));
    assert.equal(challengeCalls, 34);
    await assert.rejects(() => buyer.preview(new Uint8Array([33])), /BUYER_PREVIEW_LIMIT/);
    assert.equal(challengeCalls, 34);
    assert.equal(signatures, 1);
  } finally { await buyer.close(); await fixture.close(); }
});
