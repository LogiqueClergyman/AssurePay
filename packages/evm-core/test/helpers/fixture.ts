import assert from 'node:assert/strict';
import { pad, toHex, type Address, type Hex } from 'viem';
import {
  compileContracts, deploy, signReceive, startEvm, transact,
  type Evm,
} from './evm.js';
import { hashIntent, hashPolicy, type Intent, type PolicyTerms, typeIntent } from './intent.js';

export const STATUS = { none: 0, active: 1, claimPending: 2, refunded: 3, rejected: 4, expired: 5 } as const;
export const OUTCOME = { reject: 0, providerFault: 1, poolOnly: 2 } as const;

const id = (n: number): Hex => pad(toHex(n), { size: 32 });
let saltCounter = 100;

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function fixture(options: {
  pool?: bigint;
  providerStake?: bigint;
  payerBalance?: bigint;
  secondProviderStake?: bigint;
} = {}) {
  const evm = await startEvm();
  const artifacts = compileContracts();
  const tokenAbi = artifacts.AuthorizationTokenMock.abi as any;
  const coreAbi = artifacts.AssuranceCore.abi as any;
  const token = await deploy(evm, artifacts.AuthorizationTokenMock);
  const core = await deploy(evm, artifacts.AssuranceCore, [token, evm.owner.address, evm.outsider.address]);

  const providerId = id(1);
  const secondProviderId = id(2);
  const policyId = id(11);
  const nonPoolPolicyId = id(12);
  const policy: PolicyTerms = {
    providerId, policyId, providerOwner: evm.provider.address, providerPayout: evm.outsider.address,
    premiumBps: 777, stakeBps: 3500, withholdingBps: 2200, duration: 120n, poolOnlyAllowed: true,
  };
  const nonPoolPolicy: PolicyTerms = {
    providerId, policyId: nonPoolPolicyId, providerOwner: evm.provider.address,
    providerPayout: evm.outsider.address, premiumBps: 777, stakeBps: 3500,
    withholdingBps: 2200, duration: 120n, poolOnlyAllowed: false,
  };
  const secondPolicy: PolicyTerms = {
    providerId: secondProviderId, policyId: id(13), providerOwner: evm.payer.address,
    providerPayout: evm.owner.address, premiumBps: 1250, stakeBps: 2500,
    withholdingBps: 1000, duration: 240n, poolOnlyAllowed: false,
  };

  await transact(evm, coreAbi, core, 'registerProvider', [providerId, policy.providerOwner, policy.providerPayout]);
  await transact(evm, coreAbi, core, 'registerProvider', [secondProviderId, secondPolicy.providerOwner, secondPolicy.providerPayout]);
  await transact(evm, coreAbi, core, 'registerPolicy', [policyId, providerId, policy.premiumBps, policy.stakeBps,
    policy.withholdingBps, policy.duration, policy.poolOnlyAllowed]);
  await transact(evm, coreAbi, core, 'registerPolicy', [nonPoolPolicyId, providerId, nonPoolPolicy.premiumBps,
    nonPoolPolicy.stakeBps, nonPoolPolicy.withholdingBps, nonPoolPolicy.duration, nonPoolPolicy.poolOnlyAllowed]);
  await transact(evm, coreAbi, core, 'registerPolicy', [secondPolicy.policyId, secondProviderId,
    secondPolicy.premiumBps, secondPolicy.stakeBps, secondPolicy.withholdingBps,
    secondPolicy.duration, secondPolicy.poolOnlyAllowed]);

  const amounts = [
    [evm.payer.address, options.payerBalance ?? 2_000_000n],
    [evm.provider.address, options.providerStake ?? 1_000_000n],
    [evm.payer.address, options.secondProviderStake ?? 0n],
    [evm.owner.address, options.pool ?? 1_000_000n],
  ] as const;
  // Mint once per account with summed amounts; fixture signers are ephemeral Anvil accounts.
  const mintTotals = new Map<Address, bigint>();
  for (const [account, amount] of amounts) mintTotals.set(account, (mintTotals.get(account) ?? 0n) + amount);
  for (const [account, amount] of mintTotals) if (amount > 0n) await transact(evm, tokenAbi, token, 'mint', [account, amount]);
  if ((options.providerStake ?? 1_000_000n) > 0n) {
    await transact(evm, tokenAbi, token, 'approve', [core, options.providerStake ?? 1_000_000n], evm.provider);
    await transact(evm, coreAbi, core, 'depositStake', [providerId, options.providerStake ?? 1_000_000n], evm.provider);
  }
  if ((options.secondProviderStake ?? 0n) > 0n) {
    await transact(evm, tokenAbi, token, 'approve', [core, options.secondProviderStake], evm.payer);
    await transact(evm, coreAbi, core, 'depositStake', [secondProviderId, options.secondProviderStake], evm.payer);
  }
  if ((options.pool ?? 1_000_000n) > 0n) {
    await transact(evm, tokenAbi, token, 'approve', [core, options.pool ?? 1_000_000n]);
    await transact(evm, coreAbi, core, 'fundPool', [options.pool ?? 1_000_000n]);
  }

  async function read(address: Address, abi: any, functionName: string, args: readonly unknown[] = []) {
    return evm.publicClient.readContract({ address, abi, functionName, args });
  }

  async function createIntent(args: {
    payer?: Evm['payer'];
    policy?: PolicyTerms;
    gross?: bigint;
    request?: Hex;
    salt?: Hex;
    validAfter?: bigint;
    validBefore?: bigint;
  } = {}) {
    const payer = args.payer ?? evm.payer;
    const selectedPolicy = args.policy ?? policy;
    const block = await evm.publicClient.getBlock({ blockTag: 'latest' });
    const now = block.timestamp;
    const intent: Intent = {
      chainId: '84532', core, token, payer: payer.address,
      providerId: selectedPolicy.providerId, policyId: selectedPolicy.policyId,
      policyHash: hashPolicy(selectedPolicy), requestHash: args.request ?? id(++saltCounter),
      gross: String(args.gross ?? 10_003n), payerSalt: args.salt ?? id(++saltCounter),
      validAfter: String(args.validAfter ?? (now - 10n)),
      validBefore: String(args.validBefore ?? (now + 240n)),
    };
    return { intent, payer, typed: typeIntent(intent), coverageId: hashIntent(intent), signature: await signReceive(payer, intent) };
  }

  async function settle(input: Awaited<ReturnType<typeof createIntent>>) {
    return transact(evm, coreAbi, core, 'settleAssured', [input.typed, input.signature.v,
      input.signature.r, input.signature.s]);
  }

  async function provider(id_: Hex = providerId) {
    const result = await read(core, coreAbi, 'providers', [id_]) as readonly unknown[];
    return { owner: result[0] as Address, payout: result[1] as Address,
      free: result[2] as bigint, locked: result[3] as bigint };
  }

  async function coverage(coverageId: Hex) {
    const result = await read(core, coreAbi, 'coverages', [coverageId]) as readonly unknown[];
    return {
      payer: result[0] as Address, providerId: result[1] as Hex, policyId: result[2] as Hex,
      policyHash: result[3] as Hex, requestHash: result[4] as Hex, gross: result[5] as bigint,
      premium: result[6] as bigint, withheld: result[7] as bigint, stakeLock: result[8] as bigint,
      poolReservation: result[9] as bigint, openedAt: result[10] as bigint, expiresAt: result[11] as bigint,
      poolOnlyAllowed: result[12] as boolean, status: Number(result[13]),
      evidenceHash: result[14] as Hex, decisionHash: result[15] as Hex,
      refundAmount: result[16] as bigint, outcome: Number(result[17]),
    };
  }

  async function quote(selectedPolicy: PolicyTerms, gross: bigint) {
    const values = await read(core, coreAbi, 'quoteSettlement', [selectedPolicy.policyId, gross]) as readonly bigint[];
    return { premium: values[0]!, withheld: values[1]!, net: values[2]!, stakeLock: values[3]!, poolReservation: values[4]! };
  }

  async function globals() {
    const names = ['poolAssets', 'totalPoolReserved', 'totalProviderStake', 'totalLockedStake',
      'coverageCount', 'activeCoverageCount'] as const;
    const values = await Promise.all(names.map(name => read(core, coreAbi, name)));
    return Object.fromEntries(names.map((name, index) => [name, values[index] as bigint])) as Record<typeof names[number], bigint>;
  }

  async function balance(address: Address) { return read(token, tokenAbi, 'balanceOf', [address]) as Promise<bigint>; }
  async function authorizationUsed(address: Address, nonce: Hex) {
    return Boolean(await read(token, tokenAbi, 'authorizationState', [address, nonce]));
  }

  return { evm, token, core, tokenAbi, coreAbi, providerId, secondProviderId, policy, nonPoolPolicy, secondPolicy,
    read, createIntent, settle, provider, coverage, quote, globals, balance, authorizationUsed,
    close: () => evm.close() };
}

export async function expectInvariant(f: Fixture, providerIds: readonly Hex[], coverageIds: readonly Hex[]) {
  const g = await f.globals();
  let providerStake = 0n;
  let lockedStake = 0n;
  for (const providerId of providerIds) {
    const p = await f.provider(providerId);
    providerStake += p.free + p.locked;
    lockedStake += p.locked;
  }
  let reserved = 0n;
  let coverageLocks = 0n;
  let active = 0n;
  let statusCount = 0n;
  for (const coverageId of coverageIds) {
    const c = await f.coverage(coverageId);
    if (c.status === STATUS.active || c.status === STATUS.claimPending) {
      reserved += c.poolReservation;
      coverageLocks += c.stakeLock;
      active += 1n;
    }
    if (c.status !== STATUS.none) statusCount += 1n;
  }
  assert.equal(g.totalProviderStake, providerStake);
  assert.equal(g.totalLockedStake, lockedStake);
  assert.equal(g.totalLockedStake, coverageLocks);
  assert.equal(g.totalPoolReserved, reserved);
  assert.equal(g.coverageCount, statusCount);
  assert.equal(g.activeCoverageCount, active);
  assert.ok(g.poolAssets >= g.totalPoolReserved);
  assert.ok(g.totalProviderStake >= g.totalLockedStake);
  assert.ok(await f.balance(f.core).then(b => b >= g.poolAssets + g.totalProviderStake));
  return g;
}

export function outcomeArg(value: number) { assert.ok(value >= 0 && value <= 2); return value; }
