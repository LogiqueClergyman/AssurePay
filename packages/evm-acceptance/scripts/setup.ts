import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { safeCode, PUBLIC_SCOPE } from '../src/runtime.js';
try{
 if(process.argv.length!==2)throw new Error('M5_ARGUMENTS_INVALID');
 const privateKey=generatePrivateKey(),account=privateKeyToAccount(privateKey);
 const runId=`0x${randomBytes(32).toString('hex')}`;
 const file=fileURLToPath(new URL('../.env.m5.local',import.meta.url));
 let handle;
 try{handle=await open(file,'wx',0o600);}catch{throw new Error('M5_CONFIG_ALREADY_EXISTS_OR_UNAVAILABLE');}
 try{
  await handle.writeFile(['# Private M5 runtime config; preserve for encrypted result recovery.',`M5_RUN_ID=${runId}`,`M5_ADJUDICATOR_ADDRESS=${account.address.toLowerCase()}`,`M5_ADJUDICATOR_PRIVATE_KEY=${privateKey}`,`M5_DATA_KEY_HEX=${randomBytes(32).toString('hex')}`,`M5_PUBLIC_SCOPE=${PUBLIC_SCOPE}`,'M5_RESOURCE_URL=http://127.0.0.1:40205/assured',''].join('\n'));
  await handle.sync();
 }finally{await handle.close();}
 const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
 process.stdout.write(JSON.stringify({code:'M5_PRIVATE_CONFIG_CREATED',runId,adjudicator:account.address.toLowerCase(),configurationPath:file,publicMutation:false})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
