import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import { createEvmDriver } from '../src/evm-driver.js';
import { createRegisteredFlow } from '../src/flow.js';
import type { Intent } from '../src/intent.js';
import { verifySettlement } from '../src/receipt.js';
import { type ProfileConfiguration } from '../src/profile.js';
import { compileContracts, deploy, startEvm, transact } from './helpers/evm.js';

async function fixture() {
  const evm = await startEvm();
  try {
    const artifacts = compileContracts();
    const tokenArtifact = artifacts.AuthorizationTokenMock!;
    const coreArtifact = artifacts.AssuranceCoreSpike!;
    const token = await deploy(evm, tokenArtifact);
    const id = (part: string) => `0x${part.repeat(32)}` as Hex;
    const core = await deploy(evm, coreArtifact, [token, evm.provider.address, id('44'), id('55'), id('66')]);
    await transact(evm, tokenArtifact.abi, token, 'mint', [evm.payer.address, 100n]);
    const configuration: ProfileConfiguration = {
      bindings: { chainId: 84532n, core, token, providerId: id('44'), policyId: id('55'), policyHash: id('66'), requestHash: id('77') },
      providerPayout: evm.provider.address, tokenName: 'USDC', tokenVersion: '2',
    };
    let prepares = 0;
    let broadcasts = 0;
    let explicitVerifications = 0;
    let receiptsHidden = false;
    let loseBroadcastResponse = false;
    const journal: Hex[] = [];
    const baseDriver = createEvmDriver({ publicClient: evm.publicClient, walletClient: evm.walletClient, account: evm.owner,
      gasLimit: 500_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      async beforeBroadcast(record) { journal.push(record.transaction); },
    });
    const driver = { ...baseDriver,
      async simulate(call: Parameters<typeof baseDriver.simulate>[0]) {
        explicitVerifications++;
        return baseDriver.simulate(call);
      },
      async prepareCall(call: Parameters<typeof baseDriver.prepareCall>[0]) {
        prepares++;
        const prepared = await baseDriver.prepareCall(call);
        return { hash: prepared.hash, async broadcast() {
          broadcasts++;
          await prepared.broadcast();
          if (loseBroadcastResponse) throw new Error('SIMULATED_LOST_RESPONSE');
        } };
      },
      async getReceipt(hash: Hex) { return receiptsHidden ? null : baseDriver.getReceipt(hash); },
      async verifySuccess(receipt: { transactionHash: Hex }, call: Parameters<typeof baseDriver.simulate>[0], payment: { intent: Intent }) {
        const result = await verifySettlement(evm.publicClient, { call, configuration, intent: payment.intent,
          relayer: evm.owner.address, transaction: receipt.transactionHash, minimumConfirmations: 1n });
        if (result.code === 'READ_FAILED') throw new Error('M1_VERIFY_UNAVAILABLE');
        return result.ok;
      },
    };
    const flow = await createRegisteredFlow({ configuration, driver,
      payer: { address: evm.payer.address, signTypedData: typed => evm.payer.signTypedData(typed) },
      createSalt: () => `0x${randomBytes(32).toString('hex')}`,
    });
    const read = (address: Address, abi: any, functionName: string, args: readonly unknown[] = []) =>
      evm.publicClient.readContract({ address, abi, functionName, args });
    return { evm, flow, core, token, coreArtifact, tokenArtifact, configuration, journal,
      async balances() { return Promise.all([evm.payer.address, core, evm.provider.address].map(address => read(token, tokenArtifact.abi, 'balanceOf', [address]))); },
      counts: () => ({ prepares, broadcasts, explicitVerifications }),
      hideReceipts(value: boolean) { receiptsHidden = value; },
      loseResponse(value: boolean) { loseBroadcastResponse = value; }, read,
    };
  } catch (error) { await evm.close(); throw error; }
}

test('registered real x402 client/server/self-hosted facilitator settles before service on EVM', async () => {
  const f = await fixture();
  try {
    const payment = await f.flow.purchase();
    const explicit = await f.flow.facilitator.verify(payment, f.flow.requirements);
    assert.equal(explicit.isValid, true);
    const beforeServerVerify = f.counts().explicitVerifications;
    const serverVerified = await f.flow.server.verifyPayment(payment, f.flow.requirements);
    assert.equal(serverVerified.isValid, true);
    assert.equal(f.counts().explicitVerifications, beforeServerVerify, 'upfront SDK verify skips facilitator verify');
    assert.deepEqual(await f.balances(), [100n, 0n, 0n]);
    let serviceExecutions = 0;
    const settled = await f.flow.settleBeforeService(payment);
    assert.equal(settled.success, true);
    if (settled.success) serviceExecutions++;
    assert.equal(serviceExecutions, 1);
    assert.deepEqual(await f.balances(), [0n, 7n, 93n]);
    assert.equal(await f.read(f.core, f.coreArtifact.abi, 'coverageCount'), 1n);
    assert.equal(f.counts().prepares, 1);
    assert.equal(f.counts().broadcasts, 1);
    assert.equal(f.journal[0], settled.transaction);
    const repeated = await f.flow.settleBeforeService(payment);
    assert.equal(repeated.success, true);
    assert.equal(repeated.transaction, settled.transaction);
    assert.equal(f.counts().broadcasts, 1);
  } finally { await f.evm.close(); }
});

test('registered settlement rejects post-verify mutation and failed admission before broadcast', async () => {
  const f = await fixture();
  try {
    const payment = await f.flow.purchase();
    assert.equal((await f.flow.facilitator.verify(payment, f.flow.requirements)).isValid, true);
    const changed = structuredClone(payment);
    (changed.payload.intent as Record<string, unknown>).gross = '101';
    assert.equal((await f.flow.settleBeforeService(changed)).success, false);
    await transact(f.evm, f.coreArtifact.abi, f.core, 'setAdmissionEnabled', [false]);
    const result = await f.flow.settleBeforeService(payment);
    assert.equal(result.success, false);
    assert.equal(f.counts().broadcasts, 0);
    assert.deepEqual(await f.balances(), [100n, 0n, 0n]);
    assert.equal(await f.read(f.core, f.coreArtifact.abi, 'coverageCount'), 0n);
  } finally { await f.evm.close(); }
});

test('lost submission response and expired pending retry reconcile one existing EVM transaction', async () => {
  const f = await fixture();
  try {
    const payment = await f.flow.purchase();
    f.hideReceipts(true); f.loseResponse(true);
    const first = await f.flow.settleBeforeService(payment);
    assert.equal(first.success, false);
    assert.ok(/^0x[0-9a-f]{64}$/.test(first.transaction));
    assert.deepEqual(await f.balances(), [0n, 7n, 93n]);
    const intent = payment.payload.intent as Intent;
    await f.evm.publicClient.request({ method: 'evm_setNextBlockTimestamp', params: [Number(BigInt(intent.validBefore) + 1n)] });
    await f.evm.publicClient.request({ method: 'evm_mine', params: [] });
    f.hideReceipts(false);
    const recovered = await f.flow.settleBeforeService(payment);
    assert.equal(recovered.success, true);
    assert.equal(recovered.transaction, first.transaction);
    assert.equal(f.counts().prepares, 1);
    assert.equal(f.counts().broadcasts, 1);
    assert.equal(await f.read(f.core, f.coreArtifact.abi, 'coverageCount'), 1n);
  } finally { await f.evm.close(); }
});
