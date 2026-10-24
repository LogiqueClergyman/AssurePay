import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient, readClientConfig, clientErrorCode, createAgentTools } from '@assurepay/client-sdk';
import { keccak256 } from 'viem';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { privateKeyToAccount } from 'viem/accounts';

const mode = process.argv[2];
const config = await readClientConfig(process.env.ASSUREPAY_CONFIG);
const keyText = process.env.ASSUREPAY_STORAGE_KEY;
if (!/^[0-9a-fA-F]{64}$/.test(keyText ?? '')) throw new Error('BAD_TEST_STORAGE_KEY');
const key = Uint8Array.from(Buffer.from(keyText, 'hex'));
const payerKey = process.env.ASSUREPAY_PAYER_PRIVATE_KEY;
let signatures = 0;
let account;
if (payerKey) {
  const source = privateKeyToAccount(payerKey);
  account = new Proxy(source, { get(target, property) {
    if (property === 'signTypedData') return async (value) => { signatures++; return target.signTypedData(value); };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

if (process.env.ASSUREPAY_TEST_DROP_PAID === '1') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (new Headers(init?.headers).has('payment-signature') && response.status !== 402 && response.status !== 202) {
      const payment = decodePaymentResponseHeader(response.headers.get('payment-response'));
      const receipt = JSON.parse(Buffer.from(response.headers.get('assurepay-receipt'), 'base64').toString('utf8'));
      const msg = receipt.message;
      const body = new Uint8Array(await response.clone().arrayBuffer());
      const proof = { transaction: payment.transaction, status: response.status, bodyHash: keccak256(body),
        receiptFingerprint: keccak256(Buffer.from(JSON.stringify([msg.chainId, msg.core, msg.coverageId, msg.requestHash,
          msg.responseHash, msg.status, msg.completedAt, receipt.signature]))) };
      await writeFile(process.env.ASSUREPAY_TEST_LOST_PROOF, JSON.stringify(proof));
      throw new Error('SIMULATED_CLIENT_RESPONSE_LOSS');
    }
    return response;
  };
}

const client = await createClient({ config, maxGross: process.env.ASSUREPAY_MAX_GROSS,
  budget: { maxTotalGross: process.env.ASSUREPAY_MAX_TOTAL_GROSS, maxPayments: Number(process.env.ASSUREPAY_MAX_PAYMENTS) },
  storage: { directory: resolve(process.env.ASSUREPAY_STORAGE_DIRECTORY), key }, ...(account ? { payerAccount: account } : {}) });
const output = value => process.stdout.write(`${JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item)}\n`);
const bodyPath = process.env.ASSUREPAY_REQUEST_BODY;
const body = bodyPath ? new Uint8Array(await readFile(bodyPath)) : new TextEncoder().encode('M10_NORMAL');
try {
  if (mode === 'deny') {
    const preview = await client.preview(body);
    output({ preview: { requestId: preview.requestId, requestHash: preview.requestHash, bodyHash: preview.bodyHash,
      url: preview.url, payer: preview.payer, maxGross: preview.maxGross, expiresAt: preview.expiresAt }, signatures });
  } else if (mode === 'agent-deny' || mode === 'agent-pay') {
    const tools = createAgentTools({ client, approvePayment: async preview => {
      if (preview.requestId === `0x${'00'.repeat(32)}`) throw new Error('INVALID_PUBLIC_PREVIEW');
      return mode === 'agent-pay';
    } });
    const encoded = Buffer.from(body).toString('base64');
    const preview = await tools.invoke('assurepay_preview', { bodyBase64: encoded });
    const requestId = preview?.requestId;
    if (typeof requestId !== 'string') throw new Error('AGENT_PREVIEW_FAILED');
    if (mode === 'agent-deny') {
      const denied = await tools.invoke('assurepay_pay', { requestId });
      output({ denied, signatures });
    } else {
      const result = await tools.invoke('assurepay_pay', { requestId });
      output({ result, signatures });
    }
  } else if (mode === 'pay' || mode === 'pay500' || mode === 'concurrent') {
    const requestBody = mode === 'pay500' ? new TextEncoder().encode('M10_SIGNED_500') : body;
    const preview = await client.preview(requestBody);
    const run = () => client.authorize(preview.requestId, { approved: true });
    let authorized;
    if (mode === 'concurrent') {
      const results = await Promise.allSettled([run(), run()]);
      const success = results.filter(row => row.status === 'fulfilled');
      if (success.length !== 1) throw new Error('CONCURRENT_AUTHORIZATION_COUNT_INVALID');
      authorized = success[0].value;
    } else authorized = await run();
    const result = await client.send(authorized.requestId);
    output({ authorized, result, signatures });
  } else if (mode === 'retrieve') {
    const result = await client.retrieve(process.argv[3]);
    output({ result, signatures });
  } else if (mode === 'budget') {
    const preview = await client.preview(body);
    try { await client.authorize(preview.requestId, { approved: true }); output({ accepted: true, signatures }); }
    catch (error) { output({ accepted: false, error: clientErrorCode(error), signatures }); }
  } else if (mode === 'state') {
    output({ state: await client.readState(process.argv[3]), signatures });
  } else if (mode === 'claim') {
    const evidence = new TextEncoder().encode('M10_PAYER_EVIDENCE');
    const evidenceHash = await client.uploadEvidence(process.argv[3], evidence);
    const recoveredEvidence = await client.readEvidence(process.argv[3], evidenceHash);
    const claim = await client.fileClaim(process.argv[3], evidenceHash, { approved: true });
    output({ evidenceHash, evidenceMatches: Buffer.from(recoveredEvidence).equals(Buffer.from(evidence)), claim, signatures });
  } else if (mode === 'claim-duplicate') {
    try { await client.fileClaim(process.argv[3], keccak256(new TextEncoder().encode('different evidence')), { approved: true }); output({ rejected: false, signatures }); }
    catch (error) { output({ rejected: true, error: clientErrorCode(error), signatures }); }
  } else if (mode === 'claim-same') {
    const claim = await client.fileClaim(process.argv[3], process.argv[4], { approved: true });
    output({ claim, signatures });
  } else if (mode === 'claim-reconcile') {
    output({ claims: await client.reconcileClaims(), signatures });
  } else if (mode === 'claim-premature') {
    try { await client.fileClaim(process.argv[3], `0x${'55'.repeat(32)}`, { approved: true }); output({ rejected: false, signatures }); }
    catch (error) { output({ rejected: true, error: clientErrorCode(error), signatures }); }
  } else if (mode === 'reconcile') {
    output({ claims: await client.reconcileClaims(), signatures });
  } else {
    throw new Error('UNKNOWN_TEST_MODE');
  }
} finally { await client.close(); }
