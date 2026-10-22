import assert from 'node:assert/strict';
import test from 'node:test';
import { deploy, startEvm, transact, compileContracts } from '../../evm-core/test/helpers/evm.js';
import { withLogChunks } from '../src/log-chunks.js';

test('contiguous chunks include every boundary and preserve the complete filter', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const queued = withLogChunks({
    calls,
    async getLogs(filter: Record<string, unknown>) {
      this.calls.push(filter);
      return [filter.fromBlock];
    },
  }, 4);
  const filter = { address: '0xabc', fromBlock: 9n, toBlock: 18n, topics: ['0x123'], strict: true };

  assert.deepEqual(await queued.getLogs(filter), [9n, 13n, 17n]);
  assert.deepEqual(calls, [
    { ...filter, toBlock: 12n },
    { ...filter, fromBlock: 13n, toBlock: 16n },
    { ...filter, fromBlock: 17n },
  ]);
});

test('arguments are snapshotted synchronously before the first chunk is awaited', async () => {
  const observed: Array<Record<string, unknown>> = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = withLogChunks({
    async getLogs(filter: Record<string, unknown>) {
      observed.push(filter);
      if (observed.length === 1) await gate;
      return [];
    },
  }, 2);
  const filter = { fromBlock: 1n, toBlock: 4n, topics: ['before'] };
  const pending = queued.getLogs(filter);
  filter.fromBlock = 100n;
  filter.topics[0] = 'after';
  release();
  await pending;

  assert.deepEqual(observed, [
    { fromBlock: 1n, toBlock: 2n, topics: ['before'] },
    { fromBlock: 3n, toBlock: 4n, topics: ['before'] },
  ]);
});

test('reversed ranges and excessive total chunks reject before any RPC call', async () => {
  let calls = 0;
  const queued = withLogChunks({ async getLogs(_filter: unknown) { calls += 1; return []; } }, 1);

  await assert.rejects(queued.getLogs({ fromBlock: 2n, toBlock: 1n }), { message: 'LOG_CHUNKS_RANGE_INVALID' });
  await assert.rejects(queued.getLogs({ fromBlock: -1n, toBlock: 1n }), { message: 'LOG_CHUNKS_RANGE_INVALID' });
  await assert.rejects(queued.getLogs({ fromBlock: 0n, toBlock: 1_000n }), { message: 'LOG_CHUNKS_LIMIT_EXCEEDED' });
  assert.equal(calls, 0);
});

test('a failed chunk rejects the full query and stops before later chunks', async () => {
  const failure = new Error('chunk failed');
  let calls = 0;
  const queued = withLogChunks({
    async getLogs(_filter: unknown) {
      calls += 1;
      if (calls === 2) throw failure;
      return [`chunk-${calls}`];
    },
  }, 2);

  await assert.rejects(queued.getLogs({ fromBlock: 0n, toBlock: 5n }), error => error === failure);
  assert.equal(calls, 2);
});

test('block-hash and tag queries pass through once, and other methods remain bound', async () => {
  const calls: unknown[] = [];
  const client = {
    marker: 'bound',
    async getLogs(filter: unknown) { calls.push(filter); return ['one']; },
    getChainId() { return this.marker; },
  };
  const queued = withLogChunks(client, 1);

  assert.deepEqual(await queued.getLogs({ blockHash: `0x${'11'.repeat(32)}` }), ['one']);
  assert.deepEqual(await queued.getLogs({ fromBlock: 'earliest', toBlock: 'latest' }), ['one']);
  assert.deepEqual(calls, [
    { blockHash: `0x${'11'.repeat(32)}` },
    { fromBlock: 'earliest', toBlock: 'latest' },
  ]);
  assert.equal(queued.getChainId(), 'bound');
});

test('chunked logs equal an unchunked query on an actual local EVM', async () => {
  const evm = await startEvm();
  try {
    const artifact = compileContracts().AuthorizationTokenMock;
    const token = await deploy(evm, artifact);
    await transact(evm, artifact.abi, token, 'mint', [evm.owner.address, 11n]);
    await transact(evm, artifact.abi, token, 'mint', [evm.owner.address, 13n]);
    const toBlock = await evm.publicClient.getBlockNumber();
    const filter = { address: token, fromBlock: 0n, toBlock };
    const expected = await evm.publicClient.getLogs(filter);
    const actual = await withLogChunks(evm.publicClient, 1).getLogs(filter);

    assert.deepEqual(actual, expected);
    assert.equal(actual.length, 2);
  } finally {
    await evm.close();
  }
});

test('chunk size is bounded', () => {
  assert.throws(() => withLogChunks({}, 101), { message: 'LOG_CHUNKS_INVALID_LIMIT' });
});
