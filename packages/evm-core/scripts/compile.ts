import { createHash } from 'node:crypto';
import { compileContracts } from '../src/compiler.js';

try {
  const artifacts = compileContracts();
  const contracts = ['AssuranceCore', 'AuthorizationTokenMock'].map((name) => {
    const artifact = artifacts[name];
    if (!artifact) throw new Error('MISSING_CONTRACT');
    return {
      name,
      creationBytecodeBytes: (artifact.bytecode.length - 2) / 2,
      creationBytecodeSha256: createHash('sha256').update(Buffer.from(artifact.bytecode.slice(2), 'hex')).digest('hex'),
      runtimeBytecodeBytes: (artifact.deployedBytecode.length - 2) / 2,
      runtimeBytecodeSha256: createHash('sha256').update(Buffer.from(artifact.deployedBytecode.slice(2), 'hex')).digest('hex'),
    };
  });
  process.stdout.write(`${JSON.stringify({ code: 'M2_COMPILED', contracts })}\n`);
} catch {
  process.stdout.write('{"code":"M2_COMPILE_FAILED"}\n');
  process.exitCode = 1;
}
