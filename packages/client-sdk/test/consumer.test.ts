import assert from 'node:assert/strict';
import test from 'node:test';
import { runClientConsumerGate } from './consumer-gate.js';

test('packed client SDK runs outside the repository with bounded authorization, signer-free recovery and payer claims', async () => {
  const result = await runClientConsumerGate();
  assert.equal(result.ok, true);
  assert.equal(result.code, 'LOCAL_CLIENT_SDK_VERIFIED');
  assert.equal(result.runtime, 'plain-node-outside-repository');
  assert.equal(result.previewAndAgentDenialSignatures, 0);
  assert.equal(result.concurrentAuthorizationSignatures, 1);
  assert.equal(result.firstPaymentResponseLost, true);
  assert.equal(result.clientProcessRestart, true);
  assert.equal(result.signerFreeRetrieval, true);
  assert.equal(result.sameOriginalTransactionAndReceipt, true);
  assert.equal(result.signed500Verified, true);
  assert.equal(result.payerEvidenceAndClaimIncluded, true);
  assert.equal(result.refundOnlyViaTestAdjudicator, true);
  assert.equal(result.otherCoverageLocksPreserved, true);
  assert.equal(result.capDeniedBeforeSignature, true);
  assert.equal(result.changedBudgetContextRejected, true);
  assert.equal(result.coverageCount, '3');
});
