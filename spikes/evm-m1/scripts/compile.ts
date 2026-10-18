import { createHash } from 'node:crypto';
import { compileContracts } from '../test/helpers/evm.js';

try {
  const artifacts = compileContracts();
  const contracts = ['AssuranceCoreSpike', 'AuthorizationTokenMock'].map(name => {
    const artifact = artifacts[name];
    if (!artifact) throw new Error('MISSING_CONTRACT');
    return {
      name,
      creationBytecodeBytes: (artifact.bytecode.length - 2) / 2,
      creationBytecodeSha256: createHash('sha256').update(Buffer.from(artifact.bytecode.slice(2), 'hex')).digest('hex'),
    };
  });
  process.stdout.write(`${JSON.stringify({ code: 'M1_COMPILED', contracts })}\n`);
} catch {
  process.stdout.write('{"code":"M1_COMPILE_FAILED"}\n');
  process.exitCode = 1;
}
