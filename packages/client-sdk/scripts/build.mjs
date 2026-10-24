import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(packageDir, 'dist');
const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 18)) throw new Error('CLIENT_SDK_NODE_VERSION_UNSUPPORTED');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await build({
  entryPoints: [join(packageDir, 'src/index.ts')], bundle: true, platform: 'node', format: 'esm',
  target: 'node24', outfile: join(distDir, 'index.js'), sourcemap: false,
  minifyWhitespace: true, packages: 'bundle',
  external: ['viem', 'viem/*', '@x402/core', '@x402/core/*'], logLevel: 'warning',
});

execFileSync(process.execPath, [join(packageDir, 'node_modules/typescript/bin/tsc'), '--noEmit', '--project', join(packageDir, 'tsconfig.json')], { cwd: packageDir, stdio: 'inherit' });
for (const name of ['index', 'types']) {
  const source = join(packageDir, `src/${name}.ts`);
  const result = ts.transpileDeclaration(await readFile(source, 'utf8'), {
    fileName: source,
    compilerOptions: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 },
  });
  const errors = (result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
  const declaration = result.outputText;
  if (name === 'index' && /\.\/errors\.js|\.\/agent\.js/.test(declaration)) throw new Error('CLIENT_SDK_ROOT_DECLARATION_SIBLING_IMPORT');
  if (/\.\.\/\.\.\/|packages\/(?:developer-pilot|claims-backend|x402-assurance|evm-acceptance)/.test(declaration)) throw new Error('CLIENT_SDK_SIBLING_DECLARATION_LEAK');
  await writeFile(join(distDir, `${name}.d.ts`), declaration, { encoding: 'utf8', mode: 0o644 });
}
if ((await readdir(distDir)).sort().join(',') !== 'index.d.ts,index.js,types.d.ts') throw new Error('CLIENT_SDK_DIST_CONTENTS_INVALID');
console.log(`Built ${packageJson.name}@${packageJson.version}`);
