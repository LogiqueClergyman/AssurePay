import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('package metadata keeps a private root-only API and exact bundled output', async () => {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.private, true);
  assert.equal(metadata.version, '0.1.0');
  assert.deepEqual(Object.keys(metadata.exports), ['.']);
  assert.deepEqual(await readdir(join(root, 'dist')).then(items => items.sort()), ['index.d.ts', 'index.js', 'types.d.ts']);
  assert.deepEqual(metadata.files, ['dist', 'README.md', 'skill/assurepay-client/SKILL.md']);
});

test('npm tarball contains exactly the six intended files', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'assurepay-client-sdk-npm-'));
  try {
    const executable = process.env.npm_execpath ? process.execPath : 'npm';
    const args = process.env.npm_execpath ? [process.env.npm_execpath, 'pack', '--dry-run', '--json'] : ['pack', '--dry-run', '--json'];
    const output = execFileSync(executable, args, {
      cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache },
    });
    const tarball = JSON.parse(output)[0];
    assert.deepEqual(tarball.files.map((file: { path: string }) => file.path).sort(), [
      'dist/index.d.ts', 'dist/index.js', 'dist/types.d.ts', 'package.json',
      'README.md', 'skill/assurepay-client/SKILL.md',
    ].sort());
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
