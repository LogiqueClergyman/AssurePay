import assert from 'node:assert/strict';
import test from 'node:test';
import { withReadQueue } from '../src/read-queue.js';

test('read queue makes no eager calls and serializes allowed reads', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const client = {
    async getBlockNumber() {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return calls;
    },
  };

  const queued = withReadQueue(client, { attempts: 1, spacing: 0 });
  assert.equal(calls, 0);
  assert.deepEqual(await Promise.all([
    queued.getBlockNumber(), queued.getBlockNumber(), queued.getBlockNumber(),
  ]), [1, 2, 3]);
  assert.equal(maximum, 1);
});

test('transient allowed read failures retry within the configured bound', async () => {
  let calls = 0;
  const queued = withReadQueue({
    async getChainId() {
      calls += 1;
      if (calls < 3) throw new Error('temporary transport failure');
      return 84532;
    },
  }, { delay: 0, spacing: 0 });

  assert.equal(await queued.getChainId(), 84532);
  assert.equal(calls, 3);
});

test('exhausted read retries propagate the original failure', async () => {
  const failure = new Error('upstream failure');
  let calls = 0;
  const queued = withReadQueue({
    async readContract() {
      calls += 1;
      throw failure;
    },
  }, { attempts: 2, delay: 0, spacing: 0 });

  await assert.rejects(queued.readContract(), error => error === failure);
  assert.equal(calls, 2);
});

test('unknown high-level writes are bound and invoked exactly once after failure', async () => {
  let calls = 0;
  const client = {
    async sendTransaction() {
      calls += 1;
      throw new Error('write failed');
    },
  };
  const queued = withReadQueue(client, { delay: 0, spacing: 0 });

  await assert.rejects(queued.sendTransaction(), /write failed/);
  assert.equal(calls, 1);
});

test('raw write RPC requests bypass the read queue and are never retried', async () => {
  let calls = 0;
  const client = {
    async request(request: { method: string; params?: unknown[] }) {
      calls += 1;
      assert.equal(request.method, 'eth_sendRawTransaction');
      throw new Error('write failed');
    },
  };
  const queued = withReadQueue(client, { delay: 0, spacing: 0 });

  await assert.rejects(queued.request({ method: 'eth_sendRawTransaction', params: ['0xdead'] }), /write failed/);
  assert.equal(calls, 1);
});

test('whitelisted raw reads enter the queue and retry', async () => {
  let calls = 0;
  const queued = withReadQueue({
    async request(request: { method: string; params?: unknown[] }) {
      calls += 1;
      assert.equal(request.method, 'eth_chainId');
      if (calls === 1) throw new Error('temporary transport failure');
      return '0x14a34';
    },
  }, { delay: 0, spacing: 0 });

  assert.equal(await queued.request({ method: 'eth_chainId' }), '0x14a34');
  assert.equal(calls, 2);
});

test('mutating a queued raw request cannot turn a read into a write', async () => {
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const methods: string[] = [];
  const queued = withReadQueue({
    async getBlockNumber() { await blocker; return 1; },
    async request(request: { method: string; params?: unknown[] }) {
      methods.push(request.method);
      return '0x1';
    },
  }, { attempts: 1, spacing: 0 });

  const first = queued.getBlockNumber();
  const request = { method: 'eth_chainId', params: [] as unknown[] };
  const second = queued.request(request);
  request.method = 'eth_sendRawTransaction';
  request.params.push('0xdead');
  release();

  await Promise.all([first, second]);
  assert.deepEqual(methods, ['eth_chainId']);
});

test('accessor-backed raw methods cannot enter the read retry path', async () => {
  let getterCalls = 0;
  let delegatedCalls = 0;
  const request = {
    get method() {
      getterCalls += 1;
      return getterCalls === 1 ? 'eth_chainId' : 'eth_sendRawTransaction';
    },
  };
  const queued = withReadQueue({
    async request(_request: { method?: unknown; params?: unknown }) {
      delegatedCalls += 1;
      throw new Error('must not be retried as a read');
    },
  }, { delay: 0, spacing: 0 });

  await assert.rejects(queued.request(request), { message: 'READ_QUEUE_REQUEST_INVALID' });
  assert.equal(getterCalls, 0);
  assert.equal(delegatedCalls, 0);
});

test('invalid queue limits are rejected', () => {
  assert.throws(() => withReadQueue({}, { attempts: 4 }), { message: 'READ_QUEUE_OPTIONS_INVALID' });
});
