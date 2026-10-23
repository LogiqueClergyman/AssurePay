import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, lstat, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalTls, createTrustedFetch, startLocalIngress } from '../src/local-https.js';
const execFileAsync = promisify(execFile);

async function freePort(): Promise<number> {
  const server = createHttpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('local TLS ingress pins its certificate and preserves method, public Host, path, headers and body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-local-https-'));
  let ingress: Awaited<ReturnType<typeof startLocalIngress>> | undefined;
  const observed: Array<{ method: string; url: string; host: string; body: Buffer; signature: string; rawHeaders: string[] }> = [];
  const upstream = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (part: Buffer) => chunks.push(part));
    req.on('end', () => {
      observed.push({ method: req.method!, url: req.url!, host: req.headers.host!, body: Buffer.concat(chunks), signature: req.headers['payment-signature'] as string, rawHeaders: req.rawHeaders });
      if (req.url === '/redirect') { res.writeHead(302, { location: '/resource' }).end(); return; }
      if (req.url === '/large-response') { res.writeHead(200, { 'content-length': '65537' }).end(Buffer.alloc(65_537)); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-test': 'preserved' }).end(Buffer.concat(chunks));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as { port: number }).port;
  const tls = await createLocalTls(directory);
  try {
    assert.equal((await lstat(tls.certPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(tls.keyPath)).mode & 0o777, 0o600);
    const ingressPort = await freePort();
    ingress = await startLocalIngress({ certPath: tls.certPath, keyPath: tls.keyPath, port: ingressPort, upstream: `http://127.0.0.1:${upstreamPort}/` });
    const fetcher = createTrustedFetch(tls.cert, ingress.url);
    const payload = Buffer.from([0, 1, 2, 255, 10]);
    const response = await fetcher(`${ingress.url}/resource`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'payment-signature': 'opaque-test-value' }, body: payload as any, redirect: 'error' });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    assert.deepEqual({ ...observed[0], rawHeaders: undefined }, { method: 'POST', url: '/resource', host: `127.0.0.1:${ingressPort}`, body: payload, signature: 'opaque-test-value', rawHeaders: undefined });
    const forwardedHosts: string[] = [];
    for (let i = 0; i < observed[0]!.rawHeaders.length; i += 2) {
      if (observed[0]!.rawHeaders[i]!.toLowerCase() === 'host') forwardedHosts.push(observed[0]!.rawHeaders[i + 1]!);
    }
    assert.deepEqual(forwardedHosts, [`127.0.0.1:${ingressPort}`]);
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port: ingressPort, path: '/resource', method: 'POST', ca: tls.cert, rejectUnauthorized: true });
      req.setHeader('content-type', 'application/octet-stream');
      req.setHeader('payment-signature', 'first-value');
      req.appendHeader('Payment-Signature', 'second-value');
      req.once('response', (res) => { res.resume(); res.once('end', resolve); });
      req.once('error', reject);
      req.end(payload);
    });
    const forwardedSignatures: string[] = [];
    for (let i = 0; i < observed[1]!.rawHeaders.length; i += 2) {
      if (observed[1]!.rawHeaders[i]!.toLowerCase() === 'payment-signature') forwardedSignatures.push(observed[1]!.rawHeaders[i + 1]!);
    }
    assert.deepEqual(forwardedSignatures, ['first-value', 'second-value']);
    await assert.rejects(fetcher(`${ingress.url}/redirect`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload as any }), /LOCAL_HTTPS_REDIRECT_REFUSED/);
    const oversized = await fetcher(`${ingress.url}/large-response`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload as any });
    assert.equal(oversized.status, 502);
    await assert.rejects(fetcher(`${ingress.url}/resource`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(65_537) as any }), /LOCAL_HTTPS_REQUEST_TOO_LARGE/);
    assert.equal(observed.length, 4);
    const rawPost = (headers: Record<string, string>, body: Buffer): Promise<number> => new Promise((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port: ingressPort, path: '/resource', method: 'POST', ca: tls.cert, rejectUnauthorized: true, headers });
      req.once('response', res => { const status = res.statusCode ?? 0; res.resume(); res.once('end', () => resolve(status)); });
      req.once('error', reject);
      req.end(body);
    });
    const oversizedBodyStatus = await rawPost({ 'content-type': 'application/octet-stream', 'content-length': '65537' }, Buffer.alloc(65_537));
    assert.equal(oversizedBodyStatus, 413);
    const oversizedHeaderStatus = await rawPost({ 'content-type': 'application/octet-stream', 'x-oversized': 'h'.repeat(17_000) }, Buffer.from('x'));
    assert.equal(oversizedHeaderStatus, 431);
    assert.equal(observed.length, 4);
  } finally {
    await ingress?.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('trusted local fetch rejects wrong CA, certificate name and origin', async () => {
  const first = await mkdtemp(join(tmpdir(), 'assurepay-local-tls-a-'));
  const second = await mkdtemp(join(tmpdir(), 'assurepay-local-tls-b-'));
  const server = createHttpServer((_req, res) => res.writeHead(200).end('ok'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let ingress: Awaited<ReturnType<typeof startLocalIngress>> | undefined;
  let wrongNameIngress: Awaited<ReturnType<typeof startLocalIngress>> | undefined;
  try {
    const tls = await createLocalTls(first);
    const other = await createLocalTls(second);
    const wrongCertPath = join(second, 'wrong-name.crt');
    const wrongKeyPath = join(second, 'wrong-name.key');
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-keyout', wrongKeyPath, '-out', wrongCertPath, '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost',
    ], { timeout: 20_000, maxBuffer: 1024, windowsHide: true, env: { PATH: process.env.PATH ?? '' } });
    await Promise.all([chmod(wrongKeyPath, 0o600), chmod(wrongCertPath, 0o600)]);
    const wrongCert = await readFile(wrongCertPath, 'utf8');
    const upstreamPort = (server.address() as { port: number }).port;
    const port = await freePort();
    ingress = await startLocalIngress({ certPath: tls.certPath, keyPath: tls.keyPath, port, upstream: `http://127.0.0.1:${upstreamPort}/` });
    const originFetch = createTrustedFetch(tls.cert, ingress.url);
    await assert.rejects(originFetch(`https://localhost:${port}/`, { method: 'POST', body: Buffer.alloc(0) as any }), /LOCAL_HTTPS_ORIGIN_MISMATCH/);
    const wrongCaFetch = createTrustedFetch(other.cert, ingress.url);
    await assert.rejects(wrongCaFetch(`${ingress.url}/`, { method: 'POST', body: Buffer.from('x') as any }), /LOCAL_HTTPS_REQUEST_FAILED/);
    const wrongNamePort = await freePort();
    wrongNameIngress = await startLocalIngress({ certPath: wrongCertPath, keyPath: wrongKeyPath, port: wrongNamePort, upstream: `http://127.0.0.1:${upstreamPort}/` });
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', family: 4, port: wrongNamePort, path: '/', method: 'POST', ca: wrongCert, rejectUnauthorized: true }, () => resolve());
      req.once('error', reject);
      req.end();
    }), (error: any) => error?.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
    await assert.rejects(originFetch(`${ingress.url}/`, { method: 'GET', body: Buffer.from('x') as any }), /LOCAL_HTTPS_METHOD_INVALID/);
  } finally {
    await ingress?.close();
    await wrongNameIngress?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});
