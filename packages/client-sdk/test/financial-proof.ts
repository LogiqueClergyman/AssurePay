import assert from 'node:assert/strict';
import type { createPilotFixture } from '../../developer-pilot/test/helpers.js';
export { verifyProfileSettlement as verifyFirstClientSettlement } from '../../provider-sdk/test/financial-proof.js';

/** Independently anchor every accounting slot and token delta after the three purchases. */
export async function verifyClientAccounting(
  fixture: Awaited<ReturnType<typeof createPilotFixture>>, refunded: boolean,
): Promise<Record<string, unknown>> {
  const { config, artifacts } = fixture;
  const client = fixture.evm.publicClient;
  const head = await client.getBlock({ blockTag: 'latest' });
  const expected = {
    totalProviderStake: 16087n, poolAssets: refunded ? 42328n : 52331n,
    totalLockedStake: refunded ? 7004n : 10506n,
    totalPoolReserved: refunded ? 20006n : 30009n,
    activeCoverageCount: refunded ? 2n : 3n, coverageCount: 3n,
  };
  const state: Record<string, string> = {};
  for (const [name, value] of Object.entries(expected)) {
    const actual = await client.readContract({ address: config.core, abi: artifacts.AssuranceCore.abi,
      functionName: name, blockNumber: head.number });
    assert.equal(actual, value, name); state[name] = String(actual);
  }
  const balance = async (account: string): Promise<bigint> => client.readContract({ address: config.token,
    abi: artifacts.AuthorizationTokenMock.abi, functionName: 'balanceOf', args: [account], blockNumber: head.number });
  const coreAssets = await balance(config.core), payerAssets = await balance(config.roles.payer),
    providerAssets = await balance(config.roles.provider);
  assert.equal(coreAssets, refunded ? 58415n : 68418n);
  assert.equal(payerAssets, refunded ? 119994n : 109991n);
  assert.equal(providerAssets, 21591n);
  assert.equal(coreAssets, expected.totalProviderStake + expected.poolAssets);
  assert.ok(expected.totalProviderStake >= expected.totalLockedStake);
  assert.ok(expected.poolAssets >= expected.totalPoolReserved);
  assert.equal((await client.getBlock({ blockNumber: head.number })).hash, head.hash);
  return { observedBlock: { number: String(head.number), hash: head.hash },
    coreAssetsAtomic: String(coreAssets), payerAssetsAtomic: String(payerAssets),
    providerAssetsAtomic: String(providerAssets), state, solvencyEquality: true };
}
