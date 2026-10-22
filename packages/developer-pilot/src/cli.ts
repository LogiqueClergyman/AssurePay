import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, type Hex } from 'viem';
import { createBuyer } from './buyer.js';
import { createClaimsClient } from './claims-client.js';
import { createActionSender } from './action-sender.js';
import { authorize } from './auth.js';
import { checkPilot, startPilotProvider } from './provider.js';
import { readConfig, createClients, contextFor, trustFor, id, atomic, safeCode, type PilotConfig } from './config.js';

const FLAGS:Record<string,string[]>={check:['config'],provider:['config','data','handler'],purchase:['config','data','body-file','execute'],retrieve:['config','data','id','out'],status:['config','coverage'],evidence:['config','coverage','file'],claim:['config','data','coverage','evidence','execute'],decision:['config','data','coverage','outcome','refund','reason-file','execute'],reconcile:['config','data','role']};
function args(input:string[]){
  const [command,...tail]=input;if(!command||!Object.hasOwn(FLAGS,command))throw Error('PILOT_ARGUMENTS_INVALID');
  const values:Record<string,string|true>={};for(let i=0;i<tail.length;i++){
    const key=tail[i];if(!key?.startsWith('--')||!FLAGS[command]!.includes(key.slice(2))||Object.hasOwn(values,key.slice(2)))throw Error('PILOT_ARGUMENTS_INVALID');
    if(key==='--execute')values.execute=true;
    else {const value=tail[++i];if(!value||value.startsWith('--'))throw Error('PILOT_ARGUMENTS_INVALID');values[key.slice(2)]=value;}
  }
  return {command,values};
}
function required(v:Record<string,string|true>,key:string):string{const value=v[key];if(typeof value!=='string'||!value)throw Error('PILOT_ARGUMENTS_INVALID');return value;}
function account(env:NodeJS.ProcessEnv,name:string,expected:string){
  const key=env[name];if(!key||!/^0x[0-9a-fA-F]{64}$/.test(key))throw Error('PILOT_SIGNER_REQUIRED');
  const signer=privateKeyToAccount(key as Hex);if(signer.address.toLowerCase()!==expected)throw Error('PILOT_SIGNER_MISMATCH');return signer;
}
function dataKey(env:NodeJS.ProcessEnv){const key=env.PILOT_DATA_KEY;if(!key||!/^[0-9a-fA-F]{64}$/.test(key))throw Error('PILOT_DATA_KEY_REQUIRED');return new Uint8Array(Buffer.from(key,'hex'));}
async function readBytes(path:string,max:number){
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw Error('PILOT_INPUT_FILE_INVALID');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const bytes=await handle.readFile();if(bytes.length>max)throw Error('PILOT_INPUT_FILE_INVALID');return new Uint8Array(bytes);}finally{await handle.close();}
}
async function saveBody(path:string,body:Uint8Array){
  const handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(body);await handle.sync();}finally{await handle.close();}
  const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
export async function runCli(input:string[],env:NodeJS.ProcessEnv,write:(value:unknown)=>void):Promise<void>{
 const {command,values:v}=args(input);
 if(['purchase','claim','decision'].includes(command)&&v.execute!==true)throw Error('PILOT_EXPLICIT_EXECUTE_REQUIRED');
 const config=await readConfig(required(v,'config')),{client,wallet}=createClients(config);
 if(command==='check'){await checkPilot(config,client);write({ok:true,code:'PILOT_CONFIG_CHECKED',chainId:84532,core:config.core});return;}
 if(command==='provider'){
  const handler=v.handler??'echo';if(!['echo','fail'].includes(String(handler)))throw Error('PILOT_HANDLER_INVALID');
  const runtime=await startPilotProvider({config,directory:required(v,'data'),key:dataKey(env),client,wallet,
    relayerAccount:account(env,'PILOT_RELAYER_PRIVATE_KEY',config.roles.relayer),receiptSigner:account(env,'PILOT_PROVIDER_PRIVATE_KEY',config.roles.provider),
    handler:body=>{if(handler==='fail')throw Error('PILOT_EXAMPLE_HANDLER_FAILURE');return body;}});
  write({ok:true,code:'PILOT_PROVIDER_STARTED',resourceUrl:config.resourceUrl,claimsUrl:config.claimsUrl});
  await new Promise<void>((yes,no)=>{
    let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void runtime.close().then(yes,no).finally(()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);});};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  });return;
 }
 if(command==='purchase'||command==='retrieve'){
  const buyer=await createBuyer({binding:{url:config.resourceUrl,trust:trustFor(config),maxGross:config.gross,payer:config.roles.payer},directory:required(v,'data'),key:dataKey(env),client,relayer:config.roles.relayer,
    ...(command==='purchase'?{payerSigner:account(env,'PILOT_PAYER_PRIVATE_KEY',config.roles.payer)}:{})});
  try{
   let requestId:Hex;
   if(command==='purchase'){const prepared=await buyer.prepare(await readBytes(required(v,'body-file'),65536));requestId=prepared.requestId;write({ok:true,code:'PILOT_PURCHASE_PREPARED',...prepared});}
   else requestId=id(required(v,'id'));
   const result=command==='purchase'?await buyer.send(requestId):await buyer.retrieve(requestId);
   if(command==='retrieve'&&v.out){if(!result.paid)throw Error('PILOT_RESULT_NOT_CONFIRMED');await saveBody(required(v,'out'),result.body);}
   write({ok:result.paid,code:command==='purchase'?'PILOT_PURCHASE_RESULT':'PILOT_RETRIEVAL_RESULT',requestId,status:result.status,paid:result.paid,bodyBytes:result.body.length,bodyHash:keccak256(result.body)});
   if(!result.paid)throw Error('PILOT_RESULT_PENDING');
  }finally{await buyer.close();}return;
 }
 const claims=createClaimsClient({url:config.claimsUrl});
 if(command==='status'){write({ok:true,code:'PILOT_COVERAGE_STATUS',coverage:await claims.status(id(required(v,'coverage')))});return;}
 if(command==='reconcile'){
  const role=required(v,'role');if(role!=='payer'&&role!=='adjudicator')throw Error('PILOT_ROLE_INVALID');
  const sender=await createActionSender({context:contextFor(config),actor:config.roles[role],client,journalPath:join(required(v,'data'),'actions.json')});
  try{write({ok:true,code:'PILOT_ACTIONS_RECONCILED',records:await sender.reconcile()});}finally{await sender.close();}return;
 }
 const coverageId=id(required(v,'coverage'));
 if(command==='evidence'){
  const signer=account(env,'PILOT_PAYER_PRIVATE_KEY',config.roles.payer),body=await readBytes(required(v,'file'),65536);
  const payload={bodyHex:`0x${Buffer.from(body).toString('hex')}`};
  const evidenceHash=await claims.uploadEvidence(coverageId,body,await authorize(client,config,signer,'uploadEvidence',coverageId,payload));
  write({ok:true,code:'PILOT_EVIDENCE_UPLOADED',coverageId,evidenceHash});return;
 }
 let action:any,signer:any;
 if(command==='claim'){
  signer=account(env,'PILOT_PAYER_PRIVATE_KEY',config.roles.payer);const evidenceHash=id(required(v,'evidence'));
  action=await claims.prepareClaim(coverageId,evidenceHash,await authorize(client,config,signer,'prepareClaim',coverageId,{evidenceHash}));
 }else if(command==='decision'){
  signer=account(env,'PILOT_ADJUDICATOR_PRIVATE_KEY',config.roles.adjudicator);
  const outcomeText=required(v,'outcome');if(!['0','1','2'].includes(outcomeText))throw Error('PILOT_OUTCOME_INVALID');
  const reasonBytes=await readBytes(required(v,'reason-file'),8192);let reason:string;try{reason=new TextDecoder('utf-8',{fatal:true}).decode(reasonBytes);}catch{throw Error('PILOT_REASON_INVALID');}
  const decision={outcome:Number(outcomeText) as 0|1|2,refundAmount:atomic(required(v,'refund')),reason};
  const prepared=await claims.prepareDecision(coverageId,decision,await authorize(client,config,signer,'prepareDecision',coverageId,decision));action=prepared.action;
 }else throw Error('PILOT_ARGUMENTS_INVALID');
 const sender=await createActionSender({context:contextFor(config),actor:signer.address.toLowerCase(),client,wallet,account:signer,journalPath:join(required(v,'data'),'actions.json'),polls:10,delay:100});
 try{const record=await sender.submit(action);write({ok:record.status==='success',code:'PILOT_ACTION_RESULT',record});if(record.status!=='success')throw Error('PILOT_ACTION_UNRESOLVED');}finally{await sender.close();}
}
export { safeCode };
