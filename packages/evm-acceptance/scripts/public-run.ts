import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { compileContracts } from '../../evm-core/src/compiler.js';
import { runCampaign } from '../src/campaign.js';
import { runtimeConfig, runtimeRpc, runtimeAccounts, runtimeDataKey, safeCode, PUBLIC_SCOPE } from '../src/runtime.js';
import { checkPublic } from '../src/preflight.js';
import { withBaseReceiptFees } from '../../../spikes/evm-m1/src/base-receipt-fees.js';
import { acquireRunLock } from '../src/run-lock.js';
let release:(()=>Promise<void>)|undefined;
try{
 if(process.argv.length!==3||process.argv[2]!=='--execute'||process.env.M5_PUBLIC_SCOPE!==PUBLIC_SCOPE)throw new Error('M5_EXPLICIT_EXECUTION_SCOPE_REQUIRED');
 const config=runtimeConfig(process.env),rpc=runtimeRpc(process.env);
 const directory=fileURLToPath(new URL('../.local-m5/',import.meta.url));
 await mkdir(directory,{recursive:true,mode:0o700});
 release=await acquireRunLock(join(directory,'run.lock'));
 const client=withBaseReceiptFees(createPublicClient({chain:baseSepolia,transport:http(rpc,{retryCount:0,timeout:15000}),cacheTime:0}));
 const wallet=createWalletClient({chain:baseSepolia,transport:http(rpc,{retryCount:0,timeout:15000})});
 const check=await checkPublic({config,client});if(!check.ok)throw new Error('M5_PUBLIC_PREFLIGHT_NOT_READY');
 const accounts=runtimeAccounts(process.env,config),dataKey=runtimeDataKey(process.env);
 const result=await runCampaign({config,client,wallet,accounts,dataKey,journalPath:join(directory,'campaign.json'),dataDirectory:join(directory,'data'),artifact:compileContracts().AssuranceCore,executePublic:true,polls:20,delay:1000});
 process.stdout.write(JSON.stringify({code:'M5_PUBLIC_CAMPAIGN_COMPLETE',transport:result.transport,verification:result.verification})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
finally{if(release)try{await release();}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}}
