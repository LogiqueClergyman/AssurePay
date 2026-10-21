import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createCampaignSender } from '../src/sender.js';
import { runtimeConfig, runtimeRpc, safeCode } from '../src/runtime.js';
import { withBaseReceiptFees } from '../../../spikes/evm-m1/src/base-receipt-fees.js';
import { acquireRunLock } from '../src/run-lock.js';
let release:(()=>Promise<void>)|undefined;
try{
 if(process.argv.length!==2)throw new Error('M5_ARGUMENTS_INVALID');
 const directory=fileURLToPath(new URL('../.local-m5/',import.meta.url));
 const journalPath=join(directory,'campaign.json');
 const info=await lstat(journalPath);if(!info.isFile()||info.isSymbolicLink()||info.size>1048576)throw new Error('M5_JOURNAL_INVALID');
 release=await acquireRunLock(join(directory,'run.lock'));
 const client=withBaseReceiptFees(createPublicClient({chain:baseSepolia,transport:http(runtimeRpc(process.env),{retryCount:0,timeout:15000}),cacheTime:0}));
 const sender=await createCampaignSender({config:runtimeConfig(process.env),client,journalPath});
 for(const record of sender.read().transactions)await sender.observe(record.kind);
 const manifest=sender.read();
 process.stdout.write(JSON.stringify({ok:manifest.transactions.every(tx=>!!tx.status),code:'M5_READ_ONLY_RECONCILED',manifest})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
finally{if(release)try{await release();}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}}
