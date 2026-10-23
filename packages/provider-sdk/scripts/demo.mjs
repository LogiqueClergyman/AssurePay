import { runProviderConsumerGate } from '../test/consumer-gate.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

try {
  const report = await runProviderConsumerGate();
  const evidenceDirectory = fileURLToPath(new URL('../evidence/', import.meta.url));
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(evidenceDirectory, 'm9-consumer-gate.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch {
  process.stderr.write('PROVIDER_CONSUMER_GATE_FAILED\n');
  process.exitCode = 1;
}
