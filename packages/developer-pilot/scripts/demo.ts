import { runLocalDemo } from '../src/local-demo.js';
import { safeCode } from '../src/config.js';
try {process.stdout.write(JSON.stringify(await runLocalDemo())+'\n');}
catch(error){process.stdout.write(JSON.stringify({ok:false,code:safeCode(error)})+'\n');process.exitCode=1;}
