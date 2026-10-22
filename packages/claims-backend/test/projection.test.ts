import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjection } from '../src/projection.js';
import type { BackendContext } from '../src/types.js';
import { fixture } from '../../evm-core/test/helpers/fixture.js';
import { transact } from '../../evm-core/test/helpers/evm.js';

async function tempDirectory() { return mkdtemp(join(tmpdir(), 'assurepay-projection-')); }
function context(f: Awaited<ReturnType<typeof fixture>>): BackendContext {
  return { chainId: 84532, core: f.core.toLowerCase() as `0x${string}`,
    token: f.token.toLowerCase() as `0x${string}`, adjudicator: f.evm.outsider.address.toLowerCase() as `0x${string}`,
    serviceId: `0x${'45'.repeat(32)}` as `0x${string}` };
}
function projection(f: Awaited<ReturnType<typeof fixture>>, journalPath: string, overrides: Record<string, unknown> = {}) {
  return createProjection({ client: f.evm.publicClient, context: context(f), journalPath, fromBlock: 0n, ...overrides } as any);
}
async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message === code);
}

test('rebuilds canonical M2 coverage state after restart and drops reverted claim/decision branches', async () => {
  const f = await fixture();
  const directory = await tempDirectory();
  const journalPath = join(directory, 'projection.json');
  try {
    const p = projection(f, journalPath);
    const empty = await p.refresh();
    assert.deepEqual(Object.keys(empty.coverages), []);

    const intent = await f.createIntent({ gross: 10_003n });
    const snapshotId = await f.evm.publicClient.request({ method: 'evm_snapshot', params: [] }) as string;
    await f.settle(intent);
    await transact(f.evm, f.coreAbi, f.core, 'fileClaim',
      [intent.coverageId, `0x${'31'.repeat(32)}`], f.evm.payer);
    await transact(f.evm, f.coreAbi, f.core, 'finalizeClaim',
      [intent.coverageId, 2, 1n, `0x${'32'.repeat(32)}`], f.evm.outsider);

    const resolved = await p.refresh();
    const resolvedCoverage = resolved.coverages[intent.coverageId];
    assert.ok(resolvedCoverage);
    assert.equal(resolvedCoverage.status, 3);
    assert.equal(resolvedCoverage.evidenceHash, `0x${'31'.repeat(32)}`);
    assert.equal(resolvedCoverage.decisionHash, `0x${'32'.repeat(32)}`);
    const persistedBeforeRestart = await readFile(journalPath, 'utf8');

    // A fresh projection object represents a backend process restart; it reconstructs from chain.
    const afterRestart = await projection(f, journalPath).refresh();
    assert.deepEqual(afterRestart, resolved);
    assert.notEqual(await readFile(journalPath, 'utf8'), '');

    assert.equal(await f.evm.publicClient.request({ method: 'evm_revert', params: [snapshotId] }), true);
    const reverted = await p.refresh();
    assert.deepEqual(Object.keys(reverted.coverages), []);
    const checkpointAfterRevert = await readFile(journalPath, 'utf8');
    assert.notEqual(checkpointAfterRevert, persistedBeforeRestart);

    // Reopen the same intent on an alternative branch. Its canonical opening anchor is new.
    await transact(f.evm, f.coreAbi, f.core, 'setPaused', [true], f.evm.owner);
    await transact(f.evm, f.coreAbi, f.core, 'setPaused', [false], f.evm.owner);
    await f.settle(intent);
    const reopened = await projection(f, journalPath).refresh();
    const reopenedCoverage = reopened.coverages[intent.coverageId];
    assert.ok(reopenedCoverage);
    assert.equal(reopenedCoverage.status, 1);
    assert.notDeepEqual(reopenedCoverage.opening, resolvedCoverage.opening);
    assert.equal(reopenedCoverage.evidenceHash, `0x${'00'.repeat(32)}`);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('wrong context, bounded scans, RPC failures, and malformed checkpoints fail closed without replacing committed data', async () => {
  const f = await fixture();
  const directory = await tempDirectory();
  const journalPath = join(directory, 'projection.json');
  try {
    const good = projection(f, journalPath);
    const committed = await good.refresh();
    const intent = await f.createIntent();
    await f.settle(intent);
    const withCoverage = await good.refresh();
    assert.ok(withCoverage.coverages[intent.coverageId]);
    const committedBytes = await readFile(journalPath, 'utf8');

    const wrongContext = context(f);
    wrongContext.adjudicator = f.evm.provider.address.toLowerCase() as `0x${string}`;
    const contextProjection = createProjection({ client: f.evm.publicClient, context: wrongContext,
      journalPath: join(directory, 'wrong-context.json'), fromBlock: 0n });
    await expectCode(contextProjection.refresh(), 'PROJECTION_CONTEXT_MISMATCH');

    const limited = projection(f, journalPath, { maxBlocks: 1 });
    await expectCode(limited.refresh(), 'PROJECTION_BLOCK_LIMIT');
    assert.equal(await readFile(journalPath, 'utf8'), committedBytes);

    const mismatchedClient = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'getBlock') return async (args: any) => {
        const block = await target.getBlock(args);
        return args.blockNumber === undefined ? block : { ...block, hash: `0x${'00'.repeat(32)}` };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const mismatchProjection = createProjection({ client: mismatchedClient, context: context(f), journalPath, fromBlock: 0n });
    await expectCode(mismatchProjection.refresh(), 'PROJECTION_CANONICAL_MISMATCH');
    assert.equal(await readFile(journalPath, 'utf8'), committedBytes);

    const failingClient = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'getLogs') return async () => { throw new Error('sensitive rpc detail'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const rpcProjection = createProjection({ client: failingClient, context: context(f), journalPath, fromBlock: 0n });
    await expectCode(rpcProjection.refresh(), 'PROJECTION_RPC_FAILED');
    assert.equal(await readFile(journalPath, 'utf8'), committedBytes);

    await (await import('node:fs/promises')).writeFile(journalPath, '{broken');
    await expectCode(good.refresh(), 'PROJECTION_CHECKPOINT_INVALID');
    assert.equal(await readFile(journalPath, 'utf8'), '{broken');
    assert.equal(Object.keys(committed.coverages).length, 0);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the numbered scan head when a new canonical block arrives during refresh', async () => {
  const f = await fixture();
  const directory = await tempDirectory();
  const journalPath = join(directory, 'projection.json');
  try {
    const initial = await f.evm.publicClient.getBlock({ blockTag: 'latest' });
    let mined = false;
    const advancingClient = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'getLogs') return async (args: any) => {
        if (!mined) {
          mined = true;
          await target.request({ method: 'evm_mine', params: [] });
        }
        return target.getLogs(args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });

    const snapshot = await createProjection({ client: advancingClient, context: context(f), journalPath, fromBlock: 0n }).refresh();
    const latest = await f.evm.publicClient.getBlock({ blockTag: 'latest' });
    assert.equal(mined, true);
    assert.ok(latest.number > initial.number);
    assert.equal(snapshot.head.number, initial.number.toString());
    assert.equal(snapshot.head.hash, initial.hash);
    assert.equal(Object.keys(snapshot.coverages).length, 0);
    assert.notEqual(await readFile(journalPath, 'utf8'), '');
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a reorg of the numbered scan head and preserves the previous checkpoint', async () => {
  const f = await fixture();
  const directory = await tempDirectory();
  const journalPath = join(directory, 'projection.json');
  try {
    const good = projection(f, journalPath);
    await good.refresh();
    const committedBytes = await readFile(journalPath, 'utf8');
    const beforeHead = await f.evm.publicClient.getBlock({ blockTag: 'latest' });
    const snapshotId = await f.evm.publicClient.request({ method: 'evm_snapshot', params: [] }) as string;
    await f.evm.publicClient.request({ method: 'evm_mine', params: [] });
    const scanHead = await f.evm.publicClient.getBlock({ blockTag: 'latest' });
    assert.ok(scanHead.number > beforeHead.number);

    let replaced = false;
    const reorgingClient = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'getLogs') return async (args: any) => {
        if (!replaced) {
          replaced = true;
          assert.equal(await target.request({ method: 'evm_revert', params: [snapshotId] }), true);
          await target.request({ method: 'evm_increaseTime', params: [1] });
          await target.request({ method: 'evm_mine', params: [] });
        }
        return target.getLogs(args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });

    const replacementProjection = createProjection({ client: reorgingClient, context: context(f), journalPath, fromBlock: 0n });
    await expectCode(replacementProjection.refresh(), 'PROJECTION_HEAD_CHANGED');
    const replacementHead = await f.evm.publicClient.getBlock({ blockNumber: scanHead.number });
    assert.equal(replaced, true);
    assert.ok(replacementHead.hash);
    assert.notEqual(replacementHead.hash, scanHead.hash);
    assert.equal(await readFile(journalPath, 'utf8'), committedBytes);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
