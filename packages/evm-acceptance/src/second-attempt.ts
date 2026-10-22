import { keccak256, toBytes } from 'viem';
import { validateConfig } from './plan.js';
import { MANAGED_TEST_VAULT } from './preflight.js';
import { validateFundingPlan, type FundingPlan } from './funding.js';
import type { RunConfig } from './types.js';

export const SECOND_ATTEMPT_SCOPE = 'm5-second-campaign-after-expired-first' as const;

export interface SecondAttemptProposal {
  version: 1;
  scope: typeof SECOND_ATTEMPT_SCOPE;
  config: RunConfig;
  fundingPlan: FundingPlan;
}

function fail(code: string): never { throw new Error(code); }

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) fail(code);
  return row;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateSecondAttemptProposal(value: unknown, original: RunConfig): SecondAttemptProposal {
  const root = exactObject(value, ['version', 'scope', 'config', 'fundingPlan'], 'M5_SECOND_PROPOSAL_INVALID');
  if (root.version !== 1 || root.scope !== SECOND_ATTEMPT_SCOPE) fail('M5_SECOND_PROPOSAL_SCOPE');
  let config: RunConfig;
  try { config = validateConfig(root.config); } catch { return fail('M5_SECOND_PROPOSAL_CONFIG'); }
  if (config.mode !== 'public' || config.chainId !== original.chainId || config.token !== original.token ||
      config.resourceUrl !== original.resourceUrl || config.maxFeePerGas !== original.maxFeePerGas ||
      config.maxPriorityFeePerGas !== original.maxPriorityFeePerGas ||
      Object.keys(config.roles).some((actor) => config.roles[actor as keyof RunConfig['roles']] !== original.roles[actor as keyof RunConfig['roles']])) {
    fail('M5_SECOND_PROPOSAL_CONTEXT');
  }
  if (config.runId === original.runId || config.providerId === original.providerId ||
      config.policyId === original.policyId || config.serviceId === original.serviceId) {
    fail('M5_SECOND_PROPOSAL_IDS_NOT_FRESH');
  }
  const derive = (name: string) => keccak256(toBytes(`${config.runId}:${name}`));
  if (config.providerId !== derive('provider') || config.policyId !== derive('policy') || config.serviceId !== derive('service')) {
    fail('M5_SECOND_PROPOSAL_IDS_INVALID');
  }
  let plan: FundingPlan;
  try { plan = validateFundingPlan(root.fundingPlan, config, MANAGED_TEST_VAULT); }
  catch { return fail('M5_SECOND_PROPOSAL_FUNDING_PLAN'); }
  if (!plan.ready || plan.code !== 'ready' || plan.transfers.length < 1) fail('M5_SECOND_PROPOSAL_FUNDING_PLAN');
  return { version: 1, scope: SECOND_ATTEMPT_SCOPE, config, fundingPlan: plan };
}

export function assertOriginalRuntimeMatches(proposal: SecondAttemptProposal, original: RunConfig): void {
  if (proposal.config.mode !== original.mode || proposal.config.chainId !== original.chainId ||
      proposal.config.token !== original.token || proposal.config.resourceUrl !== original.resourceUrl ||
      proposal.config.maxFeePerGas !== original.maxFeePerGas ||
      proposal.config.maxPriorityFeePerGas !== original.maxPriorityFeePerGas ||
      Object.keys(proposal.config.roles).some((actor) =>
        proposal.config.roles[actor as keyof RunConfig['roles']] !== original.roles[actor as keyof RunConfig['roles']])) {
    fail('M5_SECOND_PROPOSAL_RUNTIME_MISMATCH');
  }
}

/** Ignore only the observation block; every proposed amount, nonce, address, and allowance stays pinned. */
export function assertFundingPlanMatchesProposal(proposed: FundingPlan, observed: FundingPlan): void {
  const { observationBlock: _proposedAnchor, ...pinnedProposal } = proposed;
  const { observationBlock: _observedAnchor, ...pinnedObserved } = observed;
  if (canonical(pinnedProposal) !== canonical(pinnedObserved)) fail('M5_SECOND_FUNDING_PLAN_CHANGED');
}

export async function assertProposalAnchor(client: { getBlock(args: { blockNumber: bigint }): Promise<{ hash: string | null }> }, plan: FundingPlan): Promise<void> {
  const block = await client.getBlock({ blockNumber: BigInt(plan.observationBlock.number) });
  if (!block.hash || block.hash.toLowerCase() !== plan.observationBlock.hash.toLowerCase()) {
    fail('M5_SECOND_PROPOSAL_ANCHOR_CHANGED');
  }
}

export async function assertSpendingRoleNonces(client: {
  getTransactionCount(args: { address: `0x${string}`; blockTag: 'latest' | 'pending' }): Promise<number>;
}, config: RunConfig, plan: FundingPlan): Promise<void> {
  for (const actor of ['relayer', 'payer', 'adjudicator'] as const) {
    const address = config.roles[actor];
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address, blockTag: 'latest' }),
      client.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    if (latest !== pending || BigInt(latest) !== BigInt(plan.roles[actor].nonce)) {
      fail('M5_SECOND_ROLE_NONCE_CHANGED');
    }
  }
}
