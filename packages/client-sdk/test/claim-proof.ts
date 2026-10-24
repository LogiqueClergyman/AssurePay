import assert from 'node:assert/strict';
import { decodeFunctionData, type Hex } from 'viem';
import { CORE_ABI } from '../../claims-backend/src/abi.js';
import type { createPilotFixture } from '../../developer-pilot/test/helpers.js';

/** Independently prove a payer's exact fileClaim transaction and included coverage state. */
export async function verifyPayerClaim(
  fixture: Awaited<ReturnType<typeof createPilotFixture>>,
  coverageId: Hex,
  evidenceHash: Hex,
  transaction: Hex,
): Promise<Record<string, unknown>> {
  const { config, evm, artifacts } = fixture;
  const client = evm.publicClient;
  const head = await client.getBlock({ blockTag: 'latest' });
  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash: transaction }),
    client.getTransaction({ hash: transaction }),
  ]);
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.transactionHash, transaction);
  assert.equal(tx.hash, transaction);
  assert.equal(tx.blockHash, receipt.blockHash);
  assert.equal(tx.blockNumber, receipt.blockNumber);
  assert.ok(head.number >= receipt.blockNumber);
  assert.equal(tx.chainId, 84532);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.from.toLowerCase(), config.roles.payer);
  assert.equal(tx.to?.toLowerCase(), config.core);
  assert.equal(tx.value, 0n);
  assert.equal(tx.gas, 100_000n);
  assert.equal(tx.maxFeePerGas, 100_000_000n);
  assert.equal(tx.maxPriorityFeePerGas, 1_000_000n);
  const decoded = decodeFunctionData({ abi: CORE_ABI, data: tx.input });
  assert.equal(decoded.functionName, 'fileClaim');
  assert.ok(decoded.functionName === 'fileClaim');
  assert.deepEqual(decoded.args, [coverageId, evidenceHash]);

  const coverage = await client.readContract({ address: config.core, abi: artifacts.AssuranceCore.abi,
    functionName: 'coverages', args: [coverageId], blockNumber: receipt.blockNumber });
  assert.equal(coverage[0].toLowerCase(), config.roles.payer);
  assert.equal(coverage[14], evidenceHash);
  assert.equal(Number(coverage[13]), 2);
  const inclusion = await client.getBlock({ blockNumber: receipt.blockNumber });
  assert.equal(inclusion.hash, receipt.blockHash);
  assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, inclusion.hash);
  return { coverageId, evidenceHash, transaction, inclusion: { number: String(receipt.blockNumber), hash: receipt.blockHash },
    coverageStatus: Number(coverage[13]), payer: config.roles.payer, core: config.core,
    gas: String(tx.gas), maxFeePerGas: String(tx.maxFeePerGas), maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas) };
}
