import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { toHex, type Address, type Hex } from 'viem';
import { fixture, expectInvariant, STATUS } from '../../evm-core/test/helpers/fixture.js';
import { attemptRevert } from '../../evm-core/test/helpers/evm.js';
import { createProjection } from '../src/projection.js';
import { EncryptedVault } from '../src/vault.js';
import { contextNamespace } from '../src/common.js';
import { createClaimsBackend } from '../src/claims.js';
import { operationPayloadHash, operationTypedData, randomNonce } from '../src/auth.js';
import type { Authorization, BackendContext, Operation, PreparedAction } from '../src/types.js';

const id = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const decisionPayload = (value: { outcome: 0 | 1 | 2; refundAmount: string; reason: string }) => ({
  outcome: value.outcome, refundAmount: value.refundAmount, reason: value.reason,
});

async function signAuthorization(
  account: { address: Address; signTypedData(args: any): Promise<Hex> },
  context: BackendContext,
  operation: Operation,
  coverageId: Hex,
  payload: unknown,
  now: bigint,
  options: { nonce?: Hex; deadline?: string; signingContext?: BackendContext; signingOperation?: Operation } = {},
): Promise<Authorization> {
  const actor = account.address.toLowerCase() as Address;
  const auth = {
    actor,
    operation: options.signingOperation ?? operation,
    coverageId,
    payloadHash: operationPayloadHash(payload),
    nonce: options.nonce ?? randomNonce(),
    deadline: options.deadline ?? (now + 120n).toString(),
  };
  const signature = await account.signTypedData(operationTypedData(options.signingContext ?? context, auth) as any);
  return { ...auth, signature };
}

async function submitAction(f: Awaited<ReturnType<typeof fixture>>, prepared: PreparedAction) {
  const account = prepared.from.toLowerCase() === f.evm.payer.address.toLowerCase()
    ? f.evm.payer
    : prepared.from.toLowerCase() === f.evm.outsider.address.toLowerCase()
      ? f.evm.outsider
      : undefined;
  if (!account) throw new Error('TEST_UNEXPECTED_ACTION_ACTOR');
  const hash = await f.evm.walletClient.sendTransaction({
    account,
    to: prepared.to,
    data: prepared.data,
    value: 0n,
  });
  return f.evm.publicClient.waitForTransactionReceipt({ hash });
}

test('payer evidence auth, durable replay, claim prep and all M2 adjudication outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-claims-'));
  const f = await fixture();
  const coverageIds: Hex[] = [];
  try {
    const context: BackendContext = {
      chainId: 84532, core: f.core, token: f.token, adjudicator: f.evm.outsider.address.toLowerCase() as Address,
      serviceId: id(0xabc),
    };
    const projection = createProjection({ client: f.evm.publicClient, context, journalPath: join(directory, 'projection.json'), fromBlock: 0n });
    const vault = new EncryptedVault({
      directory: join(directory, 'objects'), namespace: contextNamespace(context), keyId: 'test-key-v1', key: randomBytes(32),
    });
    const replayPath = join(directory, 'replay.jsonl');
    let backend = await createClaimsBackend({ context, projection, vault, replayPath });

    const first = await f.createIntent();
    await f.settle(first);
    coverageIds.push(first.coverageId);
    const body = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const bodyHex = toHex(body);
    const uploadPayload = { bodyHex };
    const uploadAuth = await signAuthorization(f.evm.payer, context, 'uploadEvidence', first.coverageId,
      uploadPayload, BigInt((await projection.refresh()).head.timestamp));

    // The signed body is operation-bound. Altered bytes and a signature from another service fail.
    await assert.rejects(backend.uploadEvidence(first.coverageId, new Uint8Array([9]), uploadAuth), /AUTH_INVALID/);
    const otherContext = { ...context, serviceId: id(0xabd) };
    const wrongService = await signAuthorization(f.evm.payer, context, 'uploadEvidence', first.coverageId,
      uploadPayload, BigInt((await projection.refresh()).head.timestamp), { signingContext: otherContext });
    await assert.rejects(backend.uploadEvidence(first.coverageId, body, wrongService), /AUTH_INVALID/);
    const otherCore = { ...context, core: `0x${'11'.repeat(20)}` as Address };
    const wrongCore = await signAuthorization(f.evm.payer, context, 'uploadEvidence', first.coverageId,
      uploadPayload, BigInt((await projection.refresh()).head.timestamp), { signingContext: otherCore });
    await assert.rejects(backend.uploadEvidence(first.coverageId, body, wrongCore), /AUTH_INVALID/);
    const stale = await signAuthorization(f.evm.payer, context, 'uploadEvidence', first.coverageId,
      uploadPayload, BigInt((await projection.refresh()).head.timestamp), { deadline: '1' });
    await assert.rejects(backend.uploadEvidence(first.coverageId, body, stale), /AUTH_INVALID/);
    const tooFar = await signAuthorization(f.evm.payer, context, 'uploadEvidence', first.coverageId,
      uploadPayload, BigInt((await projection.refresh()).head.timestamp), {
        deadline: (BigInt((await projection.refresh()).head.timestamp) + 301n).toString(),
      });
    await assert.rejects(backend.uploadEvidence(first.coverageId, body, tooFar), /AUTH_INVALID/);
    const wrongOperation = await signAuthorization(f.evm.payer, context, 'uploadEvidence', first.coverageId,
      uploadPayload, BigInt((await projection.refresh()).head.timestamp), { signingOperation: 'readEvidence' });
    await assert.rejects(backend.uploadEvidence(first.coverageId, body, wrongOperation), /AUTH_INVALID/);
    const wrongActor = await signAuthorization(f.evm.outsider, context, 'uploadEvidence', first.coverageId,
      uploadPayload, BigInt((await projection.refresh()).head.timestamp));
    await assert.rejects(backend.uploadEvidence(first.coverageId, body, wrongActor), /AUTH_ROLE/);

    const evidenceHash = await backend.uploadEvidence(first.coverageId, body, uploadAuth);
    assert.match(evidenceHash, /^0x[0-9a-f]{64}$/);
    await assert.rejects(backend.uploadEvidence(first.coverageId, body, uploadAuth), /AUTH_REPLAY/);

    // Restart uses the same durable replay set and encrypted object vault.
    backend = await createClaimsBackend({ context, projection, vault, replayPath });
    await assert.rejects(backend.uploadEvidence(first.coverageId, body, uploadAuth), /AUTH_REPLAY/);
    let snapshot = await projection.refresh();
    const readPayload = { evidenceHash };
    const payerReadAuth = await signAuthorization(f.evm.payer, context, 'readEvidence', first.coverageId,
      readPayload, BigInt(snapshot.head.timestamp));
    assert.deepEqual(await backend.readEvidence(first.coverageId, evidenceHash, payerReadAuth), body);
    const mismatchedCoverage = await signAuthorization(f.evm.payer, context, 'readEvidence', id(0xdead),
      readPayload, BigInt(snapshot.head.timestamp));
    await assert.rejects(backend.readEvidence(first.coverageId, evidenceHash, mismatchedCoverage), /AUTH_INVALID/);

    const claimPayload = { evidenceHash };
    const claimAuth = await signAuthorization(f.evm.payer, context, 'prepareClaim', first.coverageId,
      claimPayload, BigInt(snapshot.head.timestamp));
    const claimAction = await backend.prepareClaim(first.coverageId, evidenceHash, claimAuth);
    assert.equal(claimAction.from, f.evm.payer.address.toLowerCase());
    assert.equal(claimAction.coverageId, first.coverageId);
    assert.equal(claimAction.value, '0');
    const claimReceipt = await submitAction(f, claimAction);
    assert.equal(claimReceipt.status, 'success');
    snapshot = await projection.refresh();
    assert.equal(snapshot.coverages[first.coverageId]!.status, STATUS.claimPending);

    // The configured adjudicator gains access only after canonical ClaimFiled.
    const adjudicatorReadAuth = await signAuthorization(f.evm.outsider, context, 'readEvidence', first.coverageId,
      readPayload, BigInt(snapshot.head.timestamp));
    assert.deepEqual(await backend.readEvidence(first.coverageId, evidenceHash, adjudicatorReadAuth), body);

    const cases = [
      { outcome: 0 as const, refundAmount: '0', reason: 'reject after review', expectedRefund: 0n },
      { outcome: 1 as const, refundAmount: '1000', reason: 'partial provider fault', expectedRefund: 1000n },
      { outcome: 1 as const, refundAmount: '10003', reason: 'full provider fault', expectedRefund: 10003n },
      { outcome: 2 as const, refundAmount: '2000', reason: 'allowed pool-only refund', expectedRefund: 2000n },
    ];
    // First coverage above is finalized as rejection; other cases each use an actual M2 coverage.
    const firstDecision = cases[0]!;
    let before = await f.balance(f.evm.payer.address);
    const firstDecisionAuth = await signAuthorization(f.evm.outsider, context, 'prepareDecision', first.coverageId,
      decisionPayload(firstDecision), BigInt(snapshot.head.timestamp));
    const firstPrepared = await backend.prepareDecision(first.coverageId, decisionPayload(firstDecision), firstDecisionAuth);
    assert.equal(firstPrepared.action.from, context.adjudicator);
    assert.equal((await submitAction(f, firstPrepared.action)).status, 'success');
    assert.equal(await f.balance(f.evm.payer.address), before);
    assert.equal((await projection.refresh()).coverages[first.coverageId]!.status, STATUS.rejected);

    for (const decision of cases.slice(1)) {
      const input = await f.createIntent();
      await f.settle(input);
      coverageIds.push(input.coverageId);
      const payload = { bodyHex: toHex(body) };
      let current = await projection.refresh();
      const payerUpload = await signAuthorization(f.evm.payer, context, 'uploadEvidence', input.coverageId,
        payload, BigInt(current.head.timestamp));
      const hash = await backend.uploadEvidence(input.coverageId, body, payerUpload);
      current = await projection.refresh();
      const payerClaim = await signAuthorization(f.evm.payer, context, 'prepareClaim', input.coverageId,
        { evidenceHash: hash }, BigInt(current.head.timestamp));
      const preparedClaim = await backend.prepareClaim(input.coverageId, hash, payerClaim);
      assert.equal((await submitAction(f, preparedClaim)).status, 'success');
      current = await projection.refresh();
      const adjudicatorAuth = await signAuthorization(f.evm.outsider, context, 'prepareDecision', input.coverageId,
        decisionPayload(decision), BigInt(current.head.timestamp));
      const preparedDecision = await backend.prepareDecision(input.coverageId, decisionPayload(decision), adjudicatorAuth);
      before = await f.balance(f.evm.payer.address);
      assert.equal((await submitAction(f, preparedDecision.action)).status, 'success');
      assert.equal(await f.balance(f.evm.payer.address), before + decision.expectedRefund);
      await projection.refresh();
      await expectInvariant(f, [f.providerId, f.secondProviderId], coverageIds);
    }

    // A disallowed PoolOnly result fails in the backend and M2 still independently rejects it.
    const disallowed = await f.createIntent({ policy: f.nonPoolPolicy });
    await f.settle(disallowed);
    coverageIds.push(disallowed.coverageId);
    let current = await projection.refresh();
    const disallowedUploadPayload = { bodyHex: toHex(body) };
    const disallowedUploadAuth = await signAuthorization(f.evm.payer, context, 'uploadEvidence', disallowed.coverageId,
      disallowedUploadPayload, BigInt(current.head.timestamp));
    const disallowedHash = await backend.uploadEvidence(disallowed.coverageId, body, disallowedUploadAuth);
    current = await projection.refresh();
    const disallowedClaimAuth = await signAuthorization(f.evm.payer, context, 'prepareClaim', disallowed.coverageId,
      { evidenceHash: disallowedHash }, BigInt(current.head.timestamp));
    await submitAction(f, await backend.prepareClaim(disallowed.coverageId, disallowedHash, disallowedClaimAuth));
    current = await projection.refresh();
    const poolDecision = { outcome: 2 as const, refundAmount: '1', reason: 'not permitted by stored policy' };
    const forbiddenAuth = await signAuthorization(f.evm.outsider, context, 'prepareDecision', disallowed.coverageId,
      poolDecision, BigInt(current.head.timestamp));
    await assert.rejects(backend.prepareDecision(disallowed.coverageId, decisionPayload(poolDecision), forbiddenAuth), /DECISION_AMOUNT/);
    const beforeInvalid = await f.balance(f.evm.payer.address);
    await attemptRevert(f.evm, f.coreAbi, f.core, 'finalizeClaim', [disallowed.coverageId, 2, 1n, id(0xeeee)], f.evm.outsider);
    assert.equal(await f.balance(f.evm.payer.address), beforeInvalid);
    assert.equal((await f.coverage(disallowed.coverageId)).status, STATUS.claimPending);
    await expectInvariant(f, [f.providerId, f.secondProviderId], coverageIds);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('claim roles, invalid decisions, active expiry and pending-after-expiry adjudication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-claims-expiry-'));
  const f = await fixture();
  const coverageIds: Hex[] = [];
  try {
    const context: BackendContext = {
      chainId: 84532, core: f.core, token: f.token, adjudicator: f.evm.outsider.address.toLowerCase() as Address,
      serviceId: id(0xbeef),
    };
    const projection = createProjection({ client: f.evm.publicClient, context, journalPath: join(directory, 'projection.json'), fromBlock: 0n });
    const vault = new EncryptedVault({
      directory: join(directory, 'objects'), namespace: contextNamespace(context), keyId: 'test-key-v1', key: randomBytes(32),
    });
    const backend = await createClaimsBackend({ context, projection, vault, replayPath: join(directory, 'replay.jsonl') });
    const body = new Uint8Array([0x43, 0x4c, 0x41, 0x49, 0x4d]);

    // Wrong payer cannot prepare through the backend or file an on-chain claim.
    const pendingInput = await f.createIntent();
    await f.settle(pendingInput);
    coverageIds.push(pendingInput.coverageId);
    let snapshot = await projection.refresh();
    const uploadPayload = { bodyHex: toHex(body) };
    const uploadAuth = await signAuthorization(f.evm.payer, context, 'uploadEvidence', pendingInput.coverageId,
      uploadPayload, BigInt(snapshot.head.timestamp));
    const evidenceHash = await backend.uploadEvidence(pendingInput.coverageId, body, uploadAuth);
    snapshot = await projection.refresh();
    const claimPayload = { evidenceHash };
    const wrongPayerAuth = await signAuthorization(f.evm.provider, context, 'prepareClaim', pendingInput.coverageId,
      claimPayload, BigInt(snapshot.head.timestamp));
    await assert.rejects(backend.prepareClaim(pendingInput.coverageId, evidenceHash, wrongPayerAuth), /AUTH_ROLE/);
    const beforeWrongPayer = await f.balance(f.evm.payer.address);
    await attemptRevert(f.evm, f.coreAbi, f.core, 'fileClaim', [pendingInput.coverageId, evidenceHash], f.evm.provider);
    assert.equal(await f.balance(f.evm.payer.address), beforeWrongPayer);
    assert.equal((await f.coverage(pendingInput.coverageId)).status, STATUS.active);
    assert.equal((await f.coverage(pendingInput.coverageId)).evidenceHash, `0x${'00'.repeat(32)}`);

    // The actual payer files the claim; a non-adjudicator cannot prepare or finalize it.
    snapshot = await projection.refresh();
    const payerClaimAuth = await signAuthorization(f.evm.payer, context, 'prepareClaim', pendingInput.coverageId,
      claimPayload, BigInt(snapshot.head.timestamp));
    const payerAction = await backend.prepareClaim(pendingInput.coverageId, evidenceHash, payerClaimAuth);
    assert.equal((await submitAction(f, payerAction)).status, 'success');
    snapshot = await projection.refresh();
    const reject = { outcome: 0 as const, refundAmount: '0', reason: 'explicit reject after review' };
    const wrongAdjudicatorAuth = await signAuthorization(f.evm.provider, context, 'prepareDecision', pendingInput.coverageId,
      reject, BigInt(snapshot.head.timestamp));
    await assert.rejects(backend.prepareDecision(pendingInput.coverageId, reject, wrongAdjudicatorAuth), /AUTH_ROLE/);
    const beforeWrongAdjudicator = await f.balance(f.evm.payer.address);
    await attemptRevert(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [pendingInput.coverageId, 0, 0n, id(0xbad)], f.evm.provider);
    assert.equal(await f.balance(f.evm.payer.address), beforeWrongAdjudicator);
    assert.equal((await f.coverage(pendingInput.coverageId)).status, STATUS.claimPending);

    // Invalid decision values and amounts fail before a valid adjudication can consume collateral.
    const invalidDecisions = [
      { value: { outcome: 0, refundAmount: '1', reason: 'reject must be zero' }, code: /DECISION_AMOUNT/ },
      { value: { outcome: 1, refundAmount: '0', reason: 'refund must be positive' }, code: /DECISION_AMOUNT/ },
      { value: { outcome: 1, refundAmount: '10004', reason: 'refund exceeds gross' }, code: /DECISION_AMOUNT/ },
      { value: { outcome: 9, refundAmount: '1', reason: 'unknown outcome' }, code: /DECISION_INVALID/ },
    ];
    const payerBeforeInvalid = await f.balance(f.evm.payer.address);
    const coreBeforeInvalid = await f.balance(f.core);
    for (const item of invalidDecisions) {
      snapshot = await projection.refresh();
      const auth = await signAuthorization(f.evm.outsider, context, 'prepareDecision', pendingInput.coverageId,
        item.value, BigInt(snapshot.head.timestamp));
      await assert.rejects(backend.prepareDecision(pendingInput.coverageId, item.value as any, auth), item.code);
    }
    assert.equal(await f.balance(f.evm.payer.address), payerBeforeInvalid);
    assert.equal(await f.balance(f.core), coreBeforeInvalid);
    assert.equal((await f.coverage(pendingInput.coverageId)).status, STATUS.claimPending);
    assert.equal((await f.coverage(pendingInput.coverageId)).decisionHash, `0x${'00'.repeat(32)}`);
    await expectInvariant(f, [f.providerId, f.secondProviderId], coverageIds);

    // Pending claims remain live beyond coverage expiry and can still be decided explicitly.
    const pendingCoverage = await f.coverage(pendingInput.coverageId);
    await (f.evm.publicClient.request as any)({ method: 'evm_setNextBlockTimestamp', params: [Number(pendingCoverage.expiresAt)] });
    await (f.evm.publicClient.request as any)({ method: 'evm_mine', params: [] });
    snapshot = await projection.refresh();
    assert.ok(BigInt(snapshot.head.timestamp) >= pendingCoverage.expiresAt);
    assert.equal(snapshot.coverages[pendingInput.coverageId]!.status, STATUS.claimPending);
    await expectInvariant(f, [f.providerId, f.secondProviderId], coverageIds);
    const expiredValidDecision = { outcome: 1 as const, refundAmount: '500', reason: 'explicit partial provider fault after expiry' };
    const expiredDecisionAuth = await signAuthorization(f.evm.outsider, context, 'prepareDecision', pendingInput.coverageId,
      expiredValidDecision, BigInt(snapshot.head.timestamp));
    const expiredDecision = await backend.prepareDecision(pendingInput.coverageId, expiredValidDecision, expiredDecisionAuth);
    const beforeExpiredDecision = await f.balance(f.evm.payer.address);
    assert.equal((await submitAction(f, expiredDecision.action)).status, 'success');
    assert.equal(await f.balance(f.evm.payer.address), beforeExpiredDecision + 500n);
    assert.equal((await projection.refresh()).coverages[pendingInput.coverageId]!.status, STATUS.refunded);
    await expectInvariant(f, [f.providerId, f.secondProviderId], coverageIds);

    // An unclaimed Active coverage cannot upload or prepare after expiry; the Core also rejects filing.
    const lateInput = await f.createIntent();
    await f.settle(lateInput);
    coverageIds.push(lateInput.coverageId);
    snapshot = await projection.refresh();
    const lateUploadAuth = await signAuthorization(f.evm.payer, context, 'uploadEvidence', lateInput.coverageId,
      uploadPayload, BigInt(snapshot.head.timestamp));
    const lateEvidenceHash = await backend.uploadEvidence(lateInput.coverageId, body, lateUploadAuth);
    const lateCoverage = await f.coverage(lateInput.coverageId);
    await (f.evm.publicClient.request as any)({ method: 'evm_setNextBlockTimestamp', params: [Number(lateCoverage.expiresAt)] });
    await (f.evm.publicClient.request as any)({ method: 'evm_mine', params: [] });
    snapshot = await projection.refresh();
    assert.equal(snapshot.coverages[lateInput.coverageId]!.status, STATUS.active);
    const lateUploadAuth2 = await signAuthorization(f.evm.payer, context, 'uploadEvidence', lateInput.coverageId,
      uploadPayload, BigInt(snapshot.head.timestamp));
    await assert.rejects(backend.uploadEvidence(lateInput.coverageId, body, lateUploadAuth2), /CLAIM_STATE/);
    const lateClaimAuth = await signAuthorization(f.evm.payer, context, 'prepareClaim', lateInput.coverageId,
      { evidenceHash: lateEvidenceHash }, BigInt(snapshot.head.timestamp));
    await assert.rejects(backend.prepareClaim(lateInput.coverageId, lateEvidenceHash, lateClaimAuth), /CLAIM_STATE/);
    const lateBefore = await f.coverage(lateInput.coverageId);
    const payerBalanceBefore = await f.balance(f.evm.payer.address);
    await attemptRevert(f.evm, f.coreAbi, f.core, 'fileClaim', [lateInput.coverageId, lateEvidenceHash], f.evm.payer);
    const lateAfter = await f.coverage(lateInput.coverageId);
    assert.equal(lateAfter.status, STATUS.active);
    assert.equal(lateAfter.evidenceHash, `0x${'00'.repeat(32)}`);
    assert.equal(lateAfter.gross, lateBefore.gross);
    assert.equal(await f.balance(f.evm.payer.address), payerBalanceBefore);
    await expectInvariant(f, [f.providerId, f.secondProviderId], coverageIds);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
