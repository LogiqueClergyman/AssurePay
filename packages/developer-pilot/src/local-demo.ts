import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, parseAbi } from 'viem';
import { createPilotFixture } from '../test/helpers.js';
import { createClaimsClient } from './claims-client.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
export async function runLocalDemo(){
 const fixture=await createPilotFixture();let provider:ChildProcess|undefined;
 const cleanEnv={...process.env,PILOT_RELAYER_PRIVATE_KEY:'',PILOT_PROVIDER_PRIVATE_KEY:'',PILOT_PAYER_PRIVATE_KEY:'',PILOT_ADJUDICATOR_PRIVATE_KEY:'',PILOT_DATA_KEY:''};
 const configPath=join(fixture.directory,'config.json'),serviceDir=join(fixture.directory,'service'),buyerDir=join(fixture.directory,'buyer'),operatorDir=join(fixture.directory,'operator');
 const providerEnv={...cleanEnv,PILOT_RELAYER_PRIVATE_KEY:fixture.roleKeys.relayer,PILOT_PROVIDER_PRIVATE_KEY:fixture.roleKeys.provider,PILOT_DATA_KEY:fixture.keys.provider.toString('hex')};
 const buyerEnv={...cleanEnv,PILOT_PAYER_PRIVATE_KEY:fixture.roleKeys.payer,PILOT_DATA_KEY:fixture.keys.buyer.toString('hex')};
 const operatorEnv={...cleanEnv,PILOT_ADJUDICATOR_PRIVATE_KEY:fixture.roleKeys.adjudicator};
 async function command(args:string[],env:NodeJS.ProcessEnv=cleanEnv){
  const child=spawn(process.execPath,['--import','tsx','scripts/pilot.ts',...args,'--config',configPath],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout!.on('data',chunk=>{stdout+=chunk;if(stdout.length>100_000)child.kill('SIGTERM');});child.stderr!.on('data',chunk=>{stderr+=chunk;if(stderr.length>100_000)child.kill('SIGTERM');});
  const timer=setTimeout(()=>child.kill('SIGKILL'),60_000);
  const [code]=await once(child,'exit');clearTimeout(timer);
  let rows:any[];try{rows=stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{throw Error('PILOT_DEMO_CLI_INVALID_OUTPUT');}
  if(code!==0)throw Error(rows.at(-1)?.code&&/^[A-Z][A-Z0-9_]{0,100}$/.test(rows.at(-1).code)?rows.at(-1).code:'PILOT_DEMO_CLI_FAILED');
  if(stderr.length)throw Error('PILOT_DEMO_CLI_STDERR');return rows;
 }
 async function start(handler:'echo'|'fail'){
  const child=spawn(process.execPath,['--import','tsx','scripts/pilot.ts','provider','--config',configPath,'--data',serviceDir,'--handler',handler],{cwd:ROOT,env:providerEnv,stdio:['ignore','pipe','pipe']});provider=child;
  await new Promise<void>((yes,no)=>{
   let output='';const timer=setTimeout(()=>no(Error('PILOT_DEMO_PROVIDER_TIMEOUT')),20_000);
   child.once('error',()=>{clearTimeout(timer);no(Error('PILOT_DEMO_PROVIDER_FAILED'));});
   child.once('exit',()=>{clearTimeout(timer);no(Error('PILOT_DEMO_PROVIDER_EXITED'));});
   child.stdout!.on('data',chunk=>{output+=chunk;if(output.includes('"code":"PILOT_PROVIDER_STARTED"')){clearTimeout(timer);yes();}else if(output.length>100_000){clearTimeout(timer);no(Error('PILOT_DEMO_PROVIDER_FAILED'));}});
   child.stderr!.resume();
  });
 }
 async function stop(){if(!provider||provider.exitCode!==null)return;const exited=once(provider,'exit');provider.kill('SIGTERM');const timer=setTimeout(()=>provider?.kill('SIGKILL'),10_000);await exited;clearTimeout(timer);provider=undefined;}
 try{
  await writeFile(configPath,JSON.stringify(fixture.config)+'\n',{flag:'wx',mode:0o600});
  const bodyPath=join(fixture.directory,'request.bin'),evidencePath=join(fixture.directory,'evidence.bin'),reasonPath=join(fixture.directory,'reason.txt'),outPath=join(fixture.directory,'retrieved.bin');
  const body=new TextEncoder().encode('local developer pilot request');
  await writeFile(bodyPath,body,{flag:'wx',mode:0o600});await writeFile(evidencePath,'synthetic local claim evidence',{flag:'wx',mode:0o600});await writeFile(reasonPath,'explicit local provider-fault decision',{flag:'wx',mode:0o600});
  await command(['check']);await start('echo');
  const bought=await command(['purchase','--data',buyerDir,'--body-file',bodyPath,'--execute'],buyerEnv);
  const prepared=bought.find(x=>x.code==='PILOT_PURCHASE_PREPARED'),paid=bought.find(x=>x.code==='PILOT_PURCHASE_RESULT');
  assert.ok(prepared&&paid?.paid&&paid.status===200);assert.equal(paid.bodyHash,keccak256(body));
  const nonceBefore=await fixture.evm.publicClient.getTransactionCount({address:fixture.config.roles.relayer});
  await stop();await start('fail');
  const restored=await command(['retrieve','--data',buyerDir,'--id',prepared.requestId,'--out',outPath],{...cleanEnv,PILOT_DATA_KEY:fixture.keys.buyer.toString('hex')});
  assert.equal(restored.at(-1).bodyHash,paid.bodyHash);assert.deepEqual(new Uint8Array(await readFile(outPath)),body);
  const nonceAfter=await fixture.evm.publicClient.getTransactionCount({address:fixture.config.roles.relayer});assert.equal(nonceAfter,nonceBefore);
  const evidence=await command(['evidence','--coverage',prepared.coverageId,'--file',evidencePath],buyerEnv);
  await command(['claim','--data',buyerDir,'--coverage',prepared.coverageId,'--evidence',evidence.at(-1).evidenceHash,'--execute'],buyerEnv);
  const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)']);
  const before=await fixture.evm.publicClient.readContract({address:fixture.config.token,abi:tokenAbi,functionName:'balanceOf',args:[fixture.config.roles.payer]});
  await command(['decision','--data',operatorDir,'--coverage',prepared.coverageId,'--outcome','1','--refund','3100','--reason-file',reasonPath,'--execute'],operatorEnv);
  const after=await fixture.evm.publicClient.readContract({address:fixture.config.token,abi:tokenAbi,functionName:'balanceOf',args:[fixture.config.roles.payer]});assert.equal(after-before,3100n);
  const status=await createClaimsClient({url:fixture.config.claimsUrl}).status(prepared.coverageId);assert.equal(status.status,3);assert.equal(status.refundAmount,'3100');
  await command(['reconcile','--data',buyerDir,'--role','payer']);await command(['reconcile','--data',operatorDir,'--role','adjudicator']);
  const coreBalance=await fixture.evm.publicClient.readContract({address:fixture.config.token,abi:tokenAbi,functionName:'balanceOf',args:[fixture.config.core]});
  const state:any={};for(const functionName of ['totalProviderStake','poolAssets','totalLockedStake','totalPoolReserved','activeCoverageCount'])state[functionName]=String(await fixture.evm.publicClient.readContract({address:fixture.config.core,abi:fixture.artifacts.AssuranceCore.abi,functionName}));
  assert.equal(coreBalance,BigInt(state.totalProviderStake)+BigInt(state.poolAssets));assert.equal(state.totalLockedStake,'0');assert.equal(state.totalPoolReserved,'0');assert.equal(state.activeCoverageCount,'0');
  return {ok:true,code:'LOCAL_PILOT_VERIFIED',chainId:84532,tokenKind:'LOCAL_ERC3009_FIXTURE',core:fixture.config.core,requestId:prepared.requestId,coverageId:prepared.coverageId,paidStatus:200,retrievedStatus:restored.at(-1).status,bodyHash:paid.bodyHash,providerRestart:true,buyerProcessRestart:true,retrievalRelayerNonceUnchanged:true,refundAtomic:'3100',payerRefundDeltaAtomic:String(after-before),solvencyEquality:true,state,limits:{publicNativeUsdcProof:false,finality:false,subjectiveAdjudication:false}};
 }finally{await stop();await fixture.close();}
}
