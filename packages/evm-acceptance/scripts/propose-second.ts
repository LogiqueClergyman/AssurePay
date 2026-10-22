import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, toHex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { buildFundingPlan } from '../src/funding.js';
import { MANAGED_TEST_VAULT, checkPublic } from '../src/preflight.js';
import { runtimeConfig, runtimeRpc, safeCode } from '../src/runtime.js';

try {
 if(process.argv.length!==2)throw new Error('M5_ARGUMENTS_INVALID');
 const config=runtimeConfig({...process.env,M5_RUN_ID:toHex(randomBytes(32))});
 const client=createPublicClient({chain:baseSepolia,transport:http(runtimeRpc(process.env),{retryCount:0,timeout:15000}),cacheTime:0});
 const preflight=await checkPublic({config,client});
 if(!['ok','native_balance_insufficient'].includes(preflight.code))throw new Error('M5_SECOND_PROPOSAL_PREFLIGHT_FAILED');
 const fundingPlan=await buildFundingPlan({config,client,vault:MANAGED_TEST_VAULT});
 if(!fundingPlan.ready)throw new Error('M5_SECOND_PROPOSAL_FUNDING_FAILED');
 const proposal={version:1,scope:'m5-second-campaign-after-expired-first',config,fundingPlan};
 const path=fileURLToPath(new URL('../evidence/second-attempt-proposal.json',import.meta.url));
 const handle=await open(path,'wx',0o644);
 try{await handle.writeFile(JSON.stringify(proposal)+'\n');await handle.sync();}finally{await handle.close();}
 const directory=await open(fileURLToPath(new URL('../evidence/',import.meta.url)),'r');
 try{await directory.sync();}finally{await directory.close();}
 process.stdout.write(JSON.stringify({ok:true,code:'M5_SECOND_PROPOSAL_CREATED',runId:config.runId,transfers:fundingPlan.transfers,totalTopUpWei:fundingPlan.transferValueWei,fundingFeeAllowanceWei:fundingPlan.totalFeeAllowanceWei,maximumNewVaultOutflowWei:fundingPlan.requiredVaultWei,publicMutation:false})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
