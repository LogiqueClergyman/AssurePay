import { createRehearsal } from '../src/rehearsal.js';
let fixture:Awaited<ReturnType<typeof createRehearsal>>|undefined;
try{
 if(process.argv.length!==2)throw new Error('M5_ARGUMENTS_INVALID');
 fixture=await createRehearsal();const result=await fixture.run();
 process.stdout.write(JSON.stringify({code:'M5_LOCAL_REHEARSAL_COMPLETE',transport:result.transport,verification:result.verification,budget:fixture.budgets})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'M5_REHEARSAL_FAILED'})+'\n');process.exitCode=1;}
finally{await fixture?.close();}
