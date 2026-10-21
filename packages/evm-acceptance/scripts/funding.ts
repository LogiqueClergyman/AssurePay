import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildFundingPlan, fundCampaign, reconcileFunding, PUBLIC_FUNDING_SCOPE } from '../src/funding.js';
import { MANAGED_TEST_VAULT, checkPublic } from '../src/preflight.js';
import { runtimeConfig, runtimeRpc, safeCode, PUBLIC_SCOPE } from '../src/runtime.js';
import { acquireRunLock } from '../src/run-lock.js';
import { withBaseReceiptFees } from '../../../spikes/evm-m1/src/base-receipt-fees.js';

// Stage B proposal from the canonical read-only snapshot. Changed shortfalls
// require a new reviewed proposal; this entry point cannot enlarge the values.
const PROPOSED_TOP_UPS = {
  relayer: '302480018003071', payer: '108000000000000', adjudicator: '94000000000000',
} as const;
let release:(()=>Promise<void>)|undefined;
try {
  const args=process.argv.slice(2);
  const execute=args.length===3&&args[0]==='--execute'&&args[1]==='--scope'&&args[2]===PUBLIC_FUNDING_SCOPE;
  const reconcile=args.length===1&&args[0]==='--reconcile';
  if(args.length!==0&&!execute&&!reconcile)throw new Error('M5_ARGUMENTS_INVALID');
  if(execute&&process.env.M5_PUBLIC_SCOPE!==PUBLIC_SCOPE)throw new Error('M5_EXPLICIT_EXECUTION_SCOPE_REQUIRED');
  const config=runtimeConfig(process.env),rpc=runtimeRpc(process.env);
  const client=withBaseReceiptFees(createPublicClient({chain:baseSepolia,transport:http(rpc,{retryCount:0,timeout:15000}),cacheTime:0}));
  const directory=fileURLToPath(new URL('../.local-m5/',import.meta.url));
  const journalPath=join(directory,'funding.json');
  if(execute||reconcile){
    await mkdir(directory,{recursive:true,mode:0o700});
    release=await acquireRunLock(join(directory,'run.lock'));
  }
  if(reconcile){
    const result=await reconcileFunding({config,client,journalPath,vault:MANAGED_TEST_VAULT});
    process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=1;
  } else {
    const plan=await buildFundingPlan({config,client,vault:MANAGED_TEST_VAULT});
    if(!execute){process.stdout.write(JSON.stringify({ok:plan.ready,code:'M5_FUNDING_PLAN_ONLY',plan})+'\n');if(!plan.ready)process.exitCode=1;}
    else {
      const check=await checkPublic({config,client});
      if(!['ok','native_balance_insufficient'].includes(check.code))throw new Error('M5_FUNDING_PREFLIGHT_NOT_READY');
      if(plan.transfers.some(row=>row.valueWei!==PROPOSED_TOP_UPS[row.actor]))throw new Error('M5_FUNDING_PROPOSAL_CHANGED');
      const key=process.env.VAULT_PRIVATE_KEY;
      if(!key||!/^0x[0-9a-fA-F]{64}$/.test(key))throw new Error('M5_VAULT_SIGNER_REQUIRED');
      const account=privateKeyToAccount(key as Hex);
      if(account.address.toLowerCase()!==MANAGED_TEST_VAULT)throw new Error('M5_VAULT_SIGNER_MISMATCH');
      const wallet=createWalletClient({chain:baseSepolia,transport:http(rpc,{retryCount:0,timeout:15000})});
      const result=await fundCampaign({config,client,wallet,account,plan,journalPath,execute:true,publicScope:PUBLIC_FUNDING_SCOPE,polls:20,delay:1000});
      process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=1;
    }
  }
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
finally{if(release)try{await release();}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}}
