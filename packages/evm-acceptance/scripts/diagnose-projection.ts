import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createProjection } from '../../claims-backend/src/projection.js';
import type { CampaignManifest } from '../src/types.js';

const safeError = (error: unknown): string => error instanceof Error && /^PROJECTION_[A-Z0-9_]+$/.test(error.message)
  ? error.message : 'PROJECTION_DIAGNOSTIC_FAILED';

try {
  if (process.argv.length !== 2) throw new Error('DIAGNOSTIC_ARGUMENTS_INVALID');
  const evidencePath = fileURLToPath(new URL('../evidence/public-reconciliation.json', import.meta.url));
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

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
  const parsedRpc = new URL(rpcUrl);
  if (parsedRpc.protocol !== 'https:' || parsedRpc.username || parsedRpc.password || parsedRpc.hash) {
    throw new Error('DIAGNOSTIC_RPC_CONFIG_INVALID');
  }
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }), cacheTime: 0 });
  const context = {
    chainId: 84532 as const,
    core: manifest.core,
    token: manifest.config.token,
    adjudicator: manifest.config.roles.adjudicator,
    serviceId: manifest.config.serviceId,
  };
  const journalPath = join(fileURLToPath(new URL('../.local-m5/', import.meta.url)), 'diagnostic-projection.json');
  let firstHead: { number: string; hash: string } | null = null;
  let lastHead: { number: string; hash: string } | null = null;
  try {
    const head = await client.getBlock({ blockTag: 'latest' });
    if (head.number !== null && head.hash) firstHead = { number: head.number.toString(), hash: head.hash };
  } catch { /* The projection call below reports the stable failure code. */ }
  try {
    const snapshot = await createProjection({ client, context, journalPath, fromBlock: BigInt(manifest.transactions[0].blockNumber) }).refresh();
    const head = await client.getBlock({ blockTag: 'latest' });
    if (head.number !== null && head.hash) lastHead = { number: head.number.toString(), hash: head.hash };
    process.stdout.write(JSON.stringify({ ok: true, code: 'PROJECTION_REFRESH_OK', context, fromBlock: manifest.transactions[0].blockNumber,
      coverageCount: Object.keys(snapshot.coverages).length, snapshotHead: snapshot.head, firstHead, lastHead }) + '\n');
  } catch (error) {
    try {
      const head = await client.getBlock({ blockTag: 'latest' });
      if (head.number !== null && head.hash) lastHead = { number: head.number.toString(), hash: head.hash };
    } catch { /* Keep the diagnostic output bounded and safe. */ }
    process.stdout.write(JSON.stringify({ ok: false, code: safeError(error), context, fromBlock: manifest.transactions[0].blockNumber,
      transactionCount: manifest.transactions.length, firstHead, lastHead }) + '\n');
    process.exitCode = 1;
  }
} catch (error) {
  const code = error instanceof Error && /^DIAGNOSTIC_[A-Z0-9_]+$/.test(error.message) ? error.message : 'DIAGNOSTIC_FAILED';
  process.stdout.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
}
