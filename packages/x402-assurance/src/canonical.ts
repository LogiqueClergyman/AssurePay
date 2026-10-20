import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';
import type { CanonicalRequest } from './types.js';

export const REQUEST_TYPE_LITERAL = 'AssuredRequestV1(string method,string url,string contentType,bytes32 bodyHash,bytes32 requestId)' as const;
export const REQUEST_BODY_LIMIT = 65_536;

const HEX32 = /^0x[0-9a-f]{64}$/;

export function canonicalRequestUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('INVALID_REQUEST_URL');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('INVALID_REQUEST_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.href !== input || !url.pathname.startsWith('/')) throw new Error('INVALID_REQUEST_URL');
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    throw new Error('HTTPS_REQUIRED');
  }
  return input;
}

export function validateCanonicalRequest(input: CanonicalRequest): CanonicalRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).length !== 5 || ['url','method','contentType','body','requestId'].some(k => !Object.hasOwn(input,k)) ||
      input.method !== 'POST' || input.contentType !== 'application/octet-stream' ||
      !(input.body instanceof Uint8Array) || input.body.byteLength > REQUEST_BODY_LIMIT ||
      !HEX32.test(input.requestId) || /^0x0{64}$/.test(input.requestId)) throw new Error('INVALID_REQUEST');
  canonicalRequestUrl(input.url);
  return Object.freeze({ ...input, body: new Uint8Array(input.body) });
}

export function hashRequest(
  method: 'POST', url: string, contentType: 'application/octet-stream', body: Uint8Array, requestId: Hex,
): Hex {
  const request = validateCanonicalRequest({ method, url, contentType, body, requestId });
  const typeHash = keccak256(toBytes(REQUEST_TYPE_LITERAL));
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [typeHash, request.method, request.url, request.contentType, keccak256(request.body), request.requestId],
  ));
}
