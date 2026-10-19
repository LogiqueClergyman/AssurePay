import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import { BaseReceiptFeeReadError, withBaseReceiptFees } from '../src/base-receipt-fees.js';

const HASH = `0x${'11'.repeat(32)}` as Hex;
const BLOCK = `0x${'22'.repeat(32)}` as Hex;
const formatted = { transactionHash: HASH, blockHash: BLOCK, blockNumber: 123n, status: 'success' as const,
  gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n };
const raw = { transactionHash: HASH, blockHash: BLOCK, blockNumber: '0x7b', status: '0x1',
  l1Fee: '0x2a', operatorFee: '0x0' };

function client(overrides: { receipt?: unknown; rawReceipt?: unknown; failRaw?: boolean } = {}) {
  let requests = 0;
  const base = {
    getTransactionReceipt: async (_args: { hash: Hex }): Promise<any> => overrides.receipt ?? formatted,
    request: async (_args: { method: 'eth_getTransactionReceipt'; params: [Hex] }) => {
      requests++;
      if (overrides.failRaw) throw new Error('raw rpc secret marker');
      return overrides.rawReceipt ?? raw;
    },
    getBlockNumber: async () => 999n,
  };
  return { base, get requests() { return requests; } };
}

test('attaches allowlisted Base fee quantities only after canonical identity matches', async () => {
  const source = client();
  const wrapped = withBaseReceiptFees(source.base);
  const receipt = await wrapped.getTransactionReceipt({ hash: HASH });
  assert.equal(receipt.l1Fee, 42n);
  assert.equal(receipt.operatorFee, 0n);
  assert.equal(receipt.gasUsed, formatted.gasUsed);
  assert.equal(await wrapped.getBlockNumber(), 999n);
  assert.equal(source.requests, 1);
});

test('keeps absent fee fields explicitly unavailable', async () => {
  const source = client({ rawReceipt: { transactionHash: HASH, blockHash: BLOCK, blockNumber: '0x7b', status: '0x1' } });
  const receipt = await withBaseReceiptFees(source.base).getTransactionReceipt({ hash: HASH });
  assert.equal(receipt.l1Fee, null);
  assert.equal(receipt.operatorFee, null);
});

test('rejects malformed fee quantities with a fixed error and no raw content', async () => {
  const source = client({ rawReceipt: { ...raw, l1Fee: '0x01-secret-marker' } });
  await assert.rejects(withBaseReceiptFees(source.base).getTransactionReceipt({ hash: HASH }), (error: unknown) => {
    assert.ok(error instanceof BaseReceiptFeeReadError);
    assert.equal(error.message, 'M1_BASE_RECEIPT_FEE_READ_FAILED');
    assert.equal(error.message.includes('secret-marker'), false);
    return true;
  });
});

test('rejects a raw receipt with a different canonical identity', async () => {
  const source = client({ rawReceipt: { ...raw, blockHash: `0x${'33'.repeat(32)}` } });
  await assert.rejects(withBaseReceiptFees(source.base).getTransactionReceipt({ hash: HASH }),
    BaseReceiptFeeReadError);
});

test('fails closed on raw RPC errors without exposing provider details', async () => {
  const source = client({ failRaw: true });
  await assert.rejects(withBaseReceiptFees(source.base).getTransactionReceipt({ hash: HASH }), (error: unknown) => {
    assert.ok(error instanceof BaseReceiptFeeReadError);
    assert.equal(error.message.includes('secret marker'), false);
    return true;
  });
});
