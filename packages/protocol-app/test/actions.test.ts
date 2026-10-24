import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, keccak256, toBytes } from 'viem';
import { normalizeOperation, planOperation } from '../src/actions.js';
import { createProtocolFixture } from './helpers.js';

test('fixed action parser enforces exact role-bound operations and positive integer caps', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  const limits = { maxActionAmount: '5000', maxActions: 10 };
  const providerId = keccak256(toBytes('m11-provider-new'));
  const policyId = keccak256(toBytes('m11-policy-new'));

  assert.deepEqual(normalizeOperation('admin', { kind: 'setPaused', paused: true }, limits), { kind: 'setPaused', paused: true });
  assert.throws(() => normalizeOperation('provider', { kind: 'setPaused', paused: true }, limits), /PROTOCOL_FORBIDDEN/);
  assert.throws(() => normalizeOperation('admin', { kind: 'fundPool', amount: '0' }, limits), /PROTOCOL_LIMIT/);
  assert.throws(() => normalizeOperation('admin', { kind: 'fundPool', amount: '5001' }, limits), /PROTOCOL_LIMIT/);
  assert.throws(() => normalizeOperation('admin', { kind: 'fundPool', amount: '1', recipient: f.accounts.payer.address }, limits), /PROTOCOL_ARGUMENT_INVALID/);
  const accessor = Object.defineProperty({ paused: true }, 'kind', { enumerable: true, get() { throw new Error('getter invoked'); } });
  assert.throws(() => normalizeOperation('admin', accessor, limits), /PROTOCOL_ARGUMENT_INVALID/);

  const registration = normalizeOperation('admin', { kind: 'registerProvider', providerId,
    owner: f.accounts.provider.address, payout: f.accounts.payer.address }, limits);
  const planned = planOperation(registration, f.config.admin, f.config);
  assert.equal(planned.data, encodeFunctionData({ abi: (await import('../src/abi.js')).CORE_ABI,
    functionName: 'registerProvider', args: [providerId, f.accounts.provider.address, f.accounts.payer.address] }));
  assert.equal(planned.value, 0n);

  const policy = normalizeOperation('admin', { kind: 'registerPolicy', policyId, providerId: f.config.pilot.providerId,
    premiumBps: 200, stakeBps: 1000, withholdingBps: 100, duration: '3600', poolOnlyAllowed: false }, limits);
  await assert.rejects(async () => planOperation(policy, f.config.admin, f.config), /PROTOCOL_STATE_UNAVAILABLE/);
  const bound = await f.evm.publicClient.readContract({ address: f.config.pilot.core,
    abi: (await import('../src/abi.js')).CORE_ABI, functionName: 'providers', args: [f.config.pilot.providerId] });
  const policyPlan = planOperation(policy, f.config.admin, f.config, undefined, { owner: bound[0], payout: bound[1] });
  assert.match(policyPlan.review.policyHash as string, /^0x[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(policyPlan.review, 'reason'), false);
});

test('claim preview exposes only a reason hash and defers its commitment until approval', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  const coverageId = keccak256(toBytes('m11-coverage'));
  const operation = normalizeOperation('adjudicator', { kind: 'finalizeClaim', coverageId, outcome: 1,
    refundAmount: '1', reason: 'bounded test reason' }, { maxActionAmount: '5000', maxActions: 10 });
  const preview = planOperation(operation, f.config.pilot.roles.adjudicator, f.config);
  assert.equal(preview.review.reasonHash, keccak256(toBytes('bounded test reason')));
  assert.equal(preview.review.decisionCommitment, 'created-after-confirmation');
  assert.equal(Object.hasOwn(preview.review, 'reason'), false);
});
