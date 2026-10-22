import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startEvm, compileContracts, deploy, transact } from '../../evm-core/test/helpers/evm.js';
import { validateConfig } from '../src/config.js';
export async function freePort(): Promise<number> {
  const server=createServer(); await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const a=server.address(); if(!a||typeof a==='string')throw Error('PILOT_PORT_FAILED');
  await new Promise<void>((yes,no)=>server.close(e=>e?no(e):yes()));return a.port;
}
export async function createPilotFixture() {
 const localEvm=await startEvm();
 const roleKeys={relayer:generatePrivateKey(),payer:generatePrivateKey(),provider:generatePrivateKey(),adjudicator:generatePrivateKey()};
 const evm={...localEvm,owner:privateKeyToAccount(roleKeys.relayer),payer:privateKeyToAccount(roleKeys.payer),provider:privateKeyToAccount(roleKeys.provider),outsider:privateKeyToAccount(roleKeys.adjudicator)};
 const directory=await mkdtemp(join(tmpdir(),'assurepay-m6-'));
 try{
  for(const actor of [evm.owner,evm.payer,evm.provider,evm.outsider])await evm.publicClient.request({method:'anvil_setBalance',params:[actor.address,'0xde0b6b3a7640000']});
  await evm.publicClient.request({method:'anvil_setNextBlockBaseFeePerGas',params:['0x4c4b40']});
  await evm.publicClient.request({method:'evm_mine',params:[]});
  const artifacts=compileContracts();const token=await deploy(evm,artifacts.AuthorizationTokenMock);
  const core=await deploy(evm,artifacts.AssuranceCore,[token,evm.owner.address,evm.outsider.address]);
  const deploymentBlock=await evm.publicClient.getBlockNumber();
  const salt=randomBytes(16).toString('hex');const id=(s:string)=>keccak256(toBytes(`${salt}:${s}`));
  const providerId=id('provider'),policyId=id('policy'),serviceId=id('service');
  await transact(evm,artifacts.AuthorizationTokenMock.abi,token,'mint',[evm.payer.address,200000n]);
  await transact(evm,artifacts.AssuranceCore.abi,core,'registerProvider',[providerId,evm.provider.address,evm.provider.address]);
  await transact(evm,artifacts.AssuranceCore.abi,core,'registerPolicy',[policyId,providerId,777,3500,2200,3600n,true]);
  await transact(evm,artifacts.AuthorizationTokenMock.abi,token,'approve',[core,60000n],evm.payer);
  await transact(evm,artifacts.AssuranceCore.abi,core,'depositStake',[providerId,10000n],evm.payer);
  await transact(evm,artifacts.AssuranceCore.abi,core,'fundPool',[50000n],evm.payer);
  const [resourcePort,claimsPort]=await Promise.all([freePort(),freePort()]);
  const config=validateConfig({version:1,mode:'local',chainId:84532,rpcUrl:evm.url,core,token,providerId,policyId,serviceId,
    roles:{relayer:evm.owner.address,payer:evm.payer.address,provider:evm.provider.address,adjudicator:evm.outsider.address},
    resourceUrl:`http://127.0.0.1:${resourcePort}/service`,claimsUrl:`http://127.0.0.1:${claimsPort}`,deploymentBlock:String(deploymentBlock),gross:'10003'});
  return {evm,directory,config,artifacts,roleKeys,keys:{provider:randomBytes(32),buyer:randomBytes(32)},accounts:{relayer:evm.owner,payer:evm.payer,provider:evm.provider,adjudicator:evm.outsider},
    async close(){await evm.close();await rm(directory,{recursive:true,force:true});}};
 }catch(e){await evm.close();await rm(directory,{recursive:true,force:true});throw e;}
}
