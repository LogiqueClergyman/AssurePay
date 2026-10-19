import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeFunctionData, parseSignature, toFunctionSelector, type Address, type Hex } from 'viem';
import { startEvm, deploy, transact, attemptRevert, signReceive, solidityIntent, compileContracts } from './helpers/evm.js';
import { hashIntent, hashPolicy, type Intent } from './helpers/intent.js';

const H=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const providerId=H(11),policyId=H(22),decision=H(33);
async function fixture(){
  const evm=await startEvm();
  try{
    const artifacts=compileContracts(),coreAbi=artifacts.AssuranceCore!.abi,tokenAbi=artifacts.AuthorizationTokenMock!.abi;
    const token=await deploy(evm,artifacts.AuthorizationTokenMock!);
    const core=await deploy(evm,artifacts.AssuranceCore!,[token,evm.owner.address,evm.outsider.address]);
    const read=(fn:string,args:readonly unknown[]=[])=>evm.publicClient.readContract({address:core,abi:coreAbi,functionName:fn,args});
    const tok=(fn:string,args:readonly unknown[]=[])=>evm.publicClient.readContract({address:token,abi:tokenAbi,functionName:fn,args});
    const tx=(fn:string,args:readonly unknown[]=[],account=evm.owner)=>transact(evm,coreAbi,core,fn,args,account);
    const revert=(fn:string,args:readonly unknown[]=[],account=evm.owner)=>attemptRevert(evm,coreAbi,core,fn,args,account);
    const tokenTx=(fn:string,args:readonly unknown[]=[],account=evm.owner)=>transact(evm,tokenAbi,token,fn,args,account);
    await tx('registerProvider',[providerId,evm.provider.address,evm.provider.address]);
    await tx('registerPolicy',[policyId,providerId,700,3000,2000,3600n,true]);
    for(const account of [evm.owner,evm.payer,evm.provider])await tokenTx('mint',[account.address,1_000_000n]);
    await tokenTx('approve',[core,100_000n]);
    await tx('depositStake',[providerId,10_000n]);
    await tx('fundPool',[10_000n]);
    let salt=100;
    const intent=async(overrides:Partial<Intent>={}):Promise<Intent>=>{
      const now=(await evm.publicClient.getBlock()).timestamp as bigint;
      const policy=await read('policies',[policyId]);
      return {chainId:'84532',core:core.toLowerCase() as Address,token:token.toLowerCase() as Address,payer:evm.payer.address.toLowerCase() as Address,
        providerId,policyId,policyHash:policy[1],requestHash:H(44),gross:'101',payerSalt:H(salt++),validAfter:String(now-1n),validBefore:String(now+299n),...overrides};
    };
    const args=async(i:Intent)=>{const s=await signReceive(evm.payer,i);return [solidityIntent(i),s.v,s.r,s.s] as const;};
    const snapshot=async(i:Intent)=>({
      balances:await Promise.all([evm.payer.address,core,evm.provider.address].map(a=>tok('balanceOf',[a]))),
      state:await Promise.all(['poolAssets','totalPoolReserved','totalProviderStake','totalLockedStake','coverageCount','activeCoverageCount'].map(fn=>read(fn))),
      provider:await read('providers',[providerId]),coverage:await read('coverages',[hashIntent(i)]),nonce:await tok('authorizationState',[i.payer,hashIntent(i)]),
    });
    return {evm,artifacts,coreAbi,tokenAbi,token,core,read,tok,tx,revert,tokenTx,intent,args,snapshot};
  }catch{await evm.close();throw new Error('LOCAL_SECURITY_FIXTURE_FAILED');}
}

test('M1 golden intent and immutable policy hash match Solidity; every intent substitution fails',async()=>{
  const f=await fixture();
  try{
    const vector=JSON.parse(await readFile(new URL('../../../spikes/evm-m1/vectors/intent-v1.json',import.meta.url),'utf8'));
    assert.equal(hashIntent(vector.intent),vector.intentHash);
    assert.equal(await f.read('hashIntent',[solidityIntent(vector.intent)]),vector.intentHash);
    assert.equal((await f.read('policies',[policyId]))[1],hashPolicy({providerId,policyId,providerOwner:f.evm.provider.address,providerPayout:f.evm.provider.address,premiumBps:700,stakeBps:3000,withholdingBps:2000,duration:3600n,poolOnlyAllowed:true}));
    const i=await f.intent(),a=await f.args(i),before=await f.snapshot(i);
    const mutations:Partial<Intent>[]=[{chainId:'84531'},{core:f.evm.outsider.address},{token:f.evm.outsider.address},{payer:f.evm.owner.address},
      {providerId:H(99)},{policyId:H(99)},{policyHash:H(99)},{requestHash:H(99)},{gross:'102'},{payerSalt:H(99)},
      {validAfter:String(BigInt(i.validAfter)-1n)},{validBefore:String(BigInt(i.validBefore)-1n)}];
    for(const mutation of mutations){await f.revert('settleAssured',[solidityIntent({...i,...mutation}),...a.slice(1)]);assert.deepEqual(await f.snapshot(i),before);}
    await f.tx('settleAssured',a);
    assert.equal(await f.tok('authorizationState',[i.payer,hashIntent(i)]),true);
    const settled=await f.snapshot(i);await f.revert('settleAssured',a);assert.deepEqual(await f.snapshot(i),settled);
  }finally{await f.evm.close();}
});

test('extracted receive, wrong payer/domain/type and signed cancellation cannot settle',async()=>{
  const f=await fixture();
  try{
    const i=await f.intent(),s=await signReceive(f.evm.payer,i),before=await f.snapshot(i);
    await attemptRevert(f.evm,f.tokenAbi,f.token,'receiveWithAuthorization',[i.payer,f.core,BigInt(i.gross),BigInt(i.validAfter),BigInt(i.validBefore),hashIntent(i),s.v,s.r,s.s]);
    const fromOther=await signReceive(f.evm.outsider,i);await f.revert('settleAssured',[solidityIntent(i),fromOther.v,fromOther.r,fromOther.s]);
    const domain=await signReceive(f.evm.payer,{...i,chainId:'84531'});await f.revert('settleAssured',[solidityIntent(i),domain.v,domain.r,domain.s]);
    const fields=[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}] as const;
    let wrongDomain;
    try{wrongDomain=parseSignature(await f.evm.payer.signTypedData({domain:{name:'USDC',version:'2',chainId:84531,verifyingContract:f.token},primaryType:'ReceiveWithAuthorization',types:{ReceiveWithAuthorization:fields},message:{from:i.payer,to:f.core,value:BigInt(i.gross),validAfter:BigInt(i.validAfter),validBefore:BigInt(i.validBefore),nonce:hashIntent(i)}}));}catch{throw new Error('LOCAL_WRONG_DOMAIN_SIGNING_FAILED');}
    await f.revert('settleAssured',[solidityIntent(i),Number(wrongDomain.v),wrongDomain.r,wrongDomain.s]);
    let transfer;
    try{transfer=parseSignature(await f.evm.payer.signTypedData({domain:{name:'USDC',version:'2',chainId:84532,verifyingContract:f.token},primaryType:'TransferWithAuthorization',types:{TransferWithAuthorization:fields},message:{from:i.payer,to:f.core,value:BigInt(i.gross),validAfter:BigInt(i.validAfter),validBefore:BigInt(i.validBefore),nonce:hashIntent(i)}}));}catch{throw new Error('LOCAL_WRONG_TYPE_SIGNING_FAILED');}
    await f.revert('settleAssured',[solidityIntent(i),Number(transfer.v),transfer.r,transfer.s]);assert.deepEqual(await f.snapshot(i),before);
    let cancel;
    try{cancel=parseSignature(await f.evm.payer.signTypedData({domain:{name:'USDC',version:'2',chainId:84532,verifyingContract:f.token},primaryType:'CancelAuthorization',types:{CancelAuthorization:[{name:'authorizer',type:'address'},{name:'nonce',type:'bytes32'}]},message:{authorizer:i.payer,nonce:hashIntent(i)}}));}catch{throw new Error('LOCAL_CANCEL_SIGNING_FAILED');}
    await f.tokenTx('cancelAuthorization',[i.payer,hashIntent(i),Number(cancel.v),cancel.r,cancel.s]);
    await f.revert('settleAssured',[solidityIntent(i),s.v,s.r,s.s]);
    assert.equal(await f.tok('authorizationState',[i.payer,hashIntent(i)]),true);
    assert.equal(await f.read('coverageCount'),0n);
  }finally{await f.evm.close();}
});

test('failed payout and fee postcondition roll back receive nonce, coverage and every ledger; reentry guard executes',async()=>{
  const f=await fixture();
  try{
    const i=await f.intent(),a=await f.args(i),before=await f.snapshot(i);
    await f.tokenTx('setFailTransfers',[true]);await f.revert('settleAssured',a);assert.deepEqual(await f.snapshot(i),before);
    await f.tokenTx('setFailTransfers',[false]);await f.tokenTx('setTransferFee',[1n]);
    await f.revert('settleAssured',a);assert.deepEqual(await f.snapshot(i),before);
    await f.tokenTx('setTransferFee',[0n]);
    await f.tokenTx('setReentry',[f.core,encodeFunctionData({abi:f.coreAbi,functionName:'fundPool',args:[1n]})]);
    await f.tx('settleAssured',a);
    assert.equal(await f.tok('lastReentrySucceeded'),false);
    assert.equal(await f.tok('lastReentrySelector'),toFunctionSelector('ReentrancyGuardReentrantCall()'));
    assert.equal(await f.tok('authorizationState',[i.payer,hashIntent(i)]),true);
  }finally{await f.evm.close();}
});

test('failed withdrawals and refunds revert debit and terminal bookkeeping; only stored payer receives refund',async()=>{
  const f=await fixture();
  try{
    const i=await f.intent(),a=await f.args(i);await f.tx('settleAssured',a);
    await f.tx('fileClaim',[hashIntent(i),H(55)],f.evm.payer);
    const before=await f.snapshot(i);
    await f.revert('finalizeClaim',[hashIntent(i),1,100n,decision],f.evm.provider);assert.deepEqual(await f.snapshot(i),before);
    await f.tokenTx('setTransferFee',[1n]);
    await f.revert('withdrawStake',[providerId,1n],f.evm.provider);assert.deepEqual(await f.snapshot(i),before);
    await f.revert('finalizeClaim',[hashIntent(i),1,100n,decision],f.evm.outsider);assert.deepEqual(await f.snapshot(i),before);
    await f.tokenTx('setTransferFee',[0n]);await f.tokenTx('setFailTransfers',[true]);
    await f.revert('finalizeClaim',[hashIntent(i),2,101n,decision],f.evm.outsider);assert.deepEqual(await f.snapshot(i),before);
    await f.tokenTx('setFailTransfers',[false]);
    const payerBefore=await f.tok('balanceOf',[i.payer]),resolverBefore=await f.tok('balanceOf',[f.evm.outsider.address]);
    await f.tx('finalizeClaim',[hashIntent(i),2,101n,decision],f.evm.outsider);
    assert.equal(await f.tok('balanceOf',[i.payer]),payerBefore+101n);
    assert.equal(await f.tok('balanceOf',[f.evm.outsider.address]),resolverBefore);
    assert.equal((await f.read('coverages',[hashIntent(i)]))[13],3);
    const done=await f.snapshot(i);await f.revert('finalizeClaim',[hashIntent(i),2,101n,decision],f.evm.outsider);assert.deepEqual(await f.snapshot(i),done);
  }finally{await f.evm.close();}
});

test('strict authorization edges, excessive duration, tiny gross and overflow-safe quotes are enforced',async()=>{
  const f=await fixture();
  try{
    for(const bounds of [{validAfter:'0'},{validBefore:'1'},{gross:'1'}]){const i=await f.intent(bounds);await f.revert('settleAssured',await f.args(i));}
    const i=await f.intent();
    const tooLong={...i,validBefore:String(BigInt(i.validAfter)+301n)};await f.revert('settleAssured',await f.args(tooLong));
    const edge=await f.intent(),a=await f.args(edge);
    await f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(BigInt(edge.validBefore))]});
    await f.revert('settleAssured',a);
    const future=await f.intent();const start=(await f.evm.publicClient.getBlock()).timestamp+10n;
    const atStart={...future,validAfter:String(start),validBefore:String(start+300n)},startArgs=await f.args(atStart);
    await f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(start)]});await f.revert('settleAssured',startArgs);
    await f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(start+1n)]});await f.tx('settleAssured',startArgs);
    const max=(1n<<256n)-1n,q=await f.read('quoteSettlement',[policyId,max]);
    const p=max*700n/10000n,w=(max-p)*2000n/10000n,l=(max*3000n+9999n)/10000n;
    assert.deepEqual(q,[p,w,max-p-w,l,max]);
  }finally{await f.evm.close();}
});

test('constructor, immutable registry, role authorization and failed deposits reject without changing ledgers',async()=>{
  const f=await fixture();
  const zero='0x0000000000000000000000000000000000000000';
  try{
    for(const constructorArgs of [[f.evm.payer.address,f.evm.owner.address,f.evm.outsider.address],[f.token,zero,f.evm.outsider.address],[f.token,f.evm.owner.address,zero],[f.token,f.token,f.evm.outsider.address],[f.token,f.evm.owner.address,f.token]]){
      await assert.rejects(deploy(f.evm,f.artifacts.AssuranceCore!,constructorArgs),/LOCAL_DEPLOYMENT_FAILED/);
    }
    const original=await f.read('policies',[policyId]),provider=await f.read('providers',[providerId]);
    await f.revert('registerProvider',[H(88),f.evm.payer.address,f.evm.payer.address],f.evm.payer);
    await f.revert('registerProvider',[providerId,f.evm.owner.address,f.evm.owner.address]);
    for(const owner of [zero,f.core,f.token])await f.revert('registerProvider',[H(88),owner,f.evm.provider.address]);
    for(const payout of [zero,f.core,f.token])await f.revert('registerProvider',[H(88),f.evm.provider.address,payout]);
    await f.revert('registerPolicy',[policyId,providerId,1,1,1,1n,false]);
    for(const [premium,stake,withholding,duration] of [[10000,0,0,1n],[0,10001,0,1n],[0,0,10000,1n],[0,0,0,0n]] as const){
      await f.revert('registerPolicy',[H(88),providerId,premium,stake,withholding,duration,false]);
    }
    await f.revert('registerPolicy',[H(88),H(99),0,0,0,1n,false]);
    await f.revert('registerPolicy',[H(88),providerId,0,0,0,1n,false],f.evm.payer);
    await f.revert('setPaused',[true],f.evm.payer);
    assert.deepEqual(await f.read('policies',[policyId]),original);assert.deepEqual(await f.read('providers',[providerId]),provider);
    const i=await f.intent(),before=await f.snapshot(i);
    await f.revert('withdrawStake',[providerId,1n],f.evm.payer);
    await f.revert('fundPool',[0n]);await f.revert('depositStake',[H(99),1n]);
    await f.tokenTx('approve',[f.core,0n]);await f.revert('fundPool',[1n]);
    assert.deepEqual(await f.snapshot(i),before);
    await f.tx('setPaused',[true]);await f.revert('registerPolicy',[H(88),providerId,0,0,0,1n,false]);
    await f.revert('registerProvider',[H(88),f.evm.provider.address,f.evm.provider.address]);
    await f.tx('withdrawStake',[providerId,1n],f.evm.provider);
    assert.equal((await f.read('providers',[providerId]))[2],provider[2]-1n);
  }finally{await f.evm.close();}
});

test('an unclaimed coverage cannot close early or accept a claim at exact expiry; expiry overflow rolls back',async()=>{
  const f=await fixture();
  try{
    const i=await f.intent();await f.tx('settleAssured',await f.args(i));
    const id=hashIntent(i),c=await f.read('coverages',[id]);
    await f.revert('fileClaim',[id,H(33)],f.evm.provider);
    await f.revert('fileClaim',[id,H(0)],f.evm.payer);
    await f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(c[11]-1n)]});
    await f.revert('closeExpired',[id]);
    await f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(c[11])]});
    const before=await f.snapshot(i);await f.revert('fileClaim',[id,H(33)],f.evm.payer);assert.deepEqual(await f.snapshot(i),before);
    await f.tx('closeExpired',[id],f.evm.payer);
    const expired=await f.snapshot(i);assert.equal(expired.coverage[13],5);
    await f.revert('closeExpired',[id]);assert.deepEqual(await f.snapshot(i),expired);
    const maxPolicy=H(999);await f.tx('registerPolicy',[maxPolicy,providerId,0,0,0,(1n<<64n)-1n,false]);
    const overflow=await f.intent({policyId:maxPolicy,policyHash:(await f.read('policies',[maxPolicy]))[1]});
    const unchanged=await f.snapshot(overflow);await f.revert('settleAssured',await f.args(overflow));
    assert.deepEqual(await f.snapshot(overflow),unchanged);
  }finally{await f.evm.close();}
});

test('withholding in the same settlement can fund its stake lock without seeded provider stake',async()=>{
  const f=await fixture();
  try{
    await f.tx('withdrawStake',[providerId,10_000n],f.evm.provider);
    const selfFunded=H(777);await f.tx('registerPolicy',[selfFunded,providerId,1000,5000,9999,3600n,false]);
    const i=await f.intent({policyId:selfFunded,policyHash:(await f.read('policies',[selfFunded]))[1],gross:'10003'});
    const before=await f.snapshot(i);assert.equal(before.provider[2],0n);assert.equal(before.provider[3],0n);
    await f.tx('settleAssured',await f.args(i));
    const after=await f.snapshot(i);
    assert.equal(after.provider[2],4000n);assert.equal(after.provider[3],5002n);
    assert.equal(after.balances[1]-before.balances[1],10002n);
    assert.equal(after.balances[2]-before.balances[2],1n);
    assert.equal(await f.read('totalProviderStake'),9002n);
    assert.equal(await f.read('totalPoolReserved'),5001n);
    assert.equal(after.nonce,true);
  }finally{await f.evm.close();}
});
