import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { transact } from '../../evm-core/test/helpers/evm.js';
import { integration, H, safeSend } from './helpers/integration.js';
import { prepareCall, createPayment } from '../src/protocol.js';

const paidHeaders=(payment:any,requestId:string)=>({'content-type':'application/octet-stream','assurepay-request-id':requestId,'payment-signature':encodePaymentSignatureHeader(payment)});

test('actual HTTP and registered x402 settle dynamic M2 terms before one handler; exact retries reuse response and payment',async()=>{
  const f=await integration();
  try{
    const p=await f.purchase();
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:0,relayerSignatures:0,handlers:0});
    assert.equal(p.call.intent.gross,'10003');assert.equal(f.terms.premium,'777');assert.equal(f.terms.withheld,'2029');assert.equal(f.terms.stakeLock,'3502');
    const payerBefore=await f.f.balance(f.f.evm.payer.address),coreBefore=await f.f.balance(f.f.core),payoutBefore=await f.f.balance(f.terms.providerPayout);
    const [a,b]=await safeSend(()=>Promise.all([p.send(),p.retry()]));
    assert.equal(a.paid,true);assert.equal(a.status,200);assert.equal(b.paid,true);
    assert.deepEqual([...a.body],[1,2,3,42]);assert.deepEqual([...a.body],[...b.body]);
    assert.equal(a.receipt?.message.coverageId,p.call.intentHash);
    assert.equal(a.receipt?.signature===b.receipt?.signature,true);
    assert.equal(await f.f.balance(f.f.evm.payer.address),payerBefore-10003n);
    assert.equal(await f.f.balance(f.f.core),coreBefore+2806n);
    assert.equal(await f.f.balance(f.terms.providerPayout),payoutBefore+7197n);
    const again=await safeSend(()=>p.retry());assert.equal(again.paid,true);
    assert.equal(again.receipt?.signature===a.receipt?.signature,true);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});
    await f.check([p.call.intentHash]);
  }finally{await f.close();}
});

test('malformed request binding and a second payment for the same request are rejected before charging',async()=>{
  const f=await integration();
  try{
    const p=await f.purchase();
    const changed=await fetch(f.url,{method:'POST',headers:paidHeaders(p.payment,p.requestId),body:new Uint8Array([1,2,4])});
    assert.ok(changed.status>=400);assert.equal(f.counts().broadcasts,0);assert.equal(f.counts().handlers,0);
    await safeSend(()=>p.send());
    const now=(await f.f.evm.publicClient.getBlock()).timestamp;
    const second=await createPayment({terms:f.terms,requestHash:p.requestHash,payer:f.payer,nowSeconds:now,maxGross:'11000'});
    const response=await fetch(f.url,{method:'POST',headers:paidHeaders(second,p.requestId),body:new Uint8Array([1,2,3])});
    assert.equal(response.status,409);assert.equal(f.counts().broadcasts,1);assert.equal(f.counts().handlers,1);
    assert.equal((await f.f.globals()).coverageCount,1n);
    await f.check([p.call.intentHash]);
  }finally{await f.close();}
});

test('lost broadcast response stays pending then signer-free restart recovers after authorization expiry while coverage remains live',async()=>{
  const f=await integration();
  try{
    const p=await f.purchase();f.hide(true);f.lose(true);
    const pending=await safeSend(()=>p.send());assert.equal(pending.status,202);assert.equal(pending.paid,false);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:0});
    f.hide(false);f.lose(false);
    await f.f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(BigInt(p.call.intent.validBefore)+1n)]});
    await f.f.evm.publicClient.request({method:'evm_mine',params:[]});
    await f.restart(true);
    const confirmed=await safeSend(()=>p.retry());assert.equal(confirmed.paid,true);assert.equal(confirmed.status,200);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});
    await f.check([p.call.intentHash]);
  }finally{await f.close();}
});

test('lost HTTP response returns identical cached result without another signature, broadcast or handler',async()=>{
  const f=await integration();
  try{
    let dropped=false;
    const p=await f.purchase({fetch:async(input,init)=>{
      const response=await fetch(input,init);
      if(new Headers(init?.headers).has('payment-signature')&&!dropped){dropped=true;await response.arrayBuffer();throw new Error('LOCAL_HTTP_RESPONSE_LOST');}
      return response;
    }});
    await assert.rejects(safeSend(()=>p.send()),/PAID_RESPONSE_UNAVAILABLE/);
    const result=await safeSend(()=>p.retry());assert.equal(result.paid,true);assert.deepEqual([...result.body],[1,2,3,42]);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});
  }finally{await f.close();}
});

test('completed provider restart reports response unavailable and never reruns the paid handler',async()=>{
  const f=await integration();
  try{
    const p=await f.purchase();await safeSend(()=>p.send());await f.restart(true);
    const response=await fetch(f.url,{method:'POST',headers:paidHeaders(p.payment,p.requestId),body:new Uint8Array([1,2,3])});
    assert.equal(response.status,409);assert.equal(await response.text(),'RESPONSE_UNAVAILABLE');
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});
  }finally{await f.close();}
});

test('handler failure yields signed500, retained coverage and stable retry result',async()=>{
  const f=await integration({handler:async()=>{throw new Error('LOCAL_SERVICE_FAILURE');}});
  try{
    const p=await f.purchase();const result=await safeSend(()=>p.send());assert.equal(result.status,500);assert.equal(result.paid,true);
    assert.equal(result.receipt?.message.status,500);assert.equal((await f.f.globals()).coverageCount,1n);
    const retry=await safeSend(()=>p.retry());assert.equal(retry.status,500);assert.equal(retry.receipt?.signature===result.receipt?.signature,true);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});await f.check([p.call.intentHash]);
  }finally{await f.close();}
});

test('paused, unfunded and newly expired payments never execute service or consume authorization',async()=>{
  for(const scenario of ['pause','pool','stake','expiry'] as const){
    const f=await integration({pool:scenario==='pool'?0n:1_000_000n,stake:scenario==='stake'?0n:1_000_000n});
    try{
      const p=await f.purchase();
      if(scenario==='pause')await transact(f.f.evm,f.f.coreAbi,f.f.core,'setPaused',[true]);
      if(scenario==='expiry'){
        await f.f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(BigInt(p.call.intent.validBefore))]});
        await f.f.evm.publicClient.request({method:'evm_mine',params:[]});
      }
      const response=await fetch(f.url,{method:'POST',headers:paidHeaders(p.payment,p.requestId),body:new Uint8Array([1,2,3])});
      assert.ok(response.status===402||response.status===400||response.status===202);
      assert.equal(f.counts().handlers,0);assert.equal(f.counts().broadcasts,0);
      assert.equal(await f.f.authorizationUsed(f.f.evm.payer.address,p.call.intentHash),false);
      assert.equal((await f.f.globals()).coverageCount,0n);await f.check([]);
    }finally{await f.close();}
  }
});

test('distinct purchases use serialized nonces and identical concurrent HTTP requests execute once',async()=>{
  const f=await integration();
  try{
    const [a,b]=await Promise.all([f.purchase(),f.purchase({body:new Uint8Array([4,5,6])})]);
    const responses=await safeSend(()=>Promise.all([a.send(),b.send()]));assert.equal(responses.every(r=>r.paid),true);
    assert.deepEqual(f.counts(),{signatures:2,broadcasts:2,relayerSignatures:2,handlers:2});
    await f.check([a.call.intentHash,b.call.intentHash]);
  }finally{await f.close();}
});

test('two identical raw HTTP paid requests coalesce one settlement and one handler',async()=>{
  const f=await integration();
  try{
    const p=await f.purchase();const init={method:'POST',headers:paidHeaders(p.payment,p.requestId),body:new Uint8Array([1,2,3])};
    const [a,b]=await Promise.all([fetch(f.url,init),fetch(f.url,init)]);
    assert.equal(a.status,200);assert.equal(b.status,200);
    assert.equal(a.headers.get('assurepay-receipt')===b.headers.get('assurepay-receipt'),true);
    assert.deepEqual([...new Uint8Array(await a.arrayBuffer())],[...new Uint8Array(await b.arrayBuffer())]);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});await f.check([p.call.intentHash]);
  }finally{await f.close();}
});

test('an interrupted started handler is indeterminate after restart and never executed again',async()=>{
  let markStarted!:()=>void;const entered=new Promise<void>(resolve=>{markStarted=resolve;});
  const f=await integration({handler:async()=>{markStarted();return new Promise<Uint8Array>(()=>{});}});
  try{
    const p=await f.purchase();const abandoned=p.send().catch(()=>undefined);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([entered,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new Error('HANDLER_NEVER_STARTED')),5000);})]);}
    finally{if(timer)clearTimeout(timer);}
    const known=await f.engine.settle(p.call);assert.equal(known.state,'confirmed');
    await f.restart(true);await abandoned;
    const response=await fetch(f.url,{method:'POST',headers:paidHeaders(p.payment,p.requestId),body:new Uint8Array([1,2,3])});
    assert.equal(response.status,202);const body=await response.json() as {code:string;transaction:string;coverageId:string};
    assert.equal(body.code,'SERVICE_INDETERMINATE');assert.equal(body.transaction,known.transaction);assert.equal(body.coverageId,p.call.intentHash);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:1,relayerSignatures:1,handlers:1});await f.check([p.call.intentHash]);
  }finally{await f.close();}
});

test('historical payment recovery cannot start a service after its coverage expiry',async()=>{
  const f=await integration();
  try{
    const p=await f.purchase();f.hide(true);f.lose(true);await safeSend(()=>p.send());f.hide(false);f.lose(false);
    const c=await f.f.coverage(p.call.intentHash);
    await f.f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(c.expiresAt)]});
    await f.f.evm.publicClient.request({method:'evm_mine',params:[]});await f.restart(true);
    const response=await fetch(f.url,{method:'POST',headers:paidHeaders(p.payment,p.requestId),body:new Uint8Array([1,2,3])});
    assert.ok(response.status===409||response.status===503);assert.equal(f.counts().handlers,0);assert.equal(f.counts().broadcasts,1);
    await f.check([p.call.intentHash]);
  }finally{await f.close();}
});

test('unpaid and invalid signed HTTP payments never charge or serve; malformed transport fails closed',async()=>{
  const f=await integration();
  try{
    const p=await f.purchase();
    const unpaid=await fetch(f.url,{method:'POST',headers:{'content-type':'application/octet-stream','assurepay-request-id':p.requestId},body:new Uint8Array([1,2,3])});
    assert.equal(unpaid.status,402);
    for(const mutate of [
      (v:any)=>{v.payload.signature=`0x${'00'.repeat(65)}`;},
      (v:any)=>{v.accepted.extra.policyHash=H(902);},
      (v:any)=>{v.payload.intent.gross='10004';},
      (v:any)=>{v.accepted.extra.profile='unsupported';},
    ]){
      const payment=structuredClone(p.payment);mutate(payment);
      const response=await fetch(f.url,{method:'POST',headers:paidHeaders(payment,p.requestId),body:new Uint8Array([1,2,3])});
      assert.equal(response.status,402);
    }
    const oversized=await fetch(f.url,{method:'POST',headers:paidHeaders(p.payment,p.requestId),body:new Uint8Array(65_537)});
    assert.equal(oversized.status,413);
    const wrongType=await fetch(f.url,{method:'POST',headers:{...paidHeaders(p.payment,p.requestId),'content-type':'application/json'},body:'{}'});
    assert.equal(wrongType.status,415);
    const query=await fetch(`${f.url}?changed=1`,{method:'POST',headers:paidHeaders(p.payment,p.requestId),body:new Uint8Array([1,2,3])});
    assert.equal(query.status,404);
    assert.deepEqual(f.counts(),{signatures:1,broadcasts:0,relayerSignatures:0,handlers:0});
    assert.equal(await f.f.authorizationUsed(f.f.evm.payer.address,p.call.intentHash),false);
    await f.check([]);
  }finally{await f.close();}
});

test('concurrent different intents for one request reserve one identity before either can charge',async()=>{
  const f=await integration();
  try{
    const p=await f.purchase();
    const second=await createPayment({terms:f.terms,requestHash:p.requestHash,payer:f.payer,nowSeconds:(await f.f.evm.publicClient.getBlock()).timestamp,maxGross:'11000'});
    const responses=await Promise.all([p.payment,second].map(payment=>fetch(f.url,{method:'POST',headers:paidHeaders(payment,p.requestId),body:new Uint8Array([1,2,3])})));
    assert.equal(responses.filter(r=>r.status===200).length,1);
    assert.equal(responses.filter(r=>r.status===409||r.status===402).length,1);
    assert.deepEqual(f.counts(),{signatures:2,broadcasts:1,relayerSignatures:1,handlers:1});
    const secondCall=await prepareCall(second,f.terms,p.requestHash,0n,{allowExpired:true});
    const ids=[p.call.intentHash,secondCall.intentHash];
    const used=await Promise.all(ids.map(id=>f.f.authorizationUsed(f.f.evm.payer.address,id)));
    assert.equal(used.filter(Boolean).length,1);
    await f.check(ids.filter((_id,index)=>used[index]));
  }finally{await f.close();}
});
