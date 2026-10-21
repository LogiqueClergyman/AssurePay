import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileContracts } from '../../evm-core/src/compiler.js';
import { verifyCampaign } from '../src/verify.js';
import { runtimeRpc, safeCode } from '../src/runtime.js';
try{
 if(process.argv.length!==2)throw new Error('M5_ARGUMENTS_INVALID');
 const path=fileURLToPath(new URL('../.local-m5/campaign.json',import.meta.url));
 const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.size>1000000)throw new Error('M5_MANIFEST_INVALID');
 const manifest=JSON.parse(await readFile(path,'utf8'));
 const client=createPublicClient({chain:baseSepolia,transport:http(runtimeRpc(process.env),{retryCount:0,timeout:15000}),cacheTime:0});
 const report=await verifyCampaign({client,manifest,artifact:compileContracts().AssuranceCore});
 process.stdout.write(JSON.stringify(report)+'\n');if(!report.ok)process.exitCode=1;
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
