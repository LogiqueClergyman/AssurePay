import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { createPayment, prepareCall, requirementsFor, canonicalRequestUrl, hashRequest, verifyReceipt } from './protocol.js';
import type { Terms, Trust, PayerSigner, PreparedCall, PaymentResult, SignedReceipt } from './types.js';

const MAX_BODY = 65_536;
const MAX_PAYMENT_HEADER = 16_384;
export interface PurchaseOptions {
  url: string;
  body: Uint8Array;
  payer: PayerSigner;
  trust: Trust;
  maxGross: string;
  readTerms(trust: Trust, gross: string): Promise<Terms>;
  now(): number | bigint | Promise<number | bigint>;
  verifyPayment(input: { payment: PaymentPayload; call: PreparedCall; requestHash: `0x${string}`; paymentResponse: unknown }): Promise<PaymentResult>;
  fetch?: typeof globalThis.fetch;
  createRequestId?: () => `0x${string}`;
}
export interface PurchaseResponse { status: number; body: Uint8Array; paid: boolean; receipt?: SignedReceipt; paymentResponse?: unknown }
export interface PurchaseSession { requestId: `0x${string}`; requestHash: `0x${string}`; payment: PaymentPayload; call: PreparedCall; send(): Promise<PurchaseResponse>; retry(): Promise<PurchaseResponse> }
export interface PurchaseSnapshot { version: 1; url: string; bodyHex: string; trust: Trust; maxGross: string; payer: `0x${string}`; terms: Terms; requestId: `0x${string}`; payment: PaymentPayload }

function parsePaidResult(response: Response, bytes: Uint8Array, context: { terms: Terms; requestHash: `0x${string}`; call: PreparedCall; payment: PaymentPayload; verifyPayment: PurchaseOptions['verifyPayment'] }): Promise<PurchaseResponse> {
  return (async () => {
    const rawPaymentResponse = response.headers.get('payment-response');
    const rawReceipt = response.headers.get('assurepay-receipt');
    if (!rawPaymentResponse || rawPaymentResponse.length > MAX_PAYMENT_HEADER || !rawReceipt || rawReceipt.length > MAX_PAYMENT_HEADER) throw new Error('MISSING_PAID_RESPONSE_PROOF');
    let paymentResponse: unknown;
    let receipt: SignedReceipt;
    try {
      paymentResponse = decodePaymentResponseHeader(rawPaymentResponse);
      receipt = JSON.parse(Buffer.from(rawReceipt, 'base64').toString('utf8')) as SignedReceipt;
    } catch { throw new Error('INVALID_PAID_RESPONSE_PROOF'); }
    if (response.status < 200 || response.status > 599 || !await verifyReceipt(receipt, { terms: context.terms, requestHash: context.requestHash, response: bytes, status: response.status, coverageId: context.call.intentHash })) throw new Error('INVALID_RESPONSE_RECEIPT');
    if (!(paymentResponse && typeof paymentResponse === 'object' && Object.keys(paymentResponse).length === 3 && (paymentResponse as any).success === true &&
          (paymentResponse as any).network === 'eip155:84532' && typeof (paymentResponse as any).transaction === 'string' &&
          /^0x[0-9a-fA-F]{64}$/.test((paymentResponse as any).transaction) && !/^0x0{64}$/i.test((paymentResponse as any).transaction))) throw new Error('INVALID_PAYMENT_RESPONSE');
    const paymentVerified = await context.verifyPayment({ payment: context.payment, call: context.call, requestHash: context.requestHash, paymentResponse });
    if (paymentVerified.state !== 'confirmed' || !/^0x[0-9a-fA-F]{64}$/.test(paymentVerified.transaction) ||
        paymentVerified.transaction.toLowerCase() !== (paymentResponse as any).transaction.toLowerCase() ||
        paymentVerified.coverageId.toLowerCase() !== context.call.intentHash.toLowerCase()) throw new Error('PAYMENT_NOT_CONFIRMED');
    return { status: response.status, body: bytes, paid: true, receipt, paymentResponse };
  })();
}

function snapshotBody(hex: string): Uint8Array {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})*$/.test(hex) || hex.length > MAX_BODY * 2) throw new Error('INVALID_PURCHASE_SNAPSHOT');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function equalJson(a: unknown, b: unknown): boolean { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw new Error('RESPONSE_TOO_LARGE');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function parsePendingResponse(bytes: Uint8Array, call: PreparedCall): PurchaseResponse {
  let pending: any;
  try { pending = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('INVALID_PENDING_RESPONSE'); }
  if (!pending || typeof pending !== 'object' || Array.isArray(pending) || Object.getPrototypeOf(pending) !== Object.prototype || Object.keys(pending).length !== 3 ||
      !['PAYMENT_PENDING', 'SERVICE_INDETERMINATE'].includes(pending.code) || typeof pending.transaction !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(pending.transaction) || /^0x0{64}$/i.test(pending.transaction) ||
      typeof pending.coverageId !== 'string' || pending.coverageId.toLowerCase() !== call.intentHash.toLowerCase()) throw new Error('INVALID_PENDING_RESPONSE');
  return { status: 202, body: bytes, paid: false };
}

/** Creates one SDK payment from an unpaid challenge; retries reuse the exact authorization and bytes. */
export async function createPurchase(options: PurchaseOptions): Promise<PurchaseSession> {
  const url = canonicalRequestUrl(options.url);
  const body = Uint8Array.from(options.body);
  const trust = Object.freeze({ ...options.trust });
  const maxGross = options.maxGross;
  const readTerms = options.readTerms;
  const clock = options.now;
  const verifyPayment = options.verifyPayment;
  const fetcher = options.fetch ?? globalThis.fetch;
  const requestIdFactory = options.createRequestId;
  const payer = Object.freeze({ address: options.payer.address, signTypedData: options.payer.signTypedData.bind(options.payer) });
  if (body.byteLength > MAX_BODY) throw new Error('REQUEST_TOO_LARGE');
  if (!/^(0|[1-9][0-9]*)$/.test(maxGross)) throw new Error('INVALID_SPEND_CAP');
  const id = requestIdFactory?.() ?? `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}`;
  if (!/^0x[0-9a-f]{64}$/.test(id) || /^0x0{64}$/.test(id)) throw new Error('INVALID_REQUEST_ID');
  const requestHash = hashRequest('POST', url, 'application/octet-stream', body, id);
  const baseHeaders = { 'content-type': 'application/octet-stream', 'assurepay-request-id': id };
  let challenge: Response;
  try { challenge = await fetcher(url, { method: 'POST', headers: baseHeaders, body: Buffer.from(body), redirect: 'error' }); }
  catch { throw new Error('CHALLENGE_UNAVAILABLE'); }
  if (challenge.status !== 402) throw new Error('EXPECTED_PAYMENT_CHALLENGE');
  const challengeBody = await boundedBody(challenge);
  const challengeHeader = challenge.headers.get('payment-required');
  if (!challengeHeader || challengeHeader.length > MAX_PAYMENT_HEADER) throw new Error('INVALID_PAYMENT_CHALLENGE');
  let required: any;
  try { required = decodePaymentRequiredHeader(challengeHeader); } catch { throw new Error('INVALID_PAYMENT_CHALLENGE'); }
  if (!required || required.x402Version !== 2 || !Array.isArray(required.accepts) || required.accepts.length !== 1) throw new Error('INVALID_PAYMENT_CHALLENGE');
  if (Object.keys(required).some(k => !['x402Version', 'resource', 'accepts'].includes(k))) throw new Error('INVALID_PAYMENT_CHALLENGE');
  if (required.resource !== undefined) {
    const resource = required.resource;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource) || resource.url !== url ||
        Object.keys(resource).some(k => !['url', 'description', 'mimeType'].includes(k)) ||
        (resource.description !== undefined && typeof resource.description !== 'string') ||
        (resource.mimeType !== undefined && typeof resource.mimeType !== 'string')) throw new Error('UNTRUSTED_PAYMENT_RESOURCE');
  }
  const accepted = required.accepts[0];
  if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted) ||
      typeof accepted.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(accepted.amount) || BigInt(accepted.amount) > BigInt(maxGross)) throw new Error('UNTRUSTED_PAYMENT_REQUIREMENTS');
  const read = await readTerms(trust, accepted.amount);
  const terms: Terms = Object.freeze({ ...read, core: read.core.toLowerCase() as Terms['core'], token: read.token.toLowerCase() as Terms['token'], providerOwner: read.providerOwner.toLowerCase() as Terms['providerOwner'], providerPayout: read.providerPayout.toLowerCase() as Terms['providerPayout'] });
  if (terms.chainId !== trust.chainId || terms.core.toLowerCase() !== trust.core.toLowerCase() ||
      terms.token.toLowerCase() !== trust.token.toLowerCase() || terms.providerId.toLowerCase() !== trust.providerId.toLowerCase() ||
      terms.policyId.toLowerCase() !== trust.policyId.toLowerCase() || terms.gross !== accepted.amount || BigInt(terms.gross) > BigInt(maxGross)) throw new Error('TRUSTED_TERMS_MISMATCH');
  if (!equalJson(required.accepts, [requirementsFor(terms, requestHash)])) throw new Error('UNTRUSTED_PAYMENT_REQUIREMENTS');
  if (challengeBody.byteLength !== 0) throw new Error('INVALID_PAYMENT_CHALLENGE');
  const clockValue = await clock();
  const nowSeconds = typeof clockValue === 'bigint' ? clockValue : BigInt(clockValue);
  const payment = await createPayment({ terms, requestHash, payer, nowSeconds, maxGross });
  const call = await prepareCall(payment, terms, requestHash, nowSeconds);
  let flight: Promise<PurchaseResponse> | undefined;
  const send = (): Promise<PurchaseResponse> => {
    if (flight) return flight;
    flight = (async () => {
      let response: Response;
      try {
        response = await fetcher(url, { method: 'POST', headers: { ...baseHeaders, 'payment-signature': encodePaymentSignatureHeader(payment) }, body: Buffer.from(body), redirect: 'error' });
      } catch { throw new Error('PAID_RESPONSE_UNAVAILABLE'); }
      const bytes = await boundedBody(response);
      if (response.status === 202) return parsePendingResponse(bytes, call);
      return parsePaidResult(response, bytes, { terms, requestHash, call, payment, verifyPayment });
    })().finally(() => { flight = undefined; });
    return flight;
  };
  return { requestId: id, requestHash, payment, call, send, retry: send };
}

/** Reopens an encrypted buyer snapshot for retrieval. This path never signs or settles. */
export async function restorePurchase(options: {
  snapshot: PurchaseSnapshot; url: string; trust: Trust; maxGross: string; payer: `0x${string}`;
  readTerms(trust: Trust, gross: string): Promise<Terms>;
  now(): number | bigint | Promise<number | bigint>;
  verifyPayment: PurchaseOptions['verifyPayment']; fetch?: typeof globalThis.fetch;
}): Promise<PurchaseSession> {
  const readTerms = options.readTerms;
  const clock = options.now;
  const verifyPayment = options.verifyPayment;
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = canonicalRequestUrl(options.url);
  const trust = Object.freeze({ ...options.trust });
  const maxGross = options.maxGross;
  const payerAddress = options.payer.toLowerCase();
  let cloned: unknown;
  try { cloned = structuredClone(options.snapshot); } catch { throw new Error('INVALID_PURCHASE_SNAPSHOT'); }
  const s = cloned as any;
  const keys = ['version','url','bodyHex','trust','maxGross','payer','terms','requestId','payment'];
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.getPrototypeOf(s) !== Object.prototype || Object.keys(s).length !== keys.length || keys.some(k => !Object.hasOwn(s,k)) || s.version !== 1 ||
      typeof s.url !== 'string' || typeof s.bodyHex !== 'string' || typeof s.maxGross !== 'string' || typeof s.payer !== 'string' ||
      typeof s.requestId !== 'string' || !s.terms || typeof s.terms !== 'object' || !s.payment || typeof s.payment !== 'object') throw new Error('INVALID_PURCHASE_SNAPSHOT');
  const body = snapshotBody(s.bodyHex);
  if (body.byteLength > MAX_BODY || s.url !== url || s.maxGross !== maxGross || !/^(0|[1-9][0-9]*)$/.test(maxGross) ||
      !/^0x[0-9a-fA-F]{40}$/.test(payerAddress) || s.payer.toLowerCase() !== payerAddress || !equalJson(s.trust, trust) ||
      !/^0x[0-9a-f]{64}$/.test(s.requestId) || /^0x0{64}$/.test(s.requestId)) throw new Error('PURCHASE_SNAPSHOT_BINDING_MISMATCH');
  const requestHash = hashRequest('POST', url, 'application/octet-stream', body, s.requestId);
  const termsRead = await readTerms(trust, s.terms?.gross);
  const terms: Terms = Object.freeze({ ...termsRead, core: termsRead.core.toLowerCase() as Terms['core'], token: termsRead.token.toLowerCase() as Terms['token'], providerOwner: termsRead.providerOwner.toLowerCase() as Terms['providerOwner'], providerPayout: termsRead.providerPayout.toLowerCase() as Terms['providerPayout'] });
  if (!equalJson(terms, s.terms) || terms.chainId !== trust.chainId || terms.core.toLowerCase() !== trust.core.toLowerCase() ||
      terms.token.toLowerCase() !== trust.token.toLowerCase() || terms.providerId.toLowerCase() !== trust.providerId.toLowerCase() ||
      terms.policyId.toLowerCase() !== trust.policyId.toLowerCase() || !/^(0|[1-9][0-9]*)$/.test(maxGross) || BigInt(terms.gross) > BigInt(maxGross)) throw new Error('PURCHASE_SNAPSHOT_TERMS_MISMATCH');
  const clockValue = await clock();
  const nowSeconds = typeof clockValue === 'bigint' ? clockValue : BigInt(clockValue);
  const call = await prepareCall(s.payment, terms, requestHash, nowSeconds, { allowExpired: true });
  if (call.intent.payer.toLowerCase() !== payerAddress) throw new Error('PURCHASE_SNAPSHOT_PAYER_MISMATCH');
  const payment = s.payment as PaymentPayload;
  if (typeof fetcher !== 'function') throw new Error('FETCH_UNAVAILABLE');
  const headers = { 'content-type': 'application/octet-stream', 'assurepay-request-id': s.requestId, 'assurepay-retrieve-only': '1', 'payment-signature': encodePaymentSignatureHeader(payment) };
  let flight: Promise<PurchaseResponse> | undefined;
  const retrieve = (): Promise<PurchaseResponse> => {
    if (flight) return flight;
    flight = (async () => {
      let response: Response;
      try { response = await fetcher(url, { method: 'POST', headers, body: Buffer.from(body), redirect: 'error' }); }
      catch { throw new Error('PAID_RESPONSE_UNAVAILABLE'); }
      const bytes = await boundedBody(response);
      if (response.status === 202) return parsePendingResponse(bytes, call);
      return parsePaidResult(response, bytes, { terms, requestHash, call, payment, verifyPayment });
    })().finally(() => { flight = undefined; });
    return flight;
  };
  return { requestId: s.requestId, requestHash, payment, call, send: retrieve, retry: retrieve };
}
