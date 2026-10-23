import { runTransportRehearsal } from '../src/transport-rehearsal.js';
import { safeCode } from '../src/config.js';
try { process.stdout.write(JSON.stringify(await runTransportRehearsal()) + '\n'); }
catch (error) { process.stdout.write(JSON.stringify({ok: false, code: safeCode(error)}) + '\n'); process.exitCode = 1; }
