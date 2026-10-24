import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { startProtocolServer } from '../src/http.js';
import type { ProtocolRuntime, ReadSnapshot, Role } from '../src/types.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}
async function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); let data = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => { data += chunk; });
    socket.on('error', reject); socket.on('end', () => resolve(data)); socket.on('connect', () => socket.write(request));
  });
}

function fixture(origin: string) {
  const providerId = hash(11), policyId = hash(12), coverageId = hash(13);
  const calls: { preview: Role[]; confirm: Role[]; reconcile: Role[]; evidence: Role[]; anchor: number } = { preview: [], confirm: [], reconcile: [], evidence: [], anchor: 0 };
  let anchorGate: (() => Promise<void>) | undefined;
  const snapshot: ReadSnapshot = {
    anchor: { number: '7', hash: hash(7), timestamp: '100' },
    summary: { paused: false, tokenBalanceAtomic: '200', poolAssets: '100', poolReserved: '10', providerStake: '80', lockedStake: '20', coverageCount: '1', activeCoverageCount: '1', solvency: { balanceCoversAssetsAndStake: true, stakeCoversLocks: true, poolCoversReservations: true } },
    providers: [{ providerId, owner: addr(2), payout: addr(2), freeStake: '60', lockedStake: '20', payoutBalanceAtomic: '1', cumulativeNetPaidAtomic: '0', coverageCountsByStatus: { '0': '1', '5': '1', 'privateCount': '9' } }],
    policies: [{ policyId, providerId, policyHash: hash(14), premiumBps: 100, stakeBps: 1000, withholdingBps: 100, duration: '60', poolOnlyAllowed: true }],
    coverages: [
      { coverageId, payer: addr(3), providerId, policyId, gross: '50', premium: '1', withheld: '0', stakeLock: '5', poolReservation: '5', openedAt: '90', expiresAt: '150', poolOnlyAllowed: true, status: 1, hasEvidence: false, outcome: 2, refundAmount: '999' } as any,
      { coverageId: hash(15), payer: addr(3), providerId, policyId, gross: '60', premium: '2', withheld: '0', stakeLock: '6', poolReservation: '6', openedAt: '91', expiresAt: '151', poolOnlyAllowed: true, status: 0, hasEvidence: false },
      { coverageId: hash(16), payer: addr(3), providerId, policyId, gross: '70', premium: '3', withheld: '0', stakeLock: '0', poolReservation: '0', openedAt: '80', expiresAt: '85', poolOnlyAllowed: true, status: 5, hasEvidence: false },
    ],
  };
  const runtime = {
    config: { apiUrl: origin, admin: addr(1), pilot: { roles: { provider: addr(2), adjudicator: addr(4), relayer: addr(5) }, providerId } },
    capabilities: { admin: ['registerProvider'], provider: ['withdrawStake'], adjudicator: ['finalizeClaim'], operator: [] },
    snapshot: async () => ({ ...snapshot, summary: { ...snapshot.summary, secret: 'private-summary' }, providers: snapshot.providers.map(p => ({ ...p, signature: 'private-signature' })) } as any),
    assertAnchor: async () => { calls.anchor++; await anchorGate?.(); },
    preview: async (role: Role, input: any) => {
      calls.preview.push(role);
      const operation = input?.kind === 'finalizeClaim' ? 'finalizeClaim' : 'setPaused';
      const review = operation === 'finalizeClaim'
        ? { kind: operation, coverageId, outcome: 1, refundAmount: '1', reasonHash: hash(99), decisionHash: hash(98), serializedTransaction: 'secret' }
        : { kind: operation, paused: true, serializedTransaction: 'secret', unknownField: 'private', nested: { evidenceBytes: 'private' } };
      return { previewId: hash(20 + calls.preview.length), role, actor: addr(1), operation, review, chainId: 84532, core: addr(6), anchor: snapshot.anchor, expiresAt: '200', gas: '60000', maxFeePerGas: '100', maxPriorityFeePerGas: '1', rawTransaction: 'secret' } as any;
    },
    confirm: async (role: Role) => { calls.confirm.push(role); return { operationId: hash(22), operation: 'setPaused', actor: addr(1), status: 'success', transaction: hash(23), signedBytes: 'secret' } as any; },
    reconcile: async (role: Role) => { calls.reconcile.push(role); return [{ operationId: hash(22), operation: 'setPaused', actor: addr(1), status: 'unknown', privatePath: '/private' } as any]; },
    readEvidence: async (role: Role) => { calls.evidence.push(role); return Uint8Array.from([1, 2, 3]); },
    close: async () => {},
  } as unknown as ProtocolRuntime;
  return { runtime, calls, providerId, policyId, coverageId, setAnchorGate: (gate?: () => Promise<void>) => { anchorGate = gate; } };
}

async function start() {
  const origin = `http://127.0.0.1:${await freePort()}`;
  const f = fixture(origin);
  const server = await startProtocolServer({ runtime: f.runtime });
  return { ...f, origin, server };
}
function post(url: string, cookie: string | undefined, csrf: string | undefined, body: string, extra: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'x-assurepay-csrf': csrf } : {}), ...extra }, body,
    // Keep content-type under test control for malformed/media cases.
  });
}
async function login(f: Awaited<ReturnType<typeof start>>, role: Role = 'admin') {
  const capability = f.server.issueBootstrap(role);
  const response = await post(`${f.origin}/v1/session`, undefined, undefined, JSON.stringify({ bootstrapToken: capability }), { 'Content-Type': 'application/json' });
  const setCookie = response.headers.get('set-cookie')!;
  const cookie = setCookie.split(';', 1)[0]!;
  const view = await response.json() as { csrfToken: string; role: Role; address: string };
  return { cookie, csrf: view.csrfToken, response, view };
}

test('bootstrap is host-issued, one use, and session exposes only actor metadata', async () => {
  const f = await start();
  try {
    const { cookie, csrf, response, view } = await login(f, 'provider');
    assert.equal(response.status, 201);
    assert.equal(view.role, 'provider');
    assert.equal(view.address, addr(2));
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(response.headers.get('set-cookie')!, /SameSite=Strict/);
    assert.doesNotMatch(response.headers.get('set-cookie')!, /Domain=/i);
    assert.ok(csrf.length >= 40);
    assert.equal((await fetch(`${f.origin}/v1/session`, { headers: { Cookie: cookie } })).status, 200);
    const capability = f.server.issueBootstrap('admin');
    const duplicate = await post(`${f.origin}/v1/session`, undefined, undefined, `{"bootstrapToken":"${capability}","bootstrap\u0054oken":"${capability}"}`, { 'Content-Type': 'application/json' });
    assert.equal(duplicate.status, 400);
    const invalidUtf8 = await fetch(`${f.origin}/v1/session`, { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' },
      body: Uint8Array.from([0x7b, 0x22, 0x62, 0x6f, 0x6f, 0x74, 0x73, 0x74, 0x72, 0x61, 0x70, 0x54, 0x6f, 0x6b, 0x65, 0x6e, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) });
    assert.equal(invalidUtf8.status, 400);
    assert.equal((await invalidUtf8.json() as { error: string }).error, 'PROTOCOL_ARGUMENT_INVALID');
    assert.equal((await post(`${f.origin}/v1/session`, undefined, undefined, JSON.stringify({ bootstrapToken: capability }), { 'Content-Type': 'application/json' })).status, 201);
    assert.equal((await post(`${f.origin}/v1/session`, undefined, undefined, JSON.stringify({ bootstrapToken: capability }), { 'Content-Type': 'application/json' })).status, 400);
  } finally { await f.server.close(); }
});

test('same-origin, host, CSRF, media type, shape and method checks fail closed', async () => {
  const f = await start();
  try {
    const { cookie, csrf } = await login(f);
    const noCsrf = await post(`${f.origin}/v1/actions/reconcile`, cookie, undefined, '{}', { 'Content-Type': 'application/json' });
    assert.equal(noCsrf.status, 401);
    const wrongOrigin = await fetch(`${f.origin}/v1/logout`, { method: 'POST', headers: { Origin: 'http://evil.invalid', Cookie: cookie, 'x-assurepay-csrf': csrf, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(wrongOrigin.status, 403);
    const crossSite = await fetch(`${f.origin}/v1/logout`, { method: 'POST', headers: { Origin: f.origin, Cookie: cookie, 'x-assurepay-csrf': csrf, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(crossSite.status, 403);
    const forwarded = await fetch(`${f.origin}/v1/session`, { headers: { Cookie: cookie, 'X-Forwarded-Host': 'evil.invalid' } });
    assert.equal(forwarded.status, 403);
    const port = Number(new URL(f.origin).port);
    const duplicateHost = await rawHttp(port, `GET /v1/session HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    const duplicateHostStatus = Number(/^HTTP\/1\.1 (\d{3})/m.exec(duplicateHost)?.[1]);
    assert.ok([400, 403].includes(duplicateHostStatus));
    const wrongMedia = await post(`${f.origin}/v1/actions/reconcile`, cookie, csrf, '{}', { 'Content-Type': 'text/plain' });
    assert.equal(wrongMedia.status, 400);
    const compressed = await post(`${f.origin}/v1/actions/reconcile`, cookie, csrf, '{}', { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    assert.equal(compressed.status, 400);
    assert.equal((await compressed.json() as { error: string }).error, 'PROTOCOL_MEDIA_INVALID');
    const oversized = await post(`${f.origin}/v1/actions/reconcile`, cookie, csrf, `{"padding":"${'x'.repeat(33_000)}"}`, { 'Content-Type': 'application/json' });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { error: string }).error, 'PROTOCOL_BODY_TOO_LARGE');
    const extra = await post(`${f.origin}/v1/actions/reconcile`, cookie, csrf, '{"anything":true}', { 'Content-Type': 'application/json' });
    assert.equal(extra.status, 400);
    const getMutation = await fetch(`${f.origin}/v1/actions/confirm`, { headers: { Cookie: cookie } });
    assert.equal(getMutation.status, 404);
    const errors = await extra.json() as { error: string };
    assert.equal(errors.error, 'PROTOCOL_ARGUMENT_INVALID');
    assert.equal(JSON.stringify(errors).includes('anything'), false);
  } finally { await f.server.close(); }
});

test('actor authority, action delegation, scoped reads and pagination cursors are session-bound', async () => {
  const f = await start();
  try {
    const admin = await login(f, 'admin');
    const preview = await post(`${f.origin}/v1/actions/preview`, admin.cookie, admin.csrf, JSON.stringify({ operation: { kind: 'setPaused', paused: true }, role: 'provider' }), { 'Content-Type': 'application/json' });
    assert.equal(preview.status, 400); // exact wrapper schema does not accept a caller-selected role
    const goodPreview = await post(`${f.origin}/v1/actions/preview`, admin.cookie, admin.csrf, JSON.stringify({ operation: { kind: 'setPaused', paused: true } }), { 'Content-Type': 'application/json' });
    assert.equal(goodPreview.status, 200);
    const previewJson = await goodPreview.json() as Record<string, unknown>;
    assert.equal('rawTransaction' in previewJson, false);
    assert.deepEqual(previewJson.review, { kind: 'setPaused', paused: true });
    assert.deepEqual(f.calls.preview, ['admin']);
    const secondAdmin = await login(f, 'admin');
    const crossSession = await post(`${f.origin}/v1/actions/confirm`, secondAdmin.cookie, secondAdmin.csrf, JSON.stringify({ previewId: previewJson.previewId }), { 'Content-Type': 'application/json' });
    assert.equal(crossSession.status, 400);
    assert.deepEqual(f.calls.confirm, []);
    const confirmed = await post(`${f.origin}/v1/actions/confirm`, admin.cookie, admin.csrf, JSON.stringify({ previewId: hash(21) }), { 'Content-Type': 'application/json' });
    assert.equal(confirmed.status, 200);
    const confirmJson = await confirmed.json() as Record<string, unknown>;
    assert.equal('signedBytes' in confirmJson, false);
    const reconciled = await post(`${f.origin}/v1/actions/reconcile`, admin.cookie, admin.csrf, '{}', { 'Content-Type': 'application/json' });
    assert.equal(reconciled.status, 200);
    assert.equal(JSON.stringify(await reconciled.json()).includes('/private'), false);
    assert.deepEqual(f.calls.confirm, ['admin']);
    assert.deepEqual(f.calls.reconcile, ['admin']);

    const finalizePreview = await post(`${f.origin}/v1/actions/preview`, admin.cookie, admin.csrf,
      JSON.stringify({ operation: { kind: 'finalizeClaim', coverageId: f.coverageId, outcome: 1, refundAmount: '1', reason: 'private' } }), { 'Content-Type': 'application/json' });
    assert.equal(finalizePreview.status, 200);
    const finalizeReview = (await finalizePreview.json() as { review: Record<string, unknown> }).review;
    assert.deepEqual(finalizeReview, { kind: 'finalizeClaim', coverageId: f.coverageId, outcome: 1, refundAmount: '1', reasonHash: hash(99) });

    const provider = await login(f, 'provider');
    const summary = await fetch(`${f.origin}/v1/summary`, { headers: { Cookie: provider.cookie } });
    assert.equal(summary.status, 200);
    assert.equal(JSON.stringify(await summary.json()).includes('private-summary'), false);
    const page = await fetch(`${f.origin}/v1/providers?limit=1`, { headers: { Cookie: provider.cookie } });
    assert.equal(page.status, 200);
    const providerPage = await page.json() as { items: Array<{ coverageCountsByStatus: Record<string, string> }> };
    assert.equal(JSON.stringify(providerPage).includes('private-signature'), false);
    assert.equal(providerPage.items[0]!.coverageCountsByStatus['5'], '1');
    assert.equal('privateCount' in providerPage.items[0]!.coverageCountsByStatus, false);
    const forbidden = await post(`${f.origin}/v1/evidence/read`, provider.cookie, provider.csrf, JSON.stringify({ coverageId: f.coverageId }), { 'Content-Type': 'application/json' });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(f.calls.evidence, []);
    const cursorPage = await fetch(`${f.origin}/v1/coverages?limit=1`, { headers: { Cookie: provider.cookie } });
    const cursorResult = await cursorPage.json() as { nextCursor?: string };
    assert.equal(cursorPage.status, 200);
    assert.ok(cursorResult.nextCursor);
    const firstCoverage = (await fetch(`${f.origin}/v1/coverages?limit=1&providerId=${f.providerId}`, { headers: { Cookie: provider.cookie } }).then(r => r.json()) as { items: Array<Record<string, unknown>> }).items[0]!;
    assert.equal('outcome' in firstCoverage, false);
    assert.equal('refundAmount' in firstCoverage, false);
    const wrongSession = await fetch(`${f.origin}/v1/coverages?limit=1&cursor=${cursorResult.nextCursor}`, { headers: { Cookie: admin.cookie } });
    assert.equal(wrongSession.status, 400);
    let enterAnchor!: () => void, releaseAnchor!: () => void;
    const anchorEntered = new Promise<void>(resolve => { enterAnchor = resolve; });
    const anchorBlock = new Promise<void>(resolve => { releaseAnchor = resolve; });
    f.setAnchorGate(async () => { enterAnchor(); await anchorBlock; });
    const firstUse = fetch(`${f.origin}/v1/coverages?limit=1&cursor=${cursorResult.nextCursor}`, { headers: { Cookie: provider.cookie } });
    await anchorEntered;
    const concurrentReplay = await fetch(`${f.origin}/v1/coverages?limit=1&cursor=${cursorResult.nextCursor}`, { headers: { Cookie: provider.cookie } });
    assert.equal(concurrentReplay.status, 400);
    releaseAnchor();
    const second = await firstUse;
    assert.equal(second.status, 200);
    assert.equal(f.calls.anchor, 1);
    f.setAnchorGate(undefined);
    const expired = await fetch(`${f.origin}/v1/coverages?status=5`, { headers: { Cookie: provider.cookie } });
    assert.equal(expired.status, 200);
    const expiredItems = (await expired.json() as { items: Array<{ status: number }> }).items;
    assert.equal(expiredItems.length, 1);
    assert.equal(expiredItems[0]!.status, 5);
  } finally { await f.server.close(); }
});

test('adjudicator evidence is bounded binary and other roles cannot read it', async () => {
  const f = await start();
  try {
    const adjudicator = await login(f, 'adjudicator');
    const response = await post(`${f.origin}/v1/evidence/read`, adjudicator.cookie, adjudicator.csrf, JSON.stringify({ coverageId: f.coverageId }), { 'Content-Type': 'application/json' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
    assert.deepEqual(f.calls.evidence, ['adjudicator']);
  } finally { await f.server.close(); }
});

test('HTTP close is idempotent and stops further host bootstrap issuance', async () => {
  const f = await start();
  const first = f.server.close();
  const second = f.server.close();
  assert.equal(first, second);
  await first;
  assert.throws(() => f.server.issueBootstrap('admin'), /PROTOCOL_CLOSED/);
});

test('bootstrap, session and page cursors expire at their configured clocks', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let f: Awaited<ReturnType<typeof start>> | undefined;
  try {
    f = await start();
    const staleBootstrap = f.server.issueBootstrap('admin');
    now += 60_001;
    const staleLogin = await post(`${f.origin}/v1/session`, undefined, undefined, JSON.stringify({ bootstrapToken: staleBootstrap }), { 'Content-Type': 'application/json' });
    assert.equal(staleLogin.status, 400);
    assert.equal((await staleLogin.json() as { error: string }).error, 'PROTOCOL_BOOTSTRAP_INVALID');

    const expiredSession = await login(f, 'provider');
    now += 30 * 60_000 + 1;
    const staleSessionRead = await fetch(`${f.origin}/v1/session`, { headers: { Cookie: expiredSession.cookie } });
    assert.equal(staleSessionRead.status, 401);

    const freshSession = await login(f, 'provider');
    const firstPage = await fetch(`${f.origin}/v1/coverages?limit=1`, { headers: { Cookie: freshSession.cookie } });
    assert.equal(firstPage.status, 200);
    const cursor = (await firstPage.json() as { nextCursor?: string }).nextCursor;
    assert.ok(cursor);
    now += 120_001;
    const expiredCursor = await fetch(`${f.origin}/v1/coverages?limit=1&cursor=${cursor}`, { headers: { Cookie: freshSession.cookie } });
    assert.equal(expiredCursor.status, 400);
    assert.equal((await expiredCursor.json() as { error: string }).error, 'PROTOCOL_CURSOR_INVALID');
  } finally {
    Date.now = realNow;
    await f?.server.close();
  }
});
