import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeDeployData, encodeFunctionData, keccak256, toBytes, toHex, type Hex } from 'viem';
import { createCampaignSender } from './sender.js';
import { ECONOMICS, GAS_CAPS, validateConfig } from './plan.js';
import { verifyCampaign } from './verify.js';
import type { Actor, CampaignManifest, RunConfig, StepKind, StepSpec } from './types.js';
import { createSettlementEngine } from '../../x402-assurance/src/engine.js';
import { readTerms, verifySettlement, isServiceAdmissible } from '../../x402-assurance/src/chain.js';
import { createPurchase } from '../../x402-assurance/src/http-client.js';
import { startProvider, type StartedProvider } from '../../x402-assurance/src/http-provider.js';
import { createPayment, prepareCall } from '../../x402-assurance/src/protocol.js';
import type { PreparedCall, Terms } from '../../x402-assurance/src/types.js';
import { EncryptedVault, createResultStore, createProjection, createClaimsBackend, operationPayloadHash, operationTypedData, contextNamespace } from '../../claims-backend/src/index.js';
import type { Authorization, BackendContext, Operation, PreparedAction } from '../../claims-backend/src/types.js';

const TOKEN_ABI=[{type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{name:'spender',type:'address'},{name:'amount',type:'uint256'}],outputs:[{type:'bool'}]}] as const;
import { requestIdFor, requestBodyFor, rollbackRequestHashFor } from './fixtures.js';
const fixedError=(error:unknown)=>new Error(error instanceof Error&&/^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)?error.message:'M5_CAMPAIGN_FAILED');
export interface CampaignOptions {
 config:RunConfig;client:any;wallet:any;accounts:Record<Actor,any>;journalPath:string;
 dataDirectory:string;dataKey:Uint8Array;artifact:{abi:any;bytecode:Hex;deployedBytecode:Hex};
 executePublic?:boolean;polls?:number;delay?:number;
}
export interface TransportCheck {status:number;bodyHash:Hex;receiptHash:Hex;retryMatches:boolean;paymentSignatures:number;relayerSignatures:number;broadcasts:number;handlers:number}
export async function runCampaign(input:CampaignOptions):Promise<{manifest:CampaignManifest;transport:Record<string,TransportCheck>;verification:Awaited<ReturnType<typeof verifyCampaign>>}>{
 const config=validateConfig(input.config);
 if(config.mode==='public'&&input.executePublic!==true)throw new Error('M5_PUBLIC_EXECUTION_NOT_APPROVED');
 const {client,wallet,artifact}=input;const accounts={...input.accounts};
 const dataKey=Uint8Array.from(input.dataKey);
 if(dataKey.length!==32)throw new Error('M5_DATA_KEY_INVALID');
 const sender=await createCampaignSender({config,client,wallet,accounts,journalPath:input.journalPath,polls:input.polls,delay:input.delay});
 const existing=await sender.read();
 if(existing.transactions.length)throw new Error('M5_EXISTING_CAMPAIGN_RECONCILE_ONLY');
 const transport:Record<string,TransportCheck>={};
 let provider:StartedProvider|undefined;
 let currentKind:'purchaseA'|'purchaseB'='purchaseA',expectedCall:PreparedCall|undefined;
 let paymentSignatures=0,relayerSignatures=0,broadcasts=0,handlers=0;
 try {
  await mkdir(input.dataDirectory,{recursive:true,mode:0o700});
  const saveObservation=async(name:string,value:unknown)=>{
   const handle=await open(join(input.dataDirectory,name),'wx',0o600);
   try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
   const directory=await open(input.dataDirectory,'r');
   try{await directory.sync();}finally{await directory.close();}
  };
  const call=async(kind:StepKind,actor:Actor,functionName:string,args:readonly unknown[])=>{
   const manifest=await sender.read();if(!manifest.core)throw new Error('M5_CORE_UNAVAILABLE');
   return sender.submit({kind,actor,to:manifest.core,data:encodeFunctionData({abi:artifact.abi,functionName,args})});
  };
  await sender.submit({kind:'deploy',actor:'relayer',to:null,data:encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode,args:[config.token,config.roles.relayer,config.roles.adjudicator]})});
  const core=(await sender.read()).core;if(!core)throw new Error('M5_CORE_UNAVAILABLE');
  await call('provider','relayer','registerProvider',[config.providerId,config.roles.provider,config.roles.provider]);
  await call('policy','relayer','registerPolicy',[config.policyId,config.providerId,777,3500,2200,3600n,true]);
  await sender.submit({kind:'approve',actor:'payer',to:config.token,data:encodeFunctionData({abi:TOKEN_ABI,functionName:'approve',args:[core,23508n]})});
  await call('stake','payer','depositStake',[config.providerId,3502n]);
  await call('pool','payer','fundPool',[20006n]);
  const trust={chainId:84532 as const,core,token:config.token,providerId:config.providerId,policyId:config.policyId};
  const terms=await readTerms(client,trust,'10003');
  const context:BackendContext={chainId:84532,core,token:config.token,adjudicator:config.roles.adjudicator,serviceId:config.serviceId};
  const vault=new EncryptedVault({directory:join(input.dataDirectory,'objects'),namespace:contextNamespace(context),keyId:'m5-v1',key:dataKey});
  const resultStore=createResultStore(vault);
  const projection=createProjection({client,context,journalPath:join(input.dataDirectory,'projection.json'),fromBlock:BigInt((await sender.read()).transactions[0].blockNumber!)});
  const backend=await createClaimsBackend({context,projection,vault,replayPath:join(input.dataDirectory,'replay.jsonl')});
  const engineClient={...client,async sendRawTransaction({serializedTransaction}:any){broadcasts++;return sender.broadcast(currentKind,serializedTransaction);}};
  const engineWallet={...wallet,async signTransaction(args:any){
   if(!expectedCall||args.data!==expectedCall.data||args.to?.toLowerCase()!==core||args.value!==0n||args.gas!==GAS_CAPS[currentKind]||
      args.maxFeePerGas!==BigInt(config.maxFeePerGas)||args.maxPriorityFeePerGas!==BigInt(config.maxPriorityFeePerGas)||
      args.chain?.id!==84532||args.account?.address?.toLowerCase()!==config.roles.relayer)throw new Error('M5_ENGINE_REQUEST_MISMATCH');
   relayerSignatures++;return sender.prepare({kind:currentKind,actor:'relayer',to:core,data:expectedCall.data});
  }};
  const makeEngine=(readonly=false)=>createSettlementEngine({client:engineClient,...(readonly?{}:{wallet:engineWallet,account:accounts.relayer}),relayer:config.roles.relayer,terms,journalPath:join(input.dataDirectory,'payments.json'),gasLimit:800000n,maxFeePerGas:BigInt(config.maxFeePerGas),maxPriorityFeePerGas:BigInt(config.maxPriorityFeePerGas),polls:input.polls??4,delay:input.delay??250});
  const start=async(readonly=false)=>{
   provider=await startProvider({terms,engine:makeEngine(readonly),signer:{address:config.roles.provider,async signTypedData(data:any){if(readonly)throw new Error('M5_RECOVERY_SIGNING_FORBIDDEN');return accounts.provider.signTypedData(data);}},resourceUrl:config.resourceUrl,journalPath:join(input.dataDirectory,'service.jsonl'),resultStore,
    prepareCall:(payment,hash)=>prepareCall(payment,terms,hash,0n,{allowExpired:true}),canServe:call=>isServiceAdmissible(client,terms,call),
    handler:async body=>{handlers++;if(keccak256(body)===keccak256(requestBodyFor('purchaseB')))throw new Error('M5_SYNTHETIC_HANDLER_FAILURE');return new Uint8Array([...body,42]);}});
  };
  const stop=async()=>{if(provider){provider.server.closeAllConnections();await provider.close();provider=undefined;}};
  async function authorization(actor:Actor,operation:Operation,coverageId:Hex,payload:unknown):Promise<Authorization>{
   const message={actor:config.roles[actor],operation,coverageId,payloadHash:operationPayloadHash(payload),nonce:toHex(randomBytes(32)),deadline:String((await client.getBlock({blockTag:'latest'})).timestamp+250n)};
   return {...message,signature:await accounts[actor].signTypedData(operationTypedData(context,message))};
  }
  const submitAction=async(kind:StepKind,actor:Actor,action:PreparedAction)=>{
   if(action.chainId!==84532||action.to!==core||action.from!==config.roles[actor]||action.value!=='0')throw new Error('M5_ACTION_MISMATCH');
   return sender.submit({kind,actor,to:core,data:action.data});
  };
  for(const name of ['purchaseA','purchaseB'] as const){
   currentKind=name;const before={paymentSignatures,relayerSignatures,broadcasts,handlers};
   await start();
   const session=await createPurchase({url:config.resourceUrl,body:requestBodyFor(name),payer:{address:config.roles.payer,async signTypedData(data:any){paymentSignatures++;return accounts.payer.signTypedData(data);}},trust,maxGross:'10003',readTerms:(ids,gross)=>readTerms(client,ids,gross),now:async()=>(await client.getBlock({blockTag:'latest'})).timestamp,
    verifyPayment:({call,paymentResponse})=>verifySettlement(client,terms,call,(paymentResponse as any).transaction,config.roles.relayer),createRequestId:()=>requestIdFor(config,name)});
   expectedCall=session.call;
   const first=await session.send();if(!first.paid||first.status!==(name==='purchaseA'?200:500)||!first.receipt)throw new Error('M5_HTTP_PROOF_FAILED');
   await sender.observe(name);
   const repeated=await session.retry();
   if(!repeated.paid||repeated.receipt?.signature!==first.receipt.signature||keccak256(repeated.body)!==keccak256(first.body))throw new Error('M5_HTTP_RETRY_MISMATCH');
   await stop();await start(true);
   const recovered=await session.retry();
   if(!recovered.paid||recovered.receipt?.signature!==first.receipt.signature||keccak256(recovered.body)!==keccak256(first.body))throw new Error('M5_HTTP_RECOVERY_MISMATCH');
   await stop();
   const counts={paymentSignatures:paymentSignatures-before.paymentSignatures,relayerSignatures:relayerSignatures-before.relayerSignatures,broadcasts:broadcasts-before.broadcasts,handlers:handlers-before.handlers};
   if(Object.values(counts).some(value=>value!==1))throw new Error('M5_HTTP_DUPLICATE_EXECUTION');
   transport[name]={status:first.status,bodyHash:keccak256(first.body),receiptHash:keccak256(toBytes(JSON.stringify(first.receipt))),retryMatches:true,...counts};
   await saveObservation(`transport-${name}.json`,{version:1,runId:config.runId,core,case:name,observed:transport[name]});
   const id=session.call.intentHash,body=toBytes(`synthetic ${name} acceptance evidence`);
   const evidenceHash=await backend.uploadEvidence(id,body,await authorization('payer','uploadEvidence',id,{bodyHex:toHex(body)}));
   const claim=await backend.prepareClaim(id,evidenceHash,await authorization('payer','prepareClaim',id,{evidenceHash}));
   await submitAction(name==='purchaseA'?'claimA':'claimB','payer',claim);
   const decision={outcome:(name==='purchaseA'?1:2) as 1|2,refundAmount:name==='purchaseA'?'3100':'10003',reason:`explicit ${name} test adjudication`};
   const prepared=await backend.prepareDecision(id,decision,await authorization('adjudicator','prepareDecision',id,decision));
   await submitAction(name==='purchaseA'?'resolveA':'resolveB','adjudicator',prepared.action);
  }
  await call('pause','relayer','setPaused',[true]);
  const rollbackRequestHash=rollbackRequestHashFor(config);
  const payment=await createPayment({terms,requestHash:rollbackRequestHash,payer:{address:config.roles.payer,signTypedData:(data:any)=>accounts.payer.signTypedData(data)},nowSeconds:(await client.getBlock({blockTag:'latest'})).timestamp,maxGross:'10003'});
  const rollback=await prepareCall(payment,terms,rollbackRequestHash,(await client.getBlock({blockTag:'latest'})).timestamp);
  await sender.submit({kind:'revert',actor:'relayer',to:core,data:rollback.data});
  const manifest=await sender.read();
  const verification=await verifyCampaign({client,manifest,artifact,allowLocalFixture:config.mode==='local'});
  if(!verification.ok)throw new Error('M5_INDEPENDENT_VERIFICATION_FAILED');
  const result={manifest,transport,verification};
  await saveObservation('observations.json',{version:1,transport,verification});
  return result;
 } catch(error){throw fixedError(error);}
 finally{if(provider){provider.server.closeAllConnections();await provider.close().catch(()=>{});}}
}
