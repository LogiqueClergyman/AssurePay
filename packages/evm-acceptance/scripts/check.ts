import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { runtimeConfig, runtimeRpc, safeCode } from '../src/runtime.js';
import { checkPublic } from '../src/preflight.js';
try{
 if(process.argv.length!==2)throw new Error('M5_ARGUMENTS_INVALID');
 const config=runtimeConfig(process.env);
 const client=createPublicClient({chain:baseSepolia,transport:http(runtimeRpc(process.env),{retryCount:0,timeout:15000}),cacheTime:0});
 const report=await checkPublic({config,client});
 process.stdout.write(JSON.stringify(report)+'\n');
 if(!report.ok)process.exitCode=1;
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
