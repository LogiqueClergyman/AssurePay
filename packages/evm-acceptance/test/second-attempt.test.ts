import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, toBytes } from 'viem';
import { budgetSummary, MAX_FEE_PER_GAS, MAX_PRIORITY_FEE_PER_GAS, NATIVE_USDC } from '../src/plan.js';
import { MANAGED_TEST_VAULT } from '../src/preflight.js';
import type { FundingPlan } from '../src/funding.js';
import type { RunConfig } from '../src/types.js';
import {
  assertFundingPlanMatchesProposal,
  assertOriginalRuntimeMatches,
  assertProposalAnchor,
  assertSpendingRoleNonces,
  SECOND_ATTEMPT_SCOPE,
  validateSecondAttemptProposal,
} from '../src/second-attempt.js';

const id = (last: string) => `0x${last.padStart(64, '0')}` as `0x${string}`;
const address = (last: string) => `0x${last.padStart(40, '0')}` as `0x${string}`;

function config(fresh: boolean): RunConfig {
  const runId = id(fresh ? '11' : '1');
  return {
    version: 1, mode: 'public', chainId: 84532, token: NATIVE_USDC,
    roles: { relayer: address('1'), payer: address('2'), provider: address('3'), adjudicator: address('4') },
    runId, providerId: fresh ? keccak256(toBytes(`${runId}:provider`)) : id('2'),
    policyId: fresh ? keccak256(toBytes(`${runId}:policy`)) : id('3'),
    serviceId: fresh ? keccak256(toBytes(`${runId}:service`)) : id('4'), resourceUrl: 'http://localhost:40205/assured',
    maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
  };
}

function fundingPlan(run: RunConfig): FundingPlan {
  const targets = budgetSummary(run).roles;
  const relayerBalance = BigInt(targets.relayer.targetWei) - 100n;
  const payerBalance = BigInt(targets.payer.targetWei) - 200n;
  const adjudicatorBalance = BigInt(targets.adjudicator.targetWei);
  const plan: FundingPlan = {
    version: 1, mode: 'public', chainId: 84532, runId: run.runId, vault: MANAGED_TEST_VAULT,
    observationBlock: { number: '123', hash: id('ab') },
    roles: {
      relayer: { actor: 'relayer', address: run.roles.relayer, balanceWei: relayerBalance.toString(), targetWei: targets.relayer.targetWei,
        shortfallWei: '100', excessWei: '0', nonce: '9' },
      payer: { actor: 'payer', address: run.roles.payer, balanceWei: payerBalance.toString(), targetWei: targets.payer.targetWei,
        shortfallWei: '200', excessWei: '0', nonce: '3' },
      adjudicator: { actor: 'adjudicator', address: run.roles.adjudicator, balanceWei: adjudicatorBalance.toString(), targetWei: targets.adjudicator.targetWei,
        shortfallWei: '0', excessWei: '0', nonce: '0' },
    },
    vaultBalanceWei: '1000000000000000000', vaultNonce: '4',
    transfers: [
      { actor: 'relayer', from: MANAGED_TEST_VAULT, to: run.roles.relayer, nonce: '4', valueWei: '100',
        targetWei: targets.relayer.targetWei, beforeBalanceWei: relayerBalance.toString(), gas: '21000', maxFeePerGas: '100000000',
        maxPriorityFeePerGas: '1000000', auxiliaryReserveWei: '1000000000000' },
      { actor: 'payer', from: MANAGED_TEST_VAULT, to: run.roles.payer, nonce: '5', valueWei: '200',
        targetWei: targets.payer.targetWei, beforeBalanceWei: payerBalance.toString(), gas: '21000', maxFeePerGas: '100000000',
        maxPriorityFeePerGas: '1000000', auxiliaryReserveWei: '1000000000000' },
    ],
    gasAllowanceWei: '4200000000000', auxiliaryAllowanceWei: '2000000000000', totalFeeAllowanceWei: '6200000000000',
    transferValueWei: '300', requiredVaultWei: '6200000000300', vaultShortfallWei: '0', ready: true, code: 'ready',
  };
  return plan;
}

function proposal() {
  const original = config(false), next = config(true);
  const value = { version: 1, scope: SECOND_ATTEMPT_SCOPE, config: next, fundingPlan: fundingPlan(next) };
  return { original, value, parsed: validateSecondAttemptProposal(value, original) };
}

test('second-attempt proposal pins fresh IDs and preserves only the existing roles, token, and runtime settings', () => {
  const { original, value, parsed } = proposal();
  assert.equal(parsed.scope, SECOND_ATTEMPT_SCOPE);
  assert.notEqual(parsed.config.runId, original.runId);
  assertOriginalRuntimeMatches(parsed, original);

  assert.throws(() => validateSecondAttemptProposal({ ...value, scope: 'm5-two-http-refunds-paused-revert-once' }, original),
    /M5_SECOND_PROPOSAL_SCOPE/);
  assert.throws(() => validateSecondAttemptProposal({ ...value, config: { ...value.config, roles: { ...value.config.roles, payer: address('9') } } }, original),
    /M5_SECOND_PROPOSAL_CONTEXT/);
  assert.throws(() => validateSecondAttemptProposal({ ...value, config: { ...value.config, runId: original.runId } }, original),
    /M5_SECOND_PROPOSAL_IDS_NOT_FRESH/);
});

test('funding proposal comparison ignores only the observation block and rejects changed values/nonces', () => {
  const { parsed } = proposal();
  const proposed = parsed.fundingPlan;
  const later = structuredClone(proposed);
  later.observationBlock = { number: '124', hash: id('ac') };
  assert.doesNotThrow(() => assertFundingPlanMatchesProposal(proposed, later));

  const changedNonce = structuredClone(later);
  changedNonce.transfers[0]!.nonce = '10';
  assert.throws(() => assertFundingPlanMatchesProposal(proposed, changedNonce), /M5_SECOND_FUNDING_PLAN_CHANGED/);
  const changedValue = structuredClone(later);
  changedValue.transfers[1]!.valueWei = '201';
  assert.throws(() => assertFundingPlanMatchesProposal(proposed, changedValue), /M5_SECOND_FUNDING_PLAN_CHANGED/);
});

test('proposal anchor and all spending-role latest/pending nonces are checked before fresh campaign execution', async () => {
  const { parsed } = proposal();
  const expected = parsed.fundingPlan;
  await assertProposalAnchor({ async getBlock() { return { hash: expected.observationBlock.hash }; } }, expected);
  await assert.rejects(assertProposalAnchor({ async getBlock() { return { hash: id('ff') }; } }, expected), /M5_SECOND_PROPOSAL_ANCHOR_CHANGED/);

  const config = parsed.config;
  const counts: Record<string, number> = { [config.roles.relayer]: 9, [config.roles.payer]: 3, [config.roles.adjudicator]: 0 };
  await assertSpendingRoleNonces({ async getTransactionCount({ address: actor }) { return counts[actor]!; } }, config, expected);
  counts[config.roles.payer] = 4;
  await assert.rejects(assertSpendingRoleNonces({ async getTransactionCount({ address: actor }) { return counts[actor]!; } }, config, expected),
    /M5_SECOND_ROLE_NONCE_CHANGED/);
});
