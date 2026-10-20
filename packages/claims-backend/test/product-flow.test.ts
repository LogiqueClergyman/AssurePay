import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, toHex, type Hex } from 'viem';
import { integration, H, safeSend } from '../../x402-assurance/test/helpers/integration.js';
import { transact } from '../../evm-core/test/helpers/evm.js';
import { EncryptedVault } from '../src/vault.js';
import { createResultStore } from '../src/results.js';
import { createProjection } from '../src/projection.js';
import { createClaimsBackend } from '../src/claims.js';
import { operationTypedData, operationPayloadHash } from '../src/auth.js';
import { CORE_ABI } from '../src/abi.js';
import type { Authorization, BackendContext, Operation, PreparedAction } from '../src/types.js';

async function setup(){
  const directory=await mkdtemp(join(tmpdir(),'assurepay-m4-product-'));
  const vault=new EncryptedVault({directory:join(directory,'objects'),namespace:'b2'.repeat(32),keyId:'local',key:randomBytes(32)});
  const f=await integration({resultStore:createResultStore(vault)});
  const context:BackendContext={chainId:84532,core:f.trust.core,token:f.trust.token,adjudicator:f.f.evm.outsider.address.toLowerCase() as `0x${string}`,serviceId:H(850)};
  const projectionOptions={client:f.f.evm.publicClient,context,journalPath:join(directory,'projection.json'),fromBlock:0n};
  const projection=createProjection(projectionOptions);
  const options={context,projection,vault,replayPath:join(directory,'replay.jsonl')};
  const backend=await createClaimsBackend(options);
  async function auth(actor:any,operation:Operation,coverageId:Hex,payload:unknown,overrides:Partial<Omit<Authorization,'signature'>>={}){
    const message={actor:actor.address.toLowerCase(),operation,coverageId,payloadHash:operationPayloadHash(payload),nonce:toHex(randomBytes(32)),deadline:String((await f.f.evm.publicClient.getBlock()).timestamp+250n),...overrides};
    return {...message,signature:await actor.signTypedData(operationTypedData(context,message as Omit<Authorization,'signature'>))} as Authorization;
  }
  async function submit(action:PreparedAction,actor:any){
    assert.equal(action.from,actor.address.toLowerCase());assert.equal(action.to.toLowerCase(),context.core.toLowerCase());assert.equal(action.value,'0');
    const decoded=decodeFunctionData({abi:CORE_ABI,data:action.data});
    return transact(f.f.evm,f.f.coreAbi,f.f.core,decoded.functionName,decoded.args as readonly unknown[],actor);
  }
  return {f,directory,vault,context,projection,projectionOptions,options,backend,auth,submit,async close(){await f.close();await rm(directory,{recursive:true,force:true});}};
}

test('paid HTTP result -> encrypted payer evidence -> direct on-chain claim -> explicit adjudicator refund survives backend restart',async()=>{
  const t=await setup();const {f}=t;
  try{
    const p=await f.purchase();const response=await safeSend(()=>p.send());assert.equal(response.paid,true);
    const coverageId=p.call.intentHash,evidence=new TextEncoder().encode('private service failure explanation');
    const upload=await t.auth(f.f.evm.payer,'uploadEvidence',coverageId,{bodyHex:toHex(evidence)});
    const submittedBody=Uint8Array.from(evidence);
    const uploading=t.backend.uploadEvidence(coverageId,submittedBody,upload);
    submittedBody.fill(0);upload.operation='readEvidence';upload.signature='0x';
    const hash=await uploading;
    const prepare=await t.auth(f.f.evm.payer,'prepareClaim',coverageId,{evidenceHash:hash});
    const action=await t.backend.prepareClaim(coverageId,hash,prepare);
    await t.submit(action,f.f.evm.payer);
    assert.equal((await t.projection.refresh()).coverages[coverageId].status,2);
    const restarted=await createClaimsBackend({...t.options,projection:createProjection(t.projectionOptions)});
    const read=await t.auth(f.f.evm.outsider,'readEvidence',coverageId,{evidenceHash:hash});
    assert.deepEqual(await restarted.readEvidence(coverageId,hash,read),evidence);
    const decision={outcome:1 as const,refundAmount:'3100',reason:'configured adjudicator explicitly approved a partial refund'};
    const decisionAuth=await t.auth(f.f.evm.outsider,'prepareDecision',coverageId,decision);
    const before=await f.f.balance(f.f.evm.payer.address);
    const result=await restarted.prepareDecision(coverageId,decision,decisionAuth);
    await t.submit(result.action,f.f.evm.outsider);
    const projected=(await t.projection.refresh()).coverages[coverageId];
    assert.equal(projected.status,3);assert.equal(projected.evidenceHash,hash);assert.equal(projected.decisionHash,result.decisionHash);assert.equal(projected.refundAmount,'3100');
    assert.equal(await f.f.balance(f.f.evm.payer.address),before+3100n);
    await assert.rejects(()=>restarted.prepareDecision(coverageId,decision,decisionAuth),/CLAIM_STATE|AUTH_REPLAY/);
    await f.restart(true);const recovered=await safeSend(()=>p.retry());assert.equal(recovered.paid,true);assert.equal(recovered.receipt?.signature===response.receipt?.signature,true);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});await f.check([coverageId]);
    for(const name of await readdir(join(t.directory,'objects'))){const raw=await readFile(join(t.directory,'objects',name),'utf8');assert.equal(raw.includes('private service failure'),false);assert.equal(raw.includes(response.receipt!.signature),false);assert.equal(raw.includes(decision.reason),false);}
  }finally{await t.close();}
});

test('reorged claim removes adjudicator authority; orphaned opening cannot attach evidence to reopened same coverage',async()=>{
  const t=await setup();const {f}=t;
  try{
    const beforeOpening=await f.f.evm.publicClient.request({method:'evm_snapshot',params:[]});
    const p=await f.purchase();await safeSend(()=>p.send());const id=p.call.intentHash;
    const bytes=new Uint8Array([91,92,93]);const hash=await t.backend.uploadEvidence(id,bytes,await t.auth(f.f.evm.payer,'uploadEvidence',id,{bodyHex:toHex(bytes)}));
    const beforeClaim=await f.f.evm.publicClient.request({method:'evm_snapshot',params:[]});
    const action=await t.backend.prepareClaim(id,hash,await t.auth(f.f.evm.payer,'prepareClaim',id,{evidenceHash:hash}));
    await t.submit(action,f.f.evm.payer);assert.equal((await t.projection.refresh()).coverages[id].status,2);
    assert.equal(await f.f.evm.publicClient.request({method:'evm_revert',params:[beforeClaim]}),true);
    assert.equal((await t.projection.refresh()).coverages[id].status,1);
    const adjudicatorRead=await t.auth(f.f.evm.outsider,'readEvidence',id,{evidenceHash:hash});
    await assert.rejects(()=>t.backend.readEvidence(id,hash,adjudicatorRead),/AUTH_ROLE/);
    assert.equal(await f.f.evm.publicClient.request({method:'evm_revert',params:[beforeOpening]}),true);
    const empty=await t.projection.refresh();assert.equal(empty.coverages[id],undefined);
    const now=(await f.f.evm.publicClient.getBlock()).timestamp;
    await f.f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(now+20n)]});
    await f.f.evm.publicClient.request({method:'evm_mine',params:[]});
    const decoded=decodeFunctionData({abi:f.f.coreAbi,data:p.call.data});
    await transact(f.f.evm,f.f.coreAbi,f.f.core,decoded.functionName,decoded.args as readonly unknown[],f.f.evm.owner);
    assert.equal((await t.projection.refresh()).coverages[id].status,1);
    const staleRead=await t.auth(f.f.evm.payer,'readEvidence',id,{evidenceHash:hash});
    await assert.rejects(()=>t.backend.readEvidence(id,hash,staleRead),/EVIDENCE_ANCHOR/);
    const staleClaim=await t.auth(f.f.evm.payer,'prepareClaim',id,{evidenceHash:hash});
    await assert.rejects(()=>t.backend.prepareClaim(id,hash,staleClaim),/EVIDENCE_ANCHOR/);
    await f.check([id]);
  }finally{await t.close();}
});
