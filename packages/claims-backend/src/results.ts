import { keccak256, type Hex } from 'viem';
import type { DurableServiceResult, ResultStore, SignedReceipt } from '../../x402-assurance/src/types.js';
import { exact, requireAddress, requireId, uint } from './common.js';
import type { Vault } from './types.js';

const MAX_BODY = 65_536;
const HEX_BYTES = /^(?:[0-9a-f]{2})*$/;
type StoredResult = {
  version: 1; kind: 'result'; context: string; coverageId: Hex; requestHash: Hex;
  transaction: Hex; blockNumber: string; blockHash: Hex; status: number; bodyHex: string; receipt: SignedReceipt;
};
function invalid(): never { throw new Error('RESULT_INVALID'); }
function isBytes32(value: unknown): value is Hex { return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value); }
function parseReceipt(value: unknown): SignedReceipt {
  const receipt = exact(value, ['message', 'signature']);
  const message = exact(receipt.message, ['chainId', 'core', 'coverageId', 'requestHash', 'responseHash', 'status', 'completedAt']);
  if (message.chainId !== '84532' || typeof message.core !== 'string' || requireAddress(message.core) !== message.core ||
      !isBytes32(message.coverageId) || !isBytes32(message.requestHash) || !isBytes32(message.responseHash) ||
      !Number.isInteger(message.status) || message.status < 200 || message.status > 599 || typeof message.completedAt !== 'string') invalid();
  uint(message.completedAt);
  if (typeof receipt.signature !== 'string' || !/^0x[0-9a-f]{130}$/.test(receipt.signature)) invalid();
  return {
    message: {
      chainId: message.chainId, core: message.core, coverageId: message.coverageId,
      requestHash: message.requestHash, responseHash: message.responseHash,
      status: message.status, completedAt: message.completedAt,
    },
    signature: receipt.signature as Hex,
  };
}
function snapshotResult(context: string, input: DurableServiceResult): StoredResult {
  if (typeof context !== 'string' || !/^[0-9a-f]{64}$/.test(context)) invalid();
  const row = exact(input as unknown, ['coverageId', 'requestHash', 'transaction', 'blockNumber', 'blockHash', 'status', 'body', 'receipt']);
  const coverageId = requireId(row.coverageId);
  const requestHash = requireId(row.requestHash);
  const transaction = requireId(row.transaction);
  const blockHash = requireId(row.blockHash);
  if (typeof row.blockNumber !== 'string') invalid();
  uint(row.blockNumber);
  if (!Number.isInteger(row.status) || row.status < 200 || row.status > 599 || !(row.body instanceof Uint8Array) || row.body.byteLength > MAX_BODY) invalid();
  const body = Buffer.from(row.body);
  const receipt = parseReceipt(row.receipt);
  if (receipt.message.coverageId !== coverageId || receipt.message.requestHash !== requestHash || receipt.message.status !== row.status ||
      receipt.message.responseHash !== keccak256(body)) invalid();
  return {
    version: 1, kind: 'result', context, coverageId, requestHash, transaction,
    blockNumber: row.blockNumber, blockHash, status: row.status, bodyHex: body.toString('hex'), receipt,
  };
}
function decodeResult(context: string, coverageId: Hex, requestHash: Hex, value: unknown): DurableServiceResult {
  const row = exact(value, ['version', 'kind', 'context', 'coverageId', 'requestHash', 'transaction', 'blockNumber', 'blockHash', 'status', 'bodyHex', 'receipt']) as unknown as StoredResult;
  if (row.version !== 1 || row.kind !== 'result' || row.context !== context || row.coverageId !== coverageId || row.requestHash !== requestHash ||
      typeof row.bodyHex !== 'string' || row.bodyHex.length > MAX_BODY * 2 || !HEX_BYTES.test(row.bodyHex)) invalid();
  const body = Buffer.from(row.bodyHex, 'hex');
  const checked = snapshotResult(context, {
    coverageId: row.coverageId, requestHash: row.requestHash, transaction: row.transaction,
    blockNumber: row.blockNumber, blockHash: row.blockHash, status: row.status, body, receipt: row.receipt,
  });
  if (checked.bodyHex !== row.bodyHex) invalid();
  return {
    coverageId: row.coverageId, requestHash: row.requestHash, transaction: row.transaction,
    blockNumber: row.blockNumber, blockHash: row.blockHash, status: row.status,
    body: Uint8Array.from(body), receipt: checked.receipt,
  };
}

/** Adapts the encrypted vault to M3's optional durable provider-result interface. */
export function createResultStore(vault: Vault): ResultStore {
  if (!vault || typeof vault.put !== 'function' || typeof vault.get !== 'function') throw new Error('RESULT_STORE_CONFIG');
  return Object.freeze({
    async put(context: string, result: DurableServiceResult): Promise<void> {
      const row = snapshotResult(context, result);
      await vault.put('result', row.coverageId, row);
    },
    async get(context: string, coverageId: Hex, requestHash: Hex): Promise<DurableServiceResult | undefined> {
      requireId(coverageId); requireId(requestHash);
      if (typeof context !== 'string' || !/^[0-9a-f]{64}$/.test(context)) invalid();
      const value = await vault.get('result', coverageId);
      if (value === undefined) return undefined;
      return decodeResult(context, coverageId, requestHash, value);
    },
  });
}
