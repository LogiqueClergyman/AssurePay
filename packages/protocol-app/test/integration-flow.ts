import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { keccak256, parseTransaction, toBytes, toFunctionSelector, type Hex, type LocalAccount } from 'viem';
import { createClient } from '../../client-sdk/src/index.js';
import type { Client } from '../../client-sdk/src/types.js';
import { createProtocolRuntime } from '../src/runtime.js';
import { startProtocolProvider } from '../src/provider.js';
import { startProtocolServer } from '../src/http.js';
import { validateProtocolConfig } from '../src/config.js';
import { createProtocolFixture } from './helpers.js';
import type { ActionPreview, ActionResult, Operation, ProtocolRuntime, ProtocolServer, ReadSnapshot, Role } from '../src/types.js';

type Session = { cookie: string; csrf: string; role: Role };
async function session(server: ProtocolServer, role: Role): Promise<Session> {
  const response = await fetch(`${server.url}/v1/session`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: server.issueBootstrap(role) }) });
  assert.equal(response.status, 201);
  const body = await response.json() as { role: Role; csrfToken: string };
  assert.equal(body.role, role); assert.equal(typeof body.csrfToken, 'string');
  const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  return { cookie, csrf: body.csrfToken, role };
}
async function request(server: ProtocolServer, actor: Session, path: string, body?: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: actor.cookie, origin: server.url, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-assurepay-csrf': actor.csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error' });
}
async function action(server: ProtocolServer, actor: Session, operation: Operation): Promise<ActionResult> {
  const previewResponse = await request(server, actor, '/v1/actions/preview', { operation });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as ActionPreview;
  const response = await request(server, actor, '/v1/actions/confirm', { previewId: preview.previewId });
  assert.equal(response.status, 200);
  const result = await response.json() as ActionResult;
  const observed = await request(server, actor, '/v1/summary');
  assert.equal(observed.status, 200);
  const { summary } = await observed.json() as Pick<ReadSnapshot, 'summary'>;
  assert.equal(BigInt(summary.tokenBalanceAtomic), BigInt(summary.providerStake) + BigInt(summary.poolAssets));
  assert.ok(Object.values(summary.solvency).every(Boolean));
  return result;
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((yes,no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const a = server.address(); assert.ok(a && typeof a !== 'string'); return a.port;
}

/** Fresh local API actors, real Core effects and signer-free original-hash recovery. */
export async function runProtocolFlow(): Promise<Record<string, unknown>> {
  const f = await createProtocolFixture();
  let proxy: Server | undefined, runtime: ProtocolRuntime | undefined, server: ProtocolServer | undefined;
  let provider: Awaited<ReturnType<typeof startProtocolProvider>> | undefined, buyer: Client | undefined;
  const counts = { broadcasts: 0, payerPayments: 0, handlers: 0, adminTx: 0, providerTx: 0, adjudicatorTx: 0, relayerTx: 0 };
  let hiddenHash: Hex | undefined, hideOriginal = true;
  const wrap = (source: LocalAccount, kind: 'admin' | 'provider' | 'adjudicator' | 'relayer' | 'payer'): LocalAccount => ({ ...source,
    async signTransaction(...args: any[]) {
      if (kind !== 'payer') counts[`${kind}Tx`]++;
      return (source.signTransaction as any)(...args);
    },
    async signTypedData(data: any) {
      if (kind === 'payer' && data.primaryType === 'ReceiveWithAuthorization') counts.payerPayments++;
      return source.signTypedData(data);
    },
  } as LocalAccount);
  try {
    proxy = createServer(async (req,res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      let drop = false;
      try {
        const rpc = JSON.parse(bytes.toString('utf8'));
        if (hideOriginal && hiddenHash && ['eth_getTransactionByHash','eth_getTransactionReceipt'].includes(rpc.method) && rpc.params?.[0] === hiddenHash) {
          res.writeHead(503); res.end(); return;
        }
        if (rpc.method === 'eth_sendRawTransaction') {
          counts.broadcasts++;
          const tx = parseTransaction(rpc.params[0]);
          if (tx.to?.toLowerCase() === f.pilotConfig.core && tx.data?.startsWith(toFunctionSelector('finalizeClaim(bytes32,uint8,uint256,bytes32)')) && hideOriginal) {
            // The first finalization (Reject) stays visible; only PoolOnly is hidden.
            const outcomeWord = tx.data.slice(10 + 64, 10 + 128);
            if (BigInt(`0x${outcomeWord}`) === 2n) { hiddenHash = keccak256(rpc.params[0]); drop = true; }
          }
        }
        const upstream = await fetch(f.evm.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes });
        const result = Buffer.from(await upstream.arrayBuffer());
        if (drop) { res.writeHead(503); res.end(); } else { res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(result); }
      } catch { res.writeHead(502); res.end(); }
    });
    const port = await listen(proxy);
    const config = validateProtocolConfig({ ...f.config, pilot: { ...f.pilotConfig, rpcUrl: `http://127.0.0.1:${port}` } });
    const accounts = { admin: wrap(f.accounts.admin,'admin'), provider: wrap(f.accounts.provider,'provider'), adjudicator: wrap(f.accounts.adjudicator,'adjudicator') };
    const options = { config, storage: { directory: join(f.directory,'protocol'), key: f.keys.buyer }, limits: { maxActionAmount: '1000000', maxActions: 64 }, accounts };
    provider = await startProtocolProvider({ config, storage: { directory: join(f.directory,'provider-product'), key: f.keys.provider },
      receiptSigner: accounts.provider, relayerAccount: wrap(f.accounts.relayer,'relayer'), handler: body => {
        counts.handlers++; if (new TextDecoder().decode(body).startsWith('FAIL')) throw Error('CONTROLLED_LOCAL_SERVICE_FAILURE'); return body;
      } });
    runtime = await createProtocolRuntime(options); server = await startProtocolServer({ runtime });
    const admin = await session(server,'admin'), owner = await session(server,'provider'), adjudicator = await session(server,'adjudicator'), operator = await session(server,'operator');
    const initial = await runtime.snapshot(); assert.equal(initial.summary.tokenBalanceAtomic,'60000');
    const denied = await request(server, operator, '/v1/actions/preview', { operation: { kind:'setPaused',paused:true } });
    assert.equal(denied.status,403); assert.equal(counts.broadcasts,0);
    for (const [actor, op] of [
      [admin,{kind:'approveCore',amount:'10000'}], [admin,{kind:'fundPool',amount:'10000'}],
      [owner,{kind:'approveCore',amount:'5000'}], [owner,{kind:'depositStake',providerId:config.pilot.providerId,amount:'5000'}],
      [owner,{kind:'withdrawStake',providerId:config.pilot.providerId,amount:'1000'}],
    ] as Array<[Session,Operation]>) assert.equal((await action(server,actor,op)).status,'success');
    const providerId = keccak256(toBytes(`${config.pilot.core}:extra-provider`)), policyId = keccak256(toBytes(`${config.pilot.core}:extra-policy`));
    assert.equal((await action(server,admin,{kind:'registerProvider',providerId,owner:config.pilot.roles.provider,payout:config.admin})).status,'success');
    assert.equal((await action(server,admin,{kind:'registerPolicy',policyId,providerId,premiumBps:1111,stakeBps:1000,withholdingBps:1000,duration:'3600',poolOnlyAllowed:false})).status,'success');
    assert.equal((await action(server,admin,{kind:'setPaused',paused:true})).status,'success');
    assert.equal((await runtime.snapshot()).summary.paused,true);
    assert.equal((await action(server,admin,{kind:'setPaused',paused:false})).status,'success');
    await assert.rejects(f.evm.publicClient.simulateContract({ address:config.pilot.core, abi:f.artifacts.AssuranceCore.abi,
      functionName:'setPaused',args:[true],account:f.accounts.relayer.address }));

    const buyerOptions = { config:config.pilot,maxGross:'10003',budget:{maxTotalGross:'30009',maxPayments:3},
      storage:{directory:join(f.directory,'buyer'),key:f.keys.buyer},payerAccount:wrap(f.accounts.payer,'payer') };
    buyer = await createClient(buyerOptions);
    const purchase = async (text: string) => {
      const preview = await buyer!.preview(toBytes(text)); const auth = await buyer!.authorize(preview.requestId,{approved:true});
      const result = await buyer!.send(auth.requestId); assert.equal(result.state,'confirmed');
      if (result.state !== 'confirmed') throw Error('PROTOCOL_TEST_PAYMENT_UNCONFIRMED'); return result;
    };
    const good = await purchase('NORMAL'), failed = await purchase('FAIL_REFUND'), rejected = await purchase('FAIL_REJECT');
    assert.equal(good.status,200); assert.equal(failed.status,500); assert.equal(rejected.status,500);
    assert.equal(counts.payerPayments,3); assert.equal(counts.relayerTx,3); assert.equal(counts.handlers,3);
    const evidence = toBytes('Local controlled failure evidence');
    for (const coverageId of [failed.coverageId,rejected.coverageId]) {
      const hash = await buyer.uploadEvidence(coverageId,evidence);
      assert.deepEqual(await buyer.readEvidence(coverageId,hash),evidence);
      assert.equal((await buyer.fileClaim(coverageId,hash,{approved:true})).status,'success');
    }
    for (const actor of [admin,owner,operator]) assert.equal((await request(server,actor,'/v1/evidence/read',{coverageId:failed.coverageId})).status,403);
    const privateRead = await request(server,adjudicator,'/v1/evidence/read',{coverageId:failed.coverageId});
    assert.equal(privateRead.status,200); assert.deepEqual(new Uint8Array(await privateRead.arrayBuffer()),evidence);
    assert.equal((await action(server,adjudicator,{kind:'finalizeClaim',coverageId:rejected.coverageId,outcome:0,refundAmount:'0',reason:'Explicit local rejection'})).status,'success');
    const unknown = await action(server,adjudicator,{kind:'finalizeClaim',coverageId:failed.coverageId,outcome:2,refundAmount:'10003',reason:'Explicit local PoolOnly refund'});
    assert.equal(unknown.status,'unknown'); assert.equal(unknown.transaction,hiddenHash);
    const beforeRecovery = { ...counts };
    await server.close(); server = undefined; await runtime.close(); runtime = undefined;
    hideOriginal = false;
    runtime = await createProtocolRuntime({ ...options,accounts:undefined }); server = await startProtocolServer({runtime});
    const recovery = await session(server,'operator');
    const reconciledResponse = await request(server,recovery,'/v1/actions/reconcile',{}); assert.equal(reconciledResponse.status,200);
    const reconciled = await reconciledResponse.json() as ActionResult[];
    assert.ok(reconciled.some(row => row.transaction === hiddenHash && row.status === 'success'));
    assert.deepEqual(counts,beforeRecovery);
    const final = await runtime.snapshot();
    assert.equal(final.summary.tokenBalanceAtomic,'72415'); assert.equal(final.summary.providerStake,'20087');
    assert.equal(final.summary.poolAssets,'52328'); assert.equal(final.summary.lockedStake,'3502'); assert.equal(final.summary.poolReserved,'10003');
    assert.equal(final.summary.coverageCount,'3'); assert.equal(final.summary.activeCoverageCount,'1');
    assert.ok(Object.values(final.summary.solvency).every(Boolean));
    assert.equal(final.coverages.find(c=>c.coverageId===good.coverageId)?.status,1);
    assert.equal(final.coverages.find(c=>c.coverageId===failed.coverageId)?.status,3);
    assert.equal(final.coverages.find(c=>c.coverageId===rejected.coverageId)?.status,4);
    assert.equal(final.providers.length,2); assert.equal(final.policies.length,2);
    assert.equal(final.providers.find(row => row.providerId === config.pilot.providerId)?.payoutBalanceAtomic,'117591');
    assert.equal(final.providers.find(row => row.providerId === providerId)?.payoutBalanceAtomic,'90000');
    assert.deepEqual(counts,{broadcasts:16,payerPayments:3,handlers:3,adminTx:6,providerTx:3,adjudicatorTx:2,relayerTx:3});
    const page1Response = await request(server,recovery,'/v1/coverages?limit=1'); assert.equal(page1Response.status,200);
    const page1 = await page1Response.json() as {anchor:ReadSnapshot['anchor'];items:unknown[];nextCursor:string};
    await f.evm.publicClient.request({method:'evm_mine',params:[]});
    const page2Response = await request(server,recovery,`/v1/coverages?limit=1&cursor=${page1.nextCursor}`); assert.equal(page2Response.status,200);
    const page2 = await page2Response.json() as {anchor:ReadSnapshot['anchor'];items:unknown[]};
    assert.deepEqual(page2.anchor,page1.anchor); assert.equal(page2.items.length,1);
    await buyer.close(); buyer = undefined; await provider.close(); provider = undefined;
    provider = await startProtocolProvider({ config,storage:{directory:join(f.directory,'provider-product'),key:f.keys.provider},
      receiptSigner:{address:config.pilot.roles.provider,async signTypedData(){throw Error('READONLY_RECEIPT_SIGNER_USED');}},
      handler(){throw Error('READONLY_HANDLER_USED');} });
    buyer = await createClient({...buyerOptions,payerAccount:undefined});
    const retrieved = await buyer.retrieve(good.requestId); assert.equal(retrieved.state,'confirmed');
    if(retrieved.state!=='confirmed')throw Error('PROTOCOL_TEST_RETRIEVAL_UNCONFIRMED');
    assert.equal(retrieved.transaction,good.transaction); assert.equal(retrieved.receiptFingerprint,good.receiptFingerprint); assert.deepEqual(retrieved.body,good.body);
    assert.deepEqual(counts,beforeRecovery);
    const payerState = await buyer.readState(failed.coverageId); assert.equal(payerState.tokenBalanceAtomic,'119994');
    return { ok:true,code:'LOCAL_PROTOCOL_API_VERIFIED',chainId:84532,
      limits:{localOnly:true,tokenKind:'LOCAL_ERC3009_FIXTURE',publicNativeUsdcProof:false,hostedAvailability:false,finality:false},
      separateAdminAndRelayer:config.admin!==config.pilot.roles.relayer,wrongRoleDenied:true,
      allFixedControlsExecuted:true,adjudicatorPrivateEvidenceScoped:true,explicitRejectionAndRefund:true,
      originalHashReconciledWithoutSigners:true,recoveryCountsUnchanged:true,keyFreeProviderRetrieval:true,
      stablePaginationAcrossUnrelatedBlock:true,counts,initial:{anchor:initial.anchor,summary:initial.summary},
      final:{anchor:final.anchor,summary:final.summary},payerBalanceAtomic:payerState.tokenBalanceAtomic };
  } finally {
    await server?.close().catch(()=>undefined); await runtime?.close().catch(()=>undefined);
    await buyer?.close().catch(()=>undefined); await provider?.close().catch(()=>undefined);
    if(proxy)await new Promise<void>(resolve=>proxy!.close(()=>resolve())); await f.close();
  }
}
