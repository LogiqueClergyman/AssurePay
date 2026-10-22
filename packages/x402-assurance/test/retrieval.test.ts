import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { DurableServiceResult, PaymentResult, Terms, Trust } from '../src/types.js';
import { createPurchase, restorePurchase } from '../src/http-client.js';
import { startProvider } from '../src/http-provider.js';
import { prepareCall } from '../src/protocol.js';
import { encodePaymentSignatureHeader } from '@x402/core/http';

const payerAccount = privateKeyToAccount(generatePrivateKey());
const providerAccount = privateKeyToAccount(generatePrivateKey());
const transaction = `0x${'a1'.repeat(32)}` as Hex;
const blockHash = `0x${'b2'.repeat(32)}` as Hex;
const terms: Terms = {
  chainId: 84532, core: '0x1000000000000000000000000000000000000001', token: '0x2000000000000000000000000000000000000002',
  providerId: `0x${'31'.repeat(32)}`, policyId: `0x${'32'.repeat(32)}`, providerOwner: providerAccount.address.toLowerCase() as Address,
  providerPayout: '0x3000000000000000000000000000000000000003', policyHash: `0x${'33'.repeat(32)}`, premiumBps: 700,
  stakeBps: 500, withholdingBps: 0, duration: '3600', poolOnlyAllowed: false, gross: '1000000', premium: '70000',
  withheld: '0', net: '930000', stakeLock: '50000', poolReservation: '950000', tokenName: 'USDC', tokenVersion: '2',
};
const trust: Trust = { chainId: 84532, core: terms.core, token: terms.token, providerId: terms.providerId, policyId: terms.policyId };

test('restorePurchase retrieves an archived result after provider restart and missing service journal without settlement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assurepay-retrieve-'));
  const serverPath = join(dir, 'service.jsonl');
  const portServer = await import('node:net').then(({ createServer }) => new Promise<any>((resolve, reject) => {
    const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const a = server.address(); server.close(); resolve(a); });
  }));
  const url = `http://127.0.0.1:${portServer.port}/assured`;
  const archived = new Map<string, DurableServiceResult>();
  const resultStore = {
    async put(_context: string, result: DurableServiceResult) { archived.set(`${result.coverageId}:${result.requestHash}`, structuredClone(result)); },
    async get(_context: string, coverageId: Hex, requestHash: Hex) { return archived.get(`${coverageId}:${requestHash}`); },
  };
  let settlements = 0, reconciliations = 0, handlers = 0, payerSigns = 0, reconciliationMismatch = false, paymentJournalAvailable = true;
  const engine = {
    async settle(call: any): Promise<PaymentResult> { settlements++; return { state: 'confirmed', transaction, coverageId: call.intentHash, blockNumber: '7', blockHash }; },
    async reconcile(call: any): Promise<PaymentResult> {
      reconciliations++;
      if (!paymentJournalAvailable) return { state:'invalid', transaction:'', coverageId:call.intentHash };
      return { state: 'confirmed', transaction, coverageId: call.intentHash, blockNumber: '7', blockHash: reconciliationMismatch ? `0x${'c3'.repeat(32)}` as Hex : blockHash };
    },
  };
  let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  const start = () => startProvider({ terms, engine, resultStore,
    signer: { address: providerAccount.address, signTypedData: d => providerAccount.signTypedData(d) },
    handler: async body => { handlers++; return Uint8Array.from([...body, 9]); }, journalPath: serverPath, resourceUrl: url,
    canServe: async () => true, prepareCall: (payment, requestHash) => prepareCall(payment, terms, requestHash, 0n, { allowExpired: true }),
  });
  try {
    provider = await start();
    const body = new Uint8Array([1, 4, 8]);
    const session = await createPurchase({ url, body, payer: { address: payerAccount.address as Address, async signTypedData(d) { payerSigns++; return payerAccount.signTypedData(d); } },
      trust, maxGross: terms.gross, readTerms: async () => terms, now: () => 1_800_000_000,
      verifyPayment: async ({ call }) => ({ state: 'confirmed', transaction, coverageId: call.intentHash }),
    });
    const paid = await session.send();
    assert.equal(paid.status, 200);
    assert.equal(settlements, 1); assert.equal(handlers, 1); assert.equal(payerSigns, 1);
    const snapshot = { version: 1 as const, url, bodyHex: Buffer.from(body).toString('hex'), trust, maxGross: terms.gross,
      payer: payerAccount.address as `0x${string}`, terms, requestId: session.requestId, payment: session.payment };
    const mutableSnapshot = structuredClone(snapshot) as any;
    let enteredTerms!: () => void, resumeTerms!: () => void;
    const termsEntered = new Promise<void>(resolve => { enteredTerms = resolve; });
    const termsGate = new Promise<void>(resolve => { resumeTerms = resolve; });
    let capturedInit: RequestInit | undefined;
    const clonedRestore = restorePurchase({ snapshot: mutableSnapshot, url, trust, maxGross: terms.gross, payer: payerAccount.address as `0x${string}`,
      readTerms: async () => { enteredTerms(); await termsGate; return terms; }, now: () => 1_900_000_000,
      verifyPayment: async ({ call }) => ({ state:'confirmed', transaction, coverageId:call.intentHash }),
      fetch: async (_input, init) => { capturedInit = init; return new Response(JSON.stringify({code:'SERVICE_INDETERMINATE',transaction,coverageId:session.call.intentHash}),{status:202}); },
    });
    await termsEntered;
    mutableSnapshot.bodyHex = 'ff'; mutableSnapshot.requestId = `0x${'ee'.repeat(32)}`; mutableSnapshot.payment = {}; mutableSnapshot.url = 'https://changed.invalid/';
    resumeTerms();
    const clonedSession = await clonedRestore;
    const pending = await clonedSession.send();
    assert.equal(pending.status,202); assert.equal(Buffer.from(capturedInit?.body as Uint8Array).toString('hex'),Buffer.from(body).toString('hex'));
    const clonedHeaders = new Headers(capturedInit?.headers);
    assert.equal(clonedHeaders.get('assurepay-request-id'),session.requestId); assert.equal(clonedHeaders.get('assurepay-retrieve-only'),'1');
    assert.equal(clonedHeaders.get('payment-signature'),encodePaymentSignatureHeader(session.payment));
    const malformedPending = await restorePurchase({ snapshot, url, trust, maxGross:terms.gross, payer:payerAccount.address as `0x${string}`,
      readTerms:async()=>terms, now:()=>1_900_000_000, verifyPayment:async({call})=>({state:'confirmed',transaction,coverageId:call.intentHash}),
      fetch:async()=>new Response('{"code":"PAYMENT_PENDING","extra":true}',{status:202}),
    });
    await assert.rejects(() => malformedPending.send(), /INVALID_PENDING_RESPONSE/);
    await provider.close(); provider = undefined;
    await unlink(serverPath);
    provider = await start();
    const restored = await restorePurchase({ snapshot, url, trust, maxGross: terms.gross, payer: payerAccount.address as `0x${string}`,
      readTerms: async () => terms, now: () => 1_900_000_000, verifyPayment: async ({ call }) => ({ state: 'confirmed', transaction, coverageId: call.intentHash }),
    });
    paymentJournalAvailable = false;
    await assert.rejects(() => restored.send(), /MISSING_PAID_RESPONSE_PROOF/);
    assert.equal(settlements, 1); assert.equal(handlers, 1); assert.equal(payerSigns, 1);
    paymentJournalAvailable = true;
    reconciliationMismatch = true;
    await assert.rejects(() => restored.send(), /MISSING_PAID_RESPONSE_PROOF/);
    assert.equal(settlements, 1); assert.equal(handlers, 1); assert.equal(payerSigns, 1);
    reconciliationMismatch = false;
    const result = await restored.send();
    assert.equal(result.status, 200); assert.deepEqual(result.body, paid.body);
    assert.equal(settlements, 1); assert.equal(handlers, 1); assert.equal(payerSigns, 1); assert.equal(reconciliations, 3);
  } finally { await provider?.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('retrieval-only fails closed without an archive and never settles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assurepay-retrieve-empty-'));
  const net = await import('node:net').then(({ createServer }) => new Promise<any>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0,'127.0.0.1',()=>{const a=server.address();server.close();resolve(a);}); }));
  const url = `http://127.0.0.1:${net.port}/assured`;
  let settlements = 0, handlers = 0;
  let provider = await startProvider({ terms, engine: { async settle(call) { settlements++; return { state:'confirmed', transaction, coverageId:call.intentHash }; }, async reconcile(call) { return { state:'invalid', transaction:'', coverageId:call.intentHash }; } },
    resultStore: { async put(){}, async get(){ return undefined; } },
    signer:{address:providerAccount.address,signTypedData:d=>providerAccount.signTypedData(d)}, handler:async body=>{handlers++;return body;},
    journalPath:join(dir,'service.jsonl'),resourceUrl:url,canServe:async()=>true,prepareCall:(p,h)=>prepareCall(p,terms,h,0n,{allowExpired:true}),
  });
  try {
    const session = await createPurchase({ url, body:new Uint8Array([2]), payer:{address:payerAccount.address as Address,signTypedData:d=>payerAccount.signTypedData(d)}, trust,
      maxGross:terms.gross,readTerms:async()=>terms,now:()=>1_800_000_000,verifyPayment:async({call})=>({state:'confirmed',transaction,coverageId:call.intentHash}),
    });
    const invalidMode = await fetch(url, { method:'POST', headers:{'content-type':'application/octet-stream','assurepay-request-id':session.requestId,
      'assurepay-retrieve-only':'true','payment-signature':encodePaymentSignatureHeader(session.payment)}, body:Buffer.from([2]) });
    assert.equal(invalidMode.status, 400);
    assert.equal(settlements, 0); assert.equal(handlers, 0);
    const snapshot = {version:1 as const,url,bodyHex:'02',trust,maxGross:terms.gross,payer:payerAccount.address as `0x${string}`,terms,requestId:session.requestId,payment:session.payment};
    await provider.close();
    provider = await startProvider({ terms, engine:{async settle(call){settlements++;return{state:'confirmed',transaction,coverageId:call.intentHash};},async reconcile(call){return{state:'invalid',transaction:'',coverageId:call.intentHash};}},
      resultStore:{async put(){},async get(){return undefined;}},signer:{address:providerAccount.address,signTypedData:d=>providerAccount.signTypedData(d)},handler:async body=>{handlers++;return body;},
      journalPath:join(dir,'service.jsonl'),resourceUrl:url,canServe:async()=>true,prepareCall:(p,h)=>prepareCall(p,terms,h,0n,{allowExpired:true}),
    });
    try {
      const restored = await restorePurchase({snapshot,url,trust,maxGross:terms.gross,payer:payerAccount.address as `0x${string}`,readTerms:async()=>terms,now:()=>1_900_000_000,
        verifyPayment:async({call})=>({state:'confirmed',transaction,coverageId:call.intentHash})});
      await assert.rejects(() => restored.send(), /MISSING_PAID_RESPONSE_PROOF/);
      assert.equal(settlements,0); assert.equal(handlers,0);
    } finally { await provider.close(); }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
