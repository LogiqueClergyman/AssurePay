import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Terms } from '../src/types.js';
import { canonicalRequestUrl, hashRequest } from '../src/canonical.js';
import { createPayment, createRegisteredServer, prepareCall, requirementsFor } from '../src/protocol.js';
import { makeReceiptMessage, signReceipt, verifyReceipt } from '../src/receipt.js';
import type { Address, Hex } from 'viem';

const payer = privateKeyToAccount(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const terms: Terms = {
  chainId:84532,core:'0x1000000000000000000000000000000000000001',token:'0x2000000000000000000000000000000000000002',
  providerId:`0x${'31'.repeat(32)}`,policyId:`0x${'32'.repeat(32)}`,providerOwner:owner.address as Address,
  providerPayout:'0x3000000000000000000000000000000000000003',policyHash:`0x${'33'.repeat(32)}`,
  premiumBps:700,stakeBps:500,withholdingBps:0,duration:'3600',poolOnlyAllowed:false,
  gross:'1000000',premium:'70000',withheld:'0',net:'930000',stakeLock:'50000',poolReservation:'950000',tokenName:'USDC',tokenVersion:'2',
};
const requestId=`0x${'44'.repeat(32)}` as Hex;
const body=new Uint8Array([0,1,2,255]);
const url='https://api.example.test/assured';
const requestHash=hashRequest('POST',url,'application/octet-stream',body,requestId);

test('canonical request hashing binds exact URL, bytes and request ID',()=>{
  assert.equal(canonicalRequestUrl(url),url);
  assert.notEqual(hashRequest('POST',url,'application/octet-stream',new Uint8Array([0,1,2,254]),requestId),requestHash);
  assert.throws(()=>canonicalRequestUrl('https://api.example.test/assured?x=1'));
  assert.throws(()=>canonicalRequestUrl('http://api.example.test/assured'));
  assert.throws(()=>hashRequest('POST',url,'application/octet-stream',new Uint8Array(65_537),requestId));
  assert.throws(()=>hashRequest('POST',url,'application/octet-stream',body,`0x${'00'.repeat(32)}` as Hex));
});

test('requirements bind the full quote and reject inconsistent economics',()=>{
  const requirements=requirementsFor(terms,requestHash);
  assert.equal(requirements.amount,terms.gross);
  assert.equal((requirements.extra as any).providerNet,terms.net);
  const invalidTerms={...terms,stakeLock:'500000'};
  assert.throws(()=>requirementsFor(invalidTerms,requestHash),/INVALID_TERMS/);
});

test('actual registered x402 client creates a signed v2 payment and call validation rejects tampering and expiry',async()=>{
  const payment=await createPayment({terms,requestHash,payer:{address:payer.address.toLowerCase() as Address,signTypedData:(data:any)=>payer.signTypedData(data)},nowSeconds:1_800_000_000n,maxGross:'1000000',createSalt:()=>`0x${'55'.repeat(32)}` as Hex});
  assert.equal(Object.hasOwn(payment,'resource'),false,'undefined SDK metadata is removed by wire normalization');
  const call=await prepareCall(payment,terms,requestHash,1_800_000_000n);
  assert.equal(call.intentHash.length,66);
  const corrupted=structuredClone(payment) as any;
  corrupted.accepted.extra.providerNet='1';
  await assert.rejects(()=>prepareCall(corrupted,terms,requestHash,1_800_000_000n));
  const withUnknown=structuredClone(payment) as any;
  withUnknown.accepted.extra.extraFinancialHint='1';
  await assert.rejects(()=>prepareCall(withUnknown,terms,requestHash,1_800_000_000n));
  const withUnknownRoot=structuredClone(payment) as any;
  withUnknownRoot.extraFinancialHint='1';
  await assert.rejects(()=>prepareCall(withUnknownRoot,terms,requestHash,1_800_000_000n));
  const withResource={...payment,resource:{url}};
  await assert.doesNotReject(()=>prepareCall(withResource,terms,requestHash,1_800_000_000n));
  const badResource={...payment,resource:{url,financialHint:'1'}};
  await assert.rejects(()=>prepareCall(badResource,terms,requestHash,1_800_000_000n));
  await assert.rejects(()=>prepareCall(payment,terms,requestHash,1_800_000_500n));
  await assert.doesNotReject(()=>prepareCall(payment,terms,requestHash,1_800_000_500n,{allowExpired:true}));

  const server=await createRegisteredServer(terms,{async settle(){return {state:'confirmed',transaction:`0x${'77'.repeat(32)}` as Hex,coverageId:call.intentHash};}});
  assert.equal((await server.settle(payment,requestHash)).state,'confirmed');
  assert.equal((await server.settle(withUnknownRoot,requestHash)).state,'invalid','a rejected call cannot reuse the prior success');
  const mutableTerms={...terms};
  const snapshotServer=await createRegisteredServer(mutableTerms,{async settle(){return {state:'invalid',transaction:'',coverageId:call.intentHash};}});
  mutableTerms.gross='2';
  const challenge=await snapshotServer.challenge(requestHash,url);
  assert.equal(challenge.accepts[0].amount,terms.gross,'factory terms are snapshotted before later caller mutation');
});

test('owner signed receipt binds response bytes, request, status and provider identity',async()=>{
  const response=new Uint8Array([9,8,7]);
  const message=makeReceiptMessage({terms,coverageId:`0x${'66'.repeat(32)}` as Hex,requestHash,response,status:201,completedAt:1_800_000_010n});
  const receipt=await signReceipt(message,{address:owner.address,signTypedData:(data:any)=>owner.signTypedData(data)});
  assert.equal(await verifyReceipt(receipt,{terms,requestHash,response,status:201}),true);
  assert.equal(await verifyReceipt(receipt,{terms,requestHash,response:new Uint8Array([9,8,6]),status:201}),false);
  assert.equal(await verifyReceipt(receipt,{terms,requestHash,response,status:202}),false);
  assert.equal(await verifyReceipt({...receipt,signature:`0x${'00'.repeat(65)}` as Hex},{terms,requestHash,response,status:201}),false);
  const foreign=privateKeyToAccount(generatePrivateKey());
  const foreignReceipt=await signReceipt(message,{address:foreign.address,signTypedData:(data:any)=>foreign.signTypedData(data)});
  assert.equal(await verifyReceipt(foreignReceipt,{terms,requestHash,response,status:201}),false);
  assert.equal(await verifyReceipt(receipt,{terms,requestHash,response,status:201,coverageId:`0x${'67'.repeat(32)}` as Hex}),false);
  await assert.rejects(()=>signReceipt(message,{address:'bad' as Address,signTypedData:(data:any)=>owner.signTypedData(data)}));
});
