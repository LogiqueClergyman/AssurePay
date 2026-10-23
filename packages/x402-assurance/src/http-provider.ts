import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { keccak256, type Hex } from 'viem';
import type { Terms, SettlementEngine, PaymentResult, SignedReceipt, ReceiptMessage, PreparedCall, ResultStore } from './types.js';
import { canonicalRequestUrl, hashRequest, signReceipt, verifyReceipt } from './protocol.js';
import { ServiceStore, type ServiceRecord } from './service-store.js';

const MAX_BODY = 65_536;
const MAX_PAYMENT_HEADER = 16_384;
const FIXED_BODY = new TextEncoder().encode('AssurePay request failed');
type OwnerSigner = { address: `0x${string}`; signTypedData(data: any): Promise<Hex> };
export interface ProviderOptions {
  terms: Terms;
  engine: SettlementEngine;
  signer: OwnerSigner;
  handler: (body: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  journalPath: string;
  resourceUrl: string;
  listenUrl?: string;
  canServe(call: PreparedCall): Promise<boolean>;
  prepareCall(payment: unknown, requestHash: Hex): Promise<PreparedCall>;
  now?: () => number;
  resultStore?: ResultStore;
}
export interface StartedProvider { url: string; server: Server; close(): Promise<void> }
type CachedResponse = { status: number; body: Uint8Array; receipt: SignedReceipt; paymentResponse: unknown };
type PendingResponse = { code: 'PAYMENT_PENDING' | 'SERVICE_INDETERMINATE'; transaction: Hex; coverageId: Hex };
type Outcome = { kind: 'response'; response: CachedResponse } | { kind: 'pending'; value: PendingResponse } | { kind: 'rejected' } | { kind: 'unknown' } | { kind: 'not-live' } | { kind: 'admission-unknown' } | { kind: 'unavailable' } | { kind: 'storage-unknown' };

function headerValues(req: IncomingMessage, name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === name) found.push(req.rawHeaders[i + 1]!);
  return found;
}
function send(res: ServerResponse, status: number, body: Uint8Array, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': body.byteLength, ...headers });
  res.end(body);
}
function fixed(res: ServerResponse, status: number, code: string): void {
  send(res, status, new TextEncoder().encode(code), { 'cache-control': 'no-store' });
}
function validHex(value: unknown): value is Hex { return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value); }
async function readRequest(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE');
    chunks.push(b);
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}
function resultHeader(result: PaymentResult): unknown {
  return { success: true, transaction: result.transaction, network: 'eip155:84532' };
}
function pendingBody(value: PendingResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
function serviceContext(terms: Terms, resourceUrl: string): string {
  const normalized = Object.fromEntries(Object.entries(terms).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v]));
  return createHash('sha256').update(JSON.stringify({ resourceUrl, terms: normalized })).digest('hex');
}
function snapshotTerms(input: Terms): Terms {
  return Object.freeze({ ...input, core: input.core.toLowerCase() as Terms['core'], token: input.token.toLowerCase() as Terms['token'], providerOwner: input.providerOwner.toLowerCase() as Terms['providerOwner'], providerPayout: input.providerPayout.toLowerCase() as Terms['providerPayout'] });
}

/** Starts one fixed-URL, POST-only x402 resource with durable service-start protection. */
export async function startProvider(options: ProviderOptions): Promise<StartedProvider> {
  // Snapshot every transport identity before opening journals or yielding.
  const resourceUrl = options.resourceUrl;
  const listenUrl = options.listenUrl;
  const journalPath = options.journalPath;
  const configuredUrl = canonicalRequestUrl(resourceUrl);
  let bindUrl = configuredUrl;
  let expectedHost: string | undefined;
  if (listenUrl !== undefined) {
    let parsedListen: URL;
    try { parsedListen = new URL(listenUrl); } catch { throw new Error('INVALID_LISTEN_URL'); }
    if (parsedListen.protocol !== 'http:' || parsedListen.hostname !== '127.0.0.1' || !parsedListen.port ||
        parsedListen.pathname !== '/' || parsedListen.search || parsedListen.hash || parsedListen.username ||
        parsedListen.password || parsedListen.href !== listenUrl) throw new Error('INVALID_LISTEN_URL');
    if (!configuredUrl.startsWith('https://')) throw new Error('HTTPS_REQUIRED');
    bindUrl = listenUrl;
    expectedHost = new URL(configuredUrl).host;
  }
  const terms = snapshotTerms(options.terms);
  const engine = options.engine;
  const resultStore = options.resultStore && Object.freeze({
    put: options.resultStore.put.bind(options.resultStore), get: options.resultStore.get.bind(options.resultStore),
  });
  if (resultStore && typeof engine.reconcile !== 'function') throw new Error('READ_ONLY_RECOVERY_REQUIRED');
  if (!options.signer || typeof options.signer.signTypedData !== 'function' || options.signer.address.toLowerCase() !== terms.providerOwner.toLowerCase()) throw new Error('PROVIDER_SIGNER_MISMATCH');
  const signer: OwnerSigner = Object.freeze({ address: options.signer.address.toLowerCase() as OwnerSigner['address'], signTypedData: options.signer.signTypedData.bind(options.signer) });
  const canServe = options.canServe;
  const prepareCall = options.prepareCall;
  const handler = options.handler;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  if (typeof canServe !== 'function' || typeof prepareCall !== 'function' || typeof handler !== 'function') throw new Error('INVALID_PROVIDER_CONFIG');
  const context = serviceContext(terms, configuredUrl);
  const store = await ServiceStore.open(journalPath, context);
  const { createRegisteredServer } = await import('./protocol.js');
  const adapter = await createRegisteredServer(terms, engine);
  const cache = new Map<string, CachedResponse>();
  const flights = new Map<string, { intentHash: Hex; promise: Promise<Outcome> }>();
  const pathname = new URL(configuredUrl).pathname;

  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== 'POST' || req.url !== pathname) return fixed(res, 404, 'RESOURCE_NOT_FOUND');
      const hosts = headerValues(req, 'host');
      if (hosts.length !== 1 || (expectedHost !== undefined && hosts[0] !== expectedHost)) return fixed(res, 400, 'INVALID_HOST');
      if (headerValues(req, 'content-type').length !== 1 || req.headers['content-type'] !== 'application/octet-stream') return fixed(res, 415, 'UNSUPPORTED_CONTENT_TYPE');
      const enc = headerValues(req, 'content-encoding');
      if (enc.length > 1 || (enc.length === 1 && enc[0]!.toLowerCase() !== 'identity')) return fixed(res, 415, 'UNSUPPORTED_ENCODING');
      const ids = headerValues(req, 'assurepay-request-id');
      if (ids.length !== 1 || !/^0x[0-9a-f]{64}$/.test(ids[0]!) || /^0x0{64}$/.test(ids[0]!)) return fixed(res, 400, 'INVALID_REQUEST_ID');
      const requestId = ids[0] as Hex;
      const paymentHeaders = headerValues(req, 'payment-signature');
      if (paymentHeaders.length > 1) return fixed(res, 400, 'DUPLICATE_PAYMENT_HEADER');
      if (paymentHeaders[0] && paymentHeaders[0].length > MAX_PAYMENT_HEADER) return fixed(res, 413, 'PAYMENT_HEADER_TOO_LARGE');
      const retrieveHeaders = headerValues(req, 'assurepay-retrieve-only');
      if (retrieveHeaders.length > 1 || (retrieveHeaders.length === 1 && retrieveHeaders[0] !== '1')) return fixed(res, 400, 'INVALID_RETRIEVAL_MODE');
      if (headerValues(req, 'payment-required').length || headerValues(req, 'payment-response').length || headerValues(req, 'assurepay-receipt').length > 1) return fixed(res, 400, 'INVALID_FINANCIAL_HEADERS');
      const body = await readRequest(req);
      const requestHash = hashRequest('POST', configuredUrl, 'application/octet-stream', body, requestId);
      if (!paymentHeaders[0]) {
        const challenge = await adapter.challenge(requestHash, configuredUrl);
        return send(res, 402, new Uint8Array(), { 'payment-required': encodePaymentRequiredHeader(challenge), 'cache-control': 'no-store' });
      }
      let payment: unknown;
      try { payment = decodePaymentSignatureHeader(paymentHeaders[0]); }
      catch { return fixed(res, 400, 'INVALID_PAYMENT_HEADER'); }
      let call: PreparedCall;
      try { call = await prepareCall(payment, requestHash); }
      catch { return fixed(res, 402, 'PAYMENT_REJECTED'); }
      if (!validHex(call.intentHash) || call.intent.requestHash.toLowerCase() !== requestHash.toLowerCase()) return fixed(res, 402, 'PAYMENT_REJECTED');

      const serviceKey = `${call.intentHash.toLowerCase()}:${requestHash.toLowerCase()}`;
      const cached = cache.get(serviceKey);
      if (retrieveHeaders.length === 1) {
        try {
          const recovered = await retrieveExisting(call, requestHash, cached);
          if (!recovered) return fixed(res, 409, 'RESPONSE_UNAVAILABLE');
          return sendCached(res, recovered);
        } catch { return fixed(res, 503, 'STORED_RESPONSE_UNAVAILABLE'); }
      }
      if (cached && !resultStore) return sendCached(res, cached);
      const old = store.getByRequest(requestHash);
      if (old && old.coverageId.toLowerCase() !== call.intentHash.toLowerCase()) return fixed(res, 409, 'REQUEST_ALREADY_RESERVED');
      const running = flights.get(requestHash.toLowerCase());
      if (running) {
        if (running.intentHash.toLowerCase() !== call.intentHash.toLowerCase()) return fixed(res, 409, 'REQUEST_ALREADY_RESERVED');
        return sendOutcome(res, await running.promise);
      }
      if (resultStore && (old?.state === 'started' || old?.state === 'completed')) {
        const promise = (async (): Promise<Outcome> => {
          try {
            const recovered = await recoverStored(old, call, requestHash);
            if (recovered) return { kind: 'response', response: recovered };
            if (old.state === 'completed') return { kind: 'unavailable' };
            if (!validHex(old.transaction)) return { kind: 'storage-unknown' };
            return { kind: 'pending', value: { code: 'SERVICE_INDETERMINATE', transaction: old.transaction, coverageId: old.coverageId } };
          } catch { return { kind: 'storage-unknown' }; }
        })();
        flights.set(requestHash.toLowerCase(), { intentHash: call.intentHash, promise });
        try { return sendOutcome(res, await promise); }
        finally { if (flights.get(requestHash.toLowerCase())?.promise === promise) flights.delete(requestHash.toLowerCase()); }
      }
      if (old?.state === 'started') {
        if (!validHex(old.transaction)) return fixed(res, 500, 'SERVICE_JOURNAL_CORRUPT');
        return sendPending(res, { code: 'SERVICE_INDETERMINATE', transaction: old.transaction, coverageId: old.coverageId });
      }
      if (old?.state === 'completed') return fixed(res, 409, 'RESPONSE_UNAVAILABLE');

      const promise = (async (): Promise<Outcome> => {
        try {
          if (!old) {
            const reserved = await store.reserve(call.intentHash, requestHash, call.intentHash);
            const afterReserve = store.getByRequest(requestHash);
            if (reserved !== 'reserved' && afterReserve?.coverageId.toLowerCase() !== call.intentHash.toLowerCase()) return { kind: 'rejected' };
          }
          const result = await adapter.settle(payment, requestHash);
          if (!result || !['confirmed', 'pending', 'reverted', 'invalid'].includes(result.state)) return { kind: 'rejected' };
          if (!validHex(result.coverageId) || result.coverageId.toLowerCase() !== call.intentHash.toLowerCase()) return { kind: 'rejected' };
          if (result.state === 'pending') {
            if (!validHex(result.transaction)) return { kind: 'rejected' };
            return { kind: 'pending', value: { code: 'PAYMENT_PENDING', transaction: result.transaction, coverageId: result.coverageId } };
          }
          if (result.state !== 'confirmed' || !validHex(result.transaction)) return { kind: 'rejected' };
          let admissible: boolean;
          try { admissible = await canServe(call); }
          catch { return { kind: 'admission-unknown' }; }
          if (!admissible) return { kind: 'not-live' };
          const started = await store.start(result.coverageId, requestHash, result.transaction);
          if (started !== 'started') return { kind: 'rejected' };
          let responseBody: Uint8Array;
          let status = 200;
          try {
            const raw = await handler(Uint8Array.from(body));
            responseBody = Uint8Array.from(raw);
            if (responseBody.byteLength > MAX_BODY) throw new Error('RESPONSE_TOO_LARGE');
          } catch {
            responseBody = Uint8Array.from(FIXED_BODY);
            status = 500;
          }
          const at = now();
          if (!Number.isSafeInteger(at) || at < 0) return { kind: 'rejected' };
          const completedAt = String(at);
          const responseHash = keccak256(responseBody);
          const message: ReceiptMessage = { chainId: '84532', core: terms.core, coverageId: result.coverageId, requestHash, responseHash, status, completedAt };
          const receipt = await signReceipt(message, signer);
          if (resultStore) {
            if (!result.blockNumber || !/^[1-9][0-9]*$/.test(result.blockNumber) || !validHex(result.blockHash)) return { kind: 'unknown' };
            await resultStore.put(context, { coverageId: result.coverageId, requestHash, transaction: result.transaction,
              blockNumber: result.blockNumber, blockHash: result.blockHash, status, body: responseBody, receipt });
          }
          await store.complete(result.coverageId, requestHash, result.transaction, status, responseHash, completedAt);
          const response: CachedResponse = { status, body: responseBody, receipt, paymentResponse: resultHeader(result) };
          cache.set(serviceKey, response);
          return { kind: 'response', response };
        } catch {
          return { kind: 'unknown' };
        }
      })();
      flights.set(requestHash.toLowerCase(), { intentHash: call.intentHash, promise });
      try { return sendOutcome(res, await promise); }
      finally { if (flights.get(requestHash.toLowerCase())?.promise === promise) flights.delete(requestHash.toLowerCase()); }
    } catch (error) {
      if (!res.headersSent) fixed(res, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 500, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'HTTP_FLOW_FAILED');
      else res.destroy();
    }
  };
  async function recoverStored(old: ServiceRecord, call: PreparedCall, requestHash: Hex): Promise<CachedResponse | undefined> {
    const archived = await resultStore!.get(context, call.intentHash, requestHash);
    if (!archived) return undefined;
    if (archived.coverageId !== call.intentHash || archived.requestHash !== requestHash || archived.transaction !== old.transaction ||
        !(archived.body instanceof Uint8Array) || archived.body.length > MAX_BODY || !validHex(archived.blockHash) ||
        !/^[1-9][0-9]*$/.test(archived.blockNumber) ||
        !await verifyReceipt(archived.receipt, { terms, coverageId: call.intentHash, requestHash, response: archived.body, status: archived.status })) {
      throw new Error('STORED_RESPONSE_INVALID');
    }
    if (old.state === 'completed' && (old.status !== archived.status || old.responseHash !== keccak256(archived.body) ||
        old.completedAt !== archived.receipt.message.completedAt)) throw new Error('STORED_RESPONSE_INVALID');
    const proof = await engine.reconcile!(call);
    if (proof.state !== 'confirmed' || proof.coverageId !== call.intentHash || proof.transaction !== archived.transaction ||
        proof.blockNumber !== archived.blockNumber || proof.blockHash !== archived.blockHash) throw new Error('STORED_PAYMENT_UNCONFIRMED');
    if (old.state === 'started') await store.complete(call.intentHash, requestHash, archived.transaction, archived.status,
      keccak256(archived.body), archived.receipt.message.completedAt);
    return { status: archived.status, body: Uint8Array.from(archived.body), receipt: archived.receipt, paymentResponse: resultHeader(proof) };
  }
  async function retrieveExisting(call: PreparedCall, requestHash: Hex, cached?: CachedResponse): Promise<CachedResponse | undefined> {
    const old = store.getByRequest(requestHash);
    if (old && (old.coverageId.toLowerCase() !== call.intentHash.toLowerCase() || !['started','completed'].includes(old.state))) return undefined;
    const archived = await resultStore?.get(context, call.intentHash, requestHash);
    if (archived) {
      if (archived.coverageId.toLowerCase() !== call.intentHash.toLowerCase() || archived.requestHash.toLowerCase() !== requestHash.toLowerCase() ||
          !validHex(archived.transaction) || !(archived.body instanceof Uint8Array) || archived.body.length > MAX_BODY ||
          !validHex(archived.blockHash) || !/^[1-9][0-9]*$/.test(archived.blockNumber) ||
          !await verifyReceipt(archived.receipt, { terms, coverageId: call.intentHash, requestHash, response: archived.body, status: archived.status })) throw new Error('STORED_RESPONSE_INVALID');
      if (old && (!validHex(old.transaction) || old.transaction.toLowerCase() !== archived.transaction.toLowerCase())) throw new Error('STORED_RESPONSE_INVALID');
      if (old?.state === 'completed' && (old.status !== archived.status || old.responseHash !== keccak256(archived.body) || old.completedAt !== archived.receipt.message.completedAt)) throw new Error('STORED_RESPONSE_INVALID');
      const proof = await engine.reconcile!(call);
      if (proof.state !== 'confirmed' || proof.coverageId.toLowerCase() !== call.intentHash.toLowerCase() ||
          proof.transaction.toLowerCase() !== archived.transaction.toLowerCase() || proof.blockNumber !== archived.blockNumber ||
          !validHex(proof.blockHash) || proof.blockHash.toLowerCase() !== archived.blockHash.toLowerCase()) throw new Error('STORED_PAYMENT_UNCONFIRMED');
      return { status: archived.status, body: Uint8Array.from(archived.body), receipt: archived.receipt, paymentResponse: resultHeader(proof) };
    }
    if (!cached || !old) return undefined;
    if (!await verifyReceipt(cached.receipt, { terms, coverageId: call.intentHash, requestHash, response: cached.body, status: cached.status })) throw new Error('STORED_RESPONSE_INVALID');
    const cachedTx = (cached.paymentResponse as any)?.transaction;
    if (!validHex(cachedTx) || !validHex(old.transaction) || old.transaction.toLowerCase() !== cachedTx.toLowerCase()) throw new Error('STORED_RESPONSE_INVALID');
    const proof = await engine.reconcile!(call);
    if (proof.state !== 'confirmed' || proof.coverageId.toLowerCase() !== call.intentHash.toLowerCase() || proof.transaction.toLowerCase() !== cachedTx.toLowerCase()) throw new Error('STORED_PAYMENT_UNCONFIRMED');
    return { ...cached, body: Uint8Array.from(cached.body), paymentResponse: resultHeader(proof) };
  }
  function sendCached(res: ServerResponse, cached: CachedResponse): void {
    send(res, cached.status, cached.body, {
      'assurepay-receipt': Buffer.from(JSON.stringify(cached.receipt)).toString('base64'),
      'payment-response': encodePaymentResponseHeader(cached.paymentResponse as any),
      'cache-control': 'no-store',
    });
  }
  function sendPending(res: ServerResponse, value: PendingResponse): void {
    send(res, 202, pendingBody(value), { 'cache-control': 'no-store' });
  }
  function sendOutcome(res: ServerResponse, outcome: Outcome): void {
    if (outcome.kind === 'response') return sendCached(res, outcome.response);
    if (outcome.kind === 'pending') return sendPending(res, outcome.value);
    if (outcome.kind === 'unknown') return fixed(res, 503, 'PAYMENT_UNAVAILABLE');
    if (outcome.kind === 'not-live') return fixed(res, 409, 'COVERAGE_NOT_LIVE');
    if (outcome.kind === 'admission-unknown') return fixed(res, 503, 'SERVICE_ADMISSION_UNAVAILABLE');
    if (outcome.kind === 'unavailable') return fixed(res, 409, 'RESPONSE_UNAVAILABLE');
    if (outcome.kind === 'storage-unknown') return fixed(res, 503, 'STORED_RESPONSE_UNAVAILABLE');
    return fixed(res, 402, 'PAYMENT_REJECTED');
  }
  const server = createServer((req, res) => { void listener(req, res); });
  const parsed = new URL(bindUrl);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(parsed.port), parsed.hostname, () => { server.off('error', reject); resolve(); });
  });
  return { url: configuredUrl, server, close: () => new Promise((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections(); }) };
}
