import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCampaign } from '../src/verify.js';
import { GAS_CAPS, MAX_FEE_PER_GAS, MAX_PRIORITY_FEE_PER_GAS, NATIVE_USDC, STEP_ORDER, stepActor } from '../src/plan.js';
import { createRehearsal } from '../src/rehearsal.js';
import type { CampaignManifest, RunConfig, TransactionRecord } from '../src/types.js';

const address=(n:string)=>`0x${n.padStart(40,'0')}` as const;
const id=(n:string)=>`0x${n.padStart(64,'0')}` as const;
const config:RunConfig={version:1,mode:'public',chainId:84532,token:NATIVE_USDC,roles:{relayer:address('1'),payer:address('2'),provider:address('3'),adjudicator:address('4')},
  runId:id('1'),providerId:id('2'),policyId:id('3'),serviceId:id('4'),resourceUrl:'http://localhost:43127/assured',maxFeePerGas:MAX_FEE_PER_GAS,maxPriorityFeePerGas:MAX_PRIORITY_FEE_PER_GAS};
const artifact={abi:[],bytecode:'0x00' as const,deployedBytecode:'0x00' as const};

test('independent verifier rejects incomplete and extended manifests before chain access',async()=>{
  const client={async getChainId(){throw new Error('must not query incomplete campaigns');}};
  const incomplete={version:1,config,core:null,transactions:[]} as unknown as CampaignManifest;
  const rejected=await verifyCampaign({client,manifest:incomplete,artifact});
  assert.equal(rejected.ok,false);assert.equal(rejected.code,'VERIFY_MANIFEST');assert.deepEqual(rejected.transactions,[]);
  const extended={...incomplete,privateBody:'synthetic-sensitive-body'} as unknown as CampaignManifest;
  const extendedResult=await verifyCampaign({client,manifest:extended,artifact});
  assert.equal(extendedResult.code,'VERIFY_MANIFEST');
  assert.equal(JSON.stringify(extendedResult).includes('synthetic-sensitive-body'),false);
});

test('independent verifier keeps a local fixture explicitly opt-in',async()=>{
  const client={async getChainId(){throw new Error('fixture scope must fail before RPC');}};
  const local={...config,mode:'local' as const,token:address('5')};
  const transactions=STEP_ORDER.map((kind,index):TransactionRecord=>({kind,transaction:id(String(index+1)),from:local.roles[stepActor(kind)],
    to:kind==='deploy'?null:(kind==='approve'?local.token:address('9')),nonce:String(index),calldataHash:id('a'),gas:GAS_CAPS[kind].toString(),
    maxFeePerGas:MAX_FEE_PER_GAS,maxPriorityFeePerGas:MAX_PRIORITY_FEE_PER_GAS,value:'0',attempted:true,blockNumber:String(index+1),blockHash:id(String(index+20)),
    status:index===STEP_ORDER.length-1?'reverted':'success'}));
  const manifest={version:1,config:local,core:address('9'),transactions} as CampaignManifest;
  const result=await verifyCampaign({client,manifest,artifact,allowLocalFixture:false});
  assert.equal(result.ok,false);assert.equal(result.code,'VERIFY_LOCAL_FIXTURE_NOT_ALLOWED');
});

test('independent verifier rejects tampered fee, inclusion, and financial-state evidence',async()=>{
  const f=await createRehearsal();
  try{
    const verified=await f.run();
    assert.equal(verified.verification.ok,true);
    const dishonestFeeClient=new Proxy(f.evm.publicClient,{get(target,key){
      if(key==='request')return async(args:any)=>{
        const raw=await target.request(args);
        if(args.method==='eth_getTransactionReceipt'&&raw&&typeof raw==='object')return {...raw,status:raw.status==='0x1'?'0x0':'0x1',l1Fee:'0x5',operatorFee:'0x7'};
        return raw;
      };
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    const feeIdentityResult=await verifyCampaign({client:dishonestFeeClient,manifest:verified.manifest,artifact:f.artifact,allowLocalFixture:true});
    assert.equal(feeIdentityResult.ok,true);
    assert.ok(feeIdentityResult.transactions.every(tx=>tx.l1FeeWei==='unavailable'&&tx.operatorFeeWei==='unavailable'));
    const feeTamper=structuredClone(verified.manifest);feeTamper.transactions[6]!.maxFeePerGas='1';
    const feeResult=await verifyCampaign({client:f.evm.publicClient,manifest:feeTamper,artifact:f.artifact,allowLocalFixture:true});
    assert.equal(feeResult.ok,false);assert.equal(feeResult.code,'VERIFY_RECORD_POLICY');
    const inclusionTamper=structuredClone(verified.manifest);inclusionTamper.transactions[0]!.blockHash=id('eeee');
    const inclusionResult=await verifyCampaign({client:f.evm.publicClient,manifest:inclusionTamper,artifact:f.artifact,allowLocalFixture:true});
    assert.equal(inclusionResult.ok,false);assert.equal(inclusionResult.code,'VERIFY_TRANSACTION');
    const resolveABlock=BigInt(verified.manifest.transactions[8]!.blockNumber!);
    const baseClient=f.evm.publicClient;
    const alteredClient=new Proxy(baseClient,{get(target,key){
      if(key==='readContract')return async(args:any)=>{
        const value=await target.readContract(args);
        return args.functionName==='poolAssets'&&args.blockNumber===resolveABlock?value+1n:value;
      };
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    const stateResult=await verifyCampaign({client:alteredClient,manifest:verified.manifest,artifact:f.artifact,allowLocalFixture:true});
    assert.equal(stateResult.ok,false);assert.equal(stateResult.code,'VERIFY_SOLVENCY');
    for(const report of [feeResult,inclusionResult,stateResult])assert.equal(JSON.stringify(report).includes('signature'),false);
  }finally{await f.close();}
});

test('independent verifier rejects adversarial RPC and canonical evidence using one real campaign',async()=>{
  const f=await createRehearsal();
  try{
    const completed=await f.run();
    assert.equal(completed.verification.ok,true);
    const manifest=completed.manifest;
    const base=f.evm.publicClient;
    const wrap=(overrides:Record<string,(...args:any[])=>any>)=>new Proxy(base,{get(target,key){
      const name=String(key); if(overrides[name])return overrides[name];
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const verify=(client:any,proof=manifest)=>verifyCampaign({client,manifest:proof,artifact:f.artifact,allowLocalFixture:true});

    const wrongChain=await verify(wrap({getChainId:async()=>1}));
    assert.equal(wrongChain.ok,false);assert.equal(wrongChain.code,'VERIFY_CHAIN');

    const absentReceipt=await verify(wrap({getTransactionReceipt:async()=>null}));
    assert.equal(absentReceipt.ok,false);assert.equal(absentReceipt.code,'VERIFY_TRANSACTION');
    const rpcFailure=await verify(wrap({getTransaction:async()=>{throw new Error('private RPC endpoint detail');}}));
    assert.equal(rpcFailure.ok,false);assert.equal(rpcFailure.code,'VERIFY_FAILED');
    assert.equal(JSON.stringify(rpcFailure).includes('private RPC endpoint detail'),false);

    const mismatchedStatus=structuredClone(manifest);mismatchedStatus.transactions[6]!.status='reverted';
    const statusResult=await verify(base,mismatchedStatus);
    assert.equal(statusResult.ok,false);assert.equal(statusResult.code,'VERIFY_RECORD_STATUS');

    const overGas=wrap({getTransactionReceipt:async(args:any)=>{
      const receipt=await base.getTransactionReceipt(args);
      return args.hash===manifest.transactions[6]!.transaction?{...receipt,gasUsed:BigInt(manifest.transactions[6]!.gas)+1n}:receipt;
    }});
    const gasResult=await verify(overGas);
    assert.equal(gasResult.ok,false);assert.equal(gasResult.code,'VERIFY_FEE_CAP');

    let blockReads=0;
    const canonical=wrap({getBlock:async(args:any)=>{
      blockReads++;
      if(blockReads===31)return null;
      const header=await base.getBlock(args);
      return header;
    }});
    const canonicalResult=await verify(canonical);
    assert.equal(canonicalResult.ok,false);assert.equal(canonicalResult.code,'VERIFY_CANONICAL_FINAL');

    const refundBlock=BigInt(manifest.transactions[8]!.blockNumber!);
    const badRefundState=wrap({readContract:async(args:any)=>{
      const result=await base.readContract(args);
      if(args.functionName==='coverages'&&args.blockNumber===refundBlock){const changed=[...result];changed[16]=BigInt(1);return changed;}
      return result;
    }});
    const refundResult=await verify(badRefundState);
    assert.equal(refundResult.ok,false);assert.equal(refundResult.code,'VERIFY_REFUND');

    const badRefundEvent=wrap({getTransactionReceipt:async(args:any)=>{
      const receipt=await base.getTransactionReceipt(args);
      if(args.hash!==manifest.transactions[8]!.transaction)return receipt;
      return {...receipt,logs:[]};
    }});
    const eventResult=await verify(badRefundEvent);
    assert.equal(eventResult.ok,false);assert.equal(eventResult.code,'VERIFY_EVENT');
    for(const report of [wrongChain,absentReceipt,rpcFailure,statusResult,gasResult,canonicalResult,refundResult,eventResult]){
      const serialized=JSON.stringify(report);
      assert.equal(serialized.includes('signature'),false);
      assert.equal(serialized.includes('private RPC endpoint detail'),false);
    }
  }finally{await f.close();}
});
