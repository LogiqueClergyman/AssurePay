import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ECONOMICS,
  GAS_CAPS,
  MAX_FEE_PER_GAS,
  MAX_PRIORITY_FEE_PER_GAS,
  NATIVE_USDC,
  STEP_ORDER,
  budgetSummary,
  stepActor,
  validateConfig,
} from '../src/plan.js';
import type { RunConfig } from '../src/types.js';

const bytes32 = (last: string) => `0x${last.padStart(64, '0')}`;
const address = (last: string) => `0x${last.padStart(40, '0')}`;

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    version: 1,
    mode: 'public',
    chainId: 84532,
    token: NATIVE_USDC,
    roles: {
      relayer: address('1') as RunConfig['roles']['relayer'],
      payer: address('2') as RunConfig['roles']['payer'],
      provider: address('3') as RunConfig['roles']['provider'],
      adjudicator: address('4') as RunConfig['roles']['adjudicator'],
    },
    runId: bytes32('1') as RunConfig['runId'],
    providerId: bytes32('2') as RunConfig['providerId'],
    policyId: bytes32('3') as RunConfig['policyId'],
    serviceId: bytes32('4') as RunConfig['serviceId'],
    resourceUrl: 'http://localhost:43127/assured',
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
    ...overrides,
  };
}

test('frozen campaign order, actor assignment, and integer economics match the packet', () => {
  assert.deepEqual(STEP_ORDER, [
    'deploy', 'provider', 'policy', 'approve', 'stake', 'pool',
    'purchaseA', 'claimA', 'resolveA', 'purchaseB', 'claimB', 'resolveB',
    'pause', 'revert',
  ]);
  assert.deepEqual(STEP_ORDER.map(stepActor), [
    'relayer', 'relayer', 'relayer', 'payer', 'payer', 'payer',
    'relayer', 'payer', 'adjudicator', 'relayer', 'payer', 'adjudicator',
    'relayer', 'relayer',
  ]);
  assert.deepEqual(Object.values(GAS_CAPS).map(String), [
    '3200000', '150000', '200000', '100000', '170000', '110000',
    '800000', '100000', '220000', '800000', '100000', '220000', '80000', '800000',
  ]);
  assert.deepEqual(ECONOMICS, {
    gross: '10003', premium: '777', withheld: '2029', net: '7197', stakeLock: '3502',
    poolReservation: '10003', seedStake: '3502', seedPool: '20006', approval: '23508',
    allocation: '43514', partialRefund: '3100', fullRefund: '10003', duration: '3600',
    premiumBps: 777, stakeBps: 3500, withholdingBps: 2200, poolOnlyAllowed: true, purchaseCount: 2,
  });
});

test('config validation snapshots normalized addresses and enforces public versus local token scope', () => {
  const mixed = config({
    roles: {
      relayer: address('A') as RunConfig['roles']['relayer'],
      payer: address('B') as RunConfig['roles']['payer'],
      provider: address('C') as RunConfig['roles']['provider'],
      adjudicator: address('D') as RunConfig['roles']['adjudicator'],
    },
    runId: bytes32('AB') as RunConfig['runId'],
  });
  const result = validateConfig(mixed);
  assert.equal(result.roles.relayer, address('a'));
  assert.equal(result.roles.adjudicator, address('d'));
  assert.equal(result.runId, bytes32('ab'));
  assert.notEqual(result.roles, mixed.roles);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.roles));

  const local = validateConfig(config({ mode: 'local', token: address('F') as RunConfig['token'] }));
  assert.equal(local.mode, 'local');
  assert.equal(local.token, address('f'));
  assert.throws(() => validateConfig(config({ token: address('F') as RunConfig['token'] })), /M5_CONFIG_PUBLIC_TOKEN/);
  assert.throws(() => validateConfig(config({ mode: 'local' })), /M5_CONFIG_LOCAL_FIXTURE/);
});

test('config rejects mutable surprises, wrong fees, role aliases, bad IDs, and noncanonical URLs', () => {
  assert.throws(() => validateConfig({ ...config(), extra: true }), /M5_CONFIG_UNKNOWN_FIELD/);
  assert.throws(() => validateConfig(config({ chainId: 1 as 84532 })), /M5_CONFIG_SCOPE/);
  assert.throws(() => validateConfig(config({ maxFeePerGas: '100000001' })), /M5_CONFIG_FEE/);
  assert.throws(() => validateConfig(config({ maxPriorityFeePerGas: '1000000.0' })), /M5_CONFIG_FEE/);
  assert.throws(() => validateConfig(config({
    roles: {
      relayer: address('1') as RunConfig['roles']['relayer'],
      payer: address('1') as RunConfig['roles']['payer'],
      provider: address('3') as RunConfig['roles']['provider'],
      adjudicator: address('4') as RunConfig['roles']['adjudicator'],
    },
  })), /M5_CONFIG_ROLE_COLLISION/);
  assert.throws(() => validateConfig(config({ runId: `0x${'0'.repeat(64)}` })), /M5_CONFIG_ID/);
  assert.throws(() => validateConfig(config({ resourceUrl: 'https://localhost:43127/assured' })), /M5_CONFIG_RESOURCE_URL/);
  assert.throws(() => validateConfig(config({ resourceUrl: 'http://example.com:43127/assured' })), /M5_CONFIG_RESOURCE_URL/);
  assert.throws(() => validateConfig(config({ resourceUrl: 'http://localhost:43127/assured?x=1' })), /M5_CONFIG_RESOURCE_URL/);
  assert.throws(() => validateConfig(config({ resourceUrl: 'http://localhost/assured' })), /M5_CONFIG_RESOURCE_URL/);

  const accessor = Object.defineProperty({ ...config() }, 'mode', { enumerable: true, get: () => 'public' });
  assert.throws(() => validateConfig(accessor), /M5_CONFIG_INVALID/);
});

test('budget summary uses exact integer gas, fee, auxiliary, role, and funding allowances', () => {
  const summary = budgetSummary(validateConfig(config()));
  assert.deepEqual(summary, {
    totalGas: '7050000',
    executionWei: '705000000000000',
    auxiliaryWei: '200000000000000',
    totalWei: '905000000000000',
    roles: {
      relayer: { gas: '6030000', executionWei: '603000000000000', auxiliaryWei: '100000000000000', targetWei: '703000000000000' },
      payer: { gas: '580000', executionWei: '58000000000000', auxiliaryWei: '50000000000000', targetWei: '108000000000000' },
      provider: { gas: '0', executionWei: '0', auxiliaryWei: '0', targetWei: '0' },
      adjudicator: { gas: '440000', executionWei: '44000000000000', auxiliaryWei: '50000000000000', targetWei: '94000000000000' },
    },
    funding: { gas: '63000', executionWei: '6300000000000', auxiliaryWei: '3000000000000', totalWei: '9300000000000' },
    maxCampaignAndFundingWei: '914300000000000',
  });
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.roles));
  assert.ok(Object.isFrozen(summary.roles.relayer));
});
