import { join } from 'node:path';
import { parseAbi } from 'viem';
import { createSettlementEngine } from '../../x402-assurance/src/engine.js';
import { startProvider } from '../../x402-assurance/src/http-provider.js';
import { readTerms, isServiceAdmissible } from '../../x402-assurance/src/chain.js';
import { prepareCall } from '../../x402-assurance/src/protocol.js';
import { EncryptedVault, contextNamespace, createResultStore, createProjection, createClaimsBackend } from '../../claims-backend/src/index.js';
import { acquireRunLock } from '../../evm-acceptance/src/run-lock.js';
import { acquireActorLock } from './action-sender.js';
import { startClaimsServer } from './claims-http.js';
import { contextFor, createClients, ensureDirectory, trustFor, validateConfig, type PilotConfig } from './config.js';

export async function checkPilot(input: PilotConfig, suppliedClient?: any) {
  const config=validateConfig(input), client=suppliedClient??createClients(config).client;
  if(await client.getChainId()!==84532)throw Error('PILOT_CHAIN_MISMATCH');
  const abi=parseAbi(['function token() view returns(address)','function admin() view returns(address)','function adjudicator() view returns(address)']);
  const head=await client.getBlock({blockTag:'latest'});
  if(typeof head.baseFeePerGas!=='bigint'||head.baseFeePerGas+1_000_000n>100_000_000n)throw Error('PILOT_FEE_CAP_UNAVAILABLE');
  if(head.number<BigInt(config.deploymentBlock))throw Error('PILOT_DEPLOYMENT_RANGE_INVALID');
  for(const [functionName,want] of [['token',config.token],['admin',config.roles.relayer],['adjudicator',config.roles.adjudicator]]) {
    const got=await client.readContract({address:config.core,abi,functionName,blockNumber:head.number});
    if(typeof got!=='string'||got.toLowerCase()!==want)throw Error('PILOT_CONTEXT_MISMATCH');
  }
  const terms=await readTerms(client,trustFor(config),config.gross);
  if(terms.providerOwner.toLowerCase()!==config.roles.provider||terms.providerPayout.toLowerCase()!==config.roles.provider)throw Error('PILOT_PROVIDER_MISMATCH');
  const anchor=await client.getBlock({blockNumber:head.number});if(anchor.hash!==head.hash)throw Error('PILOT_CANONICALITY_UNAVAILABLE');
  return terms;
}
export async function startPilotProvider(options:{config:PilotConfig;directory:string;key:Uint8Array;
  receiptSigner:any;relayerAccount?:any;wallet?:any;client?:any;handler:(body:Uint8Array)=>Uint8Array|Promise<Uint8Array>}) {
  const config=validateConfig(options.config), key=Uint8Array.from(options.key), handler=options.handler;
  if(key.length!==32||!options.receiptSigner||options.receiptSigner.address?.toLowerCase()!==config.roles.provider)throw Error('PILOT_PROVIDER_CONFIG_INVALID');
  if(options.relayerAccount&&options.relayerAccount.address?.toLowerCase()!==config.roles.relayer)throw Error('PILOT_RELAYER_MISMATCH');
  const defaults=options.client?undefined:createClients(config),client=options.client??defaults!.client;
  const wallet=options.wallet??defaults?.wallet;
  const directory=await ensureDirectory(options.directory);
  const releases:Array<()=>Promise<void>>=[];
  let provider:Awaited<ReturnType<typeof startProvider>>|undefined,claims:Awaited<ReturnType<typeof startClaimsServer>>|undefined;
  try {
    releases.push(await acquireRunLock(join(directory,'runtime.lock')));
    releases.push(await acquireActorLock(config.roles.relayer));
    const terms=await checkPilot(config,client),context=contextFor(config);
    const vault=new EncryptedVault({directory:join(directory,'objects'),namespace:contextNamespace(context),keyId:'pilot-v1',key});
    const projection=createProjection({client,context,journalPath:join(directory,'projection.json'),fromBlock:BigInt(config.deploymentBlock),maxBlocks:25_000,maxCoverages:1_000});
    const backend=await createClaimsBackend({context,projection,vault,replayPath:join(directory,'replay.jsonl')});
    const engine=createSettlementEngine({client,wallet,account:options.relayerAccount,relayer:config.roles.relayer,terms,journalPath:join(directory,'payments.json'),gasLimit:800_000n,maxFeePerGas:100_000_000n,maxPriorityFeePerGas:1_000_000n,polls:10,delay:100});
    provider=await startProvider({terms,engine,signer:options.receiptSigner,handler,journalPath:join(directory,'service.jsonl'),resourceUrl:config.resourceUrl,
      resultStore:createResultStore(vault),canServe:call=>isServiceAdmissible(client,terms,call),
      prepareCall:(payment,requestHash)=>prepareCall(payment,terms,requestHash,0n,{allowExpired:true})});
    claims=await startClaimsServer({url:config.claimsUrl,backend,projection});
    let closing:Promise<void>|undefined;
    return {provider,claims,async close(){
      if(closing)return closing;
      closing=(async()=>{
        const stopped=await Promise.allSettled([provider!.close(),claims!.close()]);
        if(stopped.some(x=>x.status==='rejected'))throw Error('PILOT_SERVER_CLOSE_FAILED');
        for(const release of [...releases].reverse())await release();
      })();return closing;
    }};
  } catch(error) {
    await Promise.allSettled([provider?.close(),claims?.close()]);
    for(const release of releases.reverse())await release().catch(()=>{});
    throw error;
  }
}
