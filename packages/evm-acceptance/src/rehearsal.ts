import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex, toBytes } from 'viem';
import { compileContracts, startEvm, deploy, transact } from '../../evm-core/test/helpers/evm.js';
import { runCampaign } from './campaign.js';
import { budgetSummary, validateConfig, MAX_FEE_PER_GAS, MAX_PRIORITY_FEE_PER_GAS } from './plan.js';
import type { Actor, RunConfig } from './types.js';
async function resourceUrl(){
 const server=createServer();
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error();
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return `http://127.0.0.1:${address.port}/assured`;
 }catch{throw new Error('M5_LOCAL_PORT_UNAVAILABLE');}
}
export async function createRehearsal(){
 const evm=await startEvm();const directory=await mkdtemp(join(tmpdir(),'assurepay-m5-'));
 try{
  const artifacts=compileContracts();
  const token=await deploy(evm,artifacts.AuthorizationTokenMock);
  await transact(evm,artifacts.AuthorizationTokenMock.abi,token,'mint',[evm.payer.address,100000n]);
  const runId=toHex(randomBytes(32));const id=(name:string)=>keccak256(toBytes(`${runId}:${name}`));
  const accounts={relayer:evm.owner,payer:evm.payer,provider:evm.provider,adjudicator:evm.outsider};
  const config=validateConfig({version:1,mode:'local',chainId:84532,token,roles:Object.fromEntries(Object.entries(accounts).map(([name,account])=>[name,account.address.toLowerCase()])),runId,providerId:id('provider'),policyId:id('policy'),serviceId:id('service'),resourceUrl:await resourceUrl(),maxFeePerGas:MAX_FEE_PER_GAS,maxPriorityFeePerGas:MAX_PRIORITY_FEE_PER_GAS});
  const budgets=budgetSummary(config);
  for(const actor of Object.keys(accounts) as Actor[])await evm.publicClient.request({method:'anvil_setBalance',params:[config.roles[actor],toHex(BigInt(budgets.roles[actor].targetWei))]});
  await evm.publicClient.request({method:'anvil_setNextBlockBaseFeePerGas',params:[toHex(5000000n)]});
  await evm.publicClient.request({method:'evm_mine',params:[]});
  const options={config,client:evm.publicClient,wallet:evm.walletClient,accounts,journalPath:join(directory,'campaign.json'),dataDirectory:join(directory,'data'),dataKey:randomBytes(32),artifact:artifacts.AssuranceCore,polls:4,delay:0};
  return {evm,directory,config,budgets,options,artifact:artifacts.AssuranceCore,run:()=>runCampaign(options),async close(){await evm.close();await rm(directory,{recursive:true,force:true});}};
 }catch{await evm.close();await rm(directory,{recursive:true,force:true});throw new Error('M5_LOCAL_SETUP_FAILED');}
}
