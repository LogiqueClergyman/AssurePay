type ReadQueueOptions = {
  attempts?: number;
  delay?: number;
  spacing?: number;
};

const HIGH_LEVEL_READS = new Set([
  'getChainId', 'getBlock', 'getBlockNumber', 'getCode', 'getBytecode',
  'getBalance', 'getTransactionCount', 'getTransaction',
  'getTransactionReceipt', 'readContract', 'getLogs',
]);

const RPC_READS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call', 'eth_getLogs',
]);

function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]));
    }
  }
  return value;
}

function wait(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
}

export function withReadQueue<T extends object>(client: T, options: ReadQueueOptions = {}): T {
  const attempts = options.attempts ?? 3;
  const delay = options.delay ?? 250;
  const spacing = options.spacing ?? 50;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3 ||
      !Number.isInteger(delay) || delay < 0 || delay > 2_000 ||
      !Number.isInteger(spacing) || spacing < 0 || spacing > 1_000) {
    throw new Error('READ_QUEUE_OPTIONS_INVALID');
  }

  let tail: Promise<void> = Promise.resolve();
  let lastFinished = 0;
  const enqueue = <R>(operation: () => Promise<R>): Promise<R> => {
    const result = tail.then(async () => {
      const remaining = spacing - (Date.now() - lastFinished);
      if (lastFinished !== 0 && remaining > 0) await wait(remaining);
      try {
        return await operation();
      } finally {
        lastFinished = Date.now();
      }
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const runRead = <R>(call: () => Promise<R>): Promise<R> => enqueue(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        if (attempt >= attempts) throw error;
        await wait(delay * attempt);
      }
    }
  });

  return new Proxy(client, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      const bound = member.bind(target);

      if (property === 'request') {
        return (request: { method?: unknown; params?: unknown }, ...rest: unknown[]) => {
          if (!request || typeof request !== 'object') return bound(request, ...rest);
          const methodProperty = Object.getOwnPropertyDescriptor(request, 'method');
          if (!methodProperty) return bound(request, ...rest);
          if (!('value' in methodProperty)) return Promise.reject(new Error('READ_QUEUE_REQUEST_INVALID'));
          const method = methodProperty.value;
          if (typeof method !== 'string' || !RPC_READS.has(method)) return bound(request, ...rest);
          const paramsProperty = Object.getOwnPropertyDescriptor(request, 'params');
          if (paramsProperty && !('value' in paramsProperty)) return Promise.reject(new Error('READ_QUEUE_REQUEST_INVALID'));
          const captured = paramsProperty
            ? { method, params: snapshot(paramsProperty.value) }
            : { method };
          return runRead(() => Promise.resolve(bound(captured, ...snapshot(rest) as unknown[])));
        };
      }

      if (typeof property === 'string' && HIGH_LEVEL_READS.has(property)) {
        return (...args: unknown[]) => {
          const captured = snapshot(args) as unknown[];
          return runRead(() => Promise.resolve(bound(...captured)));
        };
      }

      return bound;
    },
  });
}
