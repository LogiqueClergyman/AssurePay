import assert from 'node:assert/strict';
import test from 'node:test';
import { pad, toHex } from 'viem';
import { attemptRevert, transact } from './helpers/evm.js';
import { expectInvariant, fixture, OUTCOME, STATUS, type Fixture } from './helpers/fixture.js';

const bytes32 = (value: number) => pad(toHex(value), { size: 32 });

test('deterministic adversarial multi-operation sequence preserves aggregate accounting and solvency after each result', async () => {
  const f = await fixture({ pool: 300_000n, providerStake: 30_000n, secondProviderStake: 20_000n });
  const ids: `0x${string}`[] = [];
  const providers = [f.providerId, f.secondProviderId];
  const check = async () => expectInvariant(f, providers, ids);
  try {
    const first = await f.createIntent({ gross: 12_345n });
    await f.settle(first);
    ids.push(first.coverageId);
    await check();

    const second = await f.createIntent({ policy: f.secondPolicy, gross: 23_457n });
    await f.settle(second);
    ids.push(second.coverageId);
    await check();

    // A withdrawal cannot remove a live lock; the included revert changes no ledger or token balance.
    const firstCoverage = await f.coverage(first.coverageId);
    const pBefore = await f.provider();
    const gBefore = await f.globals();
    const coreBefore = await f.balance(f.core);
    const payerBefore = await f.balance(first.payer.address);
    const nonceBefore = await f.authorizationUsed(first.payer.address, first.coverageId);
    await attemptRevert(f.evm, f.coreAbi, f.core, 'withdrawStake',
      [f.providerId, pBefore.free + 1n], f.evm.provider);
    assert.deepEqual(await f.provider(), pBefore);
    assert.deepEqual(await f.globals(), gBefore);
    assert.equal(await f.balance(f.core), coreBefore);
    assert.equal(await f.balance(first.payer.address), payerBefore);
    assert.equal(await f.authorizationUsed(first.payer.address, first.coverageId), nonceBefore);
    assert.equal(firstCoverage.status, STATUS.active);
    await check();

    await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [first.coverageId, bytes32(301)], first.payer);
    await check();
    const beforePartial = await f.coverage(first.coverageId);
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [first.coverageId, OUTCOME.providerFault, 1n, bytes32(302)], f.evm.outsider);
    const afterPartial = await f.coverage(first.coverageId);
    assert.equal(afterPartial.status, STATUS.refunded);
    assert.equal(afterPartial.refundAmount, 1n);
    assert.equal(afterPartial.stakeLock, beforePartial.stakeLock); // immutable opening snapshot
    await check();

    // Duplicate resolution and a bad resolver decision are included reverts with stable state.
    const beforeDuplicate = { globals: await f.globals(), provider: await f.provider(), payer: await f.balance(first.payer.address) };
    await attemptRevert(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [first.coverageId, OUTCOME.providerFault, 1n, bytes32(303)], f.evm.outsider);
    assert.deepEqual(await f.globals(), beforeDuplicate.globals);
    assert.deepEqual(await f.provider(), beforeDuplicate.provider);
    assert.equal(await f.balance(first.payer.address), beforeDuplicate.payer);
    await check();

    await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [second.coverageId, bytes32(304)], second.payer);
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [second.coverageId, OUTCOME.reject, 0n, bytes32(305)], f.evm.outsider);
    assert.equal((await f.coverage(second.coverageId)).status, STATUS.rejected);
    await check();

    // Donations update only their intended ledgers and continue to preserve solvency.
    await transact(f.evm, f.tokenAbi, f.token, 'mint', [f.evm.provider.address, 4_321n]);
    await transact(f.evm, f.tokenAbi, f.token, 'approve', [f.core, 4_321n], f.evm.provider);
    await transact(f.evm, f.coreAbi, f.core, 'depositStake', [f.providerId, 4_321n], f.evm.provider);
    await check();
    await transact(f.evm, f.tokenAbi, f.token, 'mint', [f.evm.owner.address, 6_543n]);
    await transact(f.evm, f.tokenAbi, f.token, 'approve', [f.core, 6_543n]);
    await transact(f.evm, f.coreAbi, f.core, 'fundPool', [6_543n]);
    await check();

    const third = await f.createIntent({ gross: 18_765n });
    await f.settle(third);
    ids.push(third.coverageId);
    await check();
    await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [third.coverageId, bytes32(306)], third.payer);
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [third.coverageId, OUTCOME.poolOnly, 2_345n, bytes32(307)], f.evm.outsider);
    assert.equal((await f.coverage(third.coverageId)).status, STATUS.refunded);
    await check();

    // A disallowed pool-only resolution must not consume the pool or release locks.
    const fourth = await f.createIntent({ policy: f.nonPoolPolicy, gross: 19_876n });
    await f.settle(fourth);
    ids.push(fourth.coverageId);
    await check();
    await transact(f.evm, f.coreAbi, f.core, 'fileClaim', [fourth.coverageId, bytes32(308)], fourth.payer);
    const beforeRejectedResolution = { globals: await f.globals(), provider: await f.provider(), payer: await f.balance(fourth.payer.address) };
    await attemptRevert(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [fourth.coverageId, OUTCOME.poolOnly, 1n, bytes32(309)], f.evm.outsider);
    assert.deepEqual(await f.globals(), beforeRejectedResolution.globals);
    assert.deepEqual(await f.provider(), beforeRejectedResolution.provider);
    assert.equal(await f.balance(fourth.payer.address), beforeRejectedResolution.payer);
    await check();

    // An invalid ERC-3009 signature fails on chain and leaves its authorization nonce unused.
    const invalid = await f.createIntent({ gross: 20_987n });
    const changedR = pad(toHex(BigInt(invalid.signature.r) ^ 1n), { size: 32 });
    await attemptRevert(f.evm, f.coreAbi, f.core, 'settleAssured', [invalid.typed,
      invalid.signature.v, changedR, invalid.signature.s]);
    assert.equal(await f.authorizationUsed(invalid.payer.address, invalid.coverageId), false);
    assert.equal((await f.coverage(invalid.coverageId)).status, STATUS.none);
    await check();

    const fifth = await f.createIntent({ policy: f.secondPolicy, gross: 21_098n });
    await f.settle(fifth);
    ids.push(fifth.coverageId);
    await check();
    const expiring = await f.coverage(fifth.coverageId);
    await (f.evm.publicClient.request as any)({ method: 'evm_setNextBlockTimestamp', params: [Number(expiring.expiresAt)] });
    await transact(f.evm, f.coreAbi, f.core, 'closeExpired', [fifth.coverageId], f.evm.outsider);
    assert.equal((await f.coverage(fifth.coverageId)).status, STATUS.expired);
    await check();
    const beforeSecondClose = { globals: await f.globals(), providers: await Promise.all(providers.map(p => f.provider(p))) };
    await attemptRevert(f.evm, f.coreAbi, f.core, 'closeExpired', [fifth.coverageId], f.evm.outsider);
    assert.deepEqual(await f.globals(), beforeSecondClose.globals);
    assert.deepEqual(await Promise.all(providers.map(p => f.provider(p))), beforeSecondClose.providers);
    await check();
  } finally { await f.close(); }
});
