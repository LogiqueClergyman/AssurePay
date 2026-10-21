import { runtimeConfig, runtimeAccounts, runtimeDataKey, safeCode } from '../src/runtime.js';
try{
 if(process.argv.length!==2)throw new Error('M5_ARGUMENTS_INVALID');
 const config=runtimeConfig(process.env);runtimeAccounts(process.env,config);runtimeDataKey(process.env);
 process.stdout.write(JSON.stringify({ok:true,code:'M5_RUNTIME_IDENTITIES_MATCH',roles:config.roles,runId:config.runId,publicMutation:false})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
