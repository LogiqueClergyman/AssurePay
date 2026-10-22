import { createPublicClient, decodeEventLog, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createProjection } from '../../claims-backend/src/projection.js';
import { CORE_ABI } from '../../claims-backend/src/abi.js';
import type { CampaignManifest } from '../src/types.js';
import { withReadQueue } from '../src/read-queue.js';
import { withLogChunks } from '../src/log-chunks.js';

const safeError = (error: unknown): string => error instanceof Error && /^PROJECTION_[A-Z0-9_]+$/.test(error.message)
  ? error.message : 'PROJECTION_DIAGNOSTIC_FAILED';

try {
  const second = process.argv.length === 3 && process.argv[2] === '--second';
  if (process.argv.length !== (second ? 3 : 2)) throw new Error('DIAGNOSTIC_ARGUMENTS_INVALID');
  const evidenceName = second ? 'second-public-reconciliation.json' : 'public-reconciliation.json';
  const evidencePath = fileURLToPath(new URL(`../evidence/${evidenceName}`, import.meta.url));
  const evidenceInfo = await lstat(evidencePath);
  if (!evidenceInfo.isFile() || evidenceInfo.isSymbolicLink() || evidenceInfo.size > 1_000_000) {
    throw new Error('DIAGNOSTIC_MANIFEST_INVALID');
  }
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as { manifest?: CampaignManifest };
  const manifest = evidence.manifest;
  if (!manifest || manifest.version !== 1 || manifest.config.mode !== 'public' || manifest.config.chainId !== 84532 ||
      !manifest.core || !Array.isArray(manifest.transactions) || manifest.transactions.length < 1 ||
      manifest.transactions[0]?.kind !== 'deploy' || !manifest.transactions[0].blockNumber) {
    throw new Error('DIAGNOSTIC_MANIFEST_INVALID');
  }

  const purchase = second ? manifest.transactions.find(row => row.kind === 'purchaseA') : undefined;
  if (second && (!purchase || !purchase.blockNumber || purchase.status !== 'success')) {
    throw new Error('DIAGNOSTIC_MANIFEST_INVALID');
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
  const parsedRpc = new URL(rpcUrl);
  if (parsedRpc.protocol !== 'https:' || parsedRpc.username || parsedRpc.password || parsedRpc.hash) {
    throw new Error('DIAGNOSTIC_RPC_CONFIG_INVALID');
  }
  const rawClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }), cacheTime: 0 });
  const failures: Array<{method:string;name:string;code?:number;status?:number;rangeRelated:boolean}> = [];
  const queuedClient = withLogChunks(withReadQueue(rawClient, { attempts: 3, delay: 250, spacing: 50 }));
  const client = new Proxy(queuedClient, { get(target, property) {
    const member = Reflect.get(target, property, target);
    if (typeof member !== 'function') return member;
    return async (...args: unknown[]) => {
      try { return await member.apply(target, args); }
      catch (error: any) {
        let current = error;
        for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
          const message = typeof current.message === 'string' ? current.message : '';
          if (failures.length < 20) failures.push({ method: String(property),
            name: typeof current.name === 'string' && /^[A-Za-z]+$/.test(current.name) ? current.name : 'Error',
            ...(Number.isInteger(current.code) ? {code:current.code} : {}),
            ...(Number.isInteger(current.status) ? {status:current.status} : {}),
            rangeRelated: /block range|range limit|query.*limit|limited to|too many blocks/i.test(message) });
        }
        throw error;
      }
    };
  } });
  const context = {
    chainId: 84532 as const,
    core: manifest.core,
    token: manifest.config.token,
    adjudicator: manifest.config.roles.adjudicator,
    serviceId: manifest.config.serviceId,
  };
  const journalFolder = second ? '../.local-m5-r2/' : '../.local-m5/';
  const journalPath = join(fileURLToPath(new URL(journalFolder, import.meta.url)), 'diagnostic-projection.json');
  let firstHead: { number: string; hash: string } | null = null;
  let lastHead: { number: string; hash: string } | null = null;
  let projectionCode: string | null = null;
  try {
    const head = await client.getBlock({ blockTag: 'latest' });
    if (head.number !== null && head.hash) firstHead = { number: head.number.toString(), hash: head.hash };
  } catch { /* The projection call below reports the stable failure code. */ }
  try {
    let snapshot;
    projectionCode = 'PROJECTION_REFRESH_OK';
    try {
      snapshot = await createProjection({ client, context, journalPath, fromBlock: BigInt(manifest.transactions[0].blockNumber), maxBlocks: 25_000 }).refresh();
    } catch (error) {
      if (!second) throw error;
      projectionCode = safeError(error);
    }

    if (!second) {
      const head = await client.getBlock({ blockTag: 'latest' });
      if (head.number !== null && head.hash) lastHead = { number: head.number.toString(), hash: head.hash };
      process.stdout.write(JSON.stringify({ ok: true, code: 'PROJECTION_REFRESH_OK', context, fromBlock: manifest.transactions[0].blockNumber,
        coverageCount: Object.keys(snapshot!.coverages).length, snapshotHead: snapshot!.head, firstHead, lastHead }) + '\n');
    } else {
      let coverage = Object.values(snapshot?.coverages ?? {}).find(row => row.opening.transaction === purchase!.transaction);
      let readSource: 'projection' | 'receipt' = 'projection';
      let claim: { coverageId: string; expiresAt: string; status: number } | undefined = coverage
        ? { coverageId: coverage.coverageId, expiresAt: coverage.expiresAt, status: coverage.status }
        : undefined;
      if (!coverage) {
        readSource = 'receipt';
        const receipt = await client.getTransactionReceipt({ hash: purchase!.transaction });
        if (receipt.status !== 'success') throw new Error('DIAGNOSTIC_PURCHASE_RECEIPT_INVALID');
        const opened = receipt.logs.flatMap(log => {
          if (log.address.toLowerCase() !== manifest.core!.toLowerCase()) return [];
          try {
            const decoded = decodeEventLog({ abi: CORE_ABI, data: log.data, topics: log.topics, strict: true });
            return decoded.eventName === 'CoverageOpened' ? [decoded.args.coverageId] : [];
          } catch { return []; }
        });
        if (opened.length !== 1) throw new Error('DIAGNOSTIC_COVERAGE_LOG_INVALID');
        const canonicalHead = await client.getBlock({ blockTag: 'latest' });
        if (canonicalHead.number === null || !canonicalHead.hash) throw new Error('DIAGNOSTIC_CANONICAL_HEAD_INVALID');
        lastHead = { number: canonicalHead.number.toString(), hash: canonicalHead.hash };
        const raw = await client.readContract({ address: manifest.core!, abi: CORE_ABI, functionName: 'coverages',
          args: [opened[0]], blockNumber: canonicalHead.number });
        const confirmedHead = await client.getBlock({ blockNumber: canonicalHead.number });
        if (!confirmedHead.hash || confirmedHead.hash.toLowerCase() !== canonicalHead.hash.toLowerCase()) {
          throw new Error('DIAGNOSTIC_CANONICAL_HEAD_CHANGED');
        }
        claim = {
          coverageId: opened[0], expiresAt: raw[11].toString(), status: Number(raw[13]),
        };
      }
      if (!claim) throw new Error('DIAGNOSTIC_COVERAGE_NOT_FOUND');
      const statusName = ({ 0: 'none', 1: 'active', 2: 'claim_pending', 3: 'refunded', 4: 'rejected' } as Record<number, string>)[claim.status] ?? 'unknown';
      process.stdout.write(JSON.stringify({ ok: true, code: 'SECOND_PROJECTION_DIAGNOSTIC_COMPLETE', projectionCode, failures,
        context, purchaseTransaction: purchase!.transaction, readSource,
        claim: { ...claim, statusName },
        snapshotHead: snapshot?.head ?? null, firstHead, lastHead }) + '\n');
    }
  } catch (error) {
    try {
      const head = await client.getBlock({ blockTag: 'latest' });
      if (head.number !== null && head.hash) lastHead = { number: head.number.toString(), hash: head.hash };
    } catch { /* Keep the diagnostic output bounded and safe. */ }
    const code = error instanceof Error && /^DIAGNOSTIC_[A-Z0-9_]+$/.test(error.message)
      ? error.message : second ? 'DIAGNOSTIC_PUBLIC_READ_FAILED' : safeError(error);
    process.stdout.write(JSON.stringify({ ok: false, code, ...(second ? { projectionCode, failures } : {}), context,
      fromBlock: manifest.transactions[0].blockNumber, transactionCount: manifest.transactions.length, firstHead, lastHead }) + '\n');
    process.exitCode = 1;
  }
} catch (error) {
  const code = error instanceof Error && /^DIAGNOSTIC_[A-Z0-9_]+$/.test(error.message) ? error.message : 'DIAGNOSTIC_FAILED';
  process.stdout.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
}
