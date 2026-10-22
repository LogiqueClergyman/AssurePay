import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('fresh sandbox starts, protects generated environments, restarts provider and cleans up on shutdown',async()=>{
 const child=spawn(process.execPath,['--import','tsx','scripts/sandbox.ts'],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['ignore','pipe','pipe']});
 let buffer='',stderr='';const rows:any[]=[];let notify=()=>{};
 child.stdout!.on('data',chunk=>{buffer+=chunk;let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);try{rows.push(JSON.parse(line));}catch{}notify();}});
 child.stderr!.on('data',chunk=>{stderr+=chunk;});
 const wait=async(code:string)=>{
  const existing=rows.find(x=>x.code===code);if(existing)return existing;
  return new Promise<any>((yes,no)=>{
   const timer=setTimeout(()=>no(Error('SANDBOX_TEST_TIMEOUT')),45_000);
   notify=()=>{const row=rows.find(x=>x.code===code);if(row){clearTimeout(timer);yes(row);}};
   child.once('exit',()=>{clearTimeout(timer);no(Error('SANDBOX_TEST_EARLY_EXIT'));});
  });
 };
 try{
  const ready=await wait('LOCAL_PILOT_SANDBOX_READY');assert.equal(ready.ok,true);assert.equal(ready.limits.localOnly,true);
  // Inspect metadata only; populated environment contents are never read.
  for(const path of Object.values(ready.roleEnvironmentPaths) as string[]){const info=await lstat(path);assert.equal(info.mode&0o777,0o600);assert.equal(info.isSymbolicLink(),false);}
  assert.notEqual(ready.roleEnvironmentPaths.retrieval,ready.roleEnvironmentPaths.buyer);
  assert.ok(ready.commands.retrieve.includes(`--env-file=${ready.roleEnvironmentPaths.retrieval} `));
  assert.equal(ready.commands.retrieve.includes(`--env-file=${ready.roleEnvironmentPaths.buyer} `),false);
  child.kill('SIGUSR2');await wait('LOCAL_PILOT_PROVIDER_RESTARTED');
  const exit=once(child,'exit');child.kill('SIGTERM');const [code]=await exit;assert.equal(code,0);assert.equal(stderr,'');
  await assert.rejects(()=>lstat(ready.directory),(e:any)=>e.code==='ENOENT');
  assert.equal(JSON.stringify(rows).includes('PILOT_RELAYER_PRIVATE_KEY='),false);
  assert.equal(rows.some(x=>Object.hasOwn(x,'privateKey')),false);
 }finally{
  if(child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10_000);await exit;clearTimeout(timer);}
 }
});
