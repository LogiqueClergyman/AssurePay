import assert from 'node:assert/strict';
import test from 'node:test';
import { runTransportRehearsal } from '../src/transport-rehearsal.js';

test('local HTTPS actual-EVM purchase and signer-free buyer process restart retrieval retain exact identity and financial invariants', async () => {
  const report = await runTransportRehearsal();
  assert.equal(report.code, 'LOCAL_HTTPS_TRANSPORT_VERIFIED');
  assert.equal(report.buyerProcessRestart, true);
  assert.equal(report.retrievalCountsUnchanged, true);
  assert.equal(report.negativeRetrievalsDidNotSettle, true);
  assert.equal(report.retrievalPayerSignatures, 0);
  assert.equal(report.solvencyEquality, true);
  assert.equal(report.state.coverageCount, '1');
  assert.equal(report.limits.localOnly, true);
});
