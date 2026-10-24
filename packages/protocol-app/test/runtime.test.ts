import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createProtocolRuntime } from '../src/runtime.js';
import { validateProtocolConfig } from '../src/config.js';
import { protocolErrorCode } from '../src/errors.js';
import { createProtocolFixture } from './helpers.js';
import type { ProtocolRuntime } from '../src/types.js';

test('protocol runtime preserves empty actor journals and rejects missing/corrupt/context-changed state on restart',async()=>{
  const f=await createProtocolFixture(); let runtime:ProtocolRuntime|undefined;
  const directory=join(f.directory,'runtime-check');
  const options={config:f.config,storage:{directory,key:f.keys.buyer},limits:{maxActionAmount:'10000',maxActions:8}};
  try{
    for (const invalid of [
      {...f.config,admin:f.config.pilot.roles.relayer},
      {...f.config,apiUrl:new URL(f.config.pilot.resourceUrl).origin},
      {...f.config,apiUrl:'https://example.org'},
      {...f.config,unexpected:true},
      {...f.config,pilot:{...f.config.pilot,token:'0x036cbd53842c5426634e7929541ec2318f3dcf7e'}},
    ]) assert.throws(()=>validateProtocolConfig(invalid),{message:'PROTOCOL_CONFIG_INVALID'});
    await assert.rejects(createProtocolRuntime({...options,accounts:{admin:f.accounts.provider}}),{message:'PROTOCOL_ACCOUNT_INVALID'});
    runtime=await createProtocolRuntime(options);
    assert.equal((await runtime.snapshot()).summary.tokenBalanceAtomic,'60000');
    await assert.rejects(createProtocolRuntime(options),{message:'PROTOCOL_LOCKED'});
    assert.deepEqual(await runtime.reconcile('operator'),[]);
    const preview=await runtime.preview('admin',{kind:'setPaused',paused:true});
    await assert.rejects(runtime.confirm('admin',preview.previewId,{approved:true}),{message:'PROTOCOL_SIGNER_REQUIRED'});
    await runtime.close(); runtime=undefined;
    // A read-only first run still records all empty actor journals durably.
    runtime=await createProtocolRuntime(options); await runtime.close(); runtime=undefined;
    await assert.rejects(createProtocolRuntime({...options,limits:{...options.limits,maxActions:9}}),{message:'PROTOCOL_CONTEXT_MISMATCH'});
    const otherKey=Uint8Array.from(f.keys.buyer);otherKey[0]^=255;
    await assert.rejects(createProtocolRuntime({...options,storage:{directory,key:otherKey}}),{message:'PROTOCOL_CONTEXT_MISMATCH'});
    const journal=join(directory,'actors/provider/journal.json'),saved=join(directory,'actors/provider/journal.saved');
    await rename(journal,saved);
    await assert.rejects(createProtocolRuntime(options),{message:'PROTOCOL_JOURNAL_MISSING'});
    await rename(saved,journal);
    const original=await readFile(journal);
    await writeFile(journal,'{broken');
    await assert.rejects(createProtocolRuntime(options),{message:'PROTOCOL_JOURNAL_INVALID'});
    await writeFile(journal,original);
    runtime=await createProtocolRuntime(options);
    assert.equal((await runtime.snapshot()).summary.activeCoverageCount,'0');
  }finally{await runtime?.close().catch(()=>undefined);await f.close();}
});

test('configuration and error boundaries reject malformed authority without returning private exception text',()=>{
  assert.throws(()=>validateProtocolConfig({}),{message:'PROTOCOL_CONFIG_INVALID'});
  assert.equal(protocolErrorCode(Error('PROTOCOL_PRIVATE_SECRET')),'PROTOCOL_OPERATION_FAILED');
  const hostile=Error();Object.defineProperty(hostile,'message',{get(){throw Error('PRIVATE');}});
  assert.equal(protocolErrorCode(hostile),'PROTOCOL_OPERATION_FAILED');
});
