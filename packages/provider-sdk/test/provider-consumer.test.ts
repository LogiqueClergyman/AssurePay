import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProviderConsumerGate } from './consumer-gate.js';

test('packed provider SDK runs outside the workspace and recovers the same paid example result without a relayer', async () => {
  const report = await runProviderConsumerGate();
  assert.equal(report.ok, true);
  assert.equal(report.code, 'LOCAL_PROVIDER_SDK_VERIFIED');
  assert.equal(report.runtime, 'plain-node-outside-repository');
  assert.equal(report.profilePayerSignatures, 1);
  assert.equal(report.retrievalPayerSignatures, 0);
  assert.equal(report.relayerBroadcastsIncludingControlledFailure, 2);
  assert.equal(report.originalRelayerNonceUnchangedOnRetrieve, true);
  assert.equal(report.providerProcessRestart, true);
  assert.equal(report.buyerProcessRestart, false);
  assert.equal(report.sameOriginalReceiptAfterRestart, true);
  assert.equal(report.retrievalOnlyNewRequestRefused, true);
  assert.equal(report.alteredBodyRefused, true);
  assert.equal(report.missingAndCorruptArchiveRefused, true);
  assert.equal(report.missingPaymentJournalRefused, true);
  assert.equal(report.rpcFailureFailsClosed, true);
  assert.equal(report.signed500Verified, true);
});
