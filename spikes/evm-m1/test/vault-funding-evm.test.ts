import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startEvm } from './helpers/evm.js';
import { runVaultFunding, createFundingSigner, FUNDING_TARGET, type FundingClient, type FundingSigner } from '../src/vault-funding.js';
import { readFundingSession } from '../src/vault-storage.js';

async function fixture() {
  const evm = await startEvm();
  const root = await mkdtemp(join(tmpdir(), 'assurepay-vault-evm-'));
  try {
    const relayer = evm.owner, vault = evm.outsider;
    const initial = 100_000_000_000_000_000n;
    await evm.publicClient.request({ method: 'anvil_setBalance', params: [relayer.address, `0x${initial.toString(16)}`] });
    await evm.publicClient.request({ method: 'anvil_setBalance', params: [vault.address, '0x0'] });
    await evm.publicClient.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: ['0x4c4b40'] });
    await evm.publicClient.request({ method: 'evm_mine', params: [] });
    let broadcasts = 0, signatures = 0, hide = false, lose = false;
    const client: FundingClient = {
      getChainId: () => evm.publicClient.getChainId(),
      getBalance: args => evm.publicClient.getBalance(args),
      getCode: args => evm.publicClient.getCode(args),
      getTransactionCount: args => evm.publicClient.getTransactionCount(args),
      getBlock: args => evm.publicClient.getBlock(args),
      // Local Anvil has no Base fee oracle; actual public CLI requires the real oracle.
      estimateL1FeeUpperBound: async () => 0n,
      async sendRawTransaction(raw) {
        broadcasts++;
        const hash = await evm.publicClient.sendRawTransaction({ serializedTransaction: raw });
        if (lose) throw new Error('LOCAL_SIMULATED_LOST_BROADCAST_RESPONSE');
        return hash;
      },
      async getTransactionReceipt(hash) {
        if (hide) return null;
        try { return await evm.publicClient.getTransactionReceipt({ hash }); } catch { return null; }
      },
      async getTransaction(hash) {
        try { const tx = await evm.publicClient.getTransaction({ hash }); return { ...tx, data: tx.input, serialized: '0x' }; }
        catch { return null; }
      },
    };
    const countSigner = (signer: FundingSigner): FundingSigner => ({ address: signer.address,
      async signTransaction(tx) { signatures++; return signer.signTransaction(tx); },
    });
    const options = { client, relayer: countSigner(createFundingSigner(relayer)), vault: countSigner(createFundingSigner(vault)),
      expectedRelayer: relayer.address, expectedVault: vault.address, journalPath: join(root, 'funding'),
      execute: true, pollAttempts: 1, pollDelayMs: 0 };
    const run = async (overrides: Partial<typeof options> = {}) => {
      try { return await runVaultFunding({ ...options, ...overrides }); }
      catch (error) {
        const message = error instanceof Error && /^M1_VAULT_FUNDING_[A-Z_]+$/.test(error.message)
          ? error.message : 'LOCAL_VAULT_OPERATION_FAILED';
        throw new Error(message);
      }
    };
    return { evm, root, relayer, vault, initial, options, run,
      counts: () => ({ broadcasts, signatures }),
      hide(value: boolean) { hide = value; }, lose(value: boolean) { lose = value; },
      close: async () => { await evm.close(); await rm(root, { recursive: true, force: true }); },
    };
  } catch { await evm.close(); await rm(root, { recursive: true, force: true }); throw new Error('LOCAL_VAULT_SETUP_FAILED'); }
}

test('vault excess transfer and measured shortfall top-up execute exactly once on EVM', async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    assert.equal(result.state, 'complete', result.code);
    assert.equal(result.relayerBalanceWei, FUNDING_TARGET.toString());
    assert.equal(result.transactions.length, 2);
    assert.deepEqual(f.counts(), { broadcasts: 2, signatures: 2 });
    const session = await readFundingSession(f.options.journalPath);
    const excess = session.prepared.find(record => record.kind === 'excess')!;
    const topup = session.prepared.find(record => record.kind === 'top-up')!;
    assert.equal(BigInt(excess.valueWei), f.initial - FUNDING_TARGET);
    const receipt1 = await f.evm.publicClient.getTransactionReceipt({ hash: excess.transactionHash });
    const receipt2 = await f.evm.publicClient.getTransactionReceipt({ hash: topup.transactionHash });
    const fee1 = BigInt(receipt1.gasUsed) * BigInt(receipt1.effectiveGasPrice);
    const fee2 = BigInt(receipt2.gasUsed) * BigInt(receipt2.effectiveGasPrice);
    assert.equal(BigInt(topup.valueWei), fee1);
    assert.equal(BigInt(result.vaultBalanceWei), f.initial - FUNDING_TARGET - fee1 - fee2);
    const again = await f.run();
    assert.equal(again.state, 'complete');
    assert.deepEqual(f.counts(), { broadcasts: 2, signatures: 2 });
    const check = await f.run({ execute: false });
    assert.equal(check.state, 'complete');
    assert.deepEqual(f.counts(), { broadcasts: 2, signatures: 2 });
  } finally { await f.close(); }
});

test('lost excess response recovers one recorded hash then signs only the missing top-up', async () => {
  const f = await fixture();
  try {
    f.hide(true); f.lose(true);
    const first = await f.run();
    assert.equal(first.state, 'pending');
    assert.deepEqual(f.counts(), { broadcasts: 1, signatures: 1 });
    f.hide(false); f.lose(false);
    const recovered = await f.run();
    assert.equal(recovered.state, 'complete', recovered.code);
    assert.equal(recovered.transactions[0], first.transactions[0]);
    assert.deepEqual(f.counts(), { broadcasts: 2, signatures: 2 });
  } finally { await f.close(); }
});

test('balance change while signing stops funding before broadcasting', async () => {
  const f = await fixture();
  try {
    const original = f.options.relayer;
    const relayer: FundingSigner = { address: original.address, async signTransaction(tx) {
      const signed = await original.signTransaction(tx);
      await f.evm.publicClient.request({ method: 'anvil_setBalance', params: [original.address, `0x${(f.initial + 1n).toString(16)}`] });
      return signed;
    } };
    await assert.rejects(f.run({ relayer }), /M1_VAULT_FUNDING_STATE_CHANGED/);
    assert.deepEqual(f.counts(), { broadcasts: 0, signatures: 1 });
    assert.equal((await readFundingSession(f.options.journalPath)).prepared.length, 0);
  } finally { await f.close(); }
});
