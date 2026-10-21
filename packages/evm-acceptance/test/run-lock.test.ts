import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunLock } from '../src/run-lock.js';

async function temp() { return mkdtemp(join(tmpdir(), 'assurepay-m5-run-lock-')); }

test('only one concurrent opener acquires the run lock, then release permits reacquisition', async () => {
  const directory = await temp();
  const path = join(directory, 'run.lock');
  try {
    const attempts = await Promise.allSettled([acquireRunLock(path), acquireRunLock(path)]);
    const acquired = attempts.filter((attempt): attempt is PromiseFulfilledResult<() => Promise<void>> => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    assert.equal(acquired.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await acquired[0]!.value();
    await assert.rejects(lstat(path), { code: 'ENOENT' });
    const releaseAgain = await acquireRunLock(path);
    await releaseAgain();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed on stale lock files and symlink lock paths without replacing them', async () => {
  const directory = await temp();
  const stalePath = join(directory, 'stale.lock');
  const targetPath = join(directory, 'target');
  const aliasPath = join(directory, 'alias.lock');
  try {
    await writeFile(stalePath, 'stale marker', { mode: 0o600, flag: 'wx' });
    await writeFile(targetPath, 'target remains', { mode: 0o600, flag: 'wx' });
    await symlink(targetPath, aliasPath);

    await assert.rejects(acquireRunLock(stalePath), /M5_RUN_LOCK_UNAVAILABLE/);
    await assert.rejects(acquireRunLock(aliasPath), /M5_RUN_LOCK_UNAVAILABLE/);
    assert.equal(await readFile(stalePath, 'utf8'), 'stale marker');
    assert.equal(await readFile(targetPath, 'utf8'), 'target remains');
    assert.equal((await lstat(aliasPath)).isSymbolicLink(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
