import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, type Address, type Hex } from 'viem';
import { prepareCoreCall } from '../src/call.js';
import { createEvmDriver, type PublicTransactionRecord } from '../src/evm-driver.js';
import { hashIntent, type Intent } from '../src/intent.js';
import { buildRequirements, type ProfileConfiguration } from '../src/profile.js';
import { compileContracts, deploy, signReceive, startEvm, transact } from './helpers/evm.js';

// Actual signing/broadcast test; no signed bytes or payload are included in assertions.
test('opaque driver journals the locally derived hash before one bounded broadcast', async () => {
  const evm = await startEvm();
  try {
    const artifacts = compileContracts();
    const tokenArtifact = artifacts.AuthorizationTokenMock!;
    const token = await deploy(evm, tokenArtifact);
    const id = (part: string) => `0x${part.repeat(32)}` as Hex;
    const core = await deploy(evm, artifacts.AssuranceCoreSpike!, [token, evm.provider.address, id('44'), id('55'), id('66')]);
    await transact(evm, tokenArtifact.abi, token, 'mint', [evm.payer.address, 100n]);
    const configuration: ProfileConfiguration = {
      bindings: { chainId: 84532n, core, token, providerId: id('44'), policyId: id('55'), policyHash: id('66'), requestHash: id('77') },
      providerPayout: evm.provider.address, tokenName: 'USDC', tokenVersion: '2',
    };
    const now = (await evm.publicClient.getBlock()).timestamp as bigint;
    const intent: Intent = { ...configuration.bindings, chainId: '84532', payer: evm.payer.address.toLowerCase() as Address,
      core: core.toLowerCase() as Address, token: token.toLowerCase() as Address,
      gross: '100', payerSalt: id('88'), validAfter: String(now - 1n), validBefore: String(now + 299n) };
    const payment = { x402Version: 2, accepted: buildRequirements(configuration), payload: {
      intent, intentHash: hashIntent(intent), signature: (await signReceive(evm.payer, intent)).signature,
    } };
    const call = await prepareCoreCall(payment, configuration, now);
    const records: PublicTransactionRecord[] = [];
    const driver = createEvmDriver({ publicClient: evm.publicClient, walletClient: evm.walletClient, account: evm.owner,
      gasLimit: 500_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      async beforeBroadcast(record) {
        assert.equal(await evm.publicClient.getTransactionCount({ address: evm.owner.address }), 3);
        records.push(record);
      },
    });
    await driver.simulate(call);
    const prepared = await driver.prepareCall(call);
    assert.deepEqual(Object.keys(prepared).sort(), ['broadcast', 'hash']);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.transaction, prepared.hash);
    assert.equal(records[0]?.intentHash, call.intentHash);
    assert.equal(await driver.getReceipt(prepared.hash), null);
    await assert.rejects(() => driver.prepareCall(call), { message: 'M1_DRIVER_BUSY' });
    await prepared.broadcast();
    await assert.rejects(() => prepared.broadcast(), { message: 'M1_DRIVER_ALREADY_ATTEMPTED' });
    const receipt = await driver.getReceipt(prepared.hash);
    assert.equal(receipt?.status, 'success');
    const tx = await evm.publicClient.getTransaction({ hash: prepared.hash });
    assert.ok(tx.input === call.data);
    assert.equal(tx.gas, 500_000n);
    assert.equal(tx.maxFeePerGas, 3_000_000_000n);
    assert.equal(tx.value, 0n);
    assert.ok(keccak256(tx.input).length === 66);
    const balances = await Promise.all([evm.payer.address, core, evm.provider.address].map(address =>
      evm.publicClient.readContract({ abi: tokenArtifact.abi, address: token, functionName: 'balanceOf', args: [address] })));
    assert.deepEqual(balances, [0n, 7n, 93n]);
  } finally { await evm.close(); }
});

test('driver rejects invalid gas and fee budgets before contacting any RPC or signer', () => {
  const empty = { publicClient: {} as any, walletClient: {} as any, account: { address: '0x1' } as any };
  for (const budget of [
    { gasLimit: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n },
    { gasLimit: 2_000_001n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n },
    { gasLimit: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 2n },
  ]) assert.throws(() => createEvmDriver({ ...empty, ...budget }), { message: 'M1_DRIVER_BUDGET' });
});
