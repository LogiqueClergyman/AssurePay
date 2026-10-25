import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { startProtocolServer } from '../src/http.js';
import type { ProtocolRuntime, ProtocolServer, Role } from '../src/types.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
const assets = Object.freeze({ html: '<!doctype html><title>Console</title>', javascript: '"use strict";', stylesheet: 'body{color:#111}' });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); let data = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => { data += chunk; });
    socket.on('error', reject); socket.on('end', () => resolve(data)); socket.on('connect', () => socket.write(request));
  });
}

function runtime(origin: string): ProtocolRuntime {
  return {
    config: { version: 1, apiUrl: origin, admin: addr(1), pilot: { core: addr(6), token: addr(7), providerId: hash(11), policyId: hash(12),
      roles: { provider: addr(2), adjudicator: addr(4), relayer: addr(5) } } } as any,
    capabilities: { admin: ['setPaused'], provider: ['withdrawStake'], adjudicator: ['finalizeClaim'], operator: [] },
    snapshot: async () => { throw Error('unused'); }, assertAnchor: async () => {}, preview: async () => { throw Error('unused'); },
    confirm: async () => { throw Error('unused'); }, reconcile: async () => [], readEvidence: async () => new Uint8Array(), close: async () => {},
  } as unknown as ProtocolRuntime;
}

async function start(withConsole: boolean) {
  const origin = `http://127.0.0.1:${await freePort()}`;
  const host = runtime(origin);
  const server = await startProtocolServer(withConsole ? { runtime: host, console: { role: 'provider', assets } } : { runtime: host });
  return { origin, host, server };
}

function post(origin: string, path: string, body: string, options: { origin?: string; fetchSite?: string; cookie?: string; csrf?: string; contentType?: string; forwarded?: boolean } = {}) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: {
    ...(options.origin === undefined ? { Origin: origin } : { Origin: options.origin }),
    ...(options.fetchSite ? { 'Sec-Fetch-Site': options.fetchSite } : {}),
    ...(options.forwarded ? { 'X-Forwarded-Host': 'evil.invalid' } : {}),
    ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.csrf ? { 'x-assurepay-csrf': options.csrf } : {}),
    'Content-Type': options.contentType ?? 'application/json',
  }, body });
}

async function enroll(origin: string, roleBody = '{}') {
  return post(origin, '/console/session', roleBody);
}

test('API-only server retains bootstrap login and exposes no console context or static assets', async () => {
  const f = await start(false);
  try {
    assert.equal((await fetch(`${f.origin}/`)).status, 401);
    assert.equal((await fetch(`${f.origin}/console/context`)).status, 401);
    assert.equal((await enroll(f.origin)).status, 401);
    const bootstrap = f.server.issueBootstrap('admin');
    const response = await post(f.origin, '/v1/session', JSON.stringify({ bootstrapToken: bootstrap }));
    assert.equal(response.status, 201);
    assert.equal((await response.json() as { role: Role }).role, 'admin');
  } finally { await f.server.close(); }
});

test('static assets are exact captured strings with restrictive no-store headers and public context is minimal', async () => {
  const origin = `http://127.0.0.1:${await freePort()}`;
  const host = runtime(origin);
  const mutableAssets = { html: '<h1>Captured</h1>', javascript: 'const captured = true;', stylesheet: '.captured{}' };
  const starting = startProtocolServer({ runtime: host, console: { role: 'provider', assets: mutableAssets } });
  mutableAssets.html = '<h1>Mutated</h1>';
  mutableAssets.javascript = 'const mutated = true;';
  mutableAssets.stylesheet = '.mutated{}';
  const server = await starting;
  try {
    const expected = [
      ['/', '<h1>Captured</h1>', 'text/html; charset=utf-8'],
      ['/assets/app.js', 'const captured = true;', 'text/javascript; charset=utf-8'],
      ['/assets/styles.css', '.captured{}', 'text/css; charset=utf-8'],
    ] as const;
    for (const [path, text, contentType] of expected) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), text);
      assert.equal(response.headers.get('content-type'), contentType);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    }
    const contextResponse = await fetch(`${origin}/console/context`);
    assert.equal(contextResponse.status, 200);
    assert.equal(contextResponse.headers.get('cache-control'), 'no-store');
    const context = await contextResponse.json() as Record<string, unknown>;
    assert.deepEqual(context, { role: 'provider', localOnly: true, chainId: 84532, core: addr(6), token: addr(7), providerId: hash(11), policyId: hash(12) });
    assert.equal('address' in context || 'csrfToken' in context || 'bootstrapToken' in context, false);
    assert.equal((await fetch(`${origin}/?ignored=1`)).status, 400);
    assert.equal((await fetch(`${origin}/assets/app.js?ignored=1`)).status, 400);
    const traversal = await fetch(`${origin}/assets/%2e%2e/src/http.ts`);
    assert.notEqual(traversal.status, 200);
    assert.equal((await traversal.text()).includes('startProtocolServer'), false);
    assert.notEqual((await fetch(`${origin}/private-file`)).status, 200);
    for (const path of ['/', '/console/context']) {
      const forwarded = await fetch(`${origin}${path}`, { headers: { 'X-Forwarded-Host': 'evil.invalid' } });
      assert.equal(forwarded.status, 403);
      const wrongOrigin = await fetch(`${origin}${path}`, { headers: { Origin: 'http://evil.invalid' } });
      assert.equal(wrongOrigin.status, 403);
    }
    const port = Number(new URL(origin).port);
    const duplicateHost = await rawHttp(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.ok([400, 403].includes(Number(/^HTTP\/1\.1 (\d{3})/m.exec(duplicateHost)?.[1])));
  } finally { await server.close(); }
});

test('console seat is exact, same-origin, one-use, fixed to host role and not rearmed by logout or legacy bootstrap', async () => {
  const f = await start(true);
  try {
    // Cross-origin and Fetch Metadata failures leave the host arm untouched.
    const wrongOrigin = await post(f.origin, '/console/session', '{}', { origin: 'http://evil.invalid' });
    assert.equal(wrongOrigin.status, 403);
    const crossSiteFetch = await post(f.origin, '/console/session', '{}', { fetchSite: 'cross-site' });
    assert.equal(crossSiteFetch.status, 403);
    const invalid = await enroll(f.origin, '{"role":"admin"}');
    assert.equal(invalid.status, 400);
    const concurrent = await Promise.all([enroll(f.origin), enroll(f.origin)]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 400]);
    const response = concurrent.find(value => value.status === 201)!;
    const view = await response.json() as { role: Role; address: string; csrfToken: string; capabilities: string[] };
    assert.equal(view.role, 'provider');
    assert.equal(view.address, addr(2));
    assert.deepEqual(view.capabilities, ['withdrawStake']);
    assert.ok(view.csrfToken.length >= 40);
    const cookieHeader = response.headers.get('set-cookie')!;
    assert.match(cookieHeader, /Path=\/v1/);
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Strict/);
    assert.doesNotMatch(cookieHeader, /Domain=/i);
    assert.equal(cookieHeader.includes(view.csrfToken), false);
    const cookie = cookieHeader.split(';', 1)[0]!;
    const resumed = await fetch(`${f.origin}/v1/session`, { headers: { Cookie: cookie } });
    assert.equal(resumed.status, 200);
    const resumedView = await resumed.json() as { role: Role; address: string; csrfToken: string };
    assert.equal(resumedView.role, view.role);
    assert.equal(resumedView.address, view.address);
    assert.equal(resumedView.csrfToken, view.csrfToken);
    const logout = await post(f.origin, '/v1/logout', '{}', { cookie, csrf: view.csrfToken });
    assert.equal(logout.status, 200);
    const afterLogout = await enroll(f.origin);
    assert.equal(afterLogout.status, 400);
    assert.equal((await afterLogout.json() as { error: string }).error, 'PROTOCOL_BOOTSTRAP_INVALID');

    const legacyCapability = f.server.issueBootstrap('adjudicator');
    const legacy = await post(f.origin, '/v1/session', JSON.stringify({ bootstrapToken: legacyCapability }));
    assert.equal(legacy.status, 201);
    assert.equal((await legacy.json() as { role: Role }).role, 'adjudicator');
    const noRole = await enroll(f.origin, '{"role":"admin"}');
    assert.equal(noRole.status, 400);
    const wrongOriginAfterSeat = await post(f.origin, '/console/session', '{}', { origin: 'http://evil.invalid' });
    assert.equal(wrongOriginAfterSeat.status, 403);
    const forwardedSeat = await post(f.origin, '/console/session', '{}', { forwarded: true });
    assert.equal(forwardedSeat.status, 403);
  } finally { await f.server.close(); }
});

test('console session expiry does not rearm the host seat', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let f: Awaited<ReturnType<typeof start>> | undefined;
  try {
    f = await start(true);
    const response = await enroll(f.origin);
    assert.equal(response.status, 201);
    const view = await response.json() as { csrfToken: string };
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!;
    now += 30 * 60_000 + 1;
    const expired = await fetch(`${f.origin}/v1/session`, { headers: { Cookie: cookie } });
    assert.equal(expired.status, 401);
    const rearm = await enroll(f.origin);
    assert.equal(rearm.status, 400);
    assert.equal((await rearm.json() as { error: string }).error, 'PROTOCOL_BOOTSTRAP_INVALID');
    assert.ok(view.csrfToken.length >= 40);
  } finally {
    Date.now = realNow;
    await f?.server.close();
  }
});

test('console configuration rejects unknown, empty and over-limit assets before binding', async () => {
  const origin = `http://127.0.0.1:${await freePort()}`;
  const host = runtime(origin);
  await assert.rejects(startProtocolServer({ runtime: host, console: { role: 'provider', assets: { ...assets, extra: 'x' } } } as any));
  await assert.rejects(startProtocolServer({ runtime: host, console: { role: 'provider', assets: { ...assets, html: '' } } }));
  await assert.rejects(startProtocolServer({ runtime: host, console: { role: 'provider', assets: { ...assets, html: 'é'.repeat(131_073) } } }));
  const hidden = { role: 'provider', assets } as Record<string, unknown>;
  Object.defineProperty(hidden, 'shadow', { value: true, enumerable: false });
  await assert.rejects(startProtocolServer({ runtime: host, console: hidden as any }));
  const accessorAssets = { javascript: assets.javascript, stylesheet: assets.stylesheet } as Record<string, unknown>;
  Object.defineProperty(accessorAssets, 'html', { enumerable: true, get: () => assets.html });
  await assert.rejects(startProtocolServer({ runtime: host, console: { role: 'provider', assets: accessorAssets as any } }));
  const accessorOptions = { runtime: host } as Record<string, unknown>;
  Object.defineProperty(accessorOptions, 'console', { enumerable: true, get: () => ({ role: 'provider', assets }) });
  await assert.rejects(startProtocolServer(accessorOptions as any));
});
