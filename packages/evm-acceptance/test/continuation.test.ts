import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeFunctionData } from 'viem';
import { createRehearsal } from '../src/rehearsal.js';
import { runCampaign } from '../src/campaign.js';
import { CORE_ABI } from '../../x402-assurance/src/core-abi.js';
import { requestHashFor } from '../src/fixtures.js';

test('explicit continuation recovers the exact seven-step prefix after purchase A and completes without repeating it',async()=>{
 const f=await createRehearsal();
 try{
  let failProjection=true;
  const client=new Proxy(f.evm.publicClient as any,{get(target,key){if(key==='getLogs')return async(...args:any[])=>{if(failProjection){failProjection=false;throw new Error('injected projection read failure');}return target.getLogs(...args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>runCampaign({...f.options,client}),/PROJECTION_UNAVAILABLE/);
  const prefix=JSON.parse(await readFile(f.options.journalPath,'utf8'));
  assert.equal(prefix.transactions.length,7);assert.deepEqual(prefix.transactions.map((row:any)=>row.kind),['deploy','provider','policy','approve','stake','pool','purchaseA']);
  const observationPath=join(f.options.dataDirectory,'transport-purchaseA.json');
  const savedA=await readFile(observationPath,'utf8');
  const originalJournal=await readFile(f.options.journalPath,'utf8');const changedPrefix=JSON.parse(originalJournal);changedPrefix.transactions[1].calldataHash=`0x${'00'.repeat(32)}`;
  await writeFile(f.options.journalPath,JSON.stringify(changedPrefix));
  await assert.rejects(()=>runCampaign({...f.options,client,continueAfterPurchaseA:true}),/CAMPAIGN_CANONICALITY_UNAVAILABLE|M5_CONTINUATION_RECONCILIATION_FAILED/);
  await writeFile(f.options.journalPath,originalJournal);
  const signedTypes:string[]=[];const settlementRequests:string[]=[];
  const accounts={...f.options.accounts,payer:{...f.options.accounts.payer,async signTypedData(data:any){signedTypes.push(data.primaryType);return f.options.accounts.payer.signTypedData(data);}},provider:{...f.options.accounts.provider,async signTypedData(data:any){signedTypes.push(data.primaryType);return f.options.accounts.provider.signTypedData(data);}}};
  const wallet={...f.options.wallet,async signTransaction(args:any){try{const decoded=decodeFunctionData({abi:CORE_ABI,data:args.data});if(decoded.functionName==='settleAssured'){const raw=decoded.args[0] as any;settlementRequests.push(raw.requestHash);}}catch{}return f.options.wallet.signTransaction(args);}};
  const continuing=await runCampaign({...f.options,client,accounts,wallet,continueAfterPurchaseA:true});
  assert.equal(continuing.verification.ok,true);assert.equal(continuing.manifest.transactions.length,14);
  assert.deepEqual(continuing.manifest.transactions.slice(0,7).map(row=>row.transaction),prefix.transactions.map((row:any)=>row.transaction));
  assert.equal(await readFile(observationPath,'utf8'),savedA);
  assert.equal(continuing.transport.purchaseA.status,200);
  assert.equal(settlementRequests.filter(hash=>hash===requestHashFor(f.config,'purchaseA')).length,0);
  assert.equal(settlementRequests.filter(hash=>hash===requestHashFor(f.config,'purchaseB')).length,1);
  assert.equal(signedTypes.filter(type=>type==='ReceiveWithAuthorization').length,2);
  assert.equal(signedTypes.filter(type=>type==='AssuredResponseV1').length,1);
  await assert.rejects(()=>runCampaign({...f.options,client,continueAfterPurchaseA:true}),/M5_CONTINUATION_PREFIX_INVALID/);
 }finally{await f.close();}
});

test('expired Purchase A prefix is rejected before continuation signs or submits',async()=>{
 const f=await createRehearsal();
 try{
  let failProjection=true;
  const client=new Proxy(f.evm.publicClient as any,{get(target,key){if(key==='getLogs')return async(...args:any[])=>{if(failProjection){failProjection=false;throw new Error('injected projection read failure');}return target.getLogs(...args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>runCampaign({...f.options,client}),/PROJECTION_UNAVAILABLE/);
  const before=JSON.parse(await readFile(f.options.journalPath,'utf8'));
  assert.equal(before.transactions.length,7);
  await f.evm.publicClient.request({method:'evm_increaseTime',params:[3601]});
  await f.evm.publicClient.request({method:'evm_mine',params:[]});
  let signatures=0,broadcasts=0;
  const accounts=Object.fromEntries(Object.entries(f.options.accounts).map(([actor,account]:[string,any])=>[actor,{...account,async signTypedData(...args:any[]){signatures++;return account.signTypedData(...args);}}])) as any;
  const wallet={...f.options.wallet,async signTransaction(...args:any[]){signatures++;return f.options.wallet.signTransaction(...args);}};
  const guardedClient=new Proxy(client as any,{get(target,key){if(key==='sendRawTransaction')return async(...args:any[])=>{broadcasts++;return target.sendRawTransaction(...args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>runCampaign({...f.options,client:guardedClient,accounts,wallet,continueAfterPurchaseA:true}),/M5_CONTINUATION_CLAIM_WINDOW_CLOSED/);
  const after=JSON.parse(await readFile(f.options.journalPath,'utf8'));
  assert.equal(signatures,0);assert.equal(broadcasts,0);
  assert.deepEqual(after,before);
  assert.equal(after.transactions.length,7);
 }finally{await f.close();}
});
