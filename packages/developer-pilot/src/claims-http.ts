import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Address, Hex } from 'viem';
import type { createClaimsBackend } from '../../claims-backend/src/claims.js';
import type { Authorization, CoverageView, DecisionInput, Projection, PreparedAction, Snapshot } from '../../claims-backend/src/types.js';

const MAX_JSON_BYTES = 143_360;
const MAX_EVIDENCE_BYTES = 65_536;
const ROUTES = new Set([
  '/v1/coverage/status', '/v1/evidence/upload', '/v1/evidence/read',
  '/v1/claims/prepare', '/v1/decisions/prepare',
]);
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export type ClaimsBackend = Awaited<ReturnType<typeof createClaimsBackend>>;
export interface ClaimsHttpOptions { url: string; backend: ClaimsBackend; projection: Projection }
export interface StartedClaimsServer { url: string; server: Server; close(): Promise<void> }
export interface PublicCoverageStatus {
  coverageId: Hex; payer: Address; status: number; gross: string; refundAmount: string; outcome: number;
  expiresAt: string; observedBlock: { number: string; hash: Hex };
}

function exact(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INVALID_REQUEST');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new Error('INVALID_REQUEST');
  return row;
}
function validId(value: unknown): value is Hex { return typeof value === 'string' && ID.test(value) && !/^0x0{64}$/.test(value); }
function validAddress(value: unknown): value is Address { return typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/.test(value); }
function validUInt(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78; }
function safeStatusUrl(input: string): { url: string; pathname: string; host: string } {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error('CLAIMS_URL_INVALID'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('CLAIMS_URL_INVALID');
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  if (pathname.includes('//')) throw new Error('CLAIMS_URL_INVALID');
  return { url: parsed.toString().replace(/\/$/, ''), pathname, host: `127.0.0.1:${parsed.port}` };
}
function fixed(res: ServerResponse, status: number, code: string): void {
  const body = Buffer.from(JSON.stringify({ error: code }), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.byteLength, 'cache-control': 'no-store' });
  res.end(body);
}
function fixedBytes(res: ServerResponse, bytes: Uint8Array): void {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.byteLength, 'cache-control': 'no-store' });
  res.end(Buffer.from(bytes));
}
function statusCode(error: unknown): { status: number; code: string } {
  const code = error instanceof Error ? error.message : '';
  if (code === 'AUTH_INVALID') return { status: 401, code };
  if (code === 'AUTH_ROLE') return { status: 403, code };
  if (code === 'AUTH_REPLAY' || code === 'REPLAY_CAP' || code === 'CLAIM_STATE' || code === 'DECISION_AMOUNT') return { status: 409, code };
  if (code === 'COVERAGE_NOT_FOUND' || code === 'EVIDENCE_NOT_FOUND') return { status: 404, code };
  if (code === 'PROJECTION_UNAVAILABLE' || code.startsWith('PROJECTION_') || code.startsWith('REPLAY_') || code === 'REPLAY_WRITE_FAILED') return { status: 503, code: code === 'REPLAY_CAP' ? code : 'BACKEND_UNAVAILABLE' };
  if (['INVALID_REQUEST', 'INVALID_ID', 'INVALID_ADDRESS', 'INVALID_UINT', 'EVIDENCE_INVALID', 'EVIDENCE_SIZE', 'DECISION_INVALID', 'AUTH_SCHEMA'].includes(code)) return { status: 400, code: 'INVALID_REQUEST' };
  return { status: 500, code: 'INTERNAL_ERROR' };
}
function validAuthorization(input: unknown): Authorization {
  const row = exact(input, ['actor', 'operation', 'coverageId', 'payloadHash', 'nonce', 'deadline', 'signature']);
  if (!validAddress(row.actor) || !['uploadEvidence', 'readEvidence', 'prepareClaim', 'prepareDecision'].includes(row.operation as string) ||
      !validId(row.coverageId) || !validId(row.payloadHash) && row.payloadHash !== `0x${'0'.repeat(64)}` || !validId(row.nonce) ||
      !validUInt(row.deadline) || typeof row.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(row.signature)) throw new Error('INVALID_REQUEST');
  return row as Authorization;
}
async function requestBytes(req: IncomingMessage): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (typeof declared !== 'string' || !/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) throw new Error('BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.byteLength;
    if (size > MAX_JSON_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}
async function jsonRequest(req: IncomingMessage): Promise<unknown> {
  const bytes = await requestBytes(req);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    // JSON.parse validates grammar; scan string/structural tokens to reject duplicate
    // object keys, including equivalent escaped names, without rejecting normal JSON encodings.
    const stack: Array<{object:boolean;expectKey:boolean;keys:Set<string>}> = [];
    const tokens = text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],]/g);
    for (const [token] of tokens) {
      if (token === '{' || token === '[') stack.push({object:token === '{',expectKey:token === '{',keys:new Set()});
      else if (token === '}' || token === ']') stack.pop();
      else if (token === ',') {const top=stack.at(-1);if(top?.object)top.expectKey=true;}
      else {
        const top=stack.at(-1);
        if(top?.object && top.expectKey){const key=JSON.parse(token) as string;if(top.keys.has(key))throw new Error();top.keys.add(key);top.expectKey=false;}
      }
    }
    return parsed;
  } catch { throw new Error('INVALID_REQUEST'); }
}
function publicCoverage(snapshot: Snapshot, coverageId: Hex): PublicCoverageStatus {
  const coverage = snapshot.coverages[coverageId] as CoverageView | undefined;
  if (!coverage) throw new Error('COVERAGE_NOT_FOUND');
  if (!snapshot.head || !validUInt(snapshot.head.number) || !validId(snapshot.head.hash)) throw new Error('PROJECTION_INVALID');
  if (!validId(coverage.coverageId) || coverage.coverageId !== coverageId || !validAddress(coverage.payer) ||
      !Number.isInteger(coverage.status) || coverage.status < 0 || coverage.status > 5 || !validUInt(coverage.gross) || !validUInt(coverage.refundAmount) ||
      ![0, 1, 2].includes(coverage.outcome) || !validUInt(coverage.expiresAt)) throw new Error('PROJECTION_INVALID');
  return {
    coverageId, payer: coverage.payer, status: coverage.status, gross: coverage.gross,
    refundAmount: coverage.refundAmount, outcome: coverage.outcome, expiresAt: coverage.expiresAt,
    observedBlock: { number: snapshot.head.number, hash: snapshot.head.hash },
  };
}
function decodeHexBody(bodyHex: unknown): Uint8Array {
  if (typeof bodyHex !== 'string' || !HEX_BYTES.test(bodyHex) || bodyHex.length < 4 || bodyHex.length > MAX_EVIDENCE_BYTES * 2 + 2) throw new Error('INVALID_REQUEST');
  return new Uint8Array(Buffer.from(bodyHex.slice(2), 'hex'));
}

/** Starts a fixed-route, POST-only loopback API. It prepares actions but never signs or sends them. */
export async function startClaimsServer(options: ClaimsHttpOptions): Promise<StartedClaimsServer> {
  const configured = safeStatusUrl(options.url);
  if (!options.backend || !options.projection || typeof options.projection.refresh !== 'function') throw new Error('CLAIMS_CONFIG_INVALID');
  const queue: Array<() => void> = [];
  let busy = false;
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (busy && queue.length >= 32) throw new Error('QUEUE_FULL');
    if (busy) await new Promise<void>(resolve => queue.push(resolve));
    busy = true;
    try { return await action(); }
    finally { const next = queue.shift(); if (next) next(); else busy = false; }
  }
  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const hosts = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'host');
      const contentTypes = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'content-type');
      const encodings = req.rawHeaders.flatMap((value, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'content-encoding' ? [req.rawHeaders[i + 1]!] : []);
      if (req.method !== 'POST' || !req.url || !ROUTES.has(req.url.slice(configured.pathname.length)) ||
          !req.url.startsWith(configured.pathname) || req.url.includes('?') || req.url.includes('#')) return fixed(res, 404, 'ROUTE_NOT_FOUND');
      if (hosts.length !== 1 || req.headers.host !== configured.host) return fixed(res, 400, 'INVALID_HOST');
      if (contentTypes.length !== 1 || req.headers['content-type'] !== 'application/json') return fixed(res, 415, 'UNSUPPORTED_CONTENT_TYPE');
      if (encodings.length > 1 || (encodings.length === 1 && encodings[0]!.toLowerCase() !== 'identity')) return fixed(res, 415, 'UNSUPPORTED_ENCODING');
      if (req.rawHeaders.some((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'origin')) return fixed(res, 400, 'INVALID_HEADERS');
      let input: any;
      try { input = await jsonRequest(req); }
      catch (error) { return fixed(res, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST'); }
      const route = req.url.slice(configured.pathname.length);
      let result: unknown;
      try {
        result = await exclusive(async () => {
          if (route === '/v1/coverage/status') {
            const row = exact(input, ['coverageId']);
            if (!validId(row.coverageId)) throw new Error('INVALID_REQUEST');
            return publicCoverage(await options.projection.refresh(), row.coverageId);
          }
          if (route === '/v1/evidence/upload') {
            const row = exact(input, ['coverageId', 'bodyHex', 'authorization']);
            if (!validId(row.coverageId)) throw new Error('INVALID_REQUEST');
            return { evidenceHash: await options.backend.uploadEvidence(row.coverageId, decodeHexBody(row.bodyHex), validAuthorization(row.authorization)) };
          }
          if (route === '/v1/evidence/read') {
            const row = exact(input, ['coverageId', 'evidenceHash', 'authorization']);
            if (!validId(row.coverageId) || !validId(row.evidenceHash)) throw new Error('INVALID_REQUEST');
            return await options.backend.readEvidence(row.coverageId, row.evidenceHash, validAuthorization(row.authorization));
          }
          if (route === '/v1/claims/prepare') {
            const row = exact(input, ['coverageId', 'evidenceHash', 'authorization']);
            if (!validId(row.coverageId) || !validId(row.evidenceHash)) throw new Error('INVALID_REQUEST');
            return await options.backend.prepareClaim(row.coverageId, row.evidenceHash, validAuthorization(row.authorization));
          }
          const row = exact(input, ['coverageId', 'decision', 'authorization']);
          if (!validId(row.coverageId)) throw new Error('INVALID_REQUEST');
          const decision = exact(row.decision, ['outcome', 'refundAmount', 'reason']) as unknown as DecisionInput;
          return await options.backend.prepareDecision(row.coverageId, decision, validAuthorization(row.authorization));
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'QUEUE_FULL') return fixed(res, 503, 'SERVICE_BUSY');
        const mapped = statusCode(error);
        return fixed(res, mapped.status, mapped.code);
      }
      if (route === '/v1/evidence/read') {
        if (!(result instanceof Uint8Array) || result.byteLength > MAX_EVIDENCE_BYTES) return fixed(res, 500, 'INTERNAL_ERROR');
        return fixedBytes(res, result);
      }
      const body = Buffer.from(JSON.stringify(result), 'utf8');
      if (body.byteLength > MAX_JSON_BYTES) return fixed(res, 500, 'INTERNAL_ERROR');
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.byteLength, 'cache-control': 'no-store' });
      return res.end(body);
    } catch {
      if (!res.headersSent) fixed(res, 500, 'INTERNAL_ERROR'); else res.destroy();
    }
  };
  const server = createServer((req, res) => { void listener(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(new URL(configured.url).port), '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    url: configured.url, server,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }),
  };
}
