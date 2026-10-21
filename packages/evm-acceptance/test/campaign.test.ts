import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRehearsal } from '../src/rehearsal.js';
import { runCampaign } from '../src/campaign.js';
import { STEP_ORDER } from '../src/plan.js';

test('complete local campaign composes fourteen bounded EVM steps, signed HTTP recovery, explicit refunds and independent verification',async()=>{
 const f=await createRehearsal();
 try{
  const result=await f.run();
  assert.equal(result.verification.ok,true);assert.equal(result.verification.code,'M5_LOCAL_REHEARSAL_VERIFIED');
  assert.equal(result.manifest.transactions.length,14);assert.deepEqual(result.manifest.transactions.map(tx=>tx.kind),STEP_ORDER);
  assert.equal(result.manifest.transactions.at(-1)?.status,'reverted');
  assert.equal(result.transport.purchaseA.status,200);assert.equal(result.transport.purchaseB.status,500);
  for(const check of Object.values(result.transport)){assert.equal(check.retryMatches,true);assert.equal(check.paymentSignatures,1);assert.equal(check.relayerSignatures,1);assert.equal(check.broadcasts,1);assert.equal(check.handlers,1);}
  for(const name of ['purchaseA','purchaseB'] as const){
   const saved=JSON.parse(await readFile(join(f.options.dataDirectory,`transport-${name}.json`),'utf8'));
   assert.deepEqual(saved,{version:1,runId:f.config.runId,core:result.manifest.core,case:name,observed:result.transport[name]});
  }
  const journal=await readFile(f.options.journalPath,'utf8');assert.equal(journal.includes('signature'),false);assert.equal(journal.includes('serializedTransaction'),false);
  await assert.rejects(()=>runCampaign(f.options),/M5_EXISTING_CAMPAIGN_RECONCILE_ONLY/);
 }finally{await f.close();}
});
