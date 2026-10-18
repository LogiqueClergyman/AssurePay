import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import solc from 'solc';

export interface Artifact { abi: any; bytecode: Hex }
const root = fileURLToPath(new URL('../', import.meta.url));
let compiled: Record<string, Artifact> | undefined;

/** Compiles actual Solidity; no generated artifacts or signing data are persisted. */
export function compileContracts(): Record<string, Artifact> {
  if (compiled) return compiled;
  const sources = Object.fromEntries([
    'contracts/AssuranceCoreSpike.sol', 'contracts/mocks/AuthorizationTokenMock.sol',
  ].map(name => [name, { content: readFileSync(resolve(root, name), 'utf8') }]));
  const settings = JSON.parse(readFileSync(resolve(root, 'toolchain.json'), 'utf8')).compiler;
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    optimizer: settings.optimizer, evmVersion: settings.evmVersion,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  } }), { import(name: string) {
    const local = resolve(root, name.startsWith('@') ? `node_modules/${name}` : name);
    if (!local.startsWith(resolve(root, 'node_modules') + sep) && !local.startsWith(resolve(root, 'contracts') + sep)) {
      return { error: 'IMPORT_OUTSIDE_SPIKE' };
    }
    try { return { contents: readFileSync(local, 'utf8') }; } catch { return { error: 'IMPORT_UNAVAILABLE' }; }
  } }));
  const errors = (output.errors ?? []).filter((item: any) => item.severity === 'error');
  if (errors.length) throw new Error(`LOCAL_SOLIDITY_COMPILE_FAILED: ${errors.map((item: any) => item.formattedMessage).join('\n')}`);
  compiled = {};
  for (const contracts of Object.values(output.contracts) as any[]) {
    for (const [name, contract] of Object.entries(contracts) as [string, any][]) {
      if (contract.evm.bytecode.object) compiled[name] = { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
    }
  }
  return compiled;
}
