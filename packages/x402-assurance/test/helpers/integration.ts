import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { fixture as coreFixture, expectInvariant } from '../../../evm-core/test/helpers/fixture.js';
import { transact } from '../../../evm-core/test/helpers/evm.js';
import { readTerms, verifySettlement, isServiceAdmissible } from '../../src/chain.js';
import { createSettlementEngine } from '../../src/engine.js';
import { createPurchase, type PurchaseOptions } from '../../src/http-client.js';
import { startProvider, type StartedProvider } from '../../src/http-provider.js';
import { prepareCall } from '../../src/protocol.js';
import type { ResultStore, SettlementEngine, Trust } from '../../src/types.js';

export const H=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
async function availableUrl(){
  const server=createServer();
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw new Error();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    return `http://127.0.0.1:${address.port}/assured`;
  }catch{throw new Error('M3_LOCAL_PORT_UNAVAILABLE');}
}
export async function integration(options:{pool?:bigint;stake?:bigint;handler?:(body:Uint8Array)=>Uint8Array|Promise<Uint8Array>;resultStore?:ResultStore}={}){
  const f=await coreFixture({pool:options.pool??1_000_000n,providerStake:options.stake??1_000_000n});
  const directory=await mkdtemp(join(tmpdir(),'assurepay-m3-'));
  let server:StartedProvider|undefined;
  let phase='POLICY';
  try{
    const policyId=H(900);
    await transact(f.evm,f.coreAbi,f.core,'registerPolicy',[policyId,f.providerId,777,3500,2200,3600n,true]);
    const trust:Trust={chainId:84532,core:f.core,token:f.token,providerId:f.providerId,policyId};
    phase='TERMS';const terms=await readTerms(f.evm.publicClient,trust,'10003');
    let signatures=0,broadcasts=0,relayerSignatures=0,handlers=0,hide=false,lose=false;
    const payer={address:f.evm.payer.address,async signTypedData(data:any){signatures++;return f.evm.payer.signTypedData(data);}};
    const client={...f.evm.publicClient,
      async getTransactionReceipt(args:any){if(hide)throw new Error('LOCAL_RECEIPT_UNAVAILABLE');return f.evm.publicClient.getTransactionReceipt(args);},
      async sendRawTransaction(args:any){broadcasts++;const hash=await f.evm.publicClient.sendRawTransaction(args);if(lose)throw new Error('LOCAL_BROADCAST_RESPONSE_LOST');return hash;},
    };
    const wallet={...f.evm.walletClient,async signTransaction(args:any){relayerSignatures++;return f.evm.walletClient.signTransaction(args);}};
    const journalPath=join(directory,'payments.json');
    const makeEngine=(readonly=false)=>createSettlementEngine({client,...(readonly?{}:{wallet,account:f.evm.owner}),relayer:f.evm.owner.address,terms,journalPath,gasLimit:800_000n,maxFeePerGas:3_000_000_000n,maxPriorityFeePerGas:1_000_000n,polls:3,delay:0});
    let engine=makeEngine();
    phase='SERVER';const url=await availableUrl();
    const start=async(nextEngine:SettlementEngine=engine)=>{
      engine=nextEngine;
      server=await startProvider({terms,engine,signer:f.evm.provider,resourceUrl:url,journalPath:join(directory,'service.jsonl'),resultStore:options.resultStore,
        prepareCall:(payment,requestHash)=>prepareCall(payment,terms,requestHash,0n,{allowExpired:true}),
        canServe:call=>isServiceAdmissible(f.evm.publicClient,terms,call),
        handler:async body=>{handlers++;const opened=(await f.globals()).coverageCount;if(opened<BigInt(handlers))throw new Error('HANDLER_BEFORE_PAYMENT');return options.handler?options.handler(body):new Uint8Array([...body,42]);},
      });
      return server;
    };
    await start();
    const purchase=async(overrides:Partial<PurchaseOptions>={})=>{
      try{
        const session=await createPurchase({url,body:new Uint8Array([1,2,3]),payer,trust,maxGross:'11000',
          readTerms:(ids,gross)=>readTerms(f.evm.publicClient,ids,gross),
          now:(async()=>Number((await f.evm.publicClient.getBlock()).timestamp)) as any,
          async verifyPayment({call,paymentResponse}){
            const result=paymentResponse as {transaction:Hex};
            return verifySettlement(f.evm.publicClient,terms,call,result.transaction,f.evm.owner.address);
          },...overrides});
        return session;
      }catch(error){throw safeError(error);}
    };
    return {f,directory,url,trust,terms,client,wallet,payer,journalPath,makeEngine,purchase,start,
      get engine(){return engine;},get server(){return server!;},
      counts:()=>({signatures,broadcasts,relayerSignatures,handlers}),
      hide(value:boolean){hide=value;},lose(value:boolean){lose=value;},
      check:(ids:Hex[])=>expectInvariant(f,[f.providerId,f.secondProviderId],ids),
      async restart(readonly=true){server?.server.closeAllConnections();await server?.close();return start(makeEngine(readonly));},
      async close(){server?.server.closeAllConnections();await server?.close();await f.close();await rm(directory,{recursive:true,force:true});},
    };
  }catch(error){server?.server.closeAllConnections();await server?.close().catch(()=>{});await f.close();await rm(directory,{recursive:true,force:true});throw new Error(`M3_SETUP_${phase}_${safeError(error).message}`);}
}
export function safeError(error:unknown):Error{
  const message=error instanceof Error&&/^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)?error.message:'M3_OPERATION_FAILED';
  return new Error(message);
}
export async function safeSend<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(error){throw safeError(error);}}
