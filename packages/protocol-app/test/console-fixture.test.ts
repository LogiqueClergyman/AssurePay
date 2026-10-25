import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConsoleArgs, createConsoleFixture } from './console-fixture.js';
import { main } from '../scripts/console-demo.js';

test('console host CLI rejects non-exact roles and flags before fixture setup', async () => {
  assert.equal(parseConsoleArgs([]), 'operator');
  assert.equal(parseConsoleArgs(['--role', 'adjudicator']), 'adjudicator');
  for (const args of [['--bad'], ['--role'], ['--role', 'wallet'], ['--role', 'admin', 'extra'], ['--role=admin']])
    assert.throws(() => parseConsoleArgs(args), { message: 'CONSOLE_ARGUMENT_INVALID' });
  await assert.rejects(main(['--role', 'wallet']), { message: 'CONSOLE_ARGUMENT_INVALID' });
});

test('fresh console fixture seeds an active purchase and a real filed 500 claim, with role-only API restarts', async () => {
  const fixture = await createConsoleFixture({ startServer: false });
  try {
    const before = await fixture.snapshot();
    assert.equal(before.anchor.number, String(BigInt(before.anchor.number)));
    const active = before.coverages.find(row => row.coverageId === fixture.ids.active);
    const claim = before.coverages.find(row => row.coverageId === fixture.ids.claim);
    assert.equal(active?.status, 1);
    assert.equal(claim?.status, 2);
    assert.equal(claim?.hasEvidence, true);
    assert.equal(before.summary.coverageCount, '2');
    assert.equal(before.summary.activeCoverageCount, '2');
    assert.ok(Object.values(before.summary.solvency).every(Boolean));
    assert.equal(fixture.counters().payerAuthorizations, 2);
    assert.equal(fixture.counters().claimsFiled, 1);
    const payerBalance = await fixture.payerBalance(BigInt(before.anchor.number));
    assert.ok(payerBalance >= 0n);

    const sameRuntime = fixture.runtime;
    const firstUrl = await fixture.startRole('operator');
    assert.match(firstUrl, /^http:\/\/127\.0\.0\.1:/);
    const secondUrl = await fixture.startRole('adjudicator');
    assert.equal(secondUrl, firstUrl);
    assert.equal(fixture.runtime, sameRuntime);
    const after = await fixture.snapshot();
    assert.equal(after.summary.coverageCount, before.summary.coverageCount);
    assert.deepEqual(fixture.ids, { active: active!.coverageId, claim: claim!.coverageId });
  } finally { await fixture.close(); }
});

test('lost protocol send is forwarded once, hidden until reveal, and reconciled without new signer or broadcast', async () => {
  const fixture = await createConsoleFixture({ startServer: false });
  try {
    const preview = await fixture.runtime.preview('admin', { kind: 'setPaused', paused: true });
    const before = fixture.counters();
    fixture.loseNextSend();
    const original = await fixture.runtime.confirm('admin', preview.previewId, { approved: true });
    assert.equal(original.status, 'unknown');
    assert.ok(original.transaction);
    assert.deepEqual(fixture.faultState, { hidden: true, armed: false });
    const afterSend = fixture.counters();
    assert.equal(afterSend.broadcasts, before.broadcasts + 1);
    assert.equal(afterSend.adminTransactions, before.adminTransactions + 1);

    const whileHidden = await fixture.runtime.reconcile('operator');
    assert.ok(whileHidden.some(row => row.transaction === original.transaction && row.status === 'unknown'));
    assert.deepEqual(fixture.counters(), afterSend);
    fixture.reveal();
    const recovered = await fixture.runtime.reconcile('operator');
    assert.ok(recovered.some(row => row.transaction === original.transaction && row.status === 'success'));
    assert.deepEqual(fixture.counters(), afterSend);
    assert.equal((await fixture.snapshot()).summary.paused, true);
  } finally { await fixture.close(); }
});
