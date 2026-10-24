import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toBytes, type Hex } from 'viem';
import { test } from 'node:test';
import { createReadModel } from '../src/reads.js';
import { hashIntent, hashPolicy, signReceive, solidityIntent, transact } from '../../evm-core/test/helpers/evm.js';
import type { Intent } from '../../evm-core/test/helpers/intent.js';
import { createProtocolFixture } from './helpers.js';

async function withReadModel(fn: (f: Awaited<ReturnType<typeof createProtocolFixture>>, directory: string) => Promise<void>) {
  const f = await createProtocolFixture();
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-m11-read-'));
  try { await fn(f, directory); }
  finally { await rm(directory, { recursive: true, force: true }); await f.close(); }
}

test('canonical snapshot reads actual Core/token state and sanitizes opened/finalized coverage data', async () => {
  await withReadModel(async (f, directory) => {
    const { evm, config, artifacts, accounts } = f;
    const head = await evm.publicClient.getBlock({ blockTag: 'latest' });
    const policyHash = hashPolicy({ providerId: config.pilot.providerId, policyId: config.pilot.policyId,
      providerOwner: accounts.provider.address, providerPayout: accounts.provider.address,
      premiumBps: 777, stakeBps: 3500, withholdingBps: 2200, duration: 3600n, poolOnlyAllowed: true });
    const intent: Intent = {
      chainId: '84532', core: config.pilot.core, token: config.pilot.token, payer: accounts.payer.address,
      providerId: config.pilot.providerId, policyId: config.pilot.policyId, policyHash,
      requestHash: keccak256(toBytes('m11-read-test-request')), gross: config.pilot.gross,
      payerSalt: keccak256(toBytes('m11-read-test-salt')), validAfter: String(head.timestamp - 1n),
      validBefore: String(head.timestamp + 250n),
    };
    const signature = await signReceive(accounts.payer, intent);
    await transact(evm, artifacts.AssuranceCore.abi, config.pilot.core, 'settleAssured',
      [solidityIntent(intent), signature.v, signature.r, signature.s], accounts.relayer);
    const coverageId = hashIntent(intent);
    assert.ok(coverageId);

    const evidenceHash = keccak256(toBytes('private evidence content digest'));
    await transact(evm, artifacts.AssuranceCore.abi, config.pilot.core, 'fileClaim', [coverageId, evidenceHash], accounts.payer);
    const missingCoverageLogs = new Proxy(evm.publicClient, { get(target, property, receiver) {
      if (property === 'getLogs') return async (args: any) => {
        if (args.event?.name === 'CoverageOpened') return [];
        return target.getLogs(args);
      };
      return Reflect.get(target, property, receiver);
    } });
    const mismatchModel = createReadModel({ config, client: missingCoverageLogs, directory: join(directory, 'coverage-count-mismatch') });
    await assert.rejects(mismatchModel.snapshot(), { message: 'PROTOCOL_STATE_UNAVAILABLE' });

    const model = createReadModel({ config, client: evm.publicClient, directory });
    const pending = await model.snapshot();
    assert.equal(pending.summary.coverageCount, '1');
    assert.equal(pending.summary.activeCoverageCount, '1');
    assert.deepEqual(pending.summary.solvency, {
      balanceCoversAssetsAndStake: true, stakeCoversLocks: true, poolCoversReservations: true,
    });
    assert.equal(pending.providers.length, 1);
    assert.equal(pending.providers[0]?.payoutBalanceAtomic, '107197');
    assert.equal(pending.providers[0]?.cumulativeNetPaidAtomic, '7197');
    assert.equal(pending.policies[0]?.policyId, config.pilot.policyId);
    const row = pending.coverages.find(item => item.coverageId === coverageId)!;
    assert.equal(row.status, 2);
    assert.equal(row.hasEvidence, true);
    assert.equal('evidenceHash' in row, false);
    assert.equal('decisionHash' in row, false);
    assert.equal('requestHash' in row, false);
    assert.equal('outcome' in row, false);
    await model.assertAnchor(pending.anchor);

    const decisionHash = keccak256(toBytes('private decision commitment'));
    await transact(evm, artifacts.AssuranceCore.abi, config.pilot.core, 'finalizeClaim', [coverageId, 0, 0n, decisionHash], accounts.adjudicator);
    const finalized = await model.snapshot();
    const finalRow = finalized.coverages.find(item => item.coverageId === coverageId)!;
    assert.equal(finalRow.status, 4);
    assert.equal(finalRow.outcome, 0);
    assert.equal(finalRow.refundAmount, '0');
    assert.equal('decisionHash' in finalRow, false);
  });
});

test('read model rejects a configured admin that differs from canonical Core identity', async () => {
  await withReadModel(async (f, directory) => {
    const wrongConfig = { ...f.config, admin: '0x00000000000000000000000000000000000000ab' as const };
    const model = createReadModel({ config: wrongConfig, client: f.evm.publicClient, directory });
    await assert.rejects(model.snapshot(), { message: 'PROTOCOL_CONTEXT_MISMATCH' });
  });
});

test('read model fails closed on unavailable registry RPC and changed anchor', async () => {
  await withReadModel(async (f, directory) => {
    const linkedDirectory = join(directory, 'linked');
    await symlink(directory, linkedDirectory, 'dir');
    const linkedModel = createReadModel({ config: f.config, client: f.evm.publicClient, directory: linkedDirectory });
    await assert.rejects(linkedModel.snapshot(), { message: 'PROTOCOL_STORAGE_INVALID' });

    const broken = new Proxy(f.evm.publicClient, { get(target, property, receiver) {
      if (property === 'getLogs') return async () => { throw new Error('private RPC detail must not escape'); };
      return Reflect.get(target, property, receiver);
    } });
    const model = createReadModel({ config: f.config, client: broken, directory });
    await assert.rejects(model.snapshot(), { message: 'PROTOCOL_RPC_UNAVAILABLE' });

    const outOfRange = new Proxy(f.evm.publicClient, { get(target, property, receiver) {
      if (property === 'getLogs') return async (args: any) => {
        const logs = await target.getLogs(args);
        if (!Array.isArray(logs) || logs.length === 0) return logs;
        return [{ ...logs[0], blockNumber: BigInt(args.fromBlock) - 1n }, ...logs.slice(1)];
      };
      return Reflect.get(target, property, receiver);
    } });
    const badLogModel = createReadModel({ config: f.config, client: outOfRange, directory: join(directory, 'bad-log') });
    await assert.rejects(badLogModel.snapshot(), { message: 'PROTOCOL_STATE_UNAVAILABLE' });

    const wrongChain = new Proxy(f.evm.publicClient, { get(target, property, receiver) {
      if (property === 'getChainId') return async () => 1;
      return Reflect.get(target, property, receiver);
    } });
    const wrongChainModel = createReadModel({ config: f.config, client: wrongChain, directory: join(directory, 'wrong-chain') });
    await assert.rejects(wrongChainModel.snapshot(), { message: 'PROTOCOL_CONTEXT_MISMATCH' });

    const overCap = new Proxy(f.evm.publicClient, { get(target, property, receiver) {
      if (property === 'getLogs') return async (args: any) => {
        const logs = await target.getLogs(args);
        if (logs.length === 0) return logs;
        return Array.from({ length: 101 }, (_, index) => ({ ...logs[0],
          args: { ...logs[0].args, providerId: `0x${(index + 1).toString(16).padStart(64, '0')}` },
          transactionHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
          transactionIndex: index, logIndex: index,
        }));
      };
      return Reflect.get(target, property, receiver);
    } });
    const overCapModel = createReadModel({ config: f.config, client: overCap, directory: join(directory, 'over-cap') });
    await assert.rejects(overCapModel.snapshot(), { message: 'PROTOCOL_LIMIT' });

    const ok = createReadModel({ config: f.config, client: f.evm.publicClient, directory: join(directory, 'second') });
    const snapshot = await ok.snapshot();
    await f.evm.publicClient.request({ method: 'anvil_reorg', params: [{ depth: 1, txBlock: 1 }] }).catch(() => undefined);
    // The explicit assertion also validates rejection of a caller-supplied hash that cannot anchor.
    const badAnchor = { ...snapshot.anchor, hash: `0x${'ff'.repeat(32)}` as Hex };
    await assert.rejects(ok.assertAnchor(badAnchor), { message: 'PROTOCOL_REORG' });

    const actualHead = await f.evm.publicClient.getBlock({ blockTag: 'latest' });
    const futureNumber = BigInt(f.config.pilot.deploymentBlock) + 25_000n;
    const overRangeClient = new Proxy(f.evm.publicClient, { get(target, property, receiver) {
      if (property === 'getBlock') return async (args: any) => args.blockTag === 'latest'
        ? { ...actualHead, number: futureNumber }
        : target.getBlock(args);
      if (property === 'getBytecode') return async (args: any) => target.getBytecode({ address: args.address });
      if (property === 'readContract') return async (args: any) => target.readContract({ ...args, blockNumber: undefined });
      return Reflect.get(target, property, receiver);
    } });
    const overRangeModel = createReadModel({ config: f.config, client: overRangeClient, directory: join(directory, 'over-range') });
    await assert.rejects(overRangeModel.snapshot(), { message: 'PROTOCOL_LIMIT' });
  });
});
