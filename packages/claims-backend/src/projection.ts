import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decodeEventLog, parseAbiItem, type Address, type Hex } from 'viem';
import { contextNamespace, exact, normalizeContext, requireAddress, requireId } from './common.js';
import { CORE_ABI } from './abi.js';
import type { BackendContext, CoverageView, Projection, Snapshot } from './types.js';

const ZERO = `0x${'00'.repeat(32)}` as Hex;
const OPENED_EVENT = parseAbiItem(
  'event CoverageOpened(bytes32 indexed coverageId,address indexed payer,bytes32 indexed providerId,bytes32 policyId,bytes32 requestHash,uint256 gross,uint256 premium,uint256 withheld,uint256 net,uint256 stakeLock,uint256 poolReservation,uint64 expiresAt)',
);
const DEFAULT_MAX_BLOCKS = 5_000;
const DEFAULT_MAX_COVERAGES = 1_000;
const HARD_MAX_BLOCKS = 100_000;
const HARD_MAX_COVERAGES = 10_000;
const LOG_CHUNK_BLOCKS = 500n;
const CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;

type ProjectionOptions = {
  client: any;
  context: BackendContext;
  journalPath: string;
  fromBlock: bigint;
  maxBlocks?: number;
  maxCoverages?: number;
};

function fail(code: string): never { throw new Error(code); }
function safeCode(error: unknown): Error {
  if (error instanceof Error && /^PROJECTION_[A-Z0-9_]+$/.test(error.message)) return error;
  return new Error('PROJECTION_RPC_FAILED');
}
function asBig(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) fail('PROJECTION_STATE_MISMATCH');
  return value;
}
function asIndex(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  fail('PROJECTION_LOG_INVALID');
}
function asEnum(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= 255n) return Number(value);
  fail('PROJECTION_STATE_MISMATCH');
}
function asHex(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail('PROJECTION_LOG_INVALID');
  return value.toLowerCase() as Hex;
}
function asAddress(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail('PROJECTION_LOG_INVALID');
  return requireAddress(value.toLowerCase());
}
function decimal(value: unknown): string {
  return asBig(value).toString(10);
}
function validLimit(value: number | undefined, fallback: number, hard: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > hard) fail('PROJECTION_INVALID_LIMIT');
  return limit;
}
function assertContext(input: BackendContext): BackendContext {
  try { return normalizeContext(input); } catch { return fail('PROJECTION_INVALID_CONTEXT'); }
}

function validateCoverage(value: unknown): CoverageView {
  const c = exact(value, ['coverageId', 'payer', 'providerId', 'policyId', 'policyHash', 'requestHash', 'gross',
    'premium', 'withheld', 'stakeLock', 'poolReservation', 'openedAt', 'expiresAt', 'poolOnlyAllowed', 'status',
    'evidenceHash', 'decisionHash', 'refundAmount', 'outcome', 'opening']);
  const opening = exact(c.opening, ['transaction', 'blockNumber', 'blockHash', 'logIndex']);
  const unsigned = (v: unknown) => {
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 78 || BigInt(v) >= (1n << 256n)) {
      fail('PROJECTION_CHECKPOINT_INVALID');
    }
    return v;
  };
  const smallInt = (v: unknown) => {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 255) fail('PROJECTION_CHECKPOINT_INVALID');
    return v as number;
  };
  if (typeof c.poolOnlyAllowed !== 'boolean') fail('PROJECTION_CHECKPOINT_INVALID');
  return {
    coverageId: requireId(c.coverageId), payer: requireAddress(c.payer), providerId: requireId(c.providerId),
    policyId: requireId(c.policyId), policyHash: requireId(c.policyHash), requestHash: requireId(c.requestHash),
    gross: unsigned(c.gross), premium: unsigned(c.premium), withheld: unsigned(c.withheld),
    stakeLock: unsigned(c.stakeLock), poolReservation: unsigned(c.poolReservation),
    openedAt: unsigned(c.openedAt), expiresAt: unsigned(c.expiresAt), poolOnlyAllowed: c.poolOnlyAllowed,
    status: smallInt(c.status), evidenceHash: requireId(c.evidenceHash, true),
    decisionHash: requireId(c.decisionHash, true), refundAmount: unsigned(c.refundAmount), outcome: smallInt(c.outcome),
    opening: {
      transaction: requireId(opening.transaction), blockNumber: unsigned(opening.blockNumber),
      blockHash: requireId(opening.blockHash), logIndex: unsigned(opening.logIndex),
    },
  };
}

function validateSnapshot(value: unknown): Snapshot {
  const s = exact(value, ['version', 'context', 'fromBlock', 'head', 'coverages']);
  if (s.version !== 1 || !s.coverages || typeof s.coverages !== 'object' || Array.isArray(s.coverages)) {
    fail('PROJECTION_CHECKPOINT_INVALID');
  }
  const context = assertContext(s.context as BackendContext);
  const head = exact(s.head, ['number', 'hash', 'timestamp']);
  const coverages: Record<string, CoverageView> = {};
  for (const [key, raw] of Object.entries(s.coverages as Record<string, unknown>)) {
    const coverage = validateCoverage(raw);
    if (key !== coverage.coverageId || Object.hasOwn(coverages, key)) fail('PROJECTION_CHECKPOINT_INVALID');
    coverages[key] = coverage;
  }
  const unsigned = (v: unknown) => {
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 78 || BigInt(v) >= (1n << 256n)) {
      fail('PROJECTION_CHECKPOINT_INVALID');
    }
    return v;
  };
  return {
    version: 1, context, fromBlock: unsigned(s.fromBlock),
    head: { number: unsigned(head.number), hash: requireId(head.hash), timestamp: unsigned(head.timestamp) }, coverages,
  };
}

async function readCheckpoint(path: string, namespace: string, context: BackendContext, fromBlock: string): Promise<void> {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > CHECKPOINT_MAX_BYTES) fail('PROJECTION_CHECKPOINT_INVALID');
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof Error && /^PROJECTION_/.test(error.message)) throw error;
    fail('PROJECTION_CHECKPOINT_INVALID');
  }
  try {
    const raw = await handle.readFile({ encoding: 'utf8' });
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail('PROJECTION_CHECKPOINT_INVALID'); }
    const record = exact(parsed, ['version', 'namespace', 'context', 'fromBlock', 'snapshot']);
    if (record.version !== 1 || typeof record.namespace !== 'string' || !/^[0-9a-f]{64}$/.test(record.namespace)) {
      fail('PROJECTION_CHECKPOINT_INVALID');
    }
    const savedContext = assertContext(record.context as BackendContext);
    if (record.namespace !== namespace || JSON.stringify(savedContext) !== JSON.stringify(context)) {
      fail('PROJECTION_CONTEXT_MISMATCH');
    }
    if (record.fromBlock !== fromBlock) fail('PROJECTION_CONTEXT_MISMATCH');
    const snapshot = validateSnapshot(record.snapshot);
    if (snapshot.fromBlock !== fromBlock || JSON.stringify(snapshot.context) !== JSON.stringify(context)) {
      fail('PROJECTION_CHECKPOINT_INVALID');
    }
  } catch (error) {
    if (error instanceof Error && /^PROJECTION_[A-Z0-9_]+$/.test(error.message)) throw error;
    fail('PROJECTION_CHECKPOINT_INVALID');
  } finally { await handle.close(); }
}

async function atomicCheckpoint(path: string, record: unknown): Promise<void> {
  const directory = dirname(path);
  let temporary = '';
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) fail('PROJECTION_CHECKPOINT_INVALID');
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    const dir = await open(directory, fsConstants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) {
    if (temporary) await unlink(temporary).catch(() => undefined);
    throw safeCode(error instanceof Error && /^PROJECTION_/.test(error.message) ? error : new Error('PROJECTION_STORAGE_FAILED'));
  }
}

async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += limit) {
    await Promise.all(items.slice(offset, offset + limit).map(fn));
  }
}

export function createProjection(options: ProjectionOptions): Projection {
  const context = assertContext(options.context);
  if (typeof options.journalPath !== 'string' || options.journalPath.length === 0 || options.fromBlock < 0n) {
    fail('PROJECTION_INVALID_CONFIGURATION');
  }
  const fromBlock = options.fromBlock.toString(10);
  const configuredFromBlock = options.fromBlock;
  const journalPath = options.journalPath;
  const client = options.client;
  const maxBlocks = validLimit(options.maxBlocks, DEFAULT_MAX_BLOCKS, HARD_MAX_BLOCKS);
  const maxCoverages = validLimit(options.maxCoverages, DEFAULT_MAX_COVERAGES, HARD_MAX_COVERAGES);
  const namespace = contextNamespace(context);
  let active = false;

  return {
    async refresh(): Promise<Snapshot> {
      if (active) fail('PROJECTION_REFRESH_BUSY');
      active = true;
      try {
        await readCheckpoint(journalPath, namespace, context, fromBlock);
        let chainId: number;
        try { chainId = await client.getChainId(); } catch { fail('PROJECTION_RPC_FAILED'); }
        if (chainId! !== context.chainId) fail('PROJECTION_CONTEXT_MISMATCH');

        let firstHead: any;
        let coreCode: Hex | undefined;
        let tokenCode: Hex | undefined;
        let token: Address;
        let adjudicator: Address;
        let count: bigint;
        try {
          firstHead = await client.getBlock({ blockTag: 'latest' });
          if (typeof firstHead.number !== 'bigint' || typeof firstHead.timestamp !== 'bigint' || !firstHead.hash) {
            fail('PROJECTION_RPC_FAILED');
          }
          coreCode = await client.getBytecode({ address: context.core, blockNumber: firstHead.number });
          tokenCode = await client.getBytecode({ address: context.token, blockNumber: firstHead.number });
          token = asAddress(await client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'token', blockNumber: firstHead.number }));
          adjudicator = asAddress(await client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'adjudicator', blockNumber: firstHead.number }));
          count = asBig(await client.readContract({ address: context.core, abi: CORE_ABI, functionName: 'coverageCount', blockNumber: firstHead.number }));
        } catch (error) { throw safeCode(error); }
        if (!coreCode || coreCode === '0x' || !tokenCode || tokenCode === '0x') fail('PROJECTION_CONTEXT_MISMATCH');
        if (token! !== context.token || adjudicator! !== context.adjudicator) fail('PROJECTION_CONTEXT_MISMATCH');
        if (count! > BigInt(maxCoverages)) fail('PROJECTION_COVERAGE_LIMIT');
        if (firstHead.number < configuredFromBlock) fail('PROJECTION_INVALID_RANGE');
        const blockLength = firstHead.number - configuredFromBlock + 1n;
        if (blockLength > BigInt(maxBlocks)) fail('PROJECTION_BLOCK_LIMIT');

        const logs: any[] = [];
        try {
          for (let start = configuredFromBlock; start <= firstHead.number; start += LOG_CHUNK_BLOCKS) {
            const end = start + LOG_CHUNK_BLOCKS - 1n < firstHead.number ? start + LOG_CHUNK_BLOCKS - 1n : firstHead.number;
            const part = await client.getLogs({ address: context.core, event: OPENED_EVENT,
              strict: true, fromBlock: start, toBlock: end });
            if (!Array.isArray(part)) fail('PROJECTION_RPC_FAILED');
            logs.push(...part);
            if (logs.length > maxCoverages) fail('PROJECTION_COVERAGE_LIMIT');
          }
        } catch (error) { throw safeCode(error); }
        if (BigInt(logs.length) !== count!) fail('PROJECTION_STATE_MISMATCH');

        const decoded: Array<{ log: any; args: any }> = [];
        const logKeys = new Set<string>();
        const ids = new Set<string>();
        try {
          for (const log of logs) {
            if (!log || log.removed === true || asAddress(log.address) !== context.core || typeof log.blockNumber !== 'bigint'
              || log.blockNumber < configuredFromBlock || log.blockNumber > firstHead.number
              || !log.blockHash || !log.transactionHash) fail('PROJECTION_LOG_INVALID');
            const blockHash = asHex(log.blockHash);
            const txHash = asHex(log.transactionHash);
            const logIndex = asIndex(log.logIndex);
            const transactionIndex = asIndex(log.transactionIndex);
            const logKey = `${blockHash}:${txHash}:${logIndex}`;
            if (logKeys.has(logKey)) fail('PROJECTION_DUPLICATE_LOG');
            logKeys.add(logKey);
            const event = log.args ? { eventName: log.eventName, args: log.args } :
              decodeEventLog({ abi: CORE_ABI, data: log.data, topics: log.topics, strict: true });
            if (event.eventName !== 'CoverageOpened' || !event.args) fail('PROJECTION_LOG_INVALID');
            const args = event.args as any;
            const coverageId = requireId(asHex(args.coverageId));
            if (ids.has(coverageId)) fail('PROJECTION_DUPLICATE_COVERAGE');
            ids.add(coverageId);
            decoded.push({ log, args });
          }
        } catch (error) { throw safeCode(error); }
        decoded.sort((a, b) => a.log.blockNumber === b.log.blockNumber
          ? asIndex(a.log.transactionIndex) === asIndex(b.log.transactionIndex)
            ? (asIndex(a.log.logIndex) < asIndex(b.log.logIndex) ? -1 : asIndex(a.log.logIndex) > asIndex(b.log.logIndex) ? 1 : 0)
            : (asIndex(a.log.transactionIndex) < asIndex(b.log.transactionIndex) ? -1 : 1)
          : (a.log.blockNumber < b.log.blockNumber ? -1 : 1));

        const blockCache = new Map<string, any>();
        const coverageRows = new Map<string, CoverageView>();
        try {
          const blockNumbers = [...new Set(decoded.map(({ log }) => log.blockNumber.toString()))];
          await eachLimit(blockNumbers, 16, async (number) => {
            const block = await client.getBlock({ blockNumber: BigInt(number) });
            if (!block?.hash || typeof block.timestamp !== 'bigint') fail('PROJECTION_CANONICAL_MISMATCH');
            blockCache.set(number, block);
          });
          for (const { log } of decoded) {
            const block = blockCache.get(log.blockNumber.toString());
            if (asHex(block.hash) !== asHex(log.blockHash)) fail('PROJECTION_CANONICAL_MISMATCH');
          }
          await eachLimit(decoded, 16, async ({ log, args }) => {
            const id = requireId(asHex(args.coverageId));
            const raw = await client.readContract({ address: context.core, abi: CORE_ABI,
              functionName: 'coverages', args: [id], blockNumber: firstHead.number }) as readonly unknown[];
            if (!Array.isArray(raw) || raw.length !== 18) fail('PROJECTION_STATE_MISMATCH');
            const openedBlock = blockCache.get(log.blockNumber.toString());
            const view: CoverageView = {
              coverageId: id, payer: asAddress(raw[0]), providerId: requireId(asHex(raw[1])), policyId: requireId(asHex(raw[2])),
              policyHash: requireId(asHex(raw[3])), requestHash: requireId(asHex(raw[4])), gross: decimal(raw[5]), premium: decimal(raw[6]),
              withheld: decimal(raw[7]), stakeLock: decimal(raw[8]), poolReservation: decimal(raw[9]),
              openedAt: decimal(raw[10]), expiresAt: decimal(raw[11]), poolOnlyAllowed: raw[12] as boolean,
              status: asEnum(raw[13]), evidenceHash: asHex(raw[14]), decisionHash: asHex(raw[15]),
              refundAmount: decimal(raw[16]), outcome: asEnum(raw[17]),
              opening: { transaction: requireId(asHex(log.transactionHash)), blockNumber: decimal(log.blockNumber),
                blockHash: requireId(asHex(log.blockHash)), logIndex: asIndex(log.logIndex).toString(10) },
            };
            if (typeof view.poolOnlyAllowed !== 'boolean' || view.status > 5 || view.outcome > 2) fail('PROJECTION_STATE_MISMATCH');
            const eventGross = asBig(args.gross), eventPremium = asBig(args.premium), eventWithheld = asBig(args.withheld);
            const eventNet = asBig(args.net);
            if (view.payer !== asAddress(args.payer) || view.providerId !== asHex(args.providerId)
              || view.policyId !== asHex(args.policyId) || view.requestHash !== asHex(args.requestHash)
              || BigInt(view.gross) !== eventGross || BigInt(view.premium) !== eventPremium
              || BigInt(view.withheld) !== eventWithheld || BigInt(view.stakeLock) !== asBig(args.stakeLock)
              || BigInt(view.poolReservation) !== asBig(args.poolReservation)
              || BigInt(view.expiresAt) !== asBig(args.expiresAt)
              || eventPremium + eventWithheld + eventNet !== eventGross
              || BigInt(view.openedAt) !== openedBlock.timestamp) fail('PROJECTION_STATE_MISMATCH');
            coverageRows.set(id, view);
          });
        } catch (error) { throw safeCode(error); }

        let lastHead: any;
        try { lastHead = await client.getBlock({ blockTag: 'latest' }); }
        catch { fail('PROJECTION_RPC_FAILED'); }
        if (!lastHead?.hash || lastHead.number !== firstHead.number || asHex(lastHead.hash) !== asHex(firstHead.hash)) {
          fail('PROJECTION_HEAD_CHANGED');
        }
        const snapshot: Snapshot = {
          version: 1, context, fromBlock,
          head: { number: decimal(firstHead.number), hash: asHex(firstHead.hash), timestamp: decimal(firstHead.timestamp) },
          coverages: Object.fromEntries([...coverageRows.entries()].sort(([a], [b]) => a.localeCompare(b))),
        };
        const checkpoint = { version: 1, namespace, context, fromBlock, snapshot };
        await atomicCheckpoint(journalPath, checkpoint);
        return snapshot;
      } catch (error) { throw safeCode(error); }
      finally { active = false; }
    },
  };
}
