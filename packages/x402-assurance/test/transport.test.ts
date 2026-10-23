import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTcp } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { PaymentResult, Terms, Trust } from '../src/types.js';
import { createPurchase } from '../src/http-client.js';
import { startProvider } from '../src/http-provider.js';
import { prepareCall } from '../src/protocol.js';
import { hashRequest } from '../src/canonical.js';

const payer = privateKeyToAccount(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const terms: Terms = {
  chainId: 84532,
  core: '0x1000000000000000000000000000000000000001',
  token: '0x2000000000000000000000000000000000000002',
  providerId: `0x${'31'.repeat(32)}`,
  policyId: `0x${'32'.repeat(32)}`,
  providerOwner: owner.address.toLowerCase() as Address,
  providerPayout: '0x3000000000000000000000000000000000000003',
  policyHash: `0x${'33'.repeat(32)}`,
  premiumBps: 700,
  stakeBps: 500,
  withholdingBps: 0,
  duration: '3600',
  poolOnlyAllowed: false,
  gross: '1000000',
  premium: '70000',
  withheld: '0',
  net: '930000',
  stakeLock: '50000',
  poolReservation: '950000',
  tokenName: 'USDC',
  tokenVersion: '2',
};
const trust: Trust = { chainId: 84532, core: terms.core, token: terms.token, providerId: terms.providerId, policyId: terms.policyId };
const transaction = `0x${'aa'.repeat(32)}` as Hex;
const resultFor = (coverageId: Hex): PaymentResult => ({ state: 'confirmed', transaction, coverageId });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function providerOptions(directory: string, resourceUrl: string, listenUrl: string, counters: { settled: number; handled: number; hashes: Hex[] }) {
  return {
    terms,
    engine: { async settle(call: any) { counters.settled++; return resultFor(call.intentHash); } },
    signer: { address: owner.address, signTypedData: (data: any) => owner.signTypedData(data) },
    handler: async (body: Uint8Array) => { counters.handled++; return Uint8Array.from(body); },
    journalPath: join(directory, 'service.jsonl'),
    resourceUrl,
    listenUrl,
    canServe: async () => true,
    prepareCall: (payment: unknown, requestHash: Hex) => {
      counters.hashes.push(requestHash);
      return prepareCall(payment, terms, requestHash, 0n, { allowExpired: true });
    },
  };
}

function tunnelFetch(upstreamPort: number, advertisedHost: string, forwardedHost: () => string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('host', advertisedHost);
    headers.set('forwarded', `for=192.0.2.17;proto=https;host=${forwardedHost()}`);
    headers.set('x-forwarded-host', forwardedHost());
    headers.set('x-forwarded-proto', 'https');
    const target = new URL(String(input));
    const body = init?.body;
    return await new Promise<Response>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, path: target.pathname, method: init?.method,
        headers: Object.fromEntries(headers), agent: false }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const responseHeaders = Object.fromEntries(Object.entries(response.headers)
            .filter(([, value]) => typeof value === 'string') as [string, string][]);
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: responseHeaders }));
        });
      });
      req.once('error', reject);
      if (body instanceof Uint8Array) req.end(Buffer.from(body)); else req.end(body as any);
    });
  };
}

async function rawRequest(port: number, request: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.once('connect', () => socket.write(request));
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
}

test('loopback listener keeps HTTPS resource identity despite forwarded-header changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-transport-'));
  const port = await freePort();
  const resourceUrl = 'https://api.example.test:8443/assured';
  const listenUrl = `http://127.0.0.1:${port}/`;
  const counters = { settled: 0, handled: 0, hashes: [] as Hex[] };
  const provider = await startProvider(providerOptions(directory, resourceUrl, listenUrl, counters));
  try {
    assert.equal(provider.url, resourceUrl);
    const body = new Uint8Array([0, 4, 8, 255]);
    const requestId = `0x${'44'.repeat(32)}` as Hex;
    const expectedHash = hashRequest('POST', resourceUrl, 'application/octet-stream', body, requestId);
    let forwardedHost = 'wrong-one.example';
    const session = await createPurchase({
        url: resourceUrl,
        body,
        payer: { address: payer.address.toLowerCase() as Address, signTypedData: data => payer.signTypedData(data) },
        trust,
        maxGross: terms.gross,
        readTerms: async () => ({ ...terms }),
        now: () => 1_800_000_000n,
        verifyPayment: async ({ call }) => resultFor(call.intentHash),
        fetch: tunnelFetch(port, new URL(resourceUrl).host, () => forwardedHost),
        createRequestId: () => requestId,
      });
    const first = await session.send();
    forwardedHost = 'wrong-two.example';
    const second = await session.retry();
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.deepEqual(first.body, body); assert.deepEqual(second.body, body);
    assert.deepEqual(counters.hashes, [expectedHash, expectedHash]);
    assert.equal(counters.settled, 1); assert.equal(counters.handled, 1);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('wrong Host, duplicate Host, and wrong path are rejected before payment or handler work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-transport-reject-'));
  const port = await freePort();
  const resourceUrl = 'https://api.example.test:8443/assured';
  const counters = { settled: 0, handled: 0, hashes: [] as Hex[] };
  const provider = await startProvider(providerOptions(directory, resourceUrl, `http://127.0.0.1:${port}/`, counters));
  try {
    const wrongHost = await rawRequest(port, 'POST /assured HTTP/1.1\r\nHost: attacker.example\r\nContent-Type: application/octet-stream\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    assert.match(wrongHost, /^HTTP\/1\.1 400 /);
    assert.doesNotMatch(wrongHost.toLowerCase(), /payment-required/);
    const duplicateHost = await rawRequest(port, 'POST /assured HTTP/1.1\r\nHost: api.example.test:8443\r\nHost: api.example.test:8443\r\nContent-Type: application/octet-stream\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    assert.match(duplicateHost, /^HTTP\/1\.1 400 /);
    assert.doesNotMatch(duplicateHost.toLowerCase(), /payment-required/);
    const wrongPath = await rawRequest(port, 'POST /other HTTP/1.1\r\nHost: api.example.test:8443\r\nContent-Type: application/octet-stream\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    assert.match(wrongPath, /^HTTP\/1\.1 404 /);
    assert.doesNotMatch(wrongPath.toLowerCase(), /payment-required/);
    assert.deepEqual(counters, { settled: 0, handled: 0, hashes: [] });
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsupported listener identities fail before creating the service journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-transport-invalid-'));
  const resourceUrl = 'https://api.example.test/assured';
  const badListeners = [
    'https://127.0.0.1:9443/',
    'http://localhost:9000/',
    'http://127.0.0.1:9001/assured',
    'http://127.0.0.1:9002/?x=1',
    'http://127.0.0.1/',
  ];
  try {
    for (let index = 0; index < badListeners.length; index++) {
      const journalPath = join(directory, `bad-${index}.jsonl`);
      const counters = { settled: 0, handled: 0, hashes: [] as Hex[] };
      await assert.rejects(() => startProvider({ ...providerOptions(directory, resourceUrl, badListeners[index]!, counters), journalPath }), /INVALID_LISTEN_URL/);
      await assert.rejects(() => stat(journalPath), { code: 'ENOENT' });
      assert.deepEqual(counters, { settled: 0, handled: 0, hashes: [] });
    }
    const journalPath = join(directory, 'http-resource.jsonl');
    const counters = { settled: 0, handled: 0, hashes: [] as Hex[] };
    await assert.rejects(() => startProvider({ ...providerOptions(directory, 'http://127.0.0.1:9003/assured', 'http://127.0.0.1:9004/', counters), journalPath }), /HTTPS_REQUIRED/);
    await assert.rejects(() => stat(journalPath), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
