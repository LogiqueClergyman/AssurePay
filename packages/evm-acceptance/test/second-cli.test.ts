import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Guard failures must happen before runtime configuration, journal access or RPC.
test('second continuation CLI rejects missing approval and malformed arguments before runtime loading', () => {
  const scope = 'm5-second-campaign-after-expired-first';
  for (const [args, expected] of [
    [['--continue', '--scope', scope], 'M5_SECOND_EXPLICIT_SCOPE_REQUIRED'],
    [['--continue'], 'M5_SECOND_ARGUMENTS_INVALID'],
    [['--continue', '--scope', 'wrong'], 'M5_SECOND_ARGUMENTS_INVALID'],
    [['--continue', '--scope', scope, '--execute'], 'M5_SECOND_ARGUMENTS_INVALID'],
  ] as const) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/second-attempt.ts', ...args], {
      cwd: new URL('../', import.meta.url), env: {}, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: expected });
  }
});
