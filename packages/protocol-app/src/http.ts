import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { address, id, roleAddress } from './common.js';
import { protocolErrorCode } from './errors.js';
import type { ActionPreview, ActionResult, Anchor, CoverageRow, PolicyRow, ProtocolRuntime, ProtocolServer, ProviderRow, ReadSnapshot, Role, Summary } from './types.js';

const JSON_LIMIT = 32_768;
const EVIDENCE_LIMIT = 65_536;
const PAGE_MAX = 100;
const PAGE_TTL_MS = 120_000;
const SESSION_TTL_MS = 30 * 60_000;
const BOOTSTRAP_TTL_MS = 60_000;
const ROLES: readonly Role[] = ['admin', 'provider', 'adjudicator', 'operator'];

type Session = { id: string; role: Role; actor: string; csrf: string; expires: number };
type PreviewOwner = { sessionId: string; role: Role };
type PageKind = 'providers' | 'policies' | 'coverages';
type Page = { id: string; sessionId: string; kind: PageKind; filter: string; rows: readonly unknown[]; anchor: Anchor; offset: number; limit: number; expires: number };

function token(): string { return randomBytes(32).toString('base64url'); }
function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!plainObject(value)) throw Error('PROTOCOL_ARGUMENT_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== 'string' || (!required.includes(k) && !optional.includes(k))) || required.some(k => !Object.hasOwn(value, k)))
    throw Error('PROTOCOL_ARGUMENT_INVALID');
  for (const k of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw Error('PROTOCOL_ARGUMENT_INVALID');
  }
  return value;
}

// JSON.parse accepts duplicate names with last-value-wins. Scan the grammar first and
// compare decoded property names at each object level, so escaped-equivalent keys fail too.
function parseJsonUnique(source: string): unknown {
  let i = 0;
  const ws = () => { while (i < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[i]!)) i++; };
  const string = (): string => {
    const start = i;
    if (source[i++] !== '"') throw Error('PROTOCOL_ARGUMENT_INVALID');
    while (i < source.length) {
      const c = source.charCodeAt(i++);
      if (c === 0x22) return JSON.parse(source.slice(start, i)) as string;
      if (c < 0x20) throw Error('PROTOCOL_ARGUMENT_INVALID');
      if (c === 0x5c) {
        if (i >= source.length) throw Error('PROTOCOL_ARGUMENT_INVALID');
        const e = source[i++]!;
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(i, i + 4))) throw Error('PROTOCOL_ARGUMENT_INVALID');
          i += 4;
        } else if (!'"\\/bfnrt'.includes(e)) throw Error('PROTOCOL_ARGUMENT_INVALID');
      }
    }
    throw Error('PROTOCOL_ARGUMENT_INVALID');
  };
  const value = (): void => {
    ws();
    const c = source[i];
    if (c === '"') { string(); return; }
    if (c === '{') {
      i++; ws(); const names = new Set<string>();
      if (source[i] === '}') { i++; return; }
      while (true) {
        ws(); const name = string();
        if (names.has(name)) throw Error('PROTOCOL_ARGUMENT_INVALID');
        names.add(name); ws(); if (source[i++] !== ':') throw Error('PROTOCOL_ARGUMENT_INVALID');
        value(); ws(); const sep = source[i++];
        if (sep === '}') return;
        if (sep !== ',') throw Error('PROTOCOL_ARGUMENT_INVALID');
      }
    }
    if (c === '[') {
      i++; ws(); if (source[i] === ']') { i++; return; }
      while (true) { value(); ws(); const sep = source[i++]; if (sep === ']') return; if (sep !== ',') throw Error('PROTOCOL_ARGUMENT_INVALID'); }
    }
    const rest = source.slice(i);
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(rest)?.[0];
    if (!literal) throw Error('PROTOCOL_ARGUMENT_INVALID');
    i += literal.length;
  };
  value(); ws(); if (i !== source.length) throw Error('PROTOCOL_ARGUMENT_INVALID');
  return JSON.parse(source);
}

async function bodyJson(req: IncomingMessage, max = JSON_LIMIT): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || contentType.toLowerCase() !== 'application/json') throw Error('PROTOCOL_MEDIA_INVALID');
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding.toLowerCase() !== 'identity') throw Error('PROTOCOL_MEDIA_INVALID');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > max)) throw Error('PROTOCOL_BODY_TOO_LARGE');
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > max) throw Error('PROTOCOL_BODY_TOO_LARGE');
    chunks.push(b);
  }
  if (!total) throw Error('PROTOCOL_ARGUMENT_INVALID');
  try { return parseJsonUnique(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw Error('PROTOCOL_ARGUMENT_INVALID'); }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(data.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(data);
}
function statusFor(code: string): number {
  if (code === 'PROTOCOL_SESSION_REQUIRED' || code === 'PROTOCOL_CSRF_REQUIRED') return 401;
  if (['PROTOCOL_FORBIDDEN', 'PROTOCOL_ORIGIN_INVALID', 'PROTOCOL_HOST_INVALID'].includes(code)) return 403;
  if (code === 'PROTOCOL_NOT_FOUND') return 404;
  if (code === 'PROTOCOL_BODY_TOO_LARGE') return 413;
  if (code === 'PROTOCOL_METHOD_INVALID') return 405;
  if (code === 'PROTOCOL_LIMIT') return 429;
  if (code === 'PROTOCOL_STATE_UNAVAILABLE' || code === 'PROTOCOL_RPC_UNAVAILABLE' || code === 'PROTOCOL_REORG') return 503;
  return 400;
}
function safeError(res: ServerResponse, error: unknown): void {
  const code = protocolErrorCode(error);
  send(res, statusFor(code), { error: code });
}
function cookieValue(req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw.length > 4096) return undefined;
  const matches: string[] = [];
  for (const item of raw.split(';')) {
    const part = item.trim(); const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === 'assurepay_session') matches.push(part.slice(eq + 1).trim());
  }
  return matches.length === 1 && /^[A-Za-z0-9_-]{40,64}$/.test(matches[0]!) ? matches[0] : undefined;
}
function roleInput(value: unknown): Role {
  if (typeof value !== 'string' || !ROLES.includes(value as Role)) throw Error('PROTOCOL_ROLE_INVALID');
  return value as Role;
}
function jsonSafeSummary(s: Summary): Summary {
  return {
    paused: s.paused, tokenBalanceAtomic: s.tokenBalanceAtomic, poolAssets: s.poolAssets, poolReserved: s.poolReserved,
    providerStake: s.providerStake, lockedStake: s.lockedStake, coverageCount: s.coverageCount, activeCoverageCount: s.activeCoverageCount,
    solvency: { balanceCoversAssetsAndStake: s.solvency.balanceCoversAssetsAndStake, stakeCoversLocks: s.solvency.stakeCoversLocks, poolCoversReservations: s.solvency.poolCoversReservations },
  };
}
function safeProvider(p: ProviderRow): ProviderRow {
  const counts: Record<string, string> = {};
  for (const status of ['0', '1', '2', '3', '4', '5']) if (Object.hasOwn(p.coverageCountsByStatus, status)) counts[status] = p.coverageCountsByStatus[status]!;
  return { providerId: p.providerId, owner: p.owner, payout: p.payout, freeStake: p.freeStake, lockedStake: p.lockedStake,
    payoutBalanceAtomic: p.payoutBalanceAtomic, cumulativeNetPaidAtomic: p.cumulativeNetPaidAtomic, coverageCountsByStatus: counts };
}
function safePolicy(p: PolicyRow): PolicyRow {
  return { policyId: p.policyId, providerId: p.providerId, policyHash: p.policyHash, premiumBps: p.premiumBps, stakeBps: p.stakeBps,
    withholdingBps: p.withholdingBps, duration: p.duration, poolOnlyAllowed: p.poolOnlyAllowed };
}
function safeCoverage(c: CoverageRow): CoverageRow {
  const result: CoverageRow = { coverageId: c.coverageId, payer: c.payer, providerId: c.providerId, policyId: c.policyId,
    gross: c.gross, premium: c.premium, withheld: c.withheld, stakeLock: c.stakeLock, poolReservation: c.poolReservation,
    openedAt: c.openedAt, expiresAt: c.expiresAt, poolOnlyAllowed: c.poolOnlyAllowed, status: c.status, hasEvidence: c.hasEvidence };
  if (c.status === 3 || c.status === 4) {
    if (c.outcome !== undefined) result.outcome = c.outcome;
    if (c.refundAmount !== undefined) result.refundAmount = c.refundAmount;
  }
  return result;
}
function safeSnapshot(s: ReadSnapshot): ReadSnapshot {
  return { anchor: { number: s.anchor.number, hash: s.anchor.hash, timestamp: s.anchor.timestamp }, summary: jsonSafeSummary(s.summary),
    providers: s.providers.map(safeProvider).sort((a, b) => a.providerId.localeCompare(b.providerId)),
    policies: s.policies.map(safePolicy).sort((a, b) => a.policyId.localeCompare(b.policyId)),
    coverages: s.coverages.map(safeCoverage).sort((a, b) => a.coverageId.localeCompare(b.coverageId)) };
}
function safeReview(p: ActionPreview): ActionPreview['review'] {
  const fields: Readonly<Record<ActionPreview['operation'], readonly string[]>> = {
    registerProvider: ['kind','providerId','owner','payout'],
    registerPolicy: ['kind','policyId','providerId','premiumBps','stakeBps','withholdingBps','duration','poolOnlyAllowed','policyHash'],
    setPaused: ['kind','paused'], approveCore: ['kind','amount'], depositStake: ['kind','providerId','amount'],
    withdrawStake: ['kind','providerId','amount'], fundPool: ['kind','amount'],
    finalizeClaim: ['kind','coverageId','outcome','refundAmount','reasonHash'],
  };
  if (!plainObject(p.review)) throw Error('PROTOCOL_STATE_UNAVAILABLE');
  const result: Record<string, string | number | boolean> = {};
  for (const key of fields[p.operation]) {
    const descriptor = Object.getOwnPropertyDescriptor(p.review, key);
    if (!descriptor) continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
      !['string','number','boolean'].includes(typeof descriptor.value)) throw Error('PROTOCOL_STATE_UNAVAILABLE');
    result[key] = descriptor.value as string | number | boolean;
  }
  return result as ActionPreview['review'];
}
function safePreview(p: ActionPreview): ActionPreview {
  return { previewId: p.previewId, role: p.role, actor: p.actor, operation: p.operation, review: safeReview(p), chainId: p.chainId,
    core: p.core, anchor: { number: p.anchor.number, hash: p.anchor.hash, timestamp: p.anchor.timestamp }, expiresAt: p.expiresAt,
    gas: p.gas, maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas };
}
function safeResult(r: ActionResult): ActionResult {
  const out: ActionResult = { operationId: r.operationId, operation: r.operation, actor: r.actor, status: r.status };
  if (r.transaction !== undefined) out.transaction = r.transaction;
  if (r.inclusion !== undefined) out.inclusion = { number: r.inclusion.number, hash: r.inclusion.hash };
  return out;
}
function queryShape(url: URL, kind: PageKind): { limit: number; cursor?: string; filter: string } {
  const allowed = kind === 'coverages' ? ['limit', 'cursor', 'providerId', 'status'] : ['limit', 'cursor'];
  const seen = new Set<string>();
  for (const [k] of url.searchParams) { if (!allowed.includes(k) || seen.has(k)) throw Error('PROTOCOL_ARGUMENT_INVALID'); seen.add(k); }
  const lim = url.searchParams.get('limit') ?? '50';
  if (!/^(?:[1-9][0-9]{0,2})$/.test(lim) || Number(lim) > PAGE_MAX) throw Error('PROTOCOL_ARGUMENT_INVALID');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{40,64}$/.test(cursor)) throw Error('PROTOCOL_CURSOR_INVALID');
  let filter = '';
  if (kind === 'coverages') {
    const providerId = url.searchParams.get('providerId'); const status = url.searchParams.get('status');
    if (providerId !== null) filter += `provider:${id(providerId)}`;
    if (status !== null) {
      if (!/^(?:0|[1-5])$/.test(status)) throw Error('PROTOCOL_ARGUMENT_INVALID');
      filter += `|status:${status}`;
    }
  }
  return { limit: Number(lim), cursor, filter };
}
function pathId(value: string): string { return id(value); }

export async function startProtocolServer({ runtime }: { runtime: ProtocolRuntime }): Promise<ProtocolServer> {
  const url = new URL(runtime.config.apiUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw Error('PROTOCOL_CONFIG_INVALID');
  const expectedHost = url.host;
  const bootstraps = new Map<string, { role: Role; expires: number }>();
  const sessions = new Map<string, Session>();
  const previewOwners = new Map<string, PreviewOwner>();
  const pages = new Map<string, Page>();
  const sessionPages = new Map<string, Set<string>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const server: Server = createServer((req, res) => { void handle(req, res); });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      res.setHeader('cache-control', 'no-store');
      const rawHost = req.headers.host;
      const rawHeaders = req.rawHeaders;
      const hostCount = rawHeaders.filter((_, index) => index % 2 === 0 && rawHeaders[index]!.toLowerCase() === 'host').length;
      if (hostCount !== 1 || typeof rawHost !== 'string' || rawHost.includes(',') || rawHost !== expectedHost ||
          rawHeaders.some((name, index) => index % 2 === 0 && name.toLowerCase().startsWith('x-forwarded-')))
        throw Error('PROTOCOL_HOST_INVALID');
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') throw Error('PROTOCOL_ORIGIN_INVALID');
      const origin = req.headers.origin;
      if (req.method === 'POST') {
        if (typeof origin !== 'string' || origin !== runtime.config.apiUrl) throw Error('PROTOCOL_ORIGIN_INVALID');
      } else if (origin !== undefined && origin !== runtime.config.apiUrl) throw Error('PROTOCOL_ORIGIN_INVALID');
      const path = new URL(req.url ?? '/', runtime.config.apiUrl);
      if (path.origin !== runtime.config.apiUrl) throw Error('PROTOCOL_NOT_FOUND');
      const isListPath = /^\/v1\/(providers|policies|coverages)$/.test(path.pathname);
      if (!isListPath && path.search !== '') throw Error('PROTOCOL_ARGUMENT_INVALID');

      if (req.method === 'POST' && path.pathname === '/v1/session') {
        const body = exactKeys(await bodyJson(req), ['bootstrapToken']);
        if (typeof body.bootstrapToken !== 'string') throw Error('PROTOCOL_BOOTSTRAP_INVALID');
        const capability = bootstraps.get(body.bootstrapToken);
        bootstraps.delete(body.bootstrapToken);
        if (!capability || capability.expires < Date.now()) throw Error('PROTOCOL_BOOTSTRAP_INVALID');
        prune();
        if (sessions.size >= 16) throw Error('PROTOCOL_LIMIT');
        const sid = token(), cookie = token();
        const session: Session = { id: sid, role: capability.role, actor: roleAddress(runtime.config, capability.role), csrf: token(), expires: Date.now() + SESSION_TTL_MS };
        sessions.set(cookie, session);
        sessionPages.set(sid, new Set());
        send(res, 201, sessionView(session), { 'set-cookie': `assurepay_session=${cookie}; Path=/v1; HttpOnly; SameSite=Strict` });
        return;
      }

      const cookie = cookieValue(req);
      const session = cookie ? sessions.get(cookie) : undefined;
      if (!session || session.expires <= Date.now()) {
        if (cookie && session) sessions.delete(cookie);
        throw Error('PROTOCOL_SESSION_REQUIRED');
      }
      if (req.method === 'POST') {
        if (typeof req.headers['x-assurepay-csrf'] !== 'string' || req.headers['x-assurepay-csrf'] !== session.csrf) throw Error('PROTOCOL_CSRF_REQUIRED');
      }

      if (req.method === 'GET' && path.pathname === '/v1/session') { send(res, 200, sessionView(session)); return; }
      if (req.method === 'POST' && path.pathname === '/v1/logout') {
        const body = exactKeys(await bodyJson(req), []); void body;
        sessions.delete(cookie!); clearPages(session.id); clearPreviews(session.id);
        send(res, 200, { closed: true }, { 'set-cookie': 'assurepay_session=; Path=/v1; HttpOnly; SameSite=Strict; Max-Age=0' }); return;
      }
      if (req.method === 'GET' && path.pathname === '/v1/summary') {
        const snapshot = safeSnapshot(await runtime.snapshot());
        send(res, 200, { anchor: snapshot.anchor, summary: snapshot.summary }); return;
      }
      const listMatch = /^\/v1\/(providers|policies|coverages)$/.exec(path.pathname);
      if (req.method === 'GET' && listMatch) { await list(req, res, session, path, listMatch[1] as PageKind); return; }
      const detail = /^\/v1\/(providers|policies|coverages)\/(0x[0-9a-fA-F]{64})$/.exec(path.pathname);
      if (req.method === 'GET' && detail) { await getDetail(res, session, detail[1] as PageKind, pathId(detail[2]!)); return; }
      if (req.method === 'POST' && path.pathname === '/v1/actions/preview') {
        if (session.role === 'operator') throw Error('PROTOCOL_FORBIDDEN');
        const body = exactKeys(await bodyJson(req), ['operation']);
        const preview = safePreview(await runtime.preview(session.role, body.operation));
        if (previewOwners.size >= 96 || previewOwners.has(preview.previewId)) throw Error('PROTOCOL_LIMIT');
        previewOwners.set(preview.previewId, { sessionId: session.id, role: session.role });
        send(res, 200, preview); return;
      }
      if (req.method === 'POST' && path.pathname === '/v1/actions/confirm') {
        if (session.role === 'operator') throw Error('PROTOCOL_FORBIDDEN');
        const body = exactKeys(await bodyJson(req), ['previewId']);
        const previewId = id(body.previewId);
        const owner = previewOwners.get(previewId);
        if (!owner || owner.sessionId !== session.id || owner.role !== session.role) throw Error('PROTOCOL_PREVIEW_REQUIRED');
        previewOwners.delete(previewId);
        send(res, 200, safeResult(await runtime.confirm(session.role, previewId, { approved: true }))); return;
      }
      if (req.method === 'POST' && path.pathname === '/v1/actions/reconcile') {
        exactKeys(await bodyJson(req), []);
        const results = await runtime.reconcile(session.role);
        send(res, 200, results.map(safeResult)); return;
      }
      if (req.method === 'POST' && path.pathname === '/v1/evidence/read') {
        if (session.role !== 'adjudicator') throw Error('PROTOCOL_FORBIDDEN');
        const body = exactKeys(await bodyJson(req), ['coverageId']);
        const bytes = await runtime.readEvidence(session.role, id(body.coverageId));
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > EVIDENCE_LIMIT) throw Error('PROTOCOL_STATE_UNAVAILABLE');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(Buffer.from(bytes)); return;
      }
      if (req.method !== 'GET' && req.method !== 'POST') throw Error('PROTOCOL_METHOD_INVALID');
      throw Error('PROTOCOL_NOT_FOUND');
    } catch (error) { safeError(res, error); }
  }
  function sessionView(s: Session) {
    return { role: s.role, address: s.actor, capabilities: [...runtime.capabilities[s.role]], csrfToken: s.csrf, expiresAt: new Date(s.expires).toISOString() };
  }
  function prune(): void {
    const now = Date.now();
    for (const [t, b] of bootstraps) if (b.expires <= now) bootstraps.delete(t);
    for (const [c, s] of sessions) if (s.expires <= now) { sessions.delete(c); clearPages(s.id); clearPreviews(s.id); }
    for (const [c, p] of pages) if (p.expires <= now) removePage(c, p.sessionId);
  }
  function removePage(cursor: string, sid: string): void { pages.delete(cursor); sessionPages.get(sid)?.delete(cursor); }
  function clearPages(sid: string): void { for (const c of sessionPages.get(sid) ?? []) pages.delete(c); sessionPages.delete(sid); }
  function clearPreviews(sid: string): void { for (const [previewId, owner] of previewOwners) if (owner.sessionId === sid) previewOwners.delete(previewId); }
  function filteredRows(snapshot: ReadSnapshot, session: Session, kind: PageKind, filter: string): readonly unknown[] {
    let rows: readonly (ProviderRow | PolicyRow | CoverageRow)[] = kind === 'providers' ? snapshot.providers : kind === 'policies' ? snapshot.policies : snapshot.coverages;
    if (session.role === 'provider') {
      if (kind === 'providers') rows = rows.filter(r => (r as ProviderRow).providerId === runtime.config.pilot.providerId && (r as ProviderRow).owner === session.actor);
      else if (kind === 'policies') rows = rows.filter(r => (r as PolicyRow).providerId === runtime.config.pilot.providerId);
      else rows = rows.filter(r => (r as CoverageRow).providerId === runtime.config.pilot.providerId);
    }
    if (kind === 'coverages') {
      const pid = /(?:^|\|)provider:(0x[0-9a-f]{64})(?:\||$)/.exec(filter)?.[1] ?? null;
      const status = /(?:^|\|)status:([0-5])(?:\||$)/.exec(filter)?.[1] ?? null;
      if (pid) rows = rows.filter(r => (r as CoverageRow).providerId === pid);
      if (status !== null) rows = rows.filter(r => String((r as CoverageRow).status) === status);
    }
    return rows.map(r => kind === 'providers' ? safeProvider(r as ProviderRow) : kind === 'policies' ? safePolicy(r as PolicyRow) : safeCoverage(r as CoverageRow));
  }
  async function list(_req: IncomingMessage, res: ServerResponse, session: Session, url: URL, kind: PageKind): Promise<void> {
    const { limit, cursor, filter } = queryShape(url, kind);
    let page: Page;
    if (cursor) {
      page = pages.get(cursor)!;
      if (!page || page.sessionId !== session.id || page.kind !== kind || page.filter !== filter || page.limit !== limit || page.expires <= Date.now()) throw Error('PROTOCOL_CURSOR_INVALID');
      // Consume synchronously before the anchor RPC await so concurrent replays cannot branch the cursor.
      removePage(cursor, session.id);
      await runtime.assertAnchor(page.anchor);
    } else {
      prune();
      const snapshot = safeSnapshot(await runtime.snapshot());
      const rows = filteredRows(snapshot, session, kind, filter);
      const keys = sessionPages.get(session.id) ?? new Set<string>();
      if (keys.size >= 8) throw Error('PROTOCOL_LIMIT');
      const cursorId = token();
      page = { id: cursorId, sessionId: session.id, kind, filter, rows, anchor: snapshot.anchor, offset: 0, limit, expires: Date.now() + PAGE_TTL_MS };
      pages.set(cursorId, page); keys.add(cursorId); sessionPages.set(session.id, keys);
    }
    const rows = page.rows.slice(page.offset, page.offset + limit);
    const nextOffset = page.offset + rows.length;
    const next = nextOffset < page.rows.length ? token() : undefined;
    if (next) {
      const nextPage = { ...page, id: next, offset: nextOffset };
      pages.set(next, nextPage); sessionPages.get(session.id)?.add(next);
    }
    removePage(page.id, session.id);
    send(res, 200, { anchor: page.anchor, items: rows, ...(next ? { nextCursor: next } : {}) });
  }
  async function getDetail(res: ServerResponse, session: Session, kind: PageKind, key: string): Promise<void> {
    const snapshot = safeSnapshot(await runtime.snapshot());
    let item: ProviderRow | PolicyRow | CoverageRow | undefined;
    if (kind === 'providers') item = snapshot.providers.find(x => x.providerId === key);
    if (kind === 'policies') item = snapshot.policies.find(x => x.policyId === key);
    if (kind === 'coverages') item = snapshot.coverages.find(x => x.coverageId === key);
    if (!item) throw Error('PROTOCOL_NOT_FOUND');
    if (session.role === 'provider') {
      const allowed = kind === 'providers' ? (item as ProviderRow).providerId === runtime.config.pilot.providerId && (item as ProviderRow).owner === session.actor :
        kind === 'policies' ? (item as PolicyRow).providerId === runtime.config.pilot.providerId : (item as CoverageRow).providerId === runtime.config.pilot.providerId;
      if (!allowed) throw Error('PROTOCOL_NOT_FOUND');
    }
    send(res, 200, { anchor: snapshot.anchor, item });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(url.port), '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const bound = server.address();
  const actualUrl = `http://127.0.0.1:${typeof bound === 'object' && bound ? bound.port : Number(url.port)}`;
  if (actualUrl !== runtime.config.apiUrl) { await new Promise<void>(resolve => server.close(() => resolve())); throw Error('PROTOCOL_CONFIG_INVALID'); }
  return {
    url: actualUrl,
    issueBootstrap(roleValue: Role): string {
      if (closing) throw Error('PROTOCOL_CLOSED');
      const role = roleInput(roleValue); prune();
      if (bootstraps.size >= 16) throw Error('PROTOCOL_LIMIT');
      const capability = token(); bootstraps.set(capability, { role, expires: Date.now() + BOOTSTRAP_TTL_MS }); return capability;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      bootstraps.clear(); sessions.clear(); previewOwners.clear(); pages.clear(); sessionPages.clear();
      closePromise = new Promise<void>((resolve, reject) => server.close(error => error ? reject(Error('PROTOCOL_CLOSE_FAILED')) : resolve()));
      return closePromise;
    },
  };
}
