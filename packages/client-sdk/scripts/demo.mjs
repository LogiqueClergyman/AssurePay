import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = resolve(packageDir, 'evidence/m10-consumer-gate.json');

try {
  execFileSync('npm', ['run', 'build'], { cwd: packageDir, encoding: 'utf8', stdio: 'pipe' });
  const { runClientConsumerGate } = await import('../test/consumer-gate.ts');
  const evidence = await runClientConsumerGate();
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({ ok: false, code: 'LOCAL_CLIENT_SDK_GATE_FAILED' })}\n`);
  process.exitCode = 1;
}
