import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPilotFixture } from './helpers.js';
import { createBuyer } from '../src/buyer.js';
import { trustFor } from '../src/config.js';
import { readTerms, isServiceAdmissible } from '../../x402-assurance/src/chain.js';
import { createSettlementEngine } from '../../x402-assurance/src/engine.js';
import { startProvider } from '../../x402-assurance/src/http-provider.js';
import { prepareCall } from '../../x402-assurance/src/protocol.js';

test('buyer persists before send, rejects duplicate sends, and retrieves after process restart without signing or settling again', async () => {
  const fixture = await createPilotFixture();
  const { evm, directory, config, keys } = fixture;
  const client = { ...evm.publicClient };
  const wallet = { ...evm.walletClient };
  let payerSignatures = 0, relayerSignatures = 0, broadcasts = 0, handlers = 0;
  const payerSigner = { address: evm.payer.address, async signTypedData(data: any) { payerSignatures++; return evm.payer.signTypedData(data); } };
  const signingWallet = { ...wallet, async signTransaction(args: any) { relayerSignatures++; return evm.walletClient.signTransaction(args); } };
  const sendingClient = { ...client, async sendRawTransaction(args: any) { broadcasts++; return evm.publicClient.sendRawTransaction(args); } };
  const trust = trustFor(config);
  const terms = await readTerms(client, trust, config.gross);
  const serviceJournal = join(directory, 'service.jsonl');
  const paymentJournal = join(directory, 'payment.jsonl');
  const resultMap = new Map<string, any>();
  const resultStore = {
    async put(context: string, result: any) { resultMap.set(`${context}:${result.coverageId}:${result.requestHash}`, structuredClone(result)); },
    async get(context: string, coverageId: string, requestHash: string) { return resultMap.get(`${context}:${coverageId}:${requestHash}`); },
  };
  const makeEngine = (readOnly: boolean) => createSettlementEngine({ client: sendingClient, ...(readOnly ? {} : { wallet: signingWallet, account: evm.owner }),
    relayer: evm.owner.address, terms, journalPath: paymentJournal, gasLimit: 800_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000n, polls: 4, delay: 0 });
  const start = (readOnly: boolean) => startProvider({ terms, engine: makeEngine(readOnly), resultStore,
    signer: evm.provider, resourceUrl: config.resourceUrl, journalPath: serviceJournal,
    prepareCall: (payment, requestHash) => prepareCall(payment, terms, requestHash, 0n, { allowExpired: true }),
    canServe: call => isServiceAdmissible(client, terms, call), handler: async body => { handlers++; return Uint8Array.from([...body, 0x7a]); },
  });
  let provider = await start(false);
  let blockPaidFetch = false, paidFetchEntered!: () => void, releasePaidFetch!: () => void;
  const paidFetchReady = new Promise<void>(resolve => { paidFetchEntered = resolve; });
  const paidFetchGate = new Promise<void>(resolve => { releasePaidFetch = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    if (blockPaidFetch && new Headers(init?.headers).has('payment-signature')) { paidFetchEntered(); await paidFetchGate; }
    return fetch(input, init);
  };
  const buyerOptions = { binding: { url: config.resourceUrl, trust, maxGross: config.gross, payer: evm.payer.address }, directory: join(directory, 'buyer'),
    key: keys.buyer, client, relayer: evm.owner.address, payerSigner, fetch: fetcher };
  let buyer = await createBuyer(buyerOptions);
  try {
    const body = new Uint8Array([0, 7, 4, 255]);
    const prepared = await buyer.prepare(body);
    assert.equal(payerSignatures, 1);
    const filesBeforeSend = await readdir(join(directory, 'buyer'));
    assert.equal(filesBeforeSend.some(file => file.startsWith('.attempt-')), false);
    blockPaidFetch = true;
    const paidRequest = buyer.send(prepared.requestId);
    await paidFetchReady;
    let closeFinished = false;
    const close = buyer.close().then(() => { closeFinished = true; });
    await assert.rejects(() => buyer.retrieve(prepared.requestId), /BUYER_CLOSED/);
    await assert.rejects(() => createBuyer(buyerOptions), /BUYER_DIRECTORY_LOCKED/);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closeFinished, false);
    releasePaidFetch();
    const paid = await paidRequest;
    await close;
    assert.equal(paid.status, 200); assert.deepEqual(paid.body, new Uint8Array([...body, 0x7a]));
    await assert.rejects(() => buyer.send(prepared.requestId), /BUYER_CLOSED/);
    const counts = { payerSignatures, relayerSignatures, broadcasts, handlers };
    const fileNames = await readdir(join(directory, 'buyer'));
    const persisted = await Promise.all(fileNames.filter(n => n.endsWith('.json')).map(n => readFile(join(directory, 'buyer', n), 'utf8')));
    assert.equal(persisted.some(text => text.includes('payment-signature') || text.includes(payerSigner.address)), false);
    await buyer.close();
    await provider.close();
    provider = await start(true);
    buyer = await createBuyer({ ...buyerOptions, payerSigner: undefined });
    const retrieved = await buyer.retrieve(prepared.requestId);
    assert.equal(retrieved.status, paid.status); assert.deepEqual(retrieved.body, paid.body);
    assert.deepEqual({ payerSignatures, relayerSignatures, broadcasts, handlers }, counts);
    await assert.rejects(() => buyer.send(prepared.requestId), /BUYER_SEND_UNAVAILABLE/);
    await buyer.close();
    await provider.close();
    await unlink(paymentJournal);
    provider = await start(true);
    buyer = await createBuyer({ ...buyerOptions, payerSigner: undefined });
    await assert.rejects(() => buyer.retrieve(prepared.requestId), /MISSING_PAID_RESPONSE_PROOF/);
    assert.deepEqual({ payerSignatures, relayerSignatures, broadcasts, handlers }, counts);
    await buyer.close();
    const vaultDir = join(directory, 'buyer', 'vault');
    const [vaultFile] = await readdir(vaultDir);
    const vaultPath = join(vaultDir, vaultFile!);
    const envelope = JSON.parse(await readFile(vaultPath, 'utf8'));
    envelope.ciphertext = (envelope.ciphertext.startsWith('00') ? '01' : '00') + envelope.ciphertext.slice(2);
    await writeFile(vaultPath, JSON.stringify(envelope) + '\n', { mode: 0o600 });
    buyer = await createBuyer({ ...buyerOptions, payerSigner: undefined });
    await assert.rejects(() => buyer.retrieve(prepared.requestId), /VAULT_CORRUPT/);
    assert.deepEqual({ payerSignatures, relayerSignatures, broadcasts, handlers }, counts);
  } finally {
    releasePaidFetch();
    await buyer.close().catch(() => {});
    await provider.close().catch(() => {});
    await fixture.close();
  }
});
