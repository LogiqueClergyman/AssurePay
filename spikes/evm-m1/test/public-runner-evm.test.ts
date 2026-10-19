import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NATIVE_USDC } from '../src/preflight.js';
import { PUBLIC_EXECUTION_SCOPE, parsePublicConfig, PUBLIC_GAS_CAPS } from '../src/public-config.js';
import { readSession } from '../src/journal.js';
import { recoverPublicRun, runPublicExecution } from '../src/public-runner.js';
import { compileContracts, deploy, startEvm, transact } from './helpers/evm.js';

test('bounded four-step runner and signer-free recovery execute against actual local EVM', async () => {
  const evm = await startEvm();
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-runner-'));
  try {
    const tokenArtifact = compileContracts().AuthorizationTokenMock!;
    const localToken = await deploy(evm, tokenArtifact);
    const code = await evm.publicClient.getCode({ address: localToken });
    // A mock at the native address on Anvil; no actual public USDC evidence.
    await evm.publicClient.request({ method: 'anvil_setCode', params: [NATIVE_USDC, code] });
    await transact(evm, tokenArtifact.abi, NATIVE_USDC, 'mint', [evm.payer.address, 200n]);
    const config = parsePublicConfig({ EXPECTED_PAYER: evm.payer.address, RELAYER_ADDRESS: evm.owner.address,
      PROVIDER_PAYOUT: evm.provider.address, MAX_FEE_PER_GAS_ATOMIC: '3000000000',
      MAX_PRIORITY_FEE_PER_GAS_ATOMIC: '1000000000', MAX_TOTAL_GAS: '3100000', MAX_L1_FEE_WEI: '100000000000000',
      M1_PUBLIC_SCOPE: PUBLIC_EXECUTION_SCOPE, PAYER_PRIVATE_KEY: 'injected-runtime-only', RELAYER_PRIVATE_KEY: 'injected-runtime-only',
    }, { execute: true });
    const ceiling = config.budget.maxTotalGas * config.budget.maxFeePerGasAtomic + config.budget.maxL1FeeWei;
    await evm.publicClient.request({ method: 'anvil_setBalance', params: [evm.owner.address, `0x${ceiling.toString(16)}`] });
    const path = join(directory, 'session');
    const stages: string[] = [];
    const wallet = { ...evm.walletClient,
      async prepareTransactionRequest(request: any) {
        stages.push('prepare');
        try { return await evm.walletClient.prepareTransactionRequest(request); }
        catch { stages.push('prepare-failed'); throw new Error('LOCAL_PREPARE_FAILED'); }
      },
      async signTransaction(request: any) {
        stages.push('sign');
        try { return await evm.walletClient.signTransaction(request); }
        catch { stages.push('sign-failed'); throw new Error('LOCAL_SIGN_FAILED'); }
      },
    };
    const result = await runPublicExecution({ config, payer: evm.payer, relayer: evm.owner,
      client: evm.publicClient, wallet, journalPath: path,
      preflight: async () => ({ ok: true }), receiptPolls: 2, pollDelayMs: 0 });
    const recorded = await readSession(path);
    assert.equal(result.ok, true, JSON.stringify({code:result.code,stages,kinds:recorded.transactions.map(record=>record.kind)}));
    assert.equal(result.transactions.length, 4);
    assert.equal(stages.filter(stage => stage === 'prepare').length, 4);
    assert.equal(stages.filter(stage => stage === 'sign').length, 4);
    const session = await readSession(path);
    assert.equal(session.transactions.length, 4);
    for (const record of session.transactions) {
      const transaction = await evm.publicClient.getTransaction({ hash: record.transactionHash });
      assert.ok(transaction.gas <= PUBLIC_GAS_CAPS[record.kind]);
      assert.ok(transaction.maxFeePerGas <= config.budget.maxFeePerGasAtomic);
      assert.ok(transaction.maxPriorityFeePerGas <= config.budget.maxPriorityFeePerGasAtomic);
      assert.equal(BigInt(record.nonce), BigInt(transaction.nonce));
      assert.equal(transaction.value, 0n);
    }
    const balances = await Promise.all([evm.payer.address, session.transactions.find(r => r.kind === 'success')!.to,
      evm.provider.address].map(address => evm.publicClient.readContract({ address: NATIVE_USDC,
      abi: tokenArtifact.abi, functionName: 'balanceOf', args: [address] })));
    assert.deepEqual(balances, [100n, 7n, 93n]);
    const recovered = await recoverPublicRun(evm.publicClient, path);
    assert.equal(recovered.ok, true, recovered.code);
    const beforeNonce = await evm.publicClient.getTransactionCount({ address: evm.owner.address });
    const repeat = await runPublicExecution({ config,
      payer: { get address() { throw new Error('SIGNER_MUST_NOT_BE_ACCESSED'); } } as any,
      relayer: {} as any, client: evm.publicClient, wallet: {} as any, journalPath: path });
    assert.equal(repeat.ok, true);
    assert.equal(await evm.publicClient.getTransactionCount({ address: evm.owner.address }), beforeNonce);
    const recordPath = join(path, 'transactions', 'success.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.nonce = String(BigInt(record.nonce) + 1n);
    await writeFile(recordPath, `${JSON.stringify(record)}\n`);
    assert.equal((await recoverPublicRun(evm.publicClient, path)).ok, false);
  } finally { await evm.close(); await rm(directory, { recursive: true, force: true }); }
});
