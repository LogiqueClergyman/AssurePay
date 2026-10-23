import assert from 'node:assert/strict';
import { decodeEventLog, decodeFunctionData, type Hex } from 'viem';
import { CORE_ABI } from '../../x402-assurance/src/core-abi.js';
import { hashRequest } from '../../x402-assurance/src/canonical.js';
import type { createPilotFixture } from '../../developer-pilot/test/helpers.js';

/** Independent, anchored checks of the first profile purchase in the fresh fixture. */
export async function verifyProfileSettlement(
  fixture: Awaited<ReturnType<typeof createPilotFixture>>,
  prepared: { requestId: Hex; requestHash: Hex; coverageId: Hex },
  transaction: Hex,
  body: Uint8Array,
): Promise<Record<string, unknown>> {
  const { config, evm, artifacts } = fixture;
  const client = evm.publicClient;
  const head = await client.getBlock({ blockTag: 'latest' });
  const expectedRequest = hashRequest('POST', config.resourceUrl, 'application/octet-stream', body, prepared.requestId);
  assert.equal(prepared.requestHash, expectedRequest);
  const receipt = await client.getTransactionReceipt({ hash: transaction });
  const tx = await client.getTransaction({ hash: transaction });
  assert.ok(head.number >= receipt.blockNumber);
  assert.equal(receipt.status, 'success');
  assert.equal(tx.hash, transaction);
  assert.equal(tx.blockHash, receipt.blockHash);
  assert.equal(tx.blockNumber, receipt.blockNumber);
  assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
  assert.equal(tx.chainId, 84532);
  assert.equal(tx.from.toLowerCase(), config.roles.relayer);
  assert.equal(tx.to.toLowerCase(), config.core);
  assert.equal(tx.value, 0n);
  const decoded = decodeFunctionData({ abi: CORE_ABI, data: tx.input });
  assert.equal(decoded.functionName, 'settleAssured');
  assert.ok(decoded.functionName === 'settleAssured');
  const intent = decoded.args[0];
  assert.equal(intent.requestHash, expectedRequest);
  assert.equal(intent.chainId, 84532n);
  assert.equal(intent.core.toLowerCase(), config.core);
  assert.equal(intent.token.toLowerCase(), config.token);
  assert.equal(intent.payer.toLowerCase(), config.roles.payer);
  assert.equal(intent.providerId, config.providerId);
  assert.equal(intent.policyId, config.policyId);
  assert.equal(intent.gross, 10003n);
  const coreLogs = receipt.logs.filter((log: { address: string }) => log.address.toLowerCase() === config.core);
  assert.equal(coreLogs.length, 1);
  const opened = decodeEventLog({ abi: CORE_ABI, data: coreLogs[0].data, topics: coreLogs[0].topics });
  assert.equal(opened.eventName, 'CoverageOpened');
  assert.equal(opened.args.coverageId, prepared.coverageId);
  assert.equal(opened.args.requestHash, expectedRequest);
  assert.equal(opened.args.payer.toLowerCase(), config.roles.payer);
  assert.equal(opened.args.providerId, config.providerId);
  assert.equal(opened.args.policyId, config.policyId);
  assert.equal(opened.args.gross, 10003n);
  assert.equal(opened.args.net, 7197n);
  const read = (functionName: string, args: readonly unknown[] = []) => client.readContract({
    address: config.core, abi: artifacts.AssuranceCore.abi, functionName, args, blockNumber: head.number,
  });
  assert.equal(await read('hashIntent', [intent]), prepared.coverageId);
  const coverage = await read('coverages', [prepared.coverageId]);
  assert.equal(coverage[0].toLowerCase(), config.roles.payer);
  assert.equal(coverage[1], config.providerId);
  assert.equal(coverage[2], config.policyId);
  assert.equal(coverage[3], intent.policyHash);
  assert.equal(coverage[4], expectedRequest);
  for (const [index, value] of [[5, 10003n], [6, 777n], [7, 2029n], [8, 3502n], [9, 10003n]] as const)
    assert.equal(coverage[index], value);
  assert.equal(Number(coverage[13]), 1);
  const state: Record<string, string> = {};
  const expected: Record<string, bigint> = {
    totalProviderStake: 12029n, poolAssets: 50777n, totalLockedStake: 3502n,
    totalPoolReserved: 10003n, activeCoverageCount: 1n, coverageCount: 1n,
  };
  for (const [name, value] of Object.entries(expected)) {
    const actual = await read(name); assert.equal(actual, value); state[name] = String(actual);
  }
  const balance = (account: string) => client.readContract({ address: config.token,
    abi: artifacts.AuthorizationTokenMock.abi, functionName: 'balanceOf', args: [account], blockNumber: head.number });
  const coreAssets = await balance(config.core);
  const payerAssets = await balance(config.roles.payer);
  const providerAssets = await balance(config.roles.provider);
  assert.equal(coreAssets, 62806n); assert.equal(payerAssets, 129997n); assert.equal(providerAssets, 7197n);
  assert.equal(coreAssets, BigInt(state.totalProviderStake!) + BigInt(state.poolAssets!));
  assert.ok(BigInt(state.poolAssets!) >= BigInt(state.totalPoolReserved!));
  assert.ok(BigInt(state.totalProviderStake!) >= BigInt(state.totalLockedStake!));
  assert.equal((await client.getBlock({ blockNumber: head.number })).hash, head.hash);
  return { transaction, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
    observedBlock: { number: String(head.number), hash: head.hash },
    coreAssetsAtomic: String(coreAssets), payerAssetsAtomic: String(payerAssets), providerAssetsAtomic: String(providerAssets),
    payerDebitAtomic: '10003', providerCreditAtomic: '7197', coreIncreaseAtomic: '2806',
    state, solvencyEquality: true };
}
