import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeFunctionData, encodeFunctionData, keccak256, type Address, type Hex, type LocalAccount } from 'viem';
import { authorize } from '../../developer-pilot/src/auth.js';
import { createActionSender, type ActionRecord } from '../../developer-pilot/src/action-sender.js';
import { createClaimsClient } from '../../developer-pilot/src/claims-client.js';
import { CORE_ABI } from '../../claims-backend/src/abi.js';
import { contextFor, type PilotConfig } from '../../developer-pilot/src/config.js';
import type { ClientConfig, ClaimSubmission } from './types.js';

const ID = /^0x[0-9a-f]{64}$/;
const ZERO32 = `0x${'0'.repeat(64)}`;
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const err = (code: string): never => { throw new Error(code); };
const approved = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  Reflect.ownKeys(v).length === 1 && Object.getOwnPropertyDescriptor(v, 'approved')?.value === true;
const validId = (v: unknown): v is Hex => typeof v === 'string' && ID.test(v) && v !== ZERO32;

function pilotConfig(config: ClientConfig): PilotConfig {
  return {
    version: 1, mode: 'local', chainId: 84532, rpcUrl: config.rpcUrl, core: config.core, token: config.token,
    providerId: config.providerId, policyId: config.policyId, serviceId: config.serviceId,
    roles: { ...config.roles }, resourceUrl: config.resourceUrl, claimsUrl: config.claimsUrl,
    deploymentBlock: config.deploymentBlock, gross: config.gross,
  };
}
function publicRow(record: ActionRecord): ClaimSubmission {
  return { coverageId: record.coverageId, transaction: record.transaction, status: record.status ?? 'pending',
    ...(record.blockNumber && record.blockHash ? { inclusion: { number: record.blockNumber, hash: record.blockHash } } : {}) };
}
function validCoverageId(v: unknown): v is Hex { return validId(v); }

/** Fixed payer-only evidence and claim operations. No decision or generic action surface is exposed. */
export function createPayerClaims(input: {
  config: ClientConfig; client: any; wallet?: any; account?: LocalAccount; directory: string;
  readState: (coverageId?: Hex) => Promise<any>;
}): {
  uploadEvidence(coverageId: Hex, body: Uint8Array): Promise<Hex>;
  readEvidence(coverageId: Hex, evidenceHash: Hex): Promise<Uint8Array>;
  fileClaim(coverageId: Hex, evidenceHash: Hex, approval: Readonly<{ approved: true }>): Promise<ClaimSubmission>;
  reconcileClaims(): Promise<readonly ClaimSubmission[]>;
  close(): Promise<void>;
} {
  const config = structuredClone(input.config);
  const client = input.client;
  const wallet = input.wallet;
  const account = input.account;
  const directory = input.directory;
  const readState = input.readState;
  const claims = createClaimsClient({ url: config.claimsUrl });
  const journalPath = join(directory, 'claims.json');
  let senderPromise: ReturnType<typeof createActionSender> | undefined;
  let senderHasSigner = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const requireAccount = (): LocalAccount => {
    const bound = account;
    if (!bound || !same(bound.address, config.roles.payer) || typeof bound.signTypedData !== 'function') return err('CLIENT_SIGNER_REQUIRED');
    return bound;
  };
  const getSender = async (withSigner: boolean) => {
    if (closing) err('CLIENT_CLOSED');
    if (senderPromise && senderHasSigner === withSigner) return senderPromise;
    if (senderPromise) {
      const previous = await senderPromise;
      await previous.close();
      senderPromise = undefined;
      senderHasSigner = false;
    }
    const payer = config.roles.payer;
    const boundAccount = withSigner ? requireAccount() : undefined;
    senderHasSigner = withSigner;
    senderPromise = createActionSender({ context: contextFor(pilotConfig(config)), actor: payer, client,
      ...(withSigner ? { wallet, account: boundAccount } : {}), journalPath });
    try { return await senderPromise; } catch (e) { senderPromise = undefined; senderHasSigner = false; throw e; }
  };
  async function auth(op: 'uploadEvidence' | 'readEvidence' | 'prepareClaim', coverageId: Hex, payload: unknown) {
    return authorize(client, pilotConfig(config), requireAccount(), op, coverageId, payload);
  }
  async function existingClaim(coverageId: Hex, evidenceHash: Hex): Promise<ClaimSubmission | undefined> {
    let info;
    try { info = await lstat(journalPath); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('CLIENT_CLAIMS_JOURNAL_UNAVAILABLE'); }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 1_048_576) err('CLIENT_CLAIMS_JOURNAL_INVALID');
    // Open and reconcile through the accepted sender first so malformed or unresolved
    // journal entries fail before the payer signs another backend authorization.
    const sender = await getSender(false);
    const reconciled = await sender.reconcile();
    let value: any;
    try {
      const handle = await open(journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1_048_576) err('CLIENT_CLAIMS_JOURNAL_INVALID'); value = JSON.parse(await handle.readFile('utf8')); }
      finally { await handle.close(); }
    } catch (e) { if (e instanceof Error && e.message.startsWith('CLIENT_')) throw e; err('CLIENT_CLAIMS_JOURNAL_INVALID'); }
    if (!value || value.version !== 1 || !Array.isArray(value.records)) err('CLIENT_CLAIMS_JOURNAL_INVALID');
    const row = value.records.find((r: any) => r?.kind === 'fileClaim' && same(r.coverageId, coverageId));
    if (!row) return undefined;
    const data = encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [coverageId, evidenceHash] });
    if (!same(row.calldataHash, keccak256(data))) err('CLIENT_CLAIM_ALREADY_FILED');
    const final = reconciled.find((r) => r.kind === 'fileClaim' && same(r.coverageId, coverageId));
    if (!final) return err('CLIENT_CLAIM_RECONCILIATION_FAILED');
    return publicRow(final);
  }
  return Object.freeze({
    async uploadEvidence(coverageId: Hex, body: Uint8Array): Promise<Hex> {
      if (!validCoverageId(coverageId)) err('CLIENT_COVERAGE_INVALID');
      const copy = body instanceof Uint8Array ? new Uint8Array(body) : err('CLIENT_EVIDENCE_INVALID');
      if (copy.byteLength === 0 || copy.byteLength > 65_536) err('CLIENT_EVIDENCE_SIZE');
      const state = await readState(coverageId);
      if (!state.coverage || state.coverage.status !== 1 || BigInt(state.observedBlock.timestamp) >= BigInt(state.coverage.expiresAt)) err('CLIENT_CLAIM_STATE');
      const authorization = await auth('uploadEvidence', coverageId, { bodyHex: `0x${Buffer.from(copy).toString('hex')}` });
      return claims.uploadEvidence(coverageId, copy, authorization);
    },
    async readEvidence(coverageId: Hex, evidenceHash: Hex): Promise<Uint8Array> {
      if (!validCoverageId(coverageId) || !validId(evidenceHash)) err('CLIENT_EVIDENCE_INVALID');
      await readState(coverageId);
      const authorization = await auth('readEvidence', coverageId, { evidenceHash });
      const bytes = await claims.readEvidence(coverageId, evidenceHash, authorization);
      if (bytes.byteLength > 65_536) err('CLIENT_EVIDENCE_SIZE');
      return new Uint8Array(bytes);
    },
    async fileClaim(coverageId: Hex, evidenceHash: Hex, approval: Readonly<{ approved: true }>): Promise<ClaimSubmission> {
      if (!validCoverageId(coverageId) || !validId(evidenceHash)) err('CLIENT_EVIDENCE_INVALID');
      if (!approved(approval)) err('CLIENT_APPROVAL_REQUIRED');
      const prior = await existingClaim(coverageId, evidenceHash);
      if (prior) return prior;
      const state = await readState(coverageId);
      if (!state.coverage || state.coverage.status !== 1 || BigInt(state.observedBlock.timestamp) >= BigInt(state.coverage.expiresAt)) err('CLIENT_CLAIM_STATE');
      requireAccount();
      const authorization = await auth('prepareClaim', coverageId, { evidenceHash });
      const action = await claims.prepareClaim(coverageId, evidenceHash, authorization);
      if (action.chainId !== 84532 || !same(action.to, config.core) || !same(action.from, config.roles.payer) || action.value !== '0' || !same(action.coverageId, coverageId)) err('CLIENT_CLAIM_ACTION_INVALID');
      let decoded: any;
      try { decoded = decodeFunctionData({ abi: CORE_ABI, data: action.data }); } catch { err('CLIENT_CLAIM_ACTION_INVALID'); }
      if (decoded.functionName !== 'fileClaim' || !Array.isArray(decoded.args) || decoded.args.length !== 2 || !same(decoded.args[0], coverageId) || !same(decoded.args[1], evidenceHash)) err('CLIENT_CLAIM_ACTION_INVALID');
      const sender = await getSender(true);
      return publicRow(await sender.submit(action));
    },
    async reconcileClaims(): Promise<readonly ClaimSubmission[]> {
      try { await lstat(journalPath); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('CLIENT_CLAIMS_JOURNAL_UNAVAILABLE'); }
      const sender = await getSender(false);
      return (await sender.reconcile()).filter((r) => r.kind === 'fileClaim').map(publicRow);
    },
    async close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => { if (senderPromise) { const sender = await senderPromise; await sender.close(); senderPromise = undefined; senderHasSigner = false; } })();
      return closePromise;
    },
  });
}
