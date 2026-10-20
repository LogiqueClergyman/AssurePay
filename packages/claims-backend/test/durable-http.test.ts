import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { integration, safeSend } from '../../x402-assurance/test/helpers/integration.js';
import { ServiceStore } from '../../x402-assurance/src/service-store.js';
import { EncryptedVault } from '../src/vault.js';
import { createResultStore } from '../src/results.js';

async function fixture(options:{failPut?:boolean;handler?:(body:Uint8Array)=>Promise<Uint8Array>}={}) {
  const directory=await mkdtemp(join(tmpdir(),'assurepay-m4-http-'));
  const key=randomBytes(32),namespace='a1'.repeat(32);
  const vault=new EncryptedVault({directory:join(directory,'objects'),namespace,keyId:'local-test',key});
  const archive=createResultStore(vault);
  const resultStore=options.failPut?{...archive,put:async()=>{throw new Error('INJECTED_STORAGE_FAILURE');}}:archive;
  try {
    const f=await integration({resultStore,handler:options.handler});
    return {f,directory,key,namespace,vault,archive,async close(){await f.close();await rm(directory,{recursive:true,force:true});}};
  } catch {await rm(directory,{recursive:true,force:true});throw new Error('M4_HTTP_SETUP_FAILED');}
}
const rawPaid=(f:any,p:any)=>fetch(f.url,{method:'POST',headers:{'content-type':'application/octet-stream','assurepay-request-id':p.requestId,'payment-signature':encodePaymentSignatureHeader(p.payment)},body:new Uint8Array([1,2,3])});

test('encrypted result survives provider restart after coverage expiry with identical receipt and no extra payment or execution',async()=>{
  const t=await fixture();const {f}=t;
  try {
    const p=await f.purchase(),first=await safeSend(()=>p.send());assert.equal(first.paid,true);
    const coverage=await f.f.coverage(p.call.intentHash);
    await f.f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(coverage.expiresAt+1n)]});
    await f.f.evm.publicClient.request({method:'evm_mine',params:[]});
    await f.restart(true);
    const second=await safeSend(()=>p.retry());assert.equal(second.paid,true);assert.equal(second.status,first.status);
    assert.equal(second.receipt?.signature===first.receipt?.signature,true);assert.deepEqual(second.body,first.body);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});
    const files=await readdir(join(t.directory,'objects'));
    assert.ok(files.length>0);
    for(const file of files){const raw=await readFile(join(t.directory,'objects',file),'utf8');assert.equal(raw.includes(first.receipt!.signature),false);assert.equal(raw.includes('responseHash'),false);}
    await f.check([p.call.intentHash]);
  }finally{await t.close();}
});

test('encrypted result written before completion marker recovers without rerunning handler',async()=>{
  const t=await fixture();const {f}=t;const complete=ServiceStore.prototype.complete;
  try {
    let fail=true;
    ServiceStore.prototype.complete=async function(...args:Parameters<typeof complete>){if(fail){fail=false;throw new Error('INJECTED_COMPLETION_FAILURE');}return complete.apply(this,args);};
    const p=await f.purchase(),first=await rawPaid(f,p);assert.equal(first.status,503);
    ServiceStore.prototype.complete=complete;
    await f.restart(true);
    const result=await safeSend(()=>p.retry());assert.equal(result.paid,true);assert.deepEqual([...result.body],[1,2,3,42]);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});await f.check([p.call.intentHash]);
  }finally{ServiceStore.prototype.complete=complete;await t.close();}
});

test('failed encrypted persistence leaves started indeterminate and cannot rerun handler',async()=>{
  const t=await fixture({failPut:true});const {f}=t;
  try {
    const p=await f.purchase(),first=await rawPaid(f,p);assert.equal(first.status,503);await f.restart(true);
    const next=await safeSend(()=>p.retry());assert.equal(next.status,202);assert.equal(next.paid,false);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});await f.check([p.call.intentHash]);
  }finally{await t.close();}
});

test('orphaned payment cannot release archived response even from memory cache',async()=>{
  const t=await fixture();const {f}=t;
  try {
    const snapshot=await f.f.evm.publicClient.request({method:'evm_snapshot',params:[]});
    const p=await f.purchase();await safeSend(()=>p.send());
    assert.equal(await f.f.evm.publicClient.request({method:'evm_revert',params:[snapshot]}),true);
    const orphan=await rawPaid(f,p);assert.equal(orphan.status,503);
    await f.restart(true);const restarted=await rawPaid(f,p);assert.equal(restarted.status,503);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});await f.check([]);
  }finally{await t.close();}
});

test('missing payment journal on archived retrieval cannot sign or submit a replacement',async()=>{
  const t=await fixture();const {f}=t;
  try {
    const p=await f.purchase();await safeSend(()=>p.send());
    await rm(f.journalPath);await f.restart(false);
    const response=await rawPaid(f,p);assert.equal(response.status,503);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});await f.check([p.call.intentHash]);
  }finally{await t.close();}
});
