import { randomBytes } from 'node:crypto';
import { encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { CORE_ABI } from './abi.js';
import {
  canonicalJson, contextNamespace, exact, hashJson, normalizeContext,
  requireAddress, requireId, sameAnchor, uint,
} from './common.js';
import { ReplayJournal, operationPayloadHash, verifyAuthorization } from './auth.js';
import type {
  Authorization, BackendContext, CoverageView, DecisionInput, Operation, PreparedAction,
  Projection, Snapshot, Vault,
} from './types.js';

const STATUS = { active: 1, claimPending: 2, refunded: 3, rejected: 4 } as const;
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
const MAX_EVIDENCE_BYTES = 65_536;
const MAX_REASON_BYTES = 8_192;
const BODY_HEX = /^0x(?:[0-9a-f]{2})+$/;

type EvidenceRecord = {
  version: 1; kind: 'evidence'; context: BackendContext; coverageId: Hex; opening: CoverageView['opening'];
  payer: Address; requestHash: Hex; salt: Hex; bodyHex: string;
};
type DecisionRecord = {
  version: 1; kind: 'decision'; context: BackendContext; coverageId: Hex; opening: CoverageView['opening'];
  payer: Address; evidenceHash: Hex; outcome: 0 | 1 | 2; refundAmount: string; reason: string; salt: Hex;
};

export interface ClaimsBackendOptions {
  context: BackendContext;
  projection: Projection;
  vault: Vault;
  replayPath: string;
}

function fail(code: string): never { throw new Error(code); }
function isZero(value: string): boolean { return value === ZERO32; }
function randomSalt(): Hex { return toHex(randomBytes(32)); }
function bytes32(value: unknown): value is Hex { return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value); }

function snapshotRecord(value: unknown, context: BackendContext): Snapshot {
  const raw = exact(value, ['version', 'context', 'fromBlock', 'head', 'coverages']);
  if (raw.version !== 1) fail('PROJECTION_INVALID');
  let projectionContext: BackendContext;
  try { projectionContext = normalizeContext(raw.context as BackendContext); } catch { fail('PROJECTION_CONTEXT'); }
  if (canonicalJson(projectionContext) !== canonicalJson(context)) fail('PROJECTION_CONTEXT');
  const head = exact(raw.head, ['number', 'hash', 'timestamp']);
  try { uint(head.number); uint(head.timestamp); requireId(head.hash); uint(raw.fromBlock); } catch { fail('PROJECTION_INVALID'); }
  if (!raw.coverages || typeof raw.coverages !== 'object' || Array.isArray(raw.coverages) || Object.getPrototypeOf(raw.coverages) !== Object.prototype) fail('PROJECTION_INVALID');
  return raw as Snapshot;
}

function getCoverage(snapshot: Snapshot, coverageId: Hex): CoverageView {
  const coverage = snapshot.coverages[coverageId];
  if (!coverage || coverage.coverageId !== coverageId || !bytes32(coverage.coverageId) || !bytes32(coverage.requestHash) ||
      !bytes32(coverage.providerId) || !bytes32(coverage.policyId) || !bytes32(coverage.policyHash) ||
      !bytes32(coverage.evidenceHash) || !bytes32(coverage.decisionHash) || !Number.isInteger(coverage.status) ||
      typeof coverage.poolOnlyAllowed !== 'boolean') fail('COVERAGE_NOT_FOUND');
  try {
    requireAddress(coverage.payer);
    for (const value of [coverage.gross, coverage.premium, coverage.withheld, coverage.stakeLock,
      coverage.poolReservation, coverage.openedAt, coverage.expiresAt, coverage.refundAmount]) uint(value);
    exact(coverage.opening, ['transaction', 'blockNumber', 'blockHash', 'logIndex']);
    requireId(coverage.opening.transaction);
    requireId(coverage.opening.blockHash);
    uint(coverage.opening.blockNumber); uint(coverage.opening.logIndex);
  } catch { fail('PROJECTION_INVALID'); }
  return coverage;
}

function evidenceRecord(value: unknown, context: BackendContext, coverage: CoverageView, id: Hex): EvidenceRecord {
  const row = exact(value, ['version', 'kind', 'context', 'coverageId', 'opening', 'payer', 'requestHash', 'salt', 'bodyHex']);
  if (row.version !== 1 || row.kind !== 'evidence' || row.coverageId !== coverage.coverageId ||
      row.payer !== coverage.payer || row.requestHash !== coverage.requestHash || !bytes32(row.salt) || isZero(row.salt) ||
      typeof row.bodyHex !== 'string' || !BODY_HEX.test(row.bodyHex) || row.bodyHex.length > MAX_EVIDENCE_BYTES * 2 + 2) fail('EVIDENCE_INVALID');
  let objectContext: BackendContext;
  try { objectContext = normalizeContext(row.context as BackendContext); } catch { fail('EVIDENCE_INVALID'); }
  if (canonicalJson(objectContext) !== canonicalJson(context) || !sameAnchor(row.opening as EvidenceRecord['opening'], coverage.opening)) fail('EVIDENCE_ANCHOR');
  const record = row as EvidenceRecord;
  if (hashJson(record) !== id) fail('EVIDENCE_COMMITMENT');
  return record;
}

function parseDecisionInput(value: unknown): DecisionInput {
  const raw = exact(value, ['outcome', 'refundAmount', 'reason']);
  if ((raw.outcome !== 0 && raw.outcome !== 1 && raw.outcome !== 2) || typeof raw.reason !== 'string' ||
      raw.reason.trim().length === 0 || Buffer.byteLength(raw.reason, 'utf8') > MAX_REASON_BYTES) fail('DECISION_INVALID');
  uint(raw.refundAmount);
  return { outcome: raw.outcome, refundAmount: raw.refundAmount, reason: raw.reason };
}

function snapshotAuthorization(value: Authorization): Authorization {
  const raw = exact(value, ['actor', 'operation', 'coverageId', 'payloadHash', 'nonce', 'deadline', 'signature']);
  return {
    actor: raw.actor, operation: raw.operation, coverageId: raw.coverageId,
    payloadHash: raw.payloadHash, nonce: raw.nonce, deadline: raw.deadline, signature: raw.signature,
  } as Authorization;
}

/** Programmatic, single-process evidence and claim preparation library. */
export async function createClaimsBackend(options: ClaimsBackendOptions) {
  const context = normalizeContext(options.context);
  const projection = options.projection;
  const vault = options.vault;
  const replayPath = options.replayPath;
  if (!projection || typeof projection.refresh !== 'function' || !vault || typeof vault.put !== 'function' ||
      typeof vault.get !== 'function') fail('BACKEND_CONFIG');
  const refreshProjection = projection.refresh.bind(projection);
  const vaultPut = vault.put.bind(vault);
  const vaultGet = vault.get.bind(vault);
  const replay = await ReplayJournal.open(replayPath, context);

  async function fresh(coverageIdInput: unknown): Promise<{ snapshot: Snapshot; coverage: CoverageView; coverageId: Hex }> {
    const coverageId = requireId(coverageIdInput);
    let raw: Snapshot;
    try { raw = await refreshProjection(); } catch { fail('PROJECTION_UNAVAILABLE'); }
    const snapshot = snapshotRecord(raw, context);
    return { snapshot, coverage: getCoverage(snapshot, coverageId), coverageId };
  }

  async function authorize(
    snapshot: Snapshot,
    coverageId: Hex,
    operation: Operation,
    payload: unknown,
    auth: Authorization,
  ): Promise<Authorization> {
    const verified = await verifyAuthorization(context, auth, {
      operation, coverageId, payloadHash: operationPayloadHash(payload), now: BigInt(snapshot.head.timestamp),
    });
    await replay.consume(verified.actor, verified.nonce);
    return verified;
  }

  async function loadEvidence(coverage: CoverageView, coverageId: Hex, evidenceHash: Hex): Promise<EvidenceRecord> {
    const stored = await vaultGet('evidence', evidenceHash);
    if (stored === undefined) fail('EVIDENCE_NOT_FOUND');
    return evidenceRecord(stored, context, coverage, evidenceHash);
  }

  function payerOnly(coverage: CoverageView, actor: Address): void {
    if (actor !== coverage.payer) fail('AUTH_ROLE');
  }

  function action(snapshot: Snapshot, coverageId: Hex, from: Address, data: Hex): PreparedAction {
    return {
      chainId: 84532, to: context.core, from, data, value: '0', coverageId,
      observedBlock: { number: snapshot.head.number, hash: snapshot.head.hash },
    };
  }

  return Object.freeze({
    async uploadEvidence(coverageIdInput: unknown, bodyInput: Uint8Array, auth: Authorization): Promise<Hex> {
      const body = bodyInput instanceof Uint8Array ? new Uint8Array(bodyInput) : fail('EVIDENCE_INVALID');
      const signedAuth = snapshotAuthorization(auth);
      if (body.byteLength === 0 || body.byteLength > MAX_EVIDENCE_BYTES) fail('EVIDENCE_SIZE');
      const { snapshot, coverage, coverageId } = await fresh(coverageIdInput);
      if (coverage.status !== STATUS.active || BigInt(snapshot.head.timestamp) >= BigInt(coverage.expiresAt)) fail('CLAIM_STATE');
      const bodyHex = toHex(body);
      const payload = { bodyHex };
      const verified = await authorize(snapshot, coverageId, 'uploadEvidence', payload, signedAuth);
      payerOnly(coverage, verified.actor);
      const record: EvidenceRecord = {
        version: 1, kind: 'evidence', context, coverageId, opening: { ...coverage.opening }, payer: coverage.payer,
        requestHash: coverage.requestHash, salt: randomSalt(), bodyHex,
      };
      const evidenceHash = hashJson(record);
      await vaultPut('evidence', evidenceHash, record);
      return evidenceHash;
    },

    async readEvidence(coverageIdInput: unknown, evidenceHashInput: unknown, auth: Authorization): Promise<Uint8Array> {
      const evidenceHash = requireId(evidenceHashInput);
      const signedAuth = snapshotAuthorization(auth);
      const { snapshot, coverage, coverageId } = await fresh(coverageIdInput);
      const verified = await authorize(snapshot, coverageId, 'readEvidence', { evidenceHash }, signedAuth);
      const payerAccess = verified.actor === coverage.payer;
      const adjudicatorAccess = verified.actor === context.adjudicator &&
        (coverage.status === STATUS.claimPending || coverage.status === STATUS.refunded || coverage.status === STATUS.rejected) &&
        coverage.evidenceHash === evidenceHash;
      if (!payerAccess && !adjudicatorAccess) fail('AUTH_ROLE');
      const record = await loadEvidence(coverage, coverageId, evidenceHash);
      return new Uint8Array(Buffer.from(record.bodyHex.slice(2), 'hex'));
    },

    async prepareClaim(coverageIdInput: unknown, evidenceHashInput: unknown, auth: Authorization): Promise<PreparedAction> {
      const evidenceHash = requireId(evidenceHashInput);
      const signedAuth = snapshotAuthorization(auth);
      const { snapshot, coverage, coverageId } = await fresh(coverageIdInput);
      if (coverage.status !== STATUS.active || BigInt(snapshot.head.timestamp) >= BigInt(coverage.expiresAt) || !isZero(coverage.evidenceHash)) fail('CLAIM_STATE');
      const verified = await authorize(snapshot, coverageId, 'prepareClaim', { evidenceHash }, signedAuth);
      payerOnly(coverage, verified.actor);
      await loadEvidence(coverage, coverageId, evidenceHash);
      const data = encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [coverageId, evidenceHash] });
      return action(snapshot, coverageId, coverage.payer, data);
    },

    async prepareDecision(coverageIdInput: unknown, decisionValue: DecisionInput, auth: Authorization): Promise<{ action: PreparedAction; decisionHash: Hex }> {
      const decision = decisionValue && typeof decisionValue === 'object' && !Array.isArray(decisionValue)
        ? parseDecisionInput(decisionValue)
        : fail('DECISION_INVALID');
      const signedAuth = snapshotAuthorization(auth);
      const { snapshot, coverage, coverageId } = await fresh(coverageIdInput);
      if (coverage.status !== STATUS.claimPending || isZero(coverage.evidenceHash)) fail('CLAIM_STATE');
      const verified = await authorize(snapshot, coverageId, 'prepareDecision', decision, signedAuth);
      if (verified.actor !== context.adjudicator) fail('AUTH_ROLE');
      await loadEvidence(coverage, coverageId, coverage.evidenceHash);
      const refund = uint(decision.refundAmount);
      const gross = uint(coverage.gross);
      if ((decision.outcome === 0 && refund !== 0n) || (decision.outcome !== 0 && (refund === 0n || refund > gross)) ||
          (decision.outcome === 2 && !coverage.poolOnlyAllowed)) fail('DECISION_AMOUNT');
      const record: DecisionRecord = {
        version: 1, kind: 'decision', context, coverageId, opening: { ...coverage.opening }, payer: coverage.payer,
        evidenceHash: coverage.evidenceHash, outcome: decision.outcome, refundAmount: decision.refundAmount,
        reason: decision.reason, salt: randomSalt(),
      };
      const decisionHash = hashJson(record);
      await vaultPut('decision', decisionHash, record);
      const data = encodeFunctionData({ abi: CORE_ABI, functionName: 'finalizeClaim', args: [
        coverageId, decision.outcome, refund, decisionHash,
      ] });
      return { action: action(snapshot, coverageId, context.adjudicator, data), decisionHash };
    },
  });
}
