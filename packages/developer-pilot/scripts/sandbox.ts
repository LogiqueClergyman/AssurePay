import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPilotFixture } from '../test/helpers.js';
import { startPilotProvider } from '../src/provider.js';
import { safeCode } from '../src/config.js';

// Fresh isolated accounts only. Existing environments and public RPCs are never loaded.
let fixture:Awaited<ReturnType<typeof createPilotFixture>>|undefined;
let runtime:Awaited<ReturnType<typeof startPilotProvider>>|undefined;
let work=Promise.resolve();let stopping=false;
try{
 fixture=await createPilotFixture();const f=fixture,configPath=join(f.directory,'config.json');
 const providerEnv=join(f.directory,'provider.env'),buyerEnv=join(f.directory,'buyer.env'),operatorEnv=join(f.directory,'operator.env'),retrievalEnv=join(f.directory,'retrieval.env');
 await writeFile(configPath,JSON.stringify(f.config)+'\n',{flag:'wx',mode:0o600});
 await writeFile(providerEnv,`PILOT_RELAYER_PRIVATE_KEY=${f.roleKeys.relayer}\nPILOT_PROVIDER_PRIVATE_KEY=${f.roleKeys.provider}\nPILOT_DATA_KEY=${f.keys.provider.toString('hex')}\n`,{flag:'wx',mode:0o600});
 await writeFile(buyerEnv,`PILOT_PAYER_PRIVATE_KEY=${f.roleKeys.payer}\nPILOT_DATA_KEY=${f.keys.buyer.toString('hex')}\n`,{flag:'wx',mode:0o600});
 await writeFile(retrievalEnv,`PILOT_DATA_KEY=${f.keys.buyer.toString('hex')}\n`,{flag:'wx',mode:0o600});
 await writeFile(operatorEnv,`PILOT_ADJUDICATOR_PRIVATE_KEY=${f.roleKeys.adjudicator}\n`,{flag:'wx',mode:0o600});
 const start=()=>startPilotProvider({config:f.config,directory:join(f.directory,'service'),key:f.keys.provider,client:f.evm.publicClient,wallet:f.evm.walletClient,relayerAccount:f.accounts.relayer,receiptSigner:f.accounts.provider,handler:body=>body});
 runtime=await start();
 const base=`node --import tsx scripts/pilot.ts`;
 process.stdout.write(JSON.stringify({ok:true,code:'LOCAL_PILOT_SANDBOX_READY',pid:process.pid,configPath,directory:f.directory,
   resourceUrl:f.config.resourceUrl,claimsUrl:f.config.claimsUrl,
   roleEnvironmentPaths:{provider:providerEnv,buyer:buyerEnv,adjudicator:operatorEnv,retrieval:retrievalEnv},
   commands:{
    purchase:`node --env-file=${buyerEnv} --import tsx scripts/pilot.ts purchase --config ${configPath} --data ${join(f.directory,'buyer')} --body-file <file> --execute`,
    retrieve:`node --env-file=${retrievalEnv} --import tsx scripts/pilot.ts retrieve --config ${configPath} --data ${join(f.directory,'buyer')} --id <requestId> --out <new-file>`,
    evidence:`node --env-file=${buyerEnv} --import tsx scripts/pilot.ts evidence --config ${configPath} --coverage <coverageId> --file <evidence-file>`,
    claim:`node --env-file=${buyerEnv} --import tsx scripts/pilot.ts claim --config ${configPath} --data ${join(f.directory,'buyer')} --coverage <coverageId> --evidence <evidenceHash> --execute`,
    decision:`node --env-file=${operatorEnv} --import tsx scripts/pilot.ts decision --config ${configPath} --data ${join(f.directory,'operator')} --coverage <coverageId> --outcome 1 --refund 3100 --reason-file <reason-file> --execute`,
    status:`${base} status --config ${configPath} --coverage <coverageId>`,
    restartProvider:`kill -USR2 ${process.pid}`,
   },limits:{localOnly:true,temporaryChain:true,publicNativeUsdcProof:false}})+'\n');
 const stop=()=>{if(stopping)return;stopping=true;work=work.then(async()=>{await runtime?.close();runtime=undefined;await f.close();fixture=undefined;}).catch(()=>{process.exitCode=1;}).finally(()=>{process.off('SIGUSR2',restart);process.off('SIGTERM',stop);process.off('SIGINT',stop);});};
 const restart=()=>{if(stopping)return;work=work.then(async()=>{await runtime!.close();runtime=await start();process.stdout.write(JSON.stringify({ok:true,code:'LOCAL_PILOT_PROVIDER_RESTARTED'})+'\n');}).catch(error=>{process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');stop();});};
 process.on('SIGUSR2',restart);process.once('SIGINT',stop);process.once('SIGTERM',stop);
}catch(error){await runtime?.close().catch(()=>{});await fixture?.close().catch(()=>{});process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
