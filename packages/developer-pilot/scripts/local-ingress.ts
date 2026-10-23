import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 65_536;
const MAX_HEADERS = 16_384;
const TIMEOUT_MS = 10_000;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export interface LocalIngressOptions { certPath: string; keyPath: string; port: number; upstream: string }
export interface LocalIngress { url: string; close(): Promise<void> }

function validOrigin(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('LOCAL_INGRESS_UPSTREAM_INVALID'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('LOCAL_INGRESS_UPSTREAM_INVALID');
  return url;
}

function requestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const declared = req.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) { req.resume(); reject(new Error('BODY_LIMIT')); return; }
    req.on('data', (part: Buffer | string) => {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += bytes.byteLength;
      if (size > MAX_BYTES) { req.destroy(); reject(new Error('BODY_LIMIT')); return; }
      chunks.push(bytes);
    });
    req.once('end', () => resolve(Buffer.concat(chunks, size)));
    req.once('error', () => reject(new Error('REQUEST_FAILED')));
  });
}

function headersForProxy(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!;
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower === 'content-length') continue;
    out.push(name, raw[i + 1]!);
  }
  return out;
}

function setRawHeaders(request: ReturnType<typeof httpRequest>, raw: string[]): void {
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!;
    const value = raw[i + 1]!;
    if (request.hasHeader(name)) request.appendHeader(name, value);
    else request.setHeader(name, value);
  }
}

async function runWorker(certPath: string, keyPath: string, port: number, upstreamInput: string): Promise<void> {
  const upstream = validOrigin(upstreamInput);
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  const server = createHttpsServer({ cert, key, maxHeaderSize: MAX_HEADERS, headersTimeout: TIMEOUT_MS, requestTimeout: TIMEOUT_MS }, (req, res) => {
    void (async () => {
      const hostHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'host');
      const contentBytes = req.rawHeaders.reduce((n, v, i) => n + (i % 2 === 0 ? Buffer.byteLength(v) : Buffer.byteLength(v) + 2), 0);
      if (contentBytes > MAX_HEADERS) return res.writeHead(431).end();
      if (req.method !== 'POST' || !req.url || hostHeaders.length !== 1) return res.writeHead(400).end();
      const body = await requestBody(req);
      const upstreamReq = httpRequest({
        hostname: '127.0.0.1', port: upstream.port, method: req.method, path: req.url,
        maxHeaderSize: MAX_HEADERS, timeout: TIMEOUT_MS, agent: false, setHost: false,
      }, (upRes) => {
        void (async () => {
          const response = await requestBody(upRes);
          const responseHeaders: string[] = [];
          for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
            const name = upRes.rawHeaders[i]!;
            if (!HOP_HEADERS.has(name.toLowerCase())) responseHeaders.push(name, upRes.rawHeaders[i + 1]!);
          }
          if (!responseHeaders.some((_, i) => i % 2 === 0 && responseHeaders[i]!.toLowerCase() === 'content-length')) responseHeaders.push('content-length', String(response.byteLength));
          res.writeHead(upRes.statusCode ?? 502, responseHeaders);
          res.end(response);
        })().catch(() => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      });
      setRawHeaders(upstreamReq, headersForProxy(req.rawHeaders));
      upstreamReq.setHeader('content-length', String(body.byteLength));
      upstreamReq.once('timeout', () => upstreamReq.destroy(new Error('UPSTREAM_TIMEOUT')));
      upstreamReq.once('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      upstreamReq.end(body);
    })().catch((error) => { if (!res.headersSent) res.writeHead(error instanceof Error && error.message === 'BODY_LIMIT' ? 413 : 400).end(); else res.destroy(); });
  });
  server.maxConnections = 32;
  server.setTimeout(TIMEOUT_MS, socket => socket.destroy());
  server.keepAliveTimeout = TIMEOUT_MS;
  server.listen(port, '127.0.0.1', () => process.stdout.write('READY\n'));
  server.once('error', () => { process.stdout.write('ERROR\n'); process.exitCode = 1; });
  const stop = () => { server.close(() => process.exit(0)); server.closeIdleConnections(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').then(() => true);
  const wait = async (ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exited, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  child.kill('SIGTERM');
  if (!await wait(8_000)) {
    child.kill('SIGKILL');
    if (!await wait(2_000)) throw new Error('LOCAL_INGRESS_STOP_TIMEOUT');
  }
}

export async function startLocalIngress(options: LocalIngressOptions): Promise<LocalIngress> {
  const upstream = validOrigin(options.upstream);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535 || Number(upstream.port) === options.port) throw new Error('LOCAL_INGRESS_PORT_INVALID');
  for (const path of [options.certPath, options.keyPath]) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('LOCAL_INGRESS_TLS_INVALID');
  }
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', options.certPath, options.keyPath, String(options.port), upstream.origin], {
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LOCAL_INGRESS_START_TIMEOUT')), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('READY\n')) { clearTimeout(timer); resolve(); }
      else if (output.includes('ERROR\n')) { clearTimeout(timer); reject(new Error('LOCAL_INGRESS_START_FAILED')); }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('LOCAL_INGRESS_START_FAILED')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('LOCAL_INGRESS_EXITED')); });
  });
  try { await ready; }
  catch {
    await stopChild(child).catch(() => undefined);
    throw new Error('LOCAL_INGRESS_START_FAILED');
  }
  let closePromise: Promise<void> | undefined;
  return {
    url: `https://127.0.0.1:${options.port}`,
    close() {
      if (closePromise) return closePromise;
      closePromise = stopChild(child);
      return closePromise;
    },
  };
}

if (process.argv[2] === '--worker') {
  const [, , , certPath, keyPath, portText, upstream] = process.argv;
  void runWorker(certPath!, keyPath!, Number(portText), upstream!).catch(() => {
    process.stdout.write('ERROR\n');
    process.exitCode = 1;
  });
}
