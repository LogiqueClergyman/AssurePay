import type { Address } from 'viem';
import type { Actor, RunConfig, StepKind } from './types.js';

export const PUBLIC_CHAIN_ID = 84532 as const;
export const NATIVE_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as Address;
export const MAX_FEE_PER_GAS = '100000000' as const;
export const MAX_PRIORITY_FEE_PER_GAS = '1000000' as const;

export const ECONOMICS = Object.freeze({
  gross: '10003',
  premium: '777',
  withheld: '2029',
  net: '7197',
  stakeLock: '3502',
  poolReservation: '10003',
  seedStake: '3502',
  seedPool: '20006',
  approval: '23508',
  allocation: '43514',
  partialRefund: '3100',
  fullRefund: '10003',
  duration: '3600',
  premiumBps: 777,
  stakeBps: 3500,
  withholdingBps: 2200,
  poolOnlyAllowed: true,
  purchaseCount: 2,
});

export const STEP_ORDER: readonly StepKind[] = Object.freeze([
  'deploy', 'provider', 'policy', 'approve', 'stake', 'pool',
  'purchaseA', 'claimA', 'resolveA', 'purchaseB', 'claimB', 'resolveB',
  'pause', 'revert',
]);

export const GAS_CAPS: Readonly<Record<StepKind, bigint>> = Object.freeze({
  deploy: 3_200_000n,
  provider: 150_000n,
  policy: 200_000n,
  approve: 100_000n,
  stake: 170_000n,
  pool: 110_000n,
  purchaseA: 800_000n,
  claimA: 100_000n,
  resolveA: 220_000n,
  purchaseB: 800_000n,
  claimB: 100_000n,
  resolveB: 220_000n,
  pause: 80_000n,
  revert: 800_000n,
});

const ACTORS: Readonly<Record<StepKind, Actor>> = Object.freeze({
  deploy: 'relayer',
  provider: 'relayer',
  policy: 'relayer',
  approve: 'payer',
  stake: 'payer',
  pool: 'payer',
  purchaseA: 'relayer',
  claimA: 'payer',
  resolveA: 'adjudicator',
  purchaseB: 'relayer',
  claimB: 'payer',
  resolveB: 'adjudicator',
  pause: 'relayer',
  revert: 'relayer',
});

const AUXILIARY_WEI: Readonly<Record<Actor, bigint>> = Object.freeze({
  relayer: 100_000_000_000_000n,
  payer: 50_000_000_000_000n,
  provider: 0n,
  adjudicator: 50_000_000_000_000n,
});
const FUNDING_TRANSFER_COUNT = 3n;
const FUNDING_TRANSFER_GAS = 21_000n;
const FUNDING_AUXILIARY_WEI = 3_000_000_000_000n;

export interface RoleBudget {
  gas: string;
  executionWei: string;
  auxiliaryWei: string;
  targetWei: string;
}

export interface BudgetSummary {
  totalGas: string;
  executionWei: string;
  auxiliaryWei: string;
  totalWei: string;
  roles: Readonly<Record<Actor, RoleBudget>>;
  funding: Readonly<{
    gas: string;
    executionWei: string;
    auxiliaryWei: string;
    totalWei: string;
  }>;
  maxCampaignAndFundingWei: string;
}

export function stepActor(kind: StepKind): Actor {
  const actor = (ACTORS as Partial<Record<string, Actor>>)[kind];
  if (!actor) throw new Error('M5_STEP_KIND_INVALID');
  return actor;
}

export function budgetSummary(config: RunConfig): BudgetSummary {
  const maxFee = BigInt(config.maxFeePerGas);
  const roleGas: Record<Actor, bigint> = {
    relayer: 0n,
    payer: 0n,
    provider: 0n,
    adjudicator: 0n,
  };
  let totalGas = 0n;
  for (const kind of STEP_ORDER) {
    const gas = GAS_CAPS[kind];
    roleGas[stepActor(kind)] += gas;
    totalGas += gas;
  }

  const roles = Object.freeze(Object.fromEntries(
    (['relayer', 'payer', 'provider', 'adjudicator'] as const).map((actor) => {
      const executionWei = roleGas[actor] * maxFee;
      const auxiliaryWei = AUXILIARY_WEI[actor];
      return [actor, Object.freeze({
        gas: roleGas[actor].toString(),
        executionWei: executionWei.toString(),
        auxiliaryWei: auxiliaryWei.toString(),
        targetWei: (executionWei + auxiliaryWei).toString(),
      })];
    }),
  )) as Readonly<Record<Actor, RoleBudget>>;

  const executionWei = totalGas * maxFee;
  const auxiliaryWei = Object.values(AUXILIARY_WEI).reduce((sum, value) => sum + value, 0n);
  const fundingGas = FUNDING_TRANSFER_COUNT * FUNDING_TRANSFER_GAS;
  const fundingExecutionWei = fundingGas * maxFee;
  const totalWei = executionWei + auxiliaryWei;
  const fundingTotalWei = fundingExecutionWei + FUNDING_AUXILIARY_WEI;

  return Object.freeze({
    totalGas: totalGas.toString(),
    executionWei: executionWei.toString(),
    auxiliaryWei: auxiliaryWei.toString(),
    totalWei: totalWei.toString(),
    roles,
    funding: Object.freeze({
      gas: fundingGas.toString(),
      executionWei: fundingExecutionWei.toString(),
      auxiliaryWei: FUNDING_AUXILIARY_WEI.toString(),
      totalWei: fundingTotalWei.toString(),
    }),
    maxCampaignAndFundingWei: (totalWei + fundingTotalWei).toString(),
  });
}

const CONFIG_KEYS = [
  'version', 'mode', 'chainId', 'token', 'roles', 'runId', 'providerId', 'policyId',
  'serviceId', 'resourceUrl', 'maxFeePerGas', 'maxPriorityFeePerGas',
] as const;
const ROLE_KEYS = ['relayer', 'payer', 'provider', 'adjudicator'] as const;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type DataRecord = Record<string, unknown>;

function fail(code: string): never {
  throw new Error(code);
}

function dataRecord(value: unknown, code: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (!descriptor.enumerable || !('value' in descriptor)) fail(code);
  }
  return value as DataRecord;
}

function exactKeys(record: DataRecord, expected: readonly string[], code: string): void {
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== 'string' || !expected.includes(key)) ||
      expected.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) fail(code);
}

function address(value: unknown, code: string): Address {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value) || /^0x0{40}$/i.test(value)) fail(code);
  return value.toLowerCase() as Address;
}

function bytes32(value: unknown, code: string): `0x${string}` {
  if (typeof value !== 'string' || !BYTES32_PATTERN.test(value) || /^0x0{64}$/i.test(value)) fail(code);
  return value.toLowerCase() as `0x${string}`;
}

function canonicalResourceUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) fail('M5_CONFIG_RESOURCE_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('M5_CONFIG_RESOURCE_URL');
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !url.port || url.pathname !== '/assured' || url.search !== '' || url.hash !== '' ||
      url.username !== '' || url.password !== '' || url.href !== value) {
    fail('M5_CONFIG_RESOURCE_URL');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail('M5_CONFIG_RESOURCE_URL');
  return url.href;
}

export function validateConfig(input: unknown): RunConfig {
  const record = dataRecord(input, 'M5_CONFIG_INVALID');
  exactKeys(record, CONFIG_KEYS, 'M5_CONFIG_UNKNOWN_FIELD');

  if (record.version !== 1 || record.mode !== 'local' && record.mode !== 'public' ||
      record.chainId !== PUBLIC_CHAIN_ID) fail('M5_CONFIG_SCOPE');
  const token = address(record.token, 'M5_CONFIG_TOKEN');
  if (record.mode === 'public' && token !== NATIVE_USDC) fail('M5_CONFIG_PUBLIC_TOKEN');
  if (record.mode === 'local' && token === NATIVE_USDC) fail('M5_CONFIG_LOCAL_FIXTURE');

  if (record.maxFeePerGas !== MAX_FEE_PER_GAS ||
      record.maxPriorityFeePerGas !== MAX_PRIORITY_FEE_PER_GAS) fail('M5_CONFIG_FEE');

  const inputRoles = dataRecord(record.roles, 'M5_CONFIG_ROLES');
  exactKeys(inputRoles, ROLE_KEYS, 'M5_CONFIG_ROLES');
  const roles = Object.freeze({
    relayer: address(inputRoles.relayer, 'M5_CONFIG_ROLES'),
    payer: address(inputRoles.payer, 'M5_CONFIG_ROLES'),
    provider: address(inputRoles.provider, 'M5_CONFIG_ROLES'),
    adjudicator: address(inputRoles.adjudicator, 'M5_CONFIG_ROLES'),
  });
  if (new Set(Object.values(roles)).size !== ROLE_KEYS.length || Object.values(roles).includes(token)) {
    fail('M5_CONFIG_ROLE_COLLISION');
  }

  const runId = bytes32(record.runId, 'M5_CONFIG_ID');
  const providerId = bytes32(record.providerId, 'M5_CONFIG_ID');
  const policyId = bytes32(record.policyId, 'M5_CONFIG_ID');
  const serviceId = bytes32(record.serviceId, 'M5_CONFIG_ID');
  const resourceUrl = canonicalResourceUrl(record.resourceUrl);

  return Object.freeze({
    version: 1,
    mode: record.mode,
    chainId: PUBLIC_CHAIN_ID,
    token,
    roles,
    runId,
    providerId,
    policyId,
    serviceId,
    resourceUrl,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
  });
}
