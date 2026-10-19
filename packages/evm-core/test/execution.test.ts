import assert from 'node:assert/strict';
import test from 'node:test';
import { pad, toHex } from 'viem';
import { attemptRevert, transact } from './helpers/evm.js';
import { expectInvariant, fixture, OUTCOME, STATUS, type Fixture } from './helpers/fixture.js';
import { hashIntent, hashPolicy } from './helpers/intent.js';

async function close(f: Fixture) { await f.close(); }
const bytes32 = (value: number) => pad(toHex(value), { size: 32 });

test('real Anvil ERC-3009 settlement matches policy/intent hashes, quote splits, and concurrent ledgers', async () => {
  const f = await fixture({ secondProviderStake: 50_000n });
  try {
    const registered = await f.read(f.core, f.coreAbi, 'policies', [f.policy.policyId]) as readonly unknown[];
    assert.equal(registered[1], hashPolicy(f.policy));

    const first = await f.createIntent({ gross: 10_003n });
    assert.equal(await f.read(f.core, f.coreAbi, 'hashIntent', [first.typed]), hashIntent(first.intent));
    const quote1 = await f.quote(f.policy, 10_003n);
    const independentlyCalculatedPremium = (10_003n * 777n / 10_000n) || 1n;
    const independentlyCalculatedWithheld = (10_003n - independentlyCalculatedPremium) * 2_200n / 10_000n;
    const independentlyCalculatedLock = (10_003n * 3_500n + 9_999n) / 10_000n;
    assert.deepEqual(quote1, {
      premium: independentlyCalculatedPremium,
      withheld: independentlyCalculatedWithheld,
      net: 10_003n - independentlyCalculatedPremium - independentlyCalculatedWithheld,
      stakeLock: independentlyCalculatedLock,
      poolReservation: 10_003n,
    });

    const payerBefore = await f.balance(first.payer.address);
    const coreBefore = await f.balance(f.core);
    const payoutBefore = await f.balance(f.policy.providerPayout);
    await f.settle(first);
    assert.equal(await f.authorizationUsed(first.payer.address, first.coverageId), true);
    assert.equal(await f.balance(first.payer.address), payerBefore - 10_003n);
    assert.equal(await f.balance(f.core), coreBefore + quote1.premium + quote1.withheld);
    assert.equal(await f.balance(f.policy.providerPayout), payoutBefore + quote1.net);
    assert.deepEqual(await f.coverage(first.coverageId), {
      payer: first.payer.address, providerId: f.providerId, policyId: f.policy.policyId,
      policyHash: hashPolicy(f.policy), requestHash: first.intent.requestHash,
      gross: 10_003n, premium: quote1.premium, withheld: quote1.withheld,
      stakeLock: quote1.stakeLock, poolReservation: quote1.poolReservation,
      openedAt: (await f.coverage(first.coverageId)).openedAt,
      expiresAt: (await f.coverage(first.coverageId)).expiresAt,
      poolOnlyAllowed: true, status: STATUS.active, evidenceHash: `0x${'00'.repeat(32)}`,
      decisionHash: `0x${'00'.repeat(32)}`, refundAmount: 0n, outcome: 0,
    });

    // Keep two independent provider coverages live together and verify all aggregates.
    const second = await f.createIntent({ policy: f.secondPolicy, gross: 20_009n });
    const quote2 = await f.quote(f.secondPolicy, 20_009n);
    await f.settle(second);
    assert.equal(await f.authorizationUsed(second.payer.address, second.coverageId), true);
    assert.equal((await f.coverage(second.coverageId)).status, STATUS.active);
    const g = await expectInvariant(f, [f.providerId, f.secondProviderId], [first.coverageId, second.coverageId]);
    assert.equal(g.coverageCount, 2n);
    assert.equal(g.activeCoverageCount, 2n);
    assert.equal(g.totalPoolReserved, quote1.poolReservation + quote2.poolReservation);
  } finally { await close(f); }
});

test('included admission reverts preserve ERC-3009 authorization, tokens, coverage, and all ledgers', async () => {
  for (const scenario of ['stake', 'pool', 'token-false', 'fee'] as const) {
    const f = await fixture({
      pool: scenario === 'pool' ? 0n : 1_000_000n,
      providerStake: scenario === 'stake' ? 0n : 1_000_000n,
    });
    try {
      const input = await f.createIntent({ gross: 10_003n });
      if (scenario === 'token-false') await transact(f.evm, f.tokenAbi, f.token, 'setFailTransfers', [true]);
      if (scenario === 'fee') await transact(f.evm, f.tokenAbi, f.token, 'setTransferFee', [1n]);
      const before = {
        payer: await f.balance(input.payer.address), core: await f.balance(f.core),
        payout: await f.balance(f.policy.providerPayout), globals: await f.globals(),
        provider: await f.provider(),
      };
      const receipt = await attemptRevert(f.evm, f.coreAbi, f.core, 'settleAssured', [input.typed,
        input.signature.v, input.signature.r, input.signature.s]);
      assert.equal(receipt.status, 'reverted');
      assert.equal(await f.authorizationUsed(input.payer.address, input.coverageId), false, `${scenario}: authorization rolled back`);
      assert.equal(await f.balance(input.payer.address), before.payer);
      assert.equal(await f.balance(f.core), before.core);
      assert.equal(await f.balance(f.policy.providerPayout), before.payout);
      assert.deepEqual(await f.globals(), before.globals);
      assert.deepEqual(await f.provider(), before.provider);
      assert.equal((await f.coverage(input.coverageId)).status, STATUS.none);
      if (scenario === 'stake') assert.equal(before.provider.free, 0n);
      if (scenario === 'pool') assert.equal(before.globals.poolAssets, 0n);
    } finally { await close(f); }
  }
});

test('provider-fault waterfall, pool-only refund, rejection, and invalid resolver decisions use stored payer and one-time transitions', async () => {
  const f = await fixture();
  const opened: Array<Awaited<ReturnType<typeof f.createIntent>>> = [];
  try {
    for (let i = 0; i < 4; i++) {
      const input = await f.createIntent({ gross: BigInt(10_003 + i) });
      await f.settle(input);
      opened.push(input);
      await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [input.coverageId, bytes32(50 + i)], input.payer);
    }
    const [partial, full, pool, rejected] = opened;
    assert.ok(partial && full && pool && rejected);

    await attemptRevert(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [partial.coverageId, OUTCOME.providerFault, 0n, bytes32(99)], f.evm.provider);
    await attemptRevert(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [partial.coverageId, OUTCOME.reject, 1n, bytes32(99)], f.evm.outsider);

    const cPartial = await f.coverage(partial.coverageId);
    const pBeforePartial = await f.provider();
    const balanceBeforePartial = await f.balance(partial.payer.address);
    const partialRefund = cPartial.stakeLock > 1n ? cPartial.stakeLock / 2n : 1n;
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [partial.coverageId, OUTCOME.providerFault, partialRefund, bytes32(101)], f.evm.outsider);
    const pAfterPartial = await f.provider();
    assert.equal(await f.balance(partial.payer.address), balanceBeforePartial + partialRefund);
    assert.equal(pAfterPartial.locked, pBeforePartial.locked - cPartial.stakeLock);
    assert.equal(pAfterPartial.free, pBeforePartial.free + cPartial.stakeLock - partialRefund);
    assert.equal((await f.coverage(partial.coverageId)).status, STATUS.refunded);

    const cFull = await f.coverage(full.coverageId);
    const pBeforeFull = await f.provider();
    const gBeforeFull = await f.globals();
    const fullPayerBefore = await f.balance(full.payer.address);
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [full.coverageId, OUTCOME.providerFault, cFull.gross, bytes32(102)], f.evm.outsider);
    const pAfterFull = await f.provider();
    const gAfterFull = await f.globals();
    const freeConsumed = cFull.gross > cFull.stakeLock ?
      (cFull.gross - cFull.stakeLock < pBeforeFull.free ? cFull.gross - cFull.stakeLock : pBeforeFull.free) : 0n;
    const poolConsumed = cFull.gross - cFull.stakeLock - freeConsumed;
    assert.equal(await f.balance(full.payer.address), fullPayerBefore + cFull.gross);
    assert.equal(pAfterFull.free, pBeforeFull.free - freeConsumed + cFull.stakeLock - cFull.stakeLock);
    assert.equal(pAfterFull.locked, pBeforeFull.locked - cFull.stakeLock);
    assert.equal(gAfterFull.totalProviderStake, gBeforeFull.totalProviderStake - cFull.stakeLock - freeConsumed);
    assert.equal(gAfterFull.poolAssets, gBeforeFull.poolAssets - poolConsumed);

    const cPool = await f.coverage(pool.coverageId);
    const pBeforePool = await f.provider();
    const gBeforePool = await f.globals();
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [pool.coverageId, OUTCOME.poolOnly, cPool.gross, bytes32(103)], f.evm.outsider);
    const pAfterPool = await f.provider();
    const gAfterPool = await f.globals();
    assert.equal(pAfterPool.free, pBeforePool.free + cPool.stakeLock);
    assert.equal(pAfterPool.locked, pBeforePool.locked - cPool.stakeLock);
    assert.equal(gAfterPool.totalProviderStake, gBeforePool.totalProviderStake);
    assert.equal(gAfterPool.poolAssets, gBeforePool.poolAssets - cPool.gross);

    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [rejected.coverageId, OUTCOME.reject, 0n, bytes32(104)], f.evm.outsider);
    assert.equal((await f.coverage(rejected.coverageId)).status, STATUS.rejected);

    const snapshot = { g: await f.globals(), p: await f.provider(), payer: await f.balance(rejected.payer.address) };
    await attemptRevert(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [rejected.coverageId, OUTCOME.reject, 0n, bytes32(105)], f.evm.outsider);
    assert.deepEqual(await f.globals(), snapshot.g);
    assert.deepEqual(await f.provider(), snapshot.p);
    assert.equal(await f.balance(rejected.payer.address), snapshot.payer);
    await expectInvariant(f, [f.providerId, f.secondProviderId], opened.map(x => x.coverageId));
  } finally { await close(f); }
});

test('pool-only policy restriction, exact expiry boundary, pending claims, pause, and open obligations', async () => {
  const f = await fixture();
  try {
    const disallowed = await f.createIntent({ policy: f.nonPoolPolicy, gross: 10_003n });
    await f.settle(disallowed);
    await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [disallowed.coverageId, bytes32(201)], disallowed.payer);
    const disallowedSnapshot = { g: await f.globals(), p: await f.provider(), payer: await f.balance(disallowed.payer.address) };
    await attemptRevert(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [disallowed.coverageId, OUTCOME.poolOnly, 1n, bytes32(202)], f.evm.outsider);
    assert.deepEqual(await f.globals(), disallowedSnapshot.g);
    assert.deepEqual(await f.provider(), disallowedSnapshot.p);
    assert.equal(await f.balance(disallowed.payer.address), disallowedSnapshot.payer);

    // Pausing blocks new admissions and registrations while claims and obligations remain serviceable.
    const activeWhilePaused = await f.createIntent({ gross: 10_004n });
    await f.settle(activeWhilePaused);
    await transact(f.evm, f.coreAbi, f.core, 'setPaused', [true]);
    const pausedInput = await f.createIntent({ gross: 10_005n });
    const pausedSnapshot = await f.globals();
    await attemptRevert(f.evm, f.coreAbi, f.core, 'settleAssured', [pausedInput.typed,
      pausedInput.signature.v, pausedInput.signature.r, pausedInput.signature.s]);
    assert.equal(await f.authorizationUsed(pausedInput.payer.address, pausedInput.coverageId), false);
    assert.deepEqual(await f.globals(), pausedSnapshot);
    await attemptRevert(f.evm, f.coreAbi, f.core, 'registerProvider', [bytes32(55), f.evm.payer.address, f.evm.owner.address]);
    await transact(f.evm, f.tokenAbi, f.token, 'mint', [f.evm.owner.address, 7n]);
    await transact(f.evm, f.tokenAbi, f.token, 'approve', [f.core, 7n]);
    await transact(f.evm, f.coreAbi, f.core, 'fundPool', [7n]);
    const pausedProviderBefore = await f.provider();
    const pausedOwnerBalance = await f.balance(f.evm.provider.address);
    const pausedCoreBalance = await f.balance(f.core);
    await transact(f.evm, f.coreAbi, f.core, 'withdrawStake', [f.providerId, 1n], f.evm.provider);
    assert.equal((await f.provider()).free, pausedProviderBefore.free - 1n);
    assert.equal(await f.balance(f.evm.provider.address), pausedOwnerBalance + 1n);
    assert.equal(await f.balance(f.core), pausedCoreBalance - 1n);
    await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [activeWhilePaused.coverageId, bytes32(203)], activeWhilePaused.payer);
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [activeWhilePaused.coverageId, OUTCOME.reject, 0n, bytes32(208)], f.evm.outsider);
    // Existing pending claim can still be finalized during pause.
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [disallowed.coverageId, OUTCOME.reject, 0n, bytes32(204)], f.evm.outsider);
    await transact(f.evm, f.coreAbi, f.core, 'setPaused', [false]);
    const timely = await f.createIntent({ gross: 10_007n });
    await f.settle(timely);
    const c = await f.coverage(timely.coverageId);
    await (f.evm.publicClient.request as any)({ method: 'evm_setNextBlockTimestamp', params: [Number(c.expiresAt - 1n)] });
    await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [timely.coverageId, bytes32(205)], timely.payer);
    await (f.evm.publicClient.request as any)({ method: 'evm_setNextBlockTimestamp', params: [Number(c.expiresAt)] });
    await attemptRevert(f.evm, f.coreAbi, f.core, 'closeExpired', [timely.coverageId], f.evm.owner);
    await attemptRevert(f.evm, f.coreAbi, f.core, 'fileClaim', [timely.coverageId, bytes32(206)], timely.payer);
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [timely.coverageId, OUTCOME.reject, 0n, bytes32(207)], f.evm.outsider);

    const expiring = await f.createIntent({ gross: 10_009n });
    await f.settle(expiring);
    const exp = await f.coverage(expiring.coverageId);
    await transact(f.evm, f.coreAbi, f.core, 'setPaused', [true]);
    await (f.evm.publicClient.request as any)({ method: 'evm_setNextBlockTimestamp', params: [Number(exp.expiresAt)] });
    const expirySnapshot = { g: await f.globals(), p: await f.provider() };
    await transact(f.evm, f.coreAbi, f.core, 'closeExpired', [expiring.coverageId], f.evm.outsider);
    assert.equal((await f.coverage(expiring.coverageId)).status, STATUS.expired);
    const gAfter = await f.globals();
    const pAfter = await f.provider();
    assert.equal(gAfter.totalPoolReserved, expirySnapshot.g.totalPoolReserved - exp.poolReservation);
    assert.equal(gAfter.totalLockedStake, expirySnapshot.g.totalLockedStake - exp.stakeLock);
    assert.equal(pAfter.free, expirySnapshot.p.free + exp.stakeLock);
    assert.equal(pAfter.locked, expirySnapshot.p.locked - exp.stakeLock);
    await transact(f.evm, f.coreAbi, f.core, 'setPaused', [false]);
    await expectInvariant(f, [f.providerId, f.secondProviderId], [disallowed.coverageId, activeWhilePaused.coverageId,
      timely.coverageId, expiring.coverageId]);
  } finally { await close(f); }
});

test('maximum provider-fault refund consumes only its own lock, its provider free stake, then the pool', async () => {
  const f = await fixture({ pool: 200_000n, providerStake: 10_000n, secondProviderStake: 20_000n });
  try {
    const first = await f.createIntent({ gross: 10_003n });
    const otherProvider = await f.createIntent({ policy: f.secondPolicy, gross: 12_011n });
    const otherSameProvider = await f.createIntent({ gross: 10_005n });
    await f.settle(first);
    await f.settle(otherProvider);
    await f.settle(otherSameProvider);
    await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [first.coverageId, bytes32(401)], first.payer);
    const p = await f.provider();
    assert.ok(p.free > 17n);
    await transact(f.evm, f.coreAbi, f.core, 'withdrawStake', [f.providerId, p.free - 17n], f.evm.provider);
    const beforeProvider = await f.provider();
    const beforeSecondProvider = await f.provider(f.secondProviderId);
    const beforeGlobals = await f.globals();
    const beforeCoverage = await f.coverage(first.coverageId);
    const lockedElsewhere = (await f.coverage(otherSameProvider.coverageId)).stakeLock;
    const lockedOtherProvider = (await f.coverage(otherProvider.coverageId)).stakeLock;
    const payerBefore = await f.balance(first.payer.address);

    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [first.coverageId, OUTCOME.providerFault, beforeCoverage.gross, bytes32(402)], f.evm.outsider);

    const afterProvider = await f.provider();
    const afterSecondProvider = await f.provider(f.secondProviderId);
    const afterGlobals = await f.globals();
    const poolConsumed = beforeCoverage.gross - beforeCoverage.stakeLock - 17n;
    assert.equal(beforeProvider.free, 17n);
    assert.equal(afterProvider.free, 0n);
    assert.equal(afterProvider.locked, beforeProvider.locked - beforeCoverage.stakeLock);
    assert.equal((await f.coverage(otherSameProvider.coverageId)).stakeLock, lockedElsewhere);
    assert.equal(afterProvider.locked, lockedElsewhere);
    assert.deepEqual(afterSecondProvider, beforeSecondProvider);
    assert.equal((await f.coverage(otherProvider.coverageId)).stakeLock, lockedOtherProvider);
    assert.equal(afterGlobals.totalProviderStake, beforeGlobals.totalProviderStake - beforeCoverage.stakeLock - 17n);
    assert.equal(afterGlobals.poolAssets, beforeGlobals.poolAssets - poolConsumed);
    assert.equal(await f.balance(first.payer.address), payerBefore + beforeCoverage.gross);
    await expectInvariant(f, [f.providerId, f.secondProviderId],
      [first.coverageId, otherProvider.coverageId, otherSameProvider.coverageId]);
  } finally { await close(f); }
});

test('one-unit rounding and zero/full stake policies produce exact integer quotes and execute', async () => {
  const f = await fixture();
  try {
    const zeroStake = {
      providerId: f.providerId, policyId: bytes32(601), providerOwner: f.policy.providerOwner,
      providerPayout: f.policy.providerPayout, premiumBps: 0, stakeBps: 0,
      withholdingBps: 0, duration: 60n, poolOnlyAllowed: false,
    } as const;
    const fullStake = {
      providerId: f.providerId, policyId: bytes32(602), providerOwner: f.policy.providerOwner,
      providerPayout: f.policy.providerPayout, premiumBps: 1_000, stakeBps: 10_000,
      withholdingBps: 9_999, duration: 60n, poolOnlyAllowed: false,
    } as const;
    for (const p of [zeroStake, fullStake]) await transact(f.evm, f.coreAbi, f.core, 'registerPolicy',
      [p.policyId, p.providerId, p.premiumBps, p.stakeBps, p.withholdingBps, p.duration, p.poolOnlyAllowed]);

    const tiny = await f.quote(zeroStake, 2n);
    assert.deepEqual(tiny, { premium: 1n, withheld: 0n, net: 1n, stakeLock: 0n, poolReservation: 2n });
    const tinyIntent = await f.createIntent({ policy: zeroStake, gross: 2n });
    await f.settle(tinyIntent);
    const tinyCoverage = await f.coverage(tinyIntent.coverageId);
    assert.equal(tinyCoverage.premium, 1n);
    assert.equal(tinyCoverage.stakeLock, 0n);
    assert.equal(tinyCoverage.poolReservation, 2n);

    const maxStakeQuote = await f.quote(fullStake, 10_003n);
    assert.equal(maxStakeQuote.stakeLock, 10_003n);
    assert.equal(maxStakeQuote.poolReservation, 0n);
    const fullIntent = await f.createIntent({ policy: fullStake, gross: 10_003n });
    await f.settle(fullIntent);
    const fullCoverage = await f.coverage(fullIntent.coverageId);
    assert.equal(fullCoverage.stakeLock, fullCoverage.gross);
    assert.equal(fullCoverage.poolReservation, 0n);
    await expectInvariant(f, [f.providerId, f.secondProviderId], [tinyIntent.coverageId, fullIntent.coverageId]);
  } finally { await close(f); }
});
