import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { compileContracts } from '../../evm-core/src/compiler.js';
import { runCampaign } from '../src/campaign.js';
import { createCampaignSender } from '../src/sender.js';
import { runtimeConfig, runtimeRpc, runtimeAccounts, runtimeDataKey, safeCode, PUBLIC_SCOPE } from '../src/runtime.js';
import { ECONOMICS, MAX_FEE_PER_GAS } from '../src/plan.js';
import { withBaseReceiptFees } from '../../../spikes/evm-m1/src/base-receipt-fees.js';
import { acquireRunLock } from '../src/run-lock.js';

const CONTINUATION_SCOPE='m5-continue-after-purchase-a-once';
let release:(()=>Promise<void>)|undefined;
try{
 if(process.argv.length!==4||process.argv[2]!=='--execute'||process.argv[3]!=='--continue-after-purchase-a'||process.env.M5_PUBLIC_SCOPE!==PUBLIC_SCOPE||process.env.M5_CONTINUATION_SCOPE!==CONTINUATION_SCOPE)throw new Error('M5_CONTINUATION_SCOPE_REQUIRED');
 const config=runtimeConfig(process.env),rpc=runtimeRpc(process.env);
 const directory=fileURLToPath(new URL('../.local-m5/',import.meta.url));
 const journalPath=join(directory,'campaign.json');
 const info=await lstat(journalPath);if(!info.isFile()||info.isSymbolicLink()||info.size>1_048_576)throw new Error('M5_CONTINUATION_JOURNAL_INVALID');
 release=await acquireRunLock(join(directory,'run.lock'));
 const client=withBaseReceiptFees(createPublicClient({chain:baseSepolia,transport:http(rpc,{retryCount:0,timeout:15000}),cacheTime:0}));
 const wallet=createWalletClient({chain:baseSepolia,transport:http(rpc,{retryCount:0,timeout:15000})});
 if(await client.getChainId()!==84532)throw new Error('CAMPAIGN_CHAIN_MISMATCH');
 const block=await client.getBlock({blockTag:'latest'});if(block.baseFeePerGas===null||block.baseFeePerGas+1_000_000n>BigInt(MAX_FEE_PER_GAS))throw new Error('M5_CONTINUATION_FEE_PREFLIGHT_FAILED');
 const accounts=runtimeAccounts(process.env,config);
 const sender=await createCampaignSender({config,client,journalPath});
 const prefix=sender.read();
 if(prefix.transactions.length!==7||prefix.transactions[6]?.kind!=='purchaseA'||prefix.transactions.some(row=>row.status!=='success'))throw new Error('M5_CONTINUATION_PREFIX_INVALID');
 for(const row of prefix.transactions)await sender.observe(row.kind);
 const payerUsdc=await client.readContract({address:config.token,abi:[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}],functionName:'balanceOf',args:[config.roles.payer]});
 if(typeof payerUsdc!=='bigint'||payerUsdc<BigInt(ECONOMICS.gross))throw new Error('M5_CONTINUATION_USDC_INSUFFICIENT');
 const result=await runCampaign({config,client,wallet,accounts,dataKey:runtimeDataKey(process.env),journalPath,dataDirectory:join(directory,'data'),artifact:compileContracts().AssuranceCore,executePublic:true,continueAfterPurchaseA:true,polls:20,delay:1000});
 process.stdout.write(JSON.stringify({code:'M5_PUBLIC_CONTINUATION_COMPLETE',transport:result.transport,verification:result.verification})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
finally{if(release)try{await release();}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}}
