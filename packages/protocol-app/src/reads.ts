import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseAbiItem, type Address, type Hex } from 'viem';
import { createProjection } from '../../claims-backend/src/projection.js';
import { contextFor } from '../../developer-pilot/src/config.js';
import { address, amount, exact, id, same } from './common.js';
import { validateProtocolConfig } from './config.js';
import { CORE_ABI, TOKEN_ABI } from './abi.js';
import { canonicalPolicyHash } from './policy.js';
import type { Anchor, CoverageRow, PolicyRow, ProviderRow, ProtocolConfig, ReadSnapshot, Summary } from './types.js';

const PROVIDER_EVENT = parseAbiItem('event ProviderRegistered(bytes32 indexed providerId, address indexed owner, address indexed payout)');
const POLICY_EVENT = parseAbiItem('event PolicyRegistered(bytes32 indexed policyId, bytes32 indexed providerId, bytes32 policyHash, uint16 premiumBps, uint16 stakeBps, uint16 withholdingBps, uint64 duration, bool poolOnlyAllowed)');
const ZERO_ID = `0x${'0'.repeat(64)}`;
const MAX_BLOCKS = 25_000n;
const MAX_REGISTRY_ROWS = 100;
const REGISTRY_CHUNK = 100n;

type ReadModelOptions = { config: ProtocolConfig; client: any; directory: string };
type RawLog = Record<string, any>;

function fail(code: string): never { throw new Error(code); }
function rpc<T>(promise: Promise<T>): Promise<T> { return promise.catch(() => fail('PROTOCOL_RPC_UNAVAILABLE')); }
function big(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << 256n)) fail('PROTOCOL_STATE_UNAVAILABLE');
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('PROTOCOL_STATE_UNAVAILABLE');
  return value;
}
function hex32(value: unknown, allowZero = false): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail('PROTOCOL_STATE_UNAVAILABLE');
  const normalized = value.toLowerCase();
  if (!allowZero && normalized === ZERO_ID) fail('PROTOCOL_STATE_UNAVAILABLE');
  return normalized as Hex;
}
function addr(value: unknown, allowZero = false): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail('PROTOCOL_STATE_UNAVAILABLE');
  const normalized = value.toLowerCase();
  if (!allowZero && normalized === `0x${'0'.repeat(40)}`) fail('PROTOCOL_STATE_UNAVAILABLE');
  return normalized as Address;
}
function decimal(value: bigint): string { return value.toString(10); }
function tuple(value: unknown, length: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== length) fail('PROTOCOL_STATE_UNAVAILABLE');
  return value;
}
function projectionError(error: unknown): never {
  let code = '';
  try { code = error instanceof Error ? error.message : ''; } catch { /* use fixed fallback */ }
  if (code === 'PROJECTION_BLOCK_LIMIT' || code === 'PROJECTION_COVERAGE_LIMIT') fail('PROTOCOL_LIMIT');
  if (code === 'PROJECTION_CONTEXT_MISMATCH') fail('PROTOCOL_CONTEXT_MISMATCH');
  if (code === 'PROJECTION_HEAD_CHANGED' || code === 'PROJECTION_CANONICAL_MISMATCH') fail('PROTOCOL_REORG');
  if (code === 'PROJECTION_CHECKPOINT_INVALID' || code === 'PROJECTION_STORAGE_FAILED') fail('PROTOCOL_STORAGE_INVALID');
  if (code === 'PROJECTION_RPC_FAILED') fail('PROTOCOL_RPC_UNAVAILABLE');
  fail('PROTOCOL_STATE_UNAVAILABLE');
}
function uint16(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65_535) fail('PROTOCOL_STATE_UNAVAILABLE');
  return value;
}
function coverageStatus(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 5) fail('PROTOCOL_STATE_UNAVAILABLE');
  return value;
}
function outcome(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2) fail('PROTOCOL_STATE_UNAVAILABLE');
  return value;
}
function canonicalAnchor(number: unknown, hash: unknown, timestamp: unknown): Anchor {
  if (typeof number !== 'bigint' || number < 0n || typeof timestamp !== 'bigint' || timestamp < 0n) fail('PROTOCOL_STATE_UNAVAILABLE');
  const blockHash = hex32(hash);
  return { number: decimal(number), hash: blockHash, timestamp: decimal(timestamp) };
}
function mapProviderTuple(value: unknown): { owner: Address; payout: Address; freeStake: bigint; lockedStake: bigint } {
  const raw = tuple(value, 4);
  return { owner: addr(raw[0]), payout: addr(raw[1]), freeStake: big(raw[2]), lockedStake: big(raw[3]) };
}
function mapPolicyTuple(value: unknown): { providerId: Hex; policyHash: Hex; premiumBps: number; stakeBps: number; withholdingBps: number; duration: bigint; poolOnlyAllowed: boolean } {
  const raw = tuple(value, 7);
  const providerId = hex32(raw[0]);
  return { providerId, policyHash: hex32(raw[1]), premiumBps: uint16(raw[2]), stakeBps: uint16(raw[3]),
    withholdingBps: uint16(raw[4]), duration: big(raw[5]), poolOnlyAllowed: bool(raw[6]) };
}
function logNumber(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return -1n;
}
function validLog(log: RawLog, core: Address, head: bigint, fromBlock = 0n): { blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logIndex: bigint; transactionIndex: bigint } {
  const logIndex = logNumber(log?.logIndex), transactionIndex = logNumber(log?.transactionIndex);
  if (!log || log.removed === true || addr(log.address) !== core || typeof log.blockNumber !== 'bigint'
    || log.blockNumber < fromBlock || log.blockNumber > head || logIndex < 0n || transactionIndex < 0n) fail('PROTOCOL_STATE_UNAVAILABLE');
  return { blockNumber: log.blockNumber, blockHash: hex32(log.blockHash), transactionHash: hex32(log.transactionHash), logIndex, transactionIndex };
}
function sorted<T, K extends keyof T>(rows: T[], field: K): T[] {
  return rows.sort((a, b) => String(a[field]).localeCompare(String(b[field])));
}

export function createReadModel(options: ReadModelOptions): { snapshot(): Promise<ReadSnapshot>; assertAnchor(anchor: Anchor): Promise<void> } {
  // Copy and validate caller-owned inputs before any asynchronous work.
  let config: ProtocolConfig;
  let client: any;
  let directory: string;
  try {
    config = validateProtocolConfig(options.config);
    client = options.client;
    directory = resolve(options.directory);
    if (!client || typeof directory !== 'string' || directory.length < 2) fail('PROTOCOL_CONFIG_INVALID');
  } catch { fail('PROTOCOL_CONFIG_INVALID'); }
  const core = address(config!.pilot.core), token = address(config!.pilot.token), expectedAdmin = address(config!.admin);
  const expectedAdjudicator = address(config!.pilot.roles.adjudicator);
  const primaryProviderId = id(config!.pilot.providerId), primaryPolicyId = id(config!.pilot.policyId);
  const fromBlock = BigInt(amount(config!.pilot.deploymentBlock));
  const context = contextFor(config!.pilot);
  let projection: ReturnType<typeof createProjection>;
  try {
    projection = createProjection({ client, context, journalPath: join(directory!, 'projection.json'), fromBlock,
      maxBlocks: Number(MAX_BLOCKS), maxCoverages: 1_000 });
  } catch { fail('PROTOCOL_CONFIG_INVALID'); }

  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };

  async function assertAnchor(anchorInput: Anchor): Promise<void> {
    let anchor: Anchor;
    try {
      const value = exact(anchorInput, ['number', 'hash', 'timestamp']);
      anchor = { number: amount(value.number), hash: hex32(value.hash), timestamp: amount(value.timestamp) };
    } catch { fail('PROTOCOL_CURSOR_INVALID'); }
    let chainId: number;
    try { chainId = await client.getChainId(); } catch { fail('PROTOCOL_RPC_UNAVAILABLE'); }
    if (chainId !== 84532) fail('PROTOCOL_CONTEXT_MISMATCH');
    const number = BigInt(anchor!.number);
    let block: any;
    try { block = await client.getBlock({ blockNumber: number }); }
    catch { fail('PROTOCOL_RPC_UNAVAILABLE'); }
    if (!block || block.number !== number || typeof block.timestamp !== 'bigint' || decimal(block.timestamp) !== anchor!.timestamp
      || !same(hex32(block.hash), anchor!.hash)) fail('PROTOCOL_REORG');
  }

  async function snapshotUnlocked(): Promise<ReadSnapshot> {
    let projected: Awaited<ReturnType<typeof projection.refresh>>;
    try { projected = await projection.refresh(); } catch (error) { projectionError(error); }
    const anchor = canonicalAnchor(BigInt(projected!.head.number), projected!.head.hash, BigInt(projected!.head.timestamp));
    const blockNumber = BigInt(anchor.number);
    const count = BigInt(Object.keys(projected!.coverages).length);
    if (count > 1_000n || blockNumber < fromBlock || blockNumber - fromBlock + 1n > MAX_BLOCKS) fail('PROTOCOL_LIMIT');

    let chainId: number;
    try { chainId = await client.getChainId(); } catch { fail('PROTOCOL_RPC_UNAVAILABLE'); }
    if (chainId !== 84532) fail('PROTOCOL_CONTEXT_MISMATCH');
    let coreCode: Hex | undefined, tokenCode: Hex | undefined;
    try {
      [coreCode, tokenCode] = await Promise.all([
        client.getBytecode({ address: core, blockNumber }), client.getBytecode({ address: token, blockNumber }),
      ]);
    } catch { fail('PROTOCOL_RPC_UNAVAILABLE'); }
    if (!coreCode || coreCode === '0x' || !tokenCode || tokenCode === '0x') fail('PROTOCOL_CONTEXT_MISMATCH');

    const read = (address_: Address, functionName: string, args: readonly unknown[] = []) => rpc(client.readContract({
      address: address_, abi: address_ === token ? TOKEN_ABI : CORE_ABI, functionName, args, blockNumber,
    }));
    let chainIdentity: unknown[];
    let coreState: unknown[];
    let tokenBalance: unknown;
    try {
      [chainIdentity, coreState, tokenBalance] = await Promise.all([
        Promise.all([read(core, 'admin'), read(core, 'adjudicator'), read(core, 'token')]),
        Promise.all([read(core, 'paused'), read(core, 'poolAssets'), read(core, 'totalPoolReserved'), read(core, 'totalProviderStake'),
          read(core, 'totalLockedStake'), read(core, 'coverageCount'), read(core, 'activeCoverageCount')]),
        read(token, 'balanceOf', [core]),
      ]);
    } catch { fail('PROTOCOL_RPC_UNAVAILABLE'); }
    if (addr(chainIdentity![0]) !== expectedAdmin || addr(chainIdentity![1]) !== expectedAdjudicator || addr(chainIdentity![2]) !== token)
      fail('PROTOCOL_CONTEXT_MISMATCH');
    const totalCoverage = big(coreState![5]), activeCoverage = big(coreState![6]);
    if (totalCoverage !== count) fail('PROTOCOL_STATE_UNAVAILABLE');

    const providerLogs: RawLog[] = [], policyLogs: RawLog[] = [];
    try {
      for (let start = fromBlock; start <= blockNumber; start += REGISTRY_CHUNK) {
        const end = start + REGISTRY_CHUNK - 1n < blockNumber ? start + REGISTRY_CHUNK - 1n : blockNumber;
        const [providers, policies] = await Promise.all([
          client.getLogs({ address: core, event: PROVIDER_EVENT, strict: true, fromBlock: start, toBlock: end }),
          client.getLogs({ address: core, event: POLICY_EVENT, strict: true, fromBlock: start, toBlock: end }),
        ]);
        if (!Array.isArray(providers) || !Array.isArray(policies)) fail('PROTOCOL_STATE_UNAVAILABLE');
        for (const log of providers) validLog(log, core, end, start);
        for (const log of policies) validLog(log, core, end, start);
        providerLogs.push(...providers); policyLogs.push(...policies);
        if (providerLogs.length > MAX_REGISTRY_ROWS || policyLogs.length > MAX_REGISTRY_ROWS) fail('PROTOCOL_LIMIT');
      }
    } catch (error) {
      if (error instanceof Error && ['PROTOCOL_LIMIT', 'PROTOCOL_STATE_UNAVAILABLE', 'PROTOCOL_REORG'].includes(error.message)) throw error;
      fail('PROTOCOL_RPC_UNAVAILABLE');
    }

    const blockHashes = new Map<string, Hex>();
    const seenProviderIds = new Set<string>(), seenPolicyIds = new Set<string>();
    const providerEvents = new Map<string, { owner: Address; payout: Address }>();
    const policyEvents = new Map<string, { providerId: Hex; policyHash: Hex; premiumBps: number; stakeBps: number; withholdingBps: number; duration: bigint; poolOnlyAllowed: boolean }>();
    for (const [logs, kind] of [[providerLogs, 'provider'], [policyLogs, 'policy']] as const) {
      let previousOrder: readonly [bigint, bigint, bigint] | undefined;
      const seenLogKeys = new Set<string>();
      for (const log of logs) {
        const meta = validLog(log, core, blockNumber);
        const key = `${meta.blockHash}:${meta.transactionHash}:${meta.logIndex}`;
        const order = [meta.blockNumber, meta.transactionIndex, meta.logIndex] as const;
        if (seenLogKeys.has(key) || (previousOrder && (order[0] < previousOrder[0]
          || (order[0] === previousOrder[0] && order[1] < previousOrder[1])
          || (order[0] === previousOrder[0] && order[1] === previousOrder[1] && order[2] <= previousOrder[2])))) {
          fail('PROTOCOL_STATE_UNAVAILABLE');
        }
        seenLogKeys.add(key); previousOrder = order;
        const previous = blockHashes.get(meta.blockNumber.toString());
        if (previous && previous !== meta.blockHash) fail('PROTOCOL_REORG');
        blockHashes.set(meta.blockNumber.toString(), meta.blockHash);
        const args = log.args;
        if (!args || typeof args !== 'object') fail('PROTOCOL_STATE_UNAVAILABLE');
        if (kind === 'provider') {
          const providerId = hex32(args.providerId), owner = addr(args.owner), payout = addr(args.payout);
          if (seenProviderIds.has(providerId)) fail('PROTOCOL_STATE_UNAVAILABLE');
          seenProviderIds.add(providerId); providerEvents.set(providerId, { owner, payout });
        } else {
          const policyId = hex32(args.policyId), providerId = hex32(args.providerId);
          const row = { providerId, policyHash: hex32(args.policyHash), premiumBps: uint16(args.premiumBps), stakeBps: uint16(args.stakeBps),
            withholdingBps: uint16(args.withholdingBps), duration: big(args.duration), poolOnlyAllowed: bool(args.poolOnlyAllowed) };
          if (seenPolicyIds.has(policyId)) fail('PROTOCOL_STATE_UNAVAILABLE');
          seenPolicyIds.add(policyId); policyEvents.set(policyId, row);
        }
      }
    }
    const historicalBlocks = await Promise.all([...blockHashes].map(async ([number, hash]) => {
      let block: any;
      try { block = await client.getBlock({ blockNumber: BigInt(number) }); } catch { fail('PROTOCOL_RPC_UNAVAILABLE'); }
      if (!block || !same(hex32(block.hash), hash)) fail('PROTOCOL_REORG');
    }));
    void historicalBlocks;

    const providerIds = [...providerEvents.keys()].sort();
    const policyIds = [...policyEvents.keys()].sort();
    const providerRows: ProviderRow[] = [];
    const providerIndex = new Map<string, ProviderRow>();
    for (const providerId of providerIds) {
      const event = providerEvents.get(providerId)!;
      const current = mapProviderTuple(await read(core, 'providers', [providerId as Hex]));
      if (current.owner !== event.owner || current.payout !== event.payout) fail('PROTOCOL_STATE_UNAVAILABLE');
      const net = Object.values(projected!.coverages).filter(c => c.providerId === providerId)
        .reduce((sum, c) => sum + BigInt(c.gross) - BigInt(c.premium) - BigInt(c.withheld), 0n);
      const counts: Record<string, string> = Object.fromEntries([0,1,2,3,4,5].map(status => [String(status), '0']));
      for (const c of Object.values(projected!.coverages)) if (c.providerId === providerId) {
        const status = coverageStatus(c.status); counts[String(status)] = (BigInt(counts[String(status)]) + 1n).toString(10);
      }
      const payoutBalance = big(await read(token, 'balanceOf', [current.payout]));
      const row: ProviderRow = { providerId: providerId as Hex, owner: current.owner, payout: current.payout,
        freeStake: decimal(current.freeStake), lockedStake: decimal(current.lockedStake), payoutBalanceAtomic: decimal(payoutBalance),
        cumulativeNetPaidAtomic: decimal(net), coverageCountsByStatus: counts };
      providerRows.push(row); providerIndex.set(providerId, row);
    }
    const policyRows: PolicyRow[] = [];
    const policyIndex = new Map<string, PolicyRow>();
    for (const policyId of policyIds) {
      const registered = policyEvents.get(policyId)!;
      const current = mapPolicyTuple(await read(core, 'policies', [policyId as Hex]));
      const provider = providerIndex.get(registered.providerId);
      if (!provider || current.providerId !== registered.providerId || current.policyHash !== registered.policyHash
        || current.premiumBps !== registered.premiumBps || current.stakeBps !== registered.stakeBps
        || current.withholdingBps !== registered.withholdingBps || current.duration !== registered.duration
        || current.poolOnlyAllowed !== registered.poolOnlyAllowed) fail('PROTOCOL_STATE_UNAVAILABLE');
      const computedHash = canonicalPolicyHash({ providerId: registered.providerId, policyId: policyId as Hex,
        owner: provider.owner, payout: provider.payout, premiumBps: current.premiumBps, stakeBps: current.stakeBps,
        withholdingBps: current.withholdingBps, duration: current.duration, poolOnlyAllowed: current.poolOnlyAllowed });
      if (computedHash !== current.policyHash) fail('PROTOCOL_STATE_UNAVAILABLE');
      const row: PolicyRow = { policyId: policyId as Hex, providerId: current.providerId, policyHash: current.policyHash,
        premiumBps: current.premiumBps, stakeBps: current.stakeBps, withholdingBps: current.withholdingBps,
        duration: decimal(current.duration), poolOnlyAllowed: current.poolOnlyAllowed };
      policyRows.push(row); policyIndex.set(policyId, row);
    }
    if (!providerIndex.has(primaryProviderId) || !policyIndex.has(primaryPolicyId)) fail('PROTOCOL_CONTEXT_MISMATCH');
    const primaryProvider = providerIndex.get(primaryProviderId)!;
    const primaryPolicy = policyIndex.get(primaryPolicyId)!;
    if (primaryProvider.owner !== address(config!.pilot.roles.provider) || primaryProvider.payout !== address(config!.pilot.roles.provider)
      || primaryPolicy.providerId !== primaryProviderId) fail('PROTOCOL_CONTEXT_MISMATCH');

    const countsByStatus = [0n,0n,0n,0n,0n,0n];
    const coverages: CoverageRow[] = [];
    for (const projectionRow of Object.values(projected!.coverages)) {
      const status = coverageStatus(projectionRow.status);
      const policy = policyIndex.get(projectionRow.policyId);
      if (!providerIndex.has(projectionRow.providerId) || !policy || policy.providerId !== projectionRow.providerId) fail('PROTOCOL_STATE_UNAVAILABLE');
      countsByStatus[status] += 1n;
      if (projectionRow.policyHash !== policy.policyHash || projectionRow.poolOnlyAllowed !== policy.poolOnlyAllowed) fail('PROTOCOL_STATE_UNAVAILABLE');
      const hasEvidence = projectionRow.evidenceHash !== ZERO_ID;
      const row: CoverageRow = { coverageId: projectionRow.coverageId, payer: addr(projectionRow.payer),
        providerId: projectionRow.providerId, policyId: projectionRow.policyId, gross: amount(projectionRow.gross),
        premium: amount(projectionRow.premium), withheld: amount(projectionRow.withheld), stakeLock: amount(projectionRow.stakeLock),
        poolReservation: amount(projectionRow.poolReservation), openedAt: amount(projectionRow.openedAt),
        expiresAt: amount(projectionRow.expiresAt), poolOnlyAllowed: projectionRow.poolOnlyAllowed, status, hasEvidence };
      if (status === 3 || status === 4) { row.outcome = outcome(projectionRow.outcome); row.refundAmount = amount(projectionRow.refundAmount); }
      coverages.push(row);
    }
    const activeFromProjection = countsByStatus[1] + countsByStatus[2];
    if (activeFromProjection !== activeCoverage) fail('PROTOCOL_STATE_UNAVAILABLE');
    const tokenBalanceAtomic = big(tokenBalance!);
    const poolAssets = big(coreState![1]), poolReserved = big(coreState![2]), providerStake = big(coreState![3]), lockedStake = big(coreState![4]);
    const summary: Summary = { paused: bool(coreState![0]), tokenBalanceAtomic: decimal(tokenBalanceAtomic), poolAssets: decimal(poolAssets),
      poolReserved: decimal(poolReserved), providerStake: decimal(providerStake), lockedStake: decimal(lockedStake),
      coverageCount: decimal(totalCoverage), activeCoverageCount: decimal(activeCoverage),
      solvency: { balanceCoversAssetsAndStake: tokenBalanceAtomic >= poolAssets + providerStake,
        stakeCoversLocks: providerStake >= lockedStake, poolCoversReservations: poolAssets >= poolReserved } };

    await assertAnchor(anchor);
    const blockAtAnchor: any = await rpc<any>(client.getBlock({ blockNumber }));
    if (!blockAtAnchor || !same(hex32(blockAtAnchor.hash), anchor.hash)) fail('PROTOCOL_REORG');
    return { anchor, summary, providers: sorted(providerRows, 'providerId'), policies: sorted(policyRows, 'policyId'),
      coverages: sorted(coverages, 'coverageId') };
  }

  return {
    snapshot: () => serialize(async () => {
      try {
        await mkdir(directory!, { recursive: true, mode: 0o700 });
        const stat = await lstat(directory!);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('PROTOCOL_STORAGE_INVALID');
      } catch (error) {
        if (error instanceof Error && error.message === 'PROTOCOL_STORAGE_INVALID') throw error;
        fail('PROTOCOL_STORAGE_INVALID');
      }
      return snapshotUnlocked();
    }),
    assertAnchor: (anchor: Anchor) => serialize(() => assertAnchor(anchor)),
  };
}
