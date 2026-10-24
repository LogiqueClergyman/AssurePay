import type { AgentOptions, AgentTool, AgentTools, ClientPreview, ClientResult, ClientState, ClientTerms, JsonValue } from './types.js';
import { clientErrorCode } from './errors.js';

const MAX_BODY_BYTES = 65_536;
const REQUEST_ID = /^0x[0-9a-fA-F]{64}$/;
const COVERAGE_ID = /^0x[0-9a-fA-F]{64}$/;

const toolDefinitions: readonly AgentTool[] = Object.freeze([
  Object.freeze({ name: 'assurepay_preview', description: 'Preview a payment request without authorizing or sending payment.', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ bodyBase64: Object.freeze({ type: 'string', contentEncoding: 'base64', maxLength: 87384, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' }) }), required: Object.freeze(['bodyBase64']), additionalProperties: false }) }),
  Object.freeze({ name: 'assurepay_pay', description: 'Request host approval and pay a request previewed by this adapter.', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ requestId: Object.freeze({ type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' }) }), required: Object.freeze(['requestId']), additionalProperties: false }) }),
  Object.freeze({ name: 'assurepay_retrieve', description: 'Retrieve the result for an existing request without creating a payment.', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ requestId: Object.freeze({ type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' }) }), required: Object.freeze(['requestId']), additionalProperties: false }) }),
  Object.freeze({ name: 'assurepay_state', description: 'Read payer balance and an optional own coverage state.', inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ coverageId: Object.freeze({ type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' }) }), additionalProperties: false }) }),
]);

function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) return false;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  const names = keys as string[];
  return required.every(key => Object.hasOwn(value, key)) && names.every(key => required.includes(key) || optional.includes(key));
}

function frozenPreview(preview: ClientPreview): ClientPreview {
  const source = preview.terms;
  const terms: ClientTerms = Object.freeze({
    chainId: source.chainId, core: source.core, token: source.token,
    providerId: source.providerId, policyId: source.policyId, policyHash: source.policyHash,
    providerOwner: source.providerOwner, providerPayout: source.providerPayout,
    premiumBps: source.premiumBps, stakeBps: source.stakeBps, withholdingBps: source.withholdingBps,
    duration: source.duration, poolOnlyAllowed: source.poolOnlyAllowed,
    gross: source.gross, premium: source.premium, withheld: source.withheld, net: source.net,
    stakeLock: source.stakeLock, poolReservation: source.poolReservation,
    tokenName: source.tokenName, tokenVersion: source.tokenVersion,
  });
  return Object.freeze({
    requestId: preview.requestId, requestHash: preview.requestHash, bodyHash: preview.bodyHash,
    url: preview.url, payer: preview.payer, serviceId: preview.serviceId,
    maxGross: preview.maxGross, expiresAt: preview.expiresAt, terms,
  });
}

function safePreview(value: ClientPreview): JsonValue {
  const preview = frozenPreview(value);
  return {
    requestId: preview.requestId, requestHash: preview.requestHash, bodyHash: preview.bodyHash,
    url: preview.url, payer: preview.payer, serviceId: preview.serviceId, maxGross: preview.maxGross,
    expiresAt: preview.expiresAt, terms: { ...preview.terms },
  };
}

function safeClientResult(value: ClientResult): JsonValue {
  if (value.state === 'retrieval-required') return {
    state: value.state, code: value.code, requestId: value.requestId,
    requestHash: value.requestHash, coverageId: value.coverageId,
  };
  if (!(value.body instanceof Uint8Array) || value.body.byteLength > MAX_BODY_BYTES) throw new Error('CLIENT_OPERATION_FAILED');
  return {
    state: value.state, requestId: value.requestId, requestHash: value.requestHash, coverageId: value.coverageId,
    status: value.status, bodyBase64: Buffer.from(value.body).toString('base64'), transaction: value.transaction,
    paymentBlock: { number: value.paymentBlock.number, hash: value.paymentBlock.hash },
    receipt: { chainId: value.receipt.chainId, core: value.receipt.core, coverageId: value.receipt.coverageId,
      requestHash: value.receipt.requestHash, responseHash: value.receipt.responseHash,
      status: value.receipt.status, completedAt: value.receipt.completedAt },
    receiptFingerprint: value.receiptFingerprint,
  };
}

function safeClientState(value: ClientState): JsonValue {
  const state: Record<string, JsonValue> = {
    chainId: value.chainId, core: value.core, token: value.token, payer: value.payer,
    tokenBalanceAtomic: value.tokenBalanceAtomic,
    observedBlock: { number: value.observedBlock.number, hash: value.observedBlock.hash, timestamp: value.observedBlock.timestamp },
  };
  if (value.coverage) state.coverage = {
    coverageId: value.coverage.coverageId, payer: value.coverage.payer, providerId: value.coverage.providerId,
    policyId: value.coverage.policyId, requestHash: value.coverage.requestHash, status: value.coverage.status,
    outcome: value.coverage.outcome, gross: value.coverage.gross, premium: value.coverage.premium,
    withheld: value.coverage.withheld, stakeLock: value.coverage.stakeLock,
    poolReservation: value.coverage.poolReservation, openedAt: value.coverage.openedAt,
    expiresAt: value.coverage.expiresAt, poolOnlyAllowed: value.coverage.poolOnlyAllowed,
    refundAmount: value.coverage.refundAmount,
  };
  return state;
}

function failure(): JsonValue { return Object.freeze({ error: 'CLIENT_OPERATION_FAILED' }); }
function safeError(error: unknown, requestId?: string): JsonValue {
  const code = clientErrorCode(error);
  return requestId ? Object.freeze({ error: code, requestId }) : Object.freeze({ error: code });
}

export function createAgentTools(options: AgentOptions): AgentTools {
  const client = options.client;
  const approvePayment = options.approvePayment;
  const previewRequest = client.preview.bind(client);
  const authorizeRequest = client.authorize.bind(client);
  const sendRequest = client.send.bind(client);
  const retrieveRequest = client.retrieve.bind(client);
  const readClientState = client.readState.bind(client);
  const pending = new Map<string, ClientPreview>();
  let previewOperations = 0;
  async function invoke(name: string, args: unknown): Promise<JsonValue> {
    let correlatedRequestId: string | undefined;
    try {
      if (name === 'assurepay_preview') {
        if (!exactObject(args, ['bodyBase64']) || typeof args.bodyBase64 !== 'string') return failure();
        const body = Buffer.from(args.bodyBase64, 'base64');
        if (body.byteLength > MAX_BODY_BYTES || body.toString('base64') !== args.bodyBase64) return failure();
        if (pending.size + previewOperations >= 32) return failure();
        previewOperations += 1;
        try {
          const preview = frozenPreview(await previewRequest(new Uint8Array(body)));
          if (pending.has(preview.requestId)) return failure();
          pending.set(preview.requestId, preview);
          return safePreview(preview);
        } finally {
          previewOperations -= 1;
        }
      }
      if (name === 'assurepay_pay') {
        if (!exactObject(args, ['requestId'])) return failure();
        const requestId = Object.getOwnPropertyDescriptor(args, 'requestId')?.value;
        if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return failure();
        correlatedRequestId = requestId;
        const preview = pending.get(requestId);
        if (!preview) return failure();
        pending.delete(requestId);
        const approved = await approvePayment(preview);
        if (approved !== true) return Object.freeze({ state: 'denied', code: 'CLIENT_APPROVAL_DENIED' });
        const authorized = await authorizeRequest(preview.requestId, { approved: true });
        const result = await sendRequest(authorized.requestId);
        return safeClientResult(result);
      }
      if (name === 'assurepay_retrieve') {
        if (!exactObject(args, ['requestId'])) return failure();
        const requestId = Object.getOwnPropertyDescriptor(args, 'requestId')?.value;
        if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return failure();
        correlatedRequestId = requestId;
        return safeClientResult(await retrieveRequest(requestId as `0x${string}`));
      }
      if (name === 'assurepay_state') {
        if (!exactObject(args, [], ['coverageId']) || (args.coverageId !== undefined && (typeof args.coverageId !== 'string' || !COVERAGE_ID.test(args.coverageId)))) return failure();
        return safeClientState(await readClientState(args.coverageId as `0x${string}` | undefined));
      }
      return failure();
    } catch (error) {
      return safeError(error, correlatedRequestId);
    }
  }
  return Object.freeze({ tools: toolDefinitions, invoke });
}
