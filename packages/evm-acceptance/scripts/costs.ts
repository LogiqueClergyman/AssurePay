import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EVIDENCE = join(ROOT, 'evidence');
const KINDS = ['deploy','provider','policy','approve','stake','pool','purchaseA','claimA','resolveA','purchaseB','claimB','resolveB','pause','revert'] as const;
const GAS_CAPS = [3200000n,150000n,200000n,100000n,170000n,110000n,800000n,100000n,220000n,800000n,100000n,220000n,80000n,800000n] as const;
const ACTORS = ['relayer','payer','provider','adjudicator'] as const;
const START_TARGETS: Record<typeof ACTORS[number], bigint> = {
  relayer: 703000000000000n, payer: 108000000000000n,
  provider: 0n, adjudicator: 94000000000000n,
};
const FUNDING_TARGETS: Record<string, { actor: string; value: bigint }> = {
  relayer: { actor: 'relayer', value: 302480018003071n },
  payer: { actor: 'payer', value: 108000000000000n },
  adjudicator: { actor: 'adjudicator', value: 94000000000000n },
};
const SECOND_TOPUP_ACTORS = ['relayer','payer'] as const;
const MANAGED_VAULT = '0x7a776d8f819b33f50ef85d37effcb5bdd2714756';
const MAX_CAMPAIGN_FEE = 905000000000000n;
const FIRST_FUNDING_FEE = 9300000000000n;
const SECOND_FUNDING_FEE = 6200000000000n;

function fail(): never { throw new Error('M5_COST_EVIDENCE_INVALID'); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  return value as Record<string, any>;
}
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) return fail();
  const n = BigInt(value); if (n >= 1n << 256n) return fail(); return n;
}
function hash(value: unknown): value is Hex { return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value); }
function address(value: unknown): value is Address { return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value); }
function sum(values: bigint[]): bigint { return values.reduce((a, b) => a + b, 0n); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function addTo(map: Record<string, bigint>, key: string, amount: bigint): void { map[key] = (map[key] ?? 0n) + amount; }
async function load(name: string): Promise<any> {
  const path = join(EVIDENCE, name);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 2_000_000) return fail();
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fail(); }
}
async function loadManifest(): Promise<any> {
  let source: any;
  try { source = await load('public-campaign-manifest.json'); }
  catch { source = await load('public-reconciliation.json'); }
  const wrapper = object(source);
  if (Object.hasOwn(wrapper, 'manifest')) {
    if (wrapper.ok !== true || wrapper.code !== 'M5_READ_ONLY_RECONCILED') return fail();
    return wrapper.manifest;
  }
  return wrapper;
}
async function loadSecondManifest(): Promise<any> {
  const wrapper = object(await load('second-public-reconciliation.json'));
  if (wrapper.ok !== true || wrapper.code !== 'M5_SECOND_READ_ONLY_RECONCILED') return fail();
  return object(wrapper.manifest);
}
function actorFor(from: string, roles: Record<string, string>): string {
  const matches = ACTORS.filter((actor) => roles[actor] === from);
  if (matches.length !== 1) return fail();
  return matches[0]!;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const second = args.length === 1 && args[0] === '--second';
  if (!(args.length === 0 || second)) return fail();
  const verificationName = second ? 'second-public-verification.json' : 'public-verification.json';
  const fundingName = second ? 'second-public-funding.json' : 'public-funding-reconciliation.json';
  const [verificationRaw, manifestRaw, fundingRaw, fundedPreflightRaw, proposalRaw] = await Promise.all([
    load(verificationName), second ? loadSecondManifest() : loadManifest(), load(fundingName),
    second ? Promise.resolve(undefined) : load('public-funded-preflight.json'),
    second ? load('second-attempt-proposal.json') : Promise.resolve(undefined),
  ]);
  const verification = object(verificationRaw);
  const manifest = object(manifestRaw);
  const config = object(manifest.config);
  const roles = object(config.roles) as Record<string, string>;
  const funding = object(fundingRaw);
  const fundingPlan = object(funding.plan);
  const proposal = second ? object(proposalRaw) : undefined;
  const proposalConfig = second ? object(proposal!.config) : undefined;
  const proposalFundingPlan = second ? object(proposal!.fundingPlan) : undefined;
  const proposalFundingRoles = second ? object(proposalFundingPlan!.roles) : undefined;
  const fundedPreflight = second ? undefined : object(fundedPreflightRaw);
  const maxFundingFee = second ? SECOND_FUNDING_FEE : FIRST_FUNDING_FEE;
  const maxTotalFee = MAX_CAMPAIGN_FEE + maxFundingFee;
  const expectedPlanTransfers = second ? proposalFundingPlan!.transfers : fundingPlan.transfers;
  const vrows = verification.transactions;
  const mrows = manifest.transactions;
  if (verification.ok !== true || verification.code !== 'M5_PUBLIC_CHAIN_VERIFIED' ||
      !Array.isArray(vrows) || vrows.length !== KINDS.length ||
      manifest.version !== 1 || manifest.core === null || config.mode !== 'public' || config.chainId !== 84532 ||
      !Array.isArray(mrows) || mrows.length !== KINDS.length || config.token !== '0x036cbd53842c5426634e7929541ec2318f3dcf7e' ||
      !ACTORS.every((actor) => address(roles[actor])) ||
      verification.limits?.finality !== false || verification.limits?.httpProvenFromChain !== false ||
      verification.limits?.postReceiveRollbackProven !== false ||
      funding.ok !== true || funding.code !== 'funding_complete' || funding.state !== 'complete' || funding.mode !== 'public' ||
      fundingPlan.ready !== true || !Array.isArray(fundingPlan.transfers) ||
      decimal(fundingPlan.totalFeeAllowanceWei) !== maxFundingFee ||
      !Array.isArray(expectedPlanTransfers) ||
      (second && (proposal!.version !== 1 || proposal!.scope !== 'm5-second-campaign-after-expired-first' ||
        Object.keys(proposal!).length !== 4 || !['version','scope','config','fundingPlan'].every((key) => Object.hasOwn(proposal!, key)) ||
        canonical(config) !== canonical(proposalConfig) ||
        canonical(fundingPlan) !== canonical(proposalFundingPlan) ||
        proposalFundingPlan!.mode !== 'public' || proposalFundingPlan!.chainId !== 84532 ||
        proposalFundingPlan!.runId !== config.runId || proposalFundingPlan!.vault !== MANAGED_VAULT ||
        expectedPlanTransfers.length !== SECOND_TOPUP_ACTORS.length ||
        Object.keys(proposalFundingRoles!).length !== 3 ||
        !(['relayer','payer','adjudicator'] as const).every((actor) => {
          const row = object(proposalFundingRoles![actor]);
          return row.actor === actor && row.address === roles[actor] && row.targetWei === START_TARGETS[actor].toString();
        }) ||
        !SECOND_TOPUP_ACTORS.every((actor, i) => {
          const transfer = object(expectedPlanTransfers[i]);
          return transfer.actor === actor && transfer.from === MANAGED_VAULT && transfer.to === roles[actor] &&
            transfer.targetWei === START_TARGETS[actor].toString() && transfer.gas === '21000' &&
            transfer.maxFeePerGas === '100000000' && transfer.maxPriorityFeePerGas === '1000000' &&
            transfer.auxiliaryReserveWei === '1000000000000';
        })) )) return fail();

  const starts: Record<string, bigint> = {};
  const ends: Record<string, bigint> = {};
  const knownExecution: Record<string, bigint> = {};
  const knownL1: Record<string, bigint> = {};
  const knownOperator: Record<string, bigint> = {};
  const l1Unavailable: Record<string, number> = {};
  const operatorUnavailable: Record<string, number> = {};
  const lastVerified: any = vrows.at(-1);
  const firstVerified: any = vrows[0];
  const startBlockNumber = decimal(firstVerified.blockNumber) - 1n;
  const finalBlockNumber = decimal(lastVerified.blockNumber);
  if (startBlockNumber < 0n || lastVerified.kind !== 'revert' || !hash(lastVerified.blockHash)) return fail();

  const client = createPublicClient({ chain: baseSepolia, transport: http(baseSepolia.rpcUrls.default.http[0]!, { retryCount: 0, timeout: 15000 }), cacheTime: 0 });
  if (await client.getChainId() !== 84532) return fail();
  const [startHeader, finalHeader] = await Promise.all([
    client.getBlock({ blockNumber: startBlockNumber }), client.getBlock({ blockNumber: finalBlockNumber }),
  ]);
  if (!startHeader.hash || !finalHeader.hash || finalHeader.hash.toLowerCase() !== String(lastVerified.blockHash).toLowerCase()) return fail();
  const anchorsToRecheck: Array<{ number: bigint; hash: Hex }> = [
    { number: startBlockNumber, hash: startHeader.hash },
    { number: finalBlockNumber, hash: finalHeader.hash },
  ];

  const roleAddresses = Object.fromEntries(ACTORS.map((actor) => [actor, roles[actor] as Address])) as Record<typeof ACTORS[number], Address>;
  for (const actor of ACTORS) {
    const before = await client.getBalance({ address: roleAddresses[actor], blockNumber: startBlockNumber });
    const after = await client.getBalance({ address: roleAddresses[actor], blockNumber: finalBlockNumber });
    if (before !== START_TARGETS[actor] || before < after) return fail();
    starts[actor] = before; ends[actor] = after;
  }

  for (let i = 0; i < KINDS.length; i++) {
    const kind = KINDS[i]!;
    const verified = object(vrows[i]);
    const record = object(mrows[i]);
    if (verified.kind !== kind || record.kind !== kind || !hash(verified.transaction) ||
        verified.transaction !== record.transaction || !hash(verified.blockHash) ||
        verified.blockNumber !== record.blockNumber || verified.blockHash !== record.blockHash ||
        record.status !== (i === KINDS.length - 1 ? 'reverted' : 'success') ||
        decimal(record.gas) !== GAS_CAPS[i] || decimal(verified.gasUsed) > decimal(record.gas) ||
        decimal(record.maxFeePerGas) !== 100_000_000n || decimal(record.maxPriorityFeePerGas) !== 1_000_000n) return fail();
    const actor = actorFor(String(record.from).toLowerCase(), Object.fromEntries(ACTORS.map((a) => [a, roles[a].toLowerCase()])));
    const execution = decimal(verified.executionFeeWei);
    const gasFee = decimal(verified.gasUsed) * decimal(verified.effectiveGasPrice);
    if (execution !== gasFee) return fail();
    addTo(knownExecution, actor, execution);
    if (verified.l1FeeWei === 'unavailable') l1Unavailable[actor] = (l1Unavailable[actor] ?? 0) + 1;
    else addTo(knownL1, actor, decimal(verified.l1FeeWei));
    if (verified.operatorFeeWei === 'unavailable') operatorUnavailable[actor] = (operatorUnavailable[actor] ?? 0) + 1;
    else addTo(knownOperator, actor, decimal(verified.operatorFeeWei));
    if (decimal(verified.blockNumber) < startBlockNumber || decimal(verified.blockNumber) > finalBlockNumber) return fail();
    anchorsToRecheck.push({ number: decimal(verified.blockNumber), hash: verified.blockHash });
  }
  if (sum(Object.values(knownExecution)) + sum(Object.values(knownL1)) + sum(Object.values(knownOperator)) > MAX_CAMPAIGN_FEE) return fail();

  const costRows: Record<string, any> = {};
  for (const actor of ACTORS) {
    const balanceDelta = starts[actor]! - ends[actor]!;
    const knownExec = knownExecution[actor] ?? 0n;
    const knownL1Fee = knownL1[actor] ?? 0n;
    const knownOperatorFee = knownOperator[actor] ?? 0n;
    const known = knownExec + knownL1Fee + knownOperatorFee;
    if (balanceDelta < known) return fail();
    costRows[actor] = {
      address: roleAddresses[actor], startBalanceWei: starts[actor]!.toString(), finalBalanceWei: ends[actor]!.toString(),
      balanceDeltaCostWei: balanceDelta.toString(), knownExecutionFeeWei: knownExec.toString(),
      knownL1FeeWei: knownL1Fee.toString(), l1UnavailableReceipts: l1Unavailable[actor] ?? 0,
      knownOperatorFeeWei: knownOperatorFee.toString(), operatorUnavailableReceipts: operatorUnavailable[actor] ?? 0,
      unattributedBalanceDeltaWei: (balanceDelta - known).toString(),
    };
  }

  const transferRows = funding.transactions;
  if (!Array.isArray(transferRows) || transferRows.length !== expectedPlanTransfers.length ||
      (!second && (fundedPreflight!.ok !== true || fundedPreflight!.chainId !== 84532 ||
        fundedPreflight!.observationBlock?.number === undefined || !hash(fundedPreflight!.observationBlock.hash)))) return fail();
  const fundingTotals = { gas: 0n, execution: 0n, auxiliary: 0n, value: 0n, knownL1: 0n, knownOperator: 0n };
  const fundingActors = second ? SECOND_TOPUP_ACTORS : ['relayer','payer','adjudicator'] as const;
  const fundingHashes: any[] = [];
  const fundingObservation = object(fundingPlan.observationBlock);
  const fundedObservation = second ? undefined : object(fundedPreflight!.observationBlock);
  for (const observation of fundedObservation ? [fundingObservation, fundedObservation] : [fundingObservation]) {
    if (!hash(observation.hash)) return fail();
    const block = await client.getBlock({ blockNumber: decimal(observation.number) });
    if (!block.hash || block.hash.toLowerCase() !== observation.hash.toLowerCase()) return fail();
    anchorsToRecheck.push({ number: decimal(observation.number), hash: observation.hash });
  }
  for (let i = 0; i < fundingActors.length; i++) {
    const actor = fundingActors[i]!;
    const item = object(transferRows[i]);
    const planTransfer = object(expectedPlanTransfers[i]);
    const target = second ? planTransfer : FUNDING_TARGETS[actor]!;
    if (item.actor !== actor || item.status !== 'success' || !hash(item.transaction) ||
        typeof item.from !== 'string' || item.from.toLowerCase() !== (second ? String(planTransfer.from).toLowerCase() : MANAGED_VAULT) ||
        item.to?.toLowerCase() !== roles[actor].toLowerCase() || item.to.toLowerCase() !== String(planTransfer.to).toLowerCase() ||
        item.nonce !== planTransfer.nonce || item.valueWei !== (second ? planTransfer.valueWei : target.value.toString()) ||
        item.targetWei !== START_TARGETS[actor]!.toString() || item.targetWei !== planTransfer.targetWei ||
        item.gas !== planTransfer.gas || item.maxFeePerGas !== planTransfer.maxFeePerGas ||
        item.maxPriorityFeePerGas !== planTransfer.maxPriorityFeePerGas || item.feeSource !== 'vault_balance_delta' ||
        !hash(item.blockHash)) return fail();
    const gas = decimal(item.actualGasUsed);
    const execution = gas * decimal(item.effectiveGasPriceWei);
    const auxiliary = decimal(item.actualAuxiliaryFeeWei);
    if (gas !== 21_000n || gas > decimal(planTransfer.gas) || auxiliary > decimal(planTransfer.auxiliaryReserveWei)) return fail();
    const l1 = item.l1FeeWei === 'unavailable' ? 0n : decimal(item.l1FeeWei);
    if (item.operatorFeeWei !== 'unavailable' && (typeof item.operatorFeeWei !== 'string' || !/^(0|[1-9][0-9]*)$/.test(item.operatorFeeWei))) return fail();
    const operator = item.operatorFeeWei === 'unavailable' ? 0n : decimal(item.operatorFeeWei);
    if (auxiliary < l1 + operator) return fail();
    fundingTotals.gas += gas; fundingTotals.execution += execution; fundingTotals.auxiliary += auxiliary; fundingTotals.value += decimal(item.valueWei);
    fundingTotals.knownL1 += l1; fundingTotals.knownOperator += operator;
    const block = decimal(item.blockNumber);
    const header = await client.getBlock({ blockNumber: block });
    if (!header.hash || header.hash.toLowerCase() !== item.blockHash.toLowerCase()) return fail();
    anchorsToRecheck.push({ number: block, hash: item.blockHash });
    fundingHashes.push({ actor, transaction: item.transaction, blockNumber: item.blockNumber, blockHash: item.blockHash });
  }
  const fundingFee = fundingTotals.execution + fundingTotals.auxiliary;
  const campaignFee = sum(Object.values(costRows).map((row: any) => BigInt(row.balanceDeltaCostWei)));
  if (fundingTotals.value !== decimal(fundingPlan.transferValueWei) || fundingFee > maxFundingFee || campaignFee + fundingFee > maxTotalFee) return fail();
  if (!second && fundingTotals.value !== 504480018003071n) return fail();

  const finalCanonicality = await Promise.all(anchorsToRecheck.map(async (anchor) => {
    const block = await client.getBlock({ blockNumber: anchor.number });
    return !!block.hash && block.hash.toLowerCase() === anchor.hash.toLowerCase();
  }));
  if (finalCanonicality.some((valid) => !valid)) return fail();

  const output = {
    ok: true, code: second ? 'M5_SECOND_PUBLIC_COSTS_RECONCILED' : 'M5_PUBLIC_COSTS_RECONCILED', chainId: 84532,
    ...(second ? { campaignAttempt: 'second' } : {}),
    costBasis: 'canonical native-balance deltas across campaign; funding gas execution and auxiliary from confirmed public funding records',
    assumptions: ['No concurrent use of campaign role accounts and no incoming native transfers during the measured campaign window.'],
    canonicalAnchors: {
      beforeCampaign: { number: startBlockNumber.toString(), hash: startHeader.hash },
      afterCampaign: { number: finalBlockNumber.toString(), hash: finalHeader.hash },
      fundingPlanSnapshot: { number: decimal(fundingObservation.number).toString(), hash: fundingObservation.hash },
      ...(fundedObservation ? { fundedPreflightSnapshot: { number: decimal(fundedObservation.number).toString(), hash: fundedObservation.hash } } : {}),
      ...(second && fundingHashes.length ? { fundingCompletion: fundingHashes.at(-1) } : {}),
      fundingReceipts: fundingHashes,
    },
    campaign: { startBalancesMustMatchBudgetTargets: true, roles: costRows,
      balanceDeltaTotalWei: campaignFee.toString(), approvedFeeAllowanceWei: MAX_CAMPAIGN_FEE.toString(),
      feeComparisonBasis: 'known execution plus reported L1 and operator components',
      operatorUnavailable: Object.values(operatorUnavailable).some((n) => n > 0),
    },
    funding: { gasUsed: fundingTotals.gas.toString(), executionFeeWei: fundingTotals.execution.toString(),
      actualAuxiliaryFeeWei: fundingTotals.auxiliary.toString(), auxiliaryFeeSource: 'vault_balance_delta',
      knownL1FeeWei: fundingTotals.knownL1.toString(), knownOperatorFeeWei: fundingTotals.knownOperator.toString(),
      operatorFeeUnavailable: transferRows.some((item: any) => item.operatorFeeWei === 'unavailable'),
      transferValueWei: fundingTotals.value.toString(), totalFeeWei: fundingFee.toString(),
      totalVaultOutflowWei: (fundingTotals.value + fundingFee).toString(), approvedFeeAllowanceWei: maxFundingFee.toString() },
    totalMeasuredFeeWei: (campaignFee + fundingFee).toString(), approvedTotalFeeAllowanceWei: maxTotalFee.toString(),
    limits: { finality: false, privateHttpNotProvenHere: true,
      ...(second ? {} : { tokenAtomicOutflowVerifiedByIndependentReport: true }) },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

try { await main(); } catch { process.stdout.write(JSON.stringify({ ok: false, code: 'M5_COST_EVIDENCE_INVALID' }) + '\n'); process.exitCode = 1; }
