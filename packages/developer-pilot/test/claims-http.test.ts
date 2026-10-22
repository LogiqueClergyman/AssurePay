import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Authorization, PreparedAction, Snapshot } from '../../claims-backend/src/types.js';
import { createClaimsClient } from '../src/claims-client.js';
import { startClaimsServer, type ClaimsBackend } from '../src/claims-http.js';
import { freePort } from './helpers.js';

const coverageId = `0x${'1'.repeat(64)}` as const;
const evidenceHash = `0x${'2'.repeat(64)}` as const;
const decisionHash = `0x${'3'.repeat(64)}` as const;
const payer = `0x${'4'.repeat(40)}` as const;
const core = `0x${'5'.repeat(40)}` as const;
const action: PreparedAction = {
  chainId: 84532, to: core, from: payer, data: '0x12345678', value: '0', coverageId,
  observedBlock: { number: '9', hash: `0x${'6'.repeat(64)}` },
};
const authorization: Authorization = {
  actor: payer, operation: 'uploadEvidence', coverageId, payloadHash: `0x${'7'.repeat(64)}`,
  nonce: `0x${'8'.repeat(64)}`, deadline: '1900000000', signature: `0x${'a'.repeat(130)}`,
};
const snapshot = {
  version: 1,
  context: { chainId: 84532, core, token: `0x${'9'.repeat(40)}`, adjudicator: `0x${'b'.repeat(40)}`, serviceId: `0x${'c'.repeat(64)}` },
  fromBlock: '1', head: { number: '9', hash: `0x${'6'.repeat(64)}`, timestamp: '1700000000' },
  coverages: { [coverageId]: {
    coverageId, payer, providerId: `0x${'d'.repeat(64)}`, policyId: `0x${'e'.repeat(64)}`, policyHash: `0x${'f'.repeat(64)}`,
    requestHash: `0x${'0'.repeat(63)}1`, gross: '10003', premium: '777', withheld: '2029', stakeLock: '3502', poolReservation: '10003',
    openedAt: '1699990000', expiresAt: '1700003600', poolOnlyAllowed: true, status: 1, evidenceHash, decisionHash,
    refundAmount: '0', outcome: 0, opening: { transaction: `0x${'1'.repeat(64)}`, blockNumber: '2', blockHash: `0x${'2'.repeat(64)}`, logIndex: '0' },
    privateBody: 'must never escape',
  } },
} as unknown as Snapshot;

function fixtureBackend() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const backend = {
    async uploadEvidence(...args: unknown[]) { calls.push({ name: 'uploadEvidence', args }); return evidenceHash; },
    async readEvidence(...args: unknown[]) { calls.push({ name: 'readEvidence', args }); return new Uint8Array([0, 1, 255]); },
    async prepareClaim(...args: unknown[]) { calls.push({ name: 'prepareClaim', args }); return action; },
    async prepareDecision(...args: unknown[]) { calls.push({ name: 'prepareDecision', args }); return { action, decisionHash }; },
  } as unknown as ClaimsBackend;
  return { backend, calls };
}

async function start(backend: ClaimsBackend, projection: { refresh(): Promise<Snapshot> } = { async refresh() { return snapshot; } }) {
  const url = `http://127.0.0.1:${await freePort()}`;
  const server = await startClaimsServer({ url, backend, projection });
  return { server, client: createClaimsClient({ url }), url };
}

test('claims client and loopback server expose five exact routes with allowlisted status and binary evidence', async t => {
  const { backend, calls } = fixtureBackend();
  const running = await start(backend);
  t.after(() => running.server.close());
  const status = await running.client.status(coverageId);
  assert.deepEqual(status, {
    coverageId, payer, status: 1, gross: '10003', refundAmount: '0', outcome: 0, expiresAt: '1700003600',
    observedBlock: { number: '9', hash: `0x${'6'.repeat(64)}` },
  });
  assert.equal(JSON.stringify(status).includes('evidenceHash'), false);
  assert.equal(JSON.stringify(status).includes('decisionHash'), false);
  assert.equal(JSON.stringify(status).includes('privateBody'), false);

  const raw = new Uint8Array([0, 1, 255]);
  assert.equal(await running.client.uploadEvidence(coverageId, raw, authorization), evidenceHash);
  assert.deepEqual(await running.client.readEvidence(coverageId, evidenceHash, authorization), raw);
  assert.deepEqual(await running.client.prepareClaim(coverageId, evidenceHash, authorization), action);
  assert.deepEqual(await running.client.prepareDecision(coverageId, { outcome: 1, refundAmount: '9', reason: 'explicit' }, authorization), { action, decisionHash });
  assert.deepEqual(calls.map(row => row.name), ['uploadEvidence', 'readEvidence', 'prepareClaim', 'prepareDecision']);
  assert.deepEqual(calls[0]!.args[1], raw);
  assert.deepEqual(calls[0]!.args[2], authorization);
  assert.deepEqual(calls[3]!.args[1], { outcome: 1, refundAmount: '9', reason: 'explicit' });
});

test('server rejects wrong method, route, media type, encoding, extra fields and oversized streamed bodies with fixed responses', async t => {
  const { backend } = fixtureBackend();
  const running = await start(backend);
  t.after(() => running.server.close());
  const get = await fetch(`${running.url}/v1/coverage/status`);
  assert.equal(get.status, 404);
  assert.deepEqual(await get.json(), { error: 'ROUTE_NOT_FOUND' });
  const route = await fetch(`${running.url}/v1/coverage/status?debug=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(route.status, 404);
  const media = await fetch(`${running.url}/v1/coverage/status`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(media.status, 415);
  assert.deepEqual(await media.json(), { error: 'UNSUPPORTED_CONTENT_TYPE' });
  const encoding = await fetch(`${running.url}/v1/coverage/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: '{}' });
  assert.equal(encoding.status, 415);
  assert.deepEqual(await encoding.json(), { error: 'UNSUPPORTED_ENCODING' });
  const extra = await fetch(`${running.url}/v1/coverage/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ coverageId, ignored: true }) });
  assert.equal(extra.status, 400);
  assert.deepEqual(await extra.json(), { error: 'INVALID_REQUEST' });
  const pretty = await fetch(`${running.url}/v1/coverage/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: `\n {\n  "coverageId" : "${coverageId}"\n } \t`,
  });
  assert.equal(pretty.status, 200);
  const duplicate = await fetch(`${running.url}/v1/coverage/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"coverageId":"${coverageId}","coverageId":"${coverageId}"}`,
  });
  assert.equal(duplicate.status, 400);
  assert.deepEqual(await duplicate.json(), { error: 'INVALID_REQUEST' });
  const large = await fetch(`${running.url}/v1/coverage/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(143_361) });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { error: 'BODY_TOO_LARGE' });
});

test('server maps backend failures to fixed codes and serializes normal concurrent refreshes', async t => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const projection = { async refresh() {
    active++; maximum = Math.max(maximum, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    return snapshot;
  } };
  const { backend } = fixtureBackend();
  const running = await start(backend, projection);
  t.after(() => running.server.close());
  const results = await Promise.all(Array.from({ length: 8 }, () => running.client.status(coverageId)));
  assert.equal(results.length, 8);
  assert.equal(calls, 8);
  assert.equal(maximum, 1);

  const broken = await start({
    ...backend,
    async prepareClaim() { throw new Error('AUTH_INVALID'); },
  } as unknown as ClaimsBackend);
  t.after(() => broken.server.close());
  const errorClient = createClaimsClient({ url: broken.url });
  await assert.rejects(() => errorClient.prepareClaim(coverageId, evidenceHash, authorization), /AUTH_INVALID/);
  const raw = await fetch(`${broken.url}/v1/claims/prepare`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ coverageId, evidenceHash, authorization }),
  });
  assert.equal(raw.status, 401);
  const body = await raw.text();
  assert.equal(body, '{"error":"AUTH_INVALID"}');
  assert.equal(body.includes(authorization.signature), false);
});

test('client rejects oversized evidence before fetch and refuses non-loopback configuration', async () => {
  let requests = 0;
  const fakeFetch = (async () => { requests++; throw new Error('unexpected'); }) as typeof fetch;
  const client = createClaimsClient({ url: 'http://127.0.0.1:12345', fetch: fakeFetch });
  await assert.rejects(() => client.uploadEvidence(coverageId, new Uint8Array(65_537), authorization), /EVIDENCE_SIZE/);
  assert.equal(requests, 0);
  assert.throws(() => createClaimsClient({ url: 'http://0.0.0.0:12345' }), /CLAIMS_URL_INVALID/);
  assert.throws(() => createClaimsClient({ url: 'https://127.0.0.1:12345' }), /CLAIMS_URL_INVALID/);
});

test('client rejects a prepared action substituted for another coverage', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ ...action, coverageId: evidenceHash }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  const client = createClaimsClient({ url: 'http://127.0.0.1:12345', fetch: fakeFetch });
  await assert.rejects(() => client.prepareClaim(coverageId, evidenceHash, authorization), /INVALID_CLAIMS_RESPONSE/);
});

test('status response accepts the on-chain expired enum value', async t => {
  const expired = structuredClone(snapshot);
  expired.coverages[coverageId]!.status = 5;
  const { backend } = fixtureBackend();
  const running = await start(backend, { async refresh() { return expired; } });
  t.after(() => running.server.close());
  assert.equal((await running.client.status(coverageId)).status, 5);
});


test('JSON accepts escaped field names and Unicode values while rejecting equivalent duplicate keys', async t => {
  const {backend,calls}=fixtureBackend();const running=await start(backend);t.after(()=>running.server.close());
  const post=(body:string)=>fetch(`${running.url}/v1/decisions/prepare`,{method:'POST',headers:{'content-type':'application/json'},body});
  const decision={outcome:1,refundAmount:'9',reason:'café, {reason}'};
  const wire=JSON.stringify({coverageId,decision,authorization}).replace('café','caf\\u00e9').replace('"coverageId":','"coverage\\u0049d":');
  const ok=await post(wire);assert.equal(ok.status,200);assert.equal((calls.at(-1)!.args[1] as any).reason,decision.reason);
  const duplicate=JSON.stringify({coverageId,decision,authorization}).replace('"coverageId":',`"coverage\\u0049d":"${coverageId}","coverageId":`);
  const rejected=await post(duplicate);assert.equal(rejected.status,400);assert.deepEqual(await rejected.json(),{error:'INVALID_REQUEST'});
});
