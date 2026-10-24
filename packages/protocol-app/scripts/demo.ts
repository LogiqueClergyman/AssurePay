import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runProtocolFlow } from '../test/integration-flow.js';

try {
  const report=await runProtocolFlow();
  const directory=fileURLToPath(new URL('../evidence/',import.meta.url));
  await mkdir(directory,{recursive:true});
  await writeFile(new URL('../evidence/m11-protocol-gate.json',import.meta.url),`${JSON.stringify(report,null,2)}\n`,{mode:0o644});
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({ok:false,code:'LOCAL_PROTOCOL_API_GATE_FAILED'})}\n`); process.exitCode=1;
}
