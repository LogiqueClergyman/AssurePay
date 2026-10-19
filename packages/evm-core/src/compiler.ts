import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import solc from 'solc';

export interface Artifact { abi: any; bytecode: Hex; deployedBytecode: Hex }
const root = fileURLToPath(new URL('../', import.meta.url));
const repository = resolve(root, '../..');
let compiled: Record<string, Artifact> | undefined;

function solidityFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return solidityFiles(path);
    return entry.isFile() && entry.name.endsWith('.sol') ? [path] : [];
  });
}

function sourcePath(path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Compiles the actual M2 contracts and the read-only M1 authorization fixture. */
export function compileContracts(): Record<string, Artifact> {
  if (compiled) return compiled;
  const packageSources = solidityFiles(resolve(root, 'contracts'));
  const fixturePath = resolve(repository, 'spikes/evm-m1/contracts/mocks/AuthorizationTokenMock.sol');
  const sources: Record<string, { content: string }> = Object.fromEntries(
    packageSources.map((path) => [sourcePath(path), { content: readFileSync(path, 'utf8') }]),
  );
  sources['contracts/mocks/AuthorizationTokenMock.sol'] = { content: readFileSync(fixturePath, 'utf8') };

  const toolchain = JSON.parse(readFileSync(resolve(root, 'toolchain.json'), 'utf8'));
  const compiler = toolchain.compiler;
  if (solc.version().split('+')[0] !== compiler.solc) throw new Error('LOCAL_SOLC_VERSION_MISMATCH');
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    optimizer: compiler.optimizer,
    viaIR: compiler.viaIR,
    evmVersion: compiler.evmVersion,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  } }), { import(name: string) {
    const normalized = name.replaceAll('\\', '/').replace(/^\.\//, '');
    const candidates = [
      resolve(root, normalized),
      resolve(root, 'contracts', normalized),
      resolve(root, 'node_modules', normalized),
      resolve(repository, 'spikes/evm-m1', normalized),
    ];
    for (const path of candidates) {
      const allowed = [resolve(root, 'contracts'), resolve(root, 'node_modules'),
        resolve(repository, 'spikes/evm-m1/contracts')]
        .some((base) => path.startsWith(`${base}${sep}`));
      if (!allowed) continue;
      try { return { contents: readFileSync(path, 'utf8') }; } catch { /* try next import base */ }
    }
    return { error: 'IMPORT_UNAVAILABLE' };
  } }));
  const errors = (output.errors ?? []).filter((item: any) => item.severity === 'error');
  if (errors.length) throw new Error(`LOCAL_SOLIDITY_COMPILE_FAILED: ${errors.map((item: any) => item.formattedMessage).join('\n')}`);
  compiled = {};
  for (const contracts of Object.values(output.contracts ?? {}) as any[]) {
    for (const [name, contract] of Object.entries(contracts) as [string, any][]) {
      if (contract.evm.bytecode.object) compiled[name] = {
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
      };
    }
  }
  return compiled;
}
