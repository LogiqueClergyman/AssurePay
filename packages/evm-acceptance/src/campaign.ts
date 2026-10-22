import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeFunctionData, encodeDeployData, encodeFunctionData, keccak256, toBytes, toHex, type Hex } from 'viem';
import { createCampaignSender } from './sender.js';
import { ECONOMICS, GAS_CAPS, validateConfig } from './plan.js';
import { verifyCampaign } from './verify.js';
import type { Actor, CampaignManifest, RunConfig, StepKind, StepSpec } from './types.js';
import { createSettlementEngine } from '../../x402-assurance/src/engine.js';
import { readTerms, verifySettlement, isServiceAdmissible } from '../../x402-assurance/src/chain.js';
import { createPurchase } from '../../x402-assurance/src/http-client.js';
import { startProvider, type StartedProvider } from '../../x402-assurance/src/http-provider.js';
import { createPayment, prepareCall } from '../../x402-assurance/src/protocol.js';
import type { Intent, PreparedCall } from '../../x402-assurance/src/types.js';
import { EncryptedVault, createResultStore, createProjection, createClaimsBackend, operationPayloadHash, operationTypedData, contextNamespace } from '../../claims-backend/src/index.js';
import type { Authorization, BackendContext, Operation, PreparedAction } from '../../claims-backend/src/types.js';
import { CORE_ABI } from '../../x402-assurance/src/core-abi.js';
import { hashIntent } from '../../x402-assurance/src/protocol.js';

const TOKEN_ABI=[{type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{name:'spender',type:'address'},{name:'amount',type:'uint256'}],outputs:[{type:'bool'}]}] as const;
import { requestIdFor, requestBodyFor, requestHashFor, rollbackRequestHashFor } from './fixtures.js';
const fixedError=(error:unknown)=>new Error(error instanceof Error&&/^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)?error.message:'M5_CAMPAIGN_FAILED');
export interface CampaignOptions {
 config:RunConfig;client:any;wallet:any;accounts:Record<Actor,any>;journalPath:string;
 dataDirectory:string;dataKey:Uint8Array;artifact:{abi:any;bytecode:Hex;deployedBytecode:Hex};
 executePublic?:boolean;continueAfterPurchaseA?:true;polls?:number;delay?:number;
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
 const continuing=input.continueAfterPurchaseA===true;
 if(continuing){
  if(existing.transactions.length!==7||existing.core===null||existing.transactions.some((row,index)=>row.kind!==(['deploy','provider','policy','approve','stake','pool','purchaseA'] as const)[index]||row.status!=='success'||row.attempted!==true))throw new Error('M5_CONTINUATION_PREFIX_INVALID');
  if(JSON.stringify(existing.config)!==JSON.stringify(config))throw new Error('M5_CONTINUATION_CONTEXT_INVALID');
  for(const row of existing.transactions){const observed=await sender.observe(row.kind);if(observed.status!=='success'||observed.transaction!==row.transaction||observed.blockHash!==row.blockHash||observed.blockNumber!==row.blockNumber)throw new Error('M5_CONTINUATION_RECONCILIATION_FAILED');}
 }else if(existing.transactions.length)throw new Error('M5_EXISTING_CAMPAIGN_RECONCILE_ONLY');
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
  if(!continuing){
   await sender.submit({kind:'deploy',actor:'relayer',to:null,data:encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode,args:[config.token,config.roles.relayer,config.roles.adjudicator]})});
   const createdCore=(await sender.read()).core;if(!createdCore)throw new Error('M5_CORE_UNAVAILABLE');
   await call('provider','relayer','registerProvider',[config.providerId,config.roles.provider,config.roles.provider]);
   await call('policy','relayer','registerPolicy',[config.policyId,config.providerId,777,3500,2200,3600n,true]);
   await sender.submit({kind:'approve',actor:'payer',to:config.token,data:encodeFunctionData({abi:TOKEN_ABI,functionName:'approve',args:[createdCore,23508n]})});
   await call('stake','payer','depositStake',[config.providerId,3502n]);
   await call('pool','payer','fundPool',[20006n]);
  }
  const core=(await sender.read()).core;if(!core)throw new Error('M5_CORE_UNAVAILABLE');
  const trust={chainId:84532 as const,core,token:config.token,providerId:config.providerId,policyId:config.policyId};
  const terms=await readTerms(client,trust,'10003');
  const context:BackendContext={chainId:84532,core,token:config.token,adjudicator:config.roles.adjudicator,serviceId:config.serviceId};
  const vault=new EncryptedVault({directory:join(input.dataDirectory,'objects'),namespace:contextNamespace(context),keyId:'m5-v1',key:dataKey});
  const resultStore=createResultStore(vault);
  const projection=createProjection({client,context,journalPath:join(input.dataDirectory,'projection.json'),fromBlock:BigInt((await sender.read()).transactions[0].blockNumber!)});
  const backend=await createClaimsBackend({context,projection,vault,replayPath:join(input.dataDirectory,'replay.jsonl')});
  const aRow=continuing?(await sender.read()).transactions[6]:undefined;
  let recoveredA:PreparedCall|undefined;
  if(continuing){
   const observationPath=join(input.dataDirectory,'transport-purchaseA.json');const observationInfo=await lstat(observationPath);
   if(!observationInfo.isFile()||observationInfo.isSymbolicLink()||observationInfo.size>4096)throw new Error('M5_CONTINUATION_TRANSPORT_INVALID');
   const publicObservation=JSON.parse(await readFile(observationPath,'utf8')) as any;
   const observed=publicObservation?.observed;
   if(!publicObservation||Object.keys(publicObservation).sort().join(',')!=='case,core,observed,runId,version'||publicObservation.version!==1||publicObservation.runId!==config.runId||publicObservation.case!=='purchaseA'||publicObservation.core!==core||!observed||Object.keys(observed).sort().join(',')!=='bodyHash,broadcasts,handlers,paymentSignatures,receiptHash,relayerSignatures,retryMatches,status'||observed.status!==200||observed.retryMatches!==true||observed.paymentSignatures!==1||observed.relayerSignatures!==1||observed.broadcasts!==1||observed.handlers!==1||!/^0x[0-9a-f]{64}$/.test(observed.bodyHash)||!/^0x[0-9a-f]{64}$/.test(observed.receiptHash))throw new Error('M5_CONTINUATION_TRANSPORT_INVALID');
   const expectedPrefix=[
    encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode,args:[config.token,config.roles.relayer,config.roles.adjudicator]}),
    encodeFunctionData({abi:artifact.abi,functionName:'registerProvider',args:[config.providerId,config.roles.provider,config.roles.provider]}),
    encodeFunctionData({abi:artifact.abi,functionName:'registerPolicy',args:[config.policyId,config.providerId,777,3500,2200,3600n,true]}),
    encodeFunctionData({abi:TOKEN_ABI,functionName:'approve',args:[core,23508n]}),
    encodeFunctionData({abi:artifact.abi,functionName:'depositStake',args:[config.providerId,3502n]}),
    encodeFunctionData({abi:artifact.abi,functionName:'fundPool',args:[20006n]}),
   ];
   for(let index=0;index<expectedPrefix.length;index++)if((await sender.read()).transactions[index]?.calldataHash!==keccak256(expectedPrefix[index]!))throw new Error('M5_CONTINUATION_PREFIX_INVALID');
   const tx=await client.getTransaction({hash:aRow!.transaction});
   if(!tx||tx.hash!==aRow!.transaction||tx.from?.toLowerCase()!==config.roles.relayer||tx.to?.toLowerCase()!==core||typeof tx.input!=='string'||keccak256(tx.input).toLowerCase()!==aRow!.calldataHash)throw new Error('M5_CONTINUATION_PURCHASE_INVALID');
   const decoded=decodeFunctionData({abi:CORE_ABI,data:tx.input});
   if(decoded.functionName!=='settleAssured')throw new Error('M5_CONTINUATION_PURCHASE_INVALID');
   const raw=decoded.args[0] as any;const intent:Intent={chainId:String(raw.chainId),core:String(raw.core).toLowerCase() as `0x${string}`,token:String(raw.token).toLowerCase() as `0x${string}`,payer:String(raw.payer).toLowerCase() as `0x${string}`,providerId:raw.providerId,policyId:raw.policyId,policyHash:raw.policyHash,requestHash:raw.requestHash,gross:String(raw.gross),payerSalt:raw.payerSalt,validAfter:String(raw.validAfter),validBefore:String(raw.validBefore)};
   const v=Number(decoded.args[1]),r=decoded.args[2],s=decoded.args[3];
   if(intent.chainId!=='84532'||intent.core!==core||intent.token!==config.token||intent.payer!==config.roles.payer||intent.providerId!==config.providerId||intent.policyId!==config.policyId||intent.requestHash!==requestHashFor(config,'purchaseA')||intent.gross!=='10003'||(v!==27&&v!==28)||typeof r!=='string'||typeof s!=='string')throw new Error('M5_CONTINUATION_PURCHASE_INVALID');
   const signature=`0x${r.slice(2)}${s.slice(2)}${v.toString(16).padStart(2,'0')}` as Hex;const intentHash=hashIntent(intent);
   const encoded=encodeFunctionData({abi:CORE_ABI,functionName:'settleAssured',args:decoded.args as any});
   if(encoded.toLowerCase()!==tx.input.toLowerCase())throw new Error('M5_CONTINUATION_PURCHASE_INVALID');
   if(intent.policyHash!==terms.policyHash)throw new Error('M5_CONTINUATION_PURCHASE_INVALID');
   const verified=await verifySettlement(client,terms,{intent,intentHash,signature,to:core,data:tx.input},aRow!.transaction,config.roles.relayer,1,BigInt(aRow!.nonce));
   if(verified.state!=='confirmed'||verified.coverageId!==intentHash||verified.blockNumber!==aRow!.blockNumber||verified.blockHash!==aRow!.blockHash)throw new Error('M5_CONTINUATION_PURCHASE_INVALID');
   recoveredA={intent,intentHash,signature,to:core,data:tx.input};
   transport.purchaseA=observed as TransportCheck;
   const coverage=await client.readContract({address:core,abi:CORE_ABI,functionName:'coverages',args:[intentHash]}) as readonly unknown[];
   const now=(await client.getBlock({blockTag:'latest'})).timestamp;
   if(typeof coverage[11]!=='bigint'||coverage[11]<=now||Number(coverage[13])!==1)throw new Error('M5_CONTINUATION_CLAIM_WINDOW_CLOSED');
  }
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
  const claimAndResolve=async(name:'purchaseA'|'purchaseB',id:Hex)=>{
   const body=toBytes(`synthetic ${name} acceptance evidence`);
   const evidenceHash=await backend.uploadEvidence(id,body,await authorization('payer','uploadEvidence',id,{bodyHex:toHex(body)}));
   const claim=await backend.prepareClaim(id,evidenceHash,await authorization('payer','prepareClaim',id,{evidenceHash}));
   await submitAction(name==='purchaseA'?'claimA':'claimB','payer',claim);
   const decision={outcome:(name==='purchaseA'?1:2) as 1|2,refundAmount:name==='purchaseA'?'3100':'10003',reason:`explicit ${name} test adjudication`};
   const prepared=await backend.prepareDecision(id,decision,await authorization('adjudicator','prepareDecision',id,decision));
   await submitAction(name==='purchaseA'?'resolveA':'resolveB','adjudicator',prepared.action);
  };
  if(continuing){if(!recoveredA)throw new Error('M5_CONTINUATION_PURCHASE_INVALID');await claimAndResolve('purchaseA',recoveredA.intentHash);}
  for(const name of (continuing?['purchaseB'] as const:['purchaseA','purchaseB'] as const)){
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
   await claimAndResolve(name,session.call.intentHash);
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
