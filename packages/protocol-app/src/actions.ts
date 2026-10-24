import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { CORE_ABI, TOKEN_ABI } from './abi.js';
import { address, amount, exact, id, same } from './common.js';
import { canonicalPolicyHash } from './policy.js';
import type { Limits, Operation, ProtocolConfig, SigningRole } from './types.js';

export const ACTION_GAS = Object.freeze({
  registerProvider: 150_000n,
  registerPolicy: 250_000n,
  setPaused: 60_000n,
  approveCore: 70_000n,
  depositStake: 140_000n,
  withdrawStake: 140_000n,
  fundPool: 120_000n,
  finalizeClaim: 220_000n,
});
export const ACTION_MAX_FEE = 100_000_000n;
export const ACTION_PRIORITY_FEE = 1_000_000n;
export const PREVIEW_TTL_SECONDS = 120n;
export const PREVIEW_CAP = 32;
export const MAX_POLICY_DURATION = (1n << 64n) - 1n;
const MAX_REASON_BYTES = 8192;
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

export interface FixedPlan {
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly gas: bigint;
  readonly review: Readonly<Record<string, string | number | boolean>>;
  readonly policyHash?: Hex;
  readonly decisionHash?: Hex;
}

function positiveCapped(value: unknown, limits: Limits): string {
  const parsed = amount(value);
  if (BigInt(parsed) === 0n || BigInt(parsed) > BigInt(amount(limits.maxActionAmount))) throw Error('PROTOCOL_LIMIT');
  return parsed;
}

function boundedUInt(value: unknown, max: bigint): string {
  const parsed = amount(value);
  if (BigInt(parsed) === 0n || BigInt(parsed) > max) throw Error('PROTOCOL_ARGUMENT_INVALID');
  return parsed;
}

export function normalizeOperation(role: SigningRole, input: unknown, limits: Limits): Operation {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype)
    throw Error('PROTOCOL_ARGUMENT_INVALID');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'kind');
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string')
    throw Error('PROTOCOL_ARGUMENT_INVALID');
  const kind = descriptor.value;
  if (kind === 'registerProvider' && role === 'admin') {
    const row = exact(input, ['kind', 'providerId', 'owner', 'payout']);
    return { kind: 'registerProvider', providerId: id(row.providerId), owner: address(row.owner), payout: address(row.payout) };
  }
  if (kind === 'registerPolicy' && role === 'admin') {
    const row = exact(input, ['kind', 'policyId', 'providerId', 'premiumBps', 'stakeBps', 'withholdingBps', 'duration', 'poolOnlyAllowed']);
    const bps = (value: unknown, max: number) => {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) throw Error('PROTOCOL_ARGUMENT_INVALID');
      return value as number;
    };
    if (typeof row.poolOnlyAllowed !== 'boolean') throw Error('PROTOCOL_ARGUMENT_INVALID');
    const duration = boundedUInt(row.duration, MAX_POLICY_DURATION);
    return { kind: 'registerPolicy', policyId: id(row.policyId), providerId: id(row.providerId),
      premiumBps: bps(row.premiumBps, 9999), stakeBps: bps(row.stakeBps, 10000),
      withholdingBps: bps(row.withholdingBps, 9999), duration, poolOnlyAllowed: row.poolOnlyAllowed };
  }
  if (kind === 'setPaused' && role === 'admin') {
    const row = exact(input, ['kind', 'paused']);
    if (typeof row.paused !== 'boolean') throw Error('PROTOCOL_ARGUMENT_INVALID');
    return { kind: 'setPaused', paused: row.paused };
  }
  if (kind === 'approveCore' && (role === 'admin' || role === 'provider')) {
    const row = exact(input, ['kind', 'amount']);
    return { kind: 'approveCore', amount: positiveCapped(row.amount, limits) };
  }
  if ((kind === 'depositStake' || kind === 'withdrawStake') && role === 'provider') {
    const row = exact(input, ['kind', 'providerId', 'amount']);
    return { kind, providerId: id(row.providerId), amount: positiveCapped(row.amount, limits) };
  }
  if (kind === 'fundPool' && role === 'admin') {
    const row = exact(input, ['kind', 'amount']);
    return { kind: 'fundPool', amount: positiveCapped(row.amount, limits) };
  }
  if (kind === 'finalizeClaim' && role === 'adjudicator') {
    const row = exact(input, ['kind', 'coverageId', 'outcome', 'refundAmount', 'reason']);
    if ((row.outcome !== 0 && row.outcome !== 1 && row.outcome !== 2) || typeof row.reason !== 'string' ||
        row.reason.trim().length === 0 || Buffer.byteLength(row.reason, 'utf8') > MAX_REASON_BYTES) throw Error('PROTOCOL_ARGUMENT_INVALID');
    const refundAmount = amount(row.refundAmount);
    if (BigInt(refundAmount) > BigInt(amount(limits.maxActionAmount)) ||
        (row.outcome === 0 ? BigInt(refundAmount) !== 0n : BigInt(refundAmount) === 0n)) throw Error('PROTOCOL_LIMIT');
    return { kind: 'finalizeClaim', coverageId: id(row.coverageId), outcome: row.outcome,
      refundAmount, reason: row.reason };
  }
  throw Error('PROTOCOL_FORBIDDEN');
}

export function planOperation(operation: Operation, actor: Address, config: ProtocolConfig, decisionHash?: Hex,
  registeredProvider?: Readonly<{ owner: Address; payout: Address }>): FixedPlan {
  const review: Record<string, string | number | boolean> = { ...operation } as unknown as Record<string, string | number | boolean>;
  let to = config.pilot.core;
  let data: Hex;
  let policyHash: Hex | undefined;
  let normalizedDecisionHash: Hex | undefined;
  switch (operation.kind) {
    case 'registerProvider':
      data = encodeFunctionData({ abi: CORE_ABI, functionName: 'registerProvider', args: [operation.providerId, operation.owner, operation.payout] });
      break;
    case 'registerPolicy': {
      if (!registeredProvider) throw Error('PROTOCOL_STATE_UNAVAILABLE');
      const owner = registeredProvider.owner;
      const payout = registeredProvider.payout;
      policyHash = canonicalPolicyHash({ providerId: operation.providerId, policyId: operation.policyId, owner, payout,
        premiumBps: operation.premiumBps, stakeBps: operation.stakeBps, withholdingBps: operation.withholdingBps,
        duration: BigInt(operation.duration), poolOnlyAllowed: operation.poolOnlyAllowed });
      review.policyHash = policyHash;
      data = encodeFunctionData({ abi: CORE_ABI, functionName: 'registerPolicy', args: [operation.policyId, operation.providerId,
        operation.premiumBps, operation.stakeBps, operation.withholdingBps, BigInt(operation.duration), operation.poolOnlyAllowed] });
      break;
    }
    case 'setPaused':
      data = encodeFunctionData({ abi: CORE_ABI, functionName: 'setPaused', args: [operation.paused] });
      break;
    case 'approveCore':
      to = config.pilot.token;
      data = encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [config.pilot.core, BigInt(operation.amount)] });
      break;
    case 'depositStake':
      data = encodeFunctionData({ abi: CORE_ABI, functionName: 'depositStake', args: [operation.providerId, BigInt(operation.amount)] });
      break;
    case 'withdrawStake':
      data = encodeFunctionData({ abi: CORE_ABI, functionName: 'withdrawStake', args: [operation.providerId, BigInt(operation.amount)] });
      break;
    case 'fundPool':
      data = encodeFunctionData({ abi: CORE_ABI, functionName: 'fundPool', args: [BigInt(operation.amount)] });
      break;
    case 'finalizeClaim': {
      normalizedDecisionHash = decisionHash ?? keccak256(toBytes(`assurepay-preview:${operation.coverageId}:${operation.outcome}:${operation.refundAmount}`));
      if (same(normalizedDecisionHash, ZERO32)) throw Error('PROTOCOL_ARGUMENT_INVALID');
      review.reasonHash = keccak256(toBytes(operation.reason));
      delete review.reason;
      review.decisionCommitment = 'created-after-confirmation';
      data = encodeFunctionData({ abi: CORE_ABI, functionName: 'finalizeClaim', args: [operation.coverageId, operation.outcome,
        BigInt(operation.refundAmount), normalizedDecisionHash] });
      break;
    }
  }
  return Object.freeze({ to, data, value: 0n, gas: ACTION_GAS[operation.kind], review: Object.freeze(review),
    ...(policyHash ? { policyHash } : {}), ...(normalizedDecisionHash ? { decisionHash: normalizedDecisionHash } : {}) });
}

export function operationKey(operation: Operation): Hex {
  return keccak256(toBytes(JSON.stringify(operation)));
}
