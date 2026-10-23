import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
export { startLocalIngress } from '../scripts/local-ingress.js';

const execFileAsync = promisify(execFile);
const MAX_BYTES = 65_536;
const MAX_HEADERS = 16_384;
const TIMEOUT_MS = 10_000;

export interface LocalTlsMaterial { certPath: string; keyPath: string; cert: string; key: string }

/** Creates short-lived local-only TLS material in a fresh private directory. */
export async function createLocalTls(directory: string): Promise<LocalTlsMaterial> {
  if (!directory) throw new Error('LOCAL_TLS_DIRECTORY_INVALID');
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0) throw new Error('LOCAL_TLS_DIRECTORY_INVALID');
  const stem = `local-${randomUUID()}`;
  const certPath = join(root, `${stem}.crt`);
  const keyPath = join(root, `${stem}.key`);
  try {
    const certHandle = await open(certPath, 'wx', 0o600);
    await certHandle.close();
    const keyHandle = await open(keyPath, 'wx', 0o600);
    await keyHandle.close();
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { timeout: 20_000, maxBuffer: 1024, windowsHide: true, env: { PATH: process.env.PATH ?? '' } });
    await chmod(certPath, 0o600);
    await chmod(keyPath, 0o600);
    const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
    if (!cert.startsWith('-----BEGIN CERTIFICATE-----') || !key.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error();
    return { certPath, keyPath, cert, key };
  } catch {
    await Promise.all([unlink(certPath).catch(() => undefined), unlink(keyPath).catch(() => undefined)]);
    throw new Error('LOCAL_TLS_GENERATION_FAILED');
  }
}

function originUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('LOCAL_HTTPS_ORIGIN_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('LOCAL_HTTPS_ORIGIN_INVALID');
  }
  return url;
}

async function readBounded(response: import('node:http').IncomingMessage): Promise<Buffer> {
  const declared = response.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error('LOCAL_HTTPS_RESPONSE_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.byteLength;
    if (size > MAX_BYTES) { response.destroy(); throw new Error('LOCAL_HTTPS_RESPONSE_TOO_LARGE'); }
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}

/** Fetch for the local rehearsal: pinned certificate, exact origin, POST only, bounded and no redirects. */
export function createTrustedFetch(cert: string, origin: string): typeof globalThis.fetch {
  if (typeof cert !== 'string' || !cert.startsWith('-----BEGIN CERTIFICATE-----')) throw new Error('LOCAL_TLS_CERT_INVALID');
  const allowed = originUrl(origin);
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let requested: URL;
    try { requested = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input); }
    catch { throw new Error('LOCAL_HTTPS_URL_INVALID'); }
    if (requested.origin !== allowed.origin || requested.protocol !== 'https:' || requested.hostname !== '127.0.0.1' || requested.username || requested.password) throw new Error('LOCAL_HTTPS_ORIGIN_MISMATCH');
    if (init?.method !== 'POST') throw new Error('LOCAL_HTTPS_METHOD_INVALID');
    const bodyValue = init.body;
    if (!(Buffer.isBuffer(bodyValue) || bodyValue instanceof Uint8Array)) throw new Error('LOCAL_HTTPS_BODY_INVALID');
    const body = Buffer.from(bodyValue);
    if (body.byteLength > MAX_BYTES) throw new Error('LOCAL_HTTPS_REQUEST_TOO_LARGE');
    const headers = new Headers(init.headers);
    if (headers.has('host') || headers.has('content-length') || headers.has('transfer-encoding')) throw new Error('LOCAL_HTTPS_HEADERS_INVALID');
    headers.set('content-length', String(body.byteLength));
    const headerBytes = [...headers].reduce((sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value) + 4, 0);
    if (headerBytes > MAX_HEADERS) throw new Error('LOCAL_HTTPS_HEADERS_TOO_LARGE');
    return await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest({
        protocol: 'https:', hostname: '127.0.0.1', port: allowed.port, path: requested.pathname + requested.search,
        method: 'POST', headers: Object.fromEntries(headers.entries()), ca: cert, rejectUnauthorized: true,
        maxHeaderSize: MAX_HEADERS, timeout: TIMEOUT_MS, agent: false,
      }, async (res) => {
        try {
          const bytes = await readBounded(res);
          const status = res.statusCode ?? 500;
          if (status >= 300 && status < 400) throw new Error('LOCAL_HTTPS_REDIRECT_REFUSED');
          resolve(new Response(new Uint8Array(bytes), { status, statusText: res.statusMessage, headers: res.headers as HeadersInit }));
        } catch (error) { reject(error instanceof Error && error.message.startsWith('LOCAL_HTTPS_') ? error : new Error('LOCAL_HTTPS_RESPONSE_FAILED')); }
      });
      req.once('timeout', () => req.destroy(new Error('LOCAL_HTTPS_TIMEOUT')));
      req.once('error', () => reject(new Error('LOCAL_HTTPS_REQUEST_FAILED')));
      req.end(body);
    });
  }) as typeof globalThis.fetch;
}
