import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));

test('built public root loads and sanitizes unknown errors', async () => {
  const builtRoot = new URL('../dist/index.js', import.meta.url).href;
  const sdk = await import(builtRoot);
  assert.deepEqual(Object.keys(sdk).sort(), [
    'createProvider', 'providerErrorCode', 'readProviderConfig', 'validateProviderConfig',
  ]);
  assert.equal(sdk.providerErrorCode(new Error('private path /secret/key')), 'PROVIDER_OPERATION_FAILED');
  assert.equal(sdk.providerErrorCode(new Error('PRIVATE_WALLET_ERROR')), 'PROVIDER_OPERATION_FAILED');
  assert.equal(sdk.providerErrorCode({ message: 'PILOT_SCHEMA_INVALID' }), 'PROVIDER_OPERATION_FAILED');
  let reads = 0;
  const changingMessage = new Error();
  Object.defineProperty(changingMessage, 'message', {
    get() { reads += 1; return reads === 1 ? 'PILOT_SCHEMA_INVALID' : '/private/second-read'; },
  });
  assert.equal(sdk.providerErrorCode(changingMessage), 'PILOT_SCHEMA_INVALID');
  assert.equal(reads, 1);
});

test('build emits only root runtime and package-owned public declarations', async () => {
  const files = (await readdir(new URL('../dist/', import.meta.url))).sort();
  assert.deepEqual(files, ['index.d.ts', 'index.js', 'types.d.ts']);
  const [runtime, indexTypes, publicTypes] = await Promise.all([
    readFile(new URL('../dist/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/index.d.ts', import.meta.url), 'utf8'),
    readFile(new URL('../dist/types.d.ts', import.meta.url), 'utf8'),
  ]);
  for (const content of [runtime, indexTypes, publicTypes]) {
    assert.doesNotMatch(content, /\.\.\/\.\.\/|packages\/(?:developer-pilot|claims-backend|x402-assurance|evm-acceptance)/);
  }
  assert.match(indexTypes, /from ['"]\.\/types\.js['"]/);
  assert.match(publicTypes, /from ['"]viem['"]/);
});

test('npm pack contains only the approved public root artifact', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'assurepay-provider-pack-cache-'));
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageDirectory,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
    });
    const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    assert.ok(pack);
    assert.deepEqual(pack.files.map(file => file.path).sort(), [
      'README.md', 'dist/index.d.ts', 'dist/index.js', 'dist/types.d.ts', 'package.json',
    ]);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
