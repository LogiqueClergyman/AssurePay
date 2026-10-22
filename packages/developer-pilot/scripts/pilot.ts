import { runCli, safeCode } from '../src/cli.js';
try { await runCli(process.argv.slice(2),process.env,value=>process.stdout.write(JSON.stringify(value)+'\n')); }
catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
