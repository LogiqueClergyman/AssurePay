import type { Address, Hex } from 'viem';
import type { Authorization, DecisionInput, PreparedAction } from '../../claims-backend/src/types.js';
import type { PublicCoverageStatus } from './claims-http.js';

const MAX_JSON_BYTES = 143_360;
const MAX_EVIDENCE_BYTES = 65_536;
const ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;

export interface ClaimsClientOptions { url: string; fetch?: typeof globalThis.fetch }
export interface ClaimsClient {
  status(coverageId: Hex): Promise<PublicCoverageStatus>;
  uploadEvidence(coverageId: Hex, body: Uint8Array, authorization: Authorization): Promise<Hex>;
  readEvidence(coverageId: Hex, evidenceHash: Hex, authorization: Authorization): Promise<Uint8Array>;
  prepareClaim(coverageId: Hex, evidenceHash: Hex, authorization: Authorization): Promise<PreparedAction>;
  prepareDecision(coverageId: Hex, decision: DecisionInput, authorization: Authorization): Promise<{ action: PreparedAction; decisionHash: Hex }>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INVALID_CLAIMS_RESPONSE');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new Error('INVALID_CLAIMS_RESPONSE');
  return row;
}
function validId(value: unknown): value is Hex { return typeof value === 'string' && ID.test(value) && !/^0x0{64}$/.test(value); }
function validAddress(value: unknown): value is Address { return typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/.test(value); }
function validUInt(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78; }
function safeUrl(input: string): { url: string; pathname: string } {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error('CLAIMS_URL_INVALID'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('CLAIMS_URL_INVALID');
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  if (pathname.includes('//')) throw new Error('CLAIMS_URL_INVALID');
  return { url: parsed.toString().replace(/\/$/, ''), pathname };
}
function validAuth(value: Authorization): Authorization {
  const row = exact(value, ['actor', 'operation', 'coverageId', 'payloadHash', 'nonce', 'deadline', 'signature']);
  if (!validAddress(row.actor) || !['uploadEvidence', 'readEvidence', 'prepareClaim', 'prepareDecision'].includes(row.operation) ||
      !validId(row.coverageId) || !(validId(row.payloadHash) || row.payloadHash === `0x${'0'.repeat(64)}`) || !validId(row.nonce) ||
      !validUInt(row.deadline) || typeof row.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(row.signature)) throw new Error('INVALID_AUTHORIZATION');
  return row as Authorization;
}
function validDecision(value: DecisionInput): DecisionInput {
  const row = exact(value, ['outcome', 'refundAmount', 'reason']);
  if (![0, 1, 2].includes(row.outcome) || !validUInt(row.refundAmount) || typeof row.reason !== 'string' ||
      row.reason.trim().length === 0 || Buffer.byteLength(row.reason, 'utf8') > 8192) throw new Error('INVALID_DECISION');
  return row as DecisionInput;
}
function validAction(value: unknown, expectedCoverageId: Hex): PreparedAction {
  const row = exact(value, ['chainId', 'to', 'from', 'data', 'value', 'coverageId', 'observedBlock']);
  const observed = exact(row.observedBlock, ['number', 'hash']);
  if (row.chainId !== 84532 || !validAddress(row.to) || !validAddress(row.from) || typeof row.data !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(row.data) || row.value !== '0' || row.coverageId !== expectedCoverageId ||
      !validUInt(observed.number) || !validId(observed.hash)) throw new Error('INVALID_CLAIMS_RESPONSE');
  return row as PreparedAction;
}
function validStatus(value: unknown, expected: Hex): PublicCoverageStatus {
  const row = exact(value, ['coverageId', 'payer', 'status', 'gross', 'refundAmount', 'outcome', 'expiresAt', 'observedBlock']);
  const observed = exact(row.observedBlock, ['number', 'hash']);
  if (row.coverageId !== expected || !validAddress(row.payer) || !Number.isInteger(row.status) || row.status < 0 || row.status > 5 ||
      !validUInt(row.gross) || !validUInt(row.refundAmount) || ![0, 1, 2].includes(row.outcome) || !validUInt(row.expiresAt) ||
      !validUInt(observed.number) || !validId(observed.hash)) throw new Error('INVALID_CLAIMS_RESPONSE');
  return row as PublicCoverageStatus;
}
async function bounded(response: Response, max: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new Error('CLAIMS_RESPONSE_TOO_LARGE');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel().catch(() => undefined); throw new Error('CLAIMS_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Creates a loopback-only claims API client. It never retries or follows redirects. */
export function createClaimsClient(options: ClaimsClientOptions): ClaimsClient {
  const configured = safeUrl(options.url);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new Error('CLAIMS_FETCH_UNAVAILABLE');
  async function request(route: string, body: unknown, binary = false): Promise<unknown | Uint8Array> {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    if (bytes.byteLength > MAX_JSON_BYTES) throw new Error('CLAIMS_REQUEST_TOO_LARGE');
    const response = await fetcher(`${configured.url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'identity' },
      body: bytes, redirect: 'error', cache: 'no-store',
    });
    const content = await bounded(response, binary && response.ok ? MAX_EVIDENCE_BYTES : MAX_JSON_BYTES);
    if (!response.ok) {
      let code = 'CLAIMS_REQUEST_FAILED';
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
        const row = exact(value, ['error']);
        if (typeof row.error === 'string' && /^[A-Z0-9_]{1,48}$/.test(row.error)) code = row.error;
      } catch { /* keep the fixed client error */ }
      throw new Error(code);
    }
    if (binary) {
      if (response.headers.get('content-type') !== 'application/octet-stream') throw new Error('INVALID_CLAIMS_RESPONSE');
      return content;
    }
    if (response.headers.get('content-type') !== 'application/json') throw new Error('INVALID_CLAIMS_RESPONSE');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as unknown; }
    catch { throw new Error('INVALID_CLAIMS_RESPONSE'); }
  }
  return Object.freeze({
    async status(coverageId: Hex): Promise<PublicCoverageStatus> {
      if (!validId(coverageId)) throw new Error('INVALID_COVERAGE_ID');
      return validStatus(await request(`${configured.pathname}/v1/coverage/status`, { coverageId }), coverageId);
    },
    async uploadEvidence(coverageId: Hex, body: Uint8Array, authorization: Authorization): Promise<Hex> {
      if (!validId(coverageId)) throw new Error('INVALID_COVERAGE_ID');
      if (!(body instanceof Uint8Array) || body.byteLength === 0 || body.byteLength > MAX_EVIDENCE_BYTES) throw new Error('EVIDENCE_SIZE');
      const bodyHex = `0x${Buffer.from(body).toString('hex')}`;
      const result = exact(await request(`${configured.pathname}/v1/evidence/upload`, { coverageId, bodyHex, authorization: validAuth(authorization) }), ['evidenceHash']);
      if (!validId(result.evidenceHash)) throw new Error('INVALID_CLAIMS_RESPONSE');
      return result.evidenceHash;
    },
    async readEvidence(coverageId: Hex, evidenceHash: Hex, authorization: Authorization): Promise<Uint8Array> {
      if (!validId(coverageId) || !validId(evidenceHash)) throw new Error('INVALID_EVIDENCE_ID');
      return await request(`${configured.pathname}/v1/evidence/read`, { coverageId, evidenceHash, authorization: validAuth(authorization) }, true) as Uint8Array;
    },
    async prepareClaim(coverageId: Hex, evidenceHash: Hex, authorization: Authorization): Promise<PreparedAction> {
      if (!validId(coverageId) || !validId(evidenceHash)) throw new Error('INVALID_EVIDENCE_ID');
      return validAction(await request(`${configured.pathname}/v1/claims/prepare`, { coverageId, evidenceHash, authorization: validAuth(authorization) }), coverageId);
    },
    async prepareDecision(coverageId: Hex, decision: DecisionInput, authorization: Authorization): Promise<{ action: PreparedAction; decisionHash: Hex }> {
      if (!validId(coverageId)) throw new Error('INVALID_COVERAGE_ID');
      const result = exact(await request(`${configured.pathname}/v1/decisions/prepare`, { coverageId, decision: validDecision(decision), authorization: validAuth(authorization) }), ['action', 'decisionHash']);
      if (!validId(result.decisionHash)) throw new Error('INVALID_CLAIMS_RESPONSE');
      return { action: validAction(result.action, coverageId), decisionHash: result.decisionHash };
    },
  });
}
