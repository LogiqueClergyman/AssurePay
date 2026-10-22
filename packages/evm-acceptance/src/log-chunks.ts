type LogFilter = {
  fromBlock?: unknown;
  toBlock?: unknown;
  blockHash?: unknown;
  [key: string]: unknown;
};

function cloneArgs(args: unknown[]): unknown[] {
  try {
    return structuredClone(args);
  } catch {
    throw new Error('LOG_CHUNKS_ARGUMENTS_INVALID');
  }
}

export function withLogChunks<T extends object>(client: T, maxBlocks = 100): T {
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 100) {
    throw new Error('LOG_CHUNKS_INVALID_LIMIT');
  }

  return new Proxy(client, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      const bound = member.bind(target);
      if (property !== 'getLogs') return bound;

      return async (...inputArgs: unknown[]) => {
        const inputFilter = inputArgs[0] as LogFilter | undefined;
        const inputIsFilter = !!inputFilter && typeof inputFilter === 'object' && !Array.isArray(inputFilter);
        const fromProperty = inputIsFilter ? Object.getOwnPropertyDescriptor(inputFilter, 'fromBlock') : undefined;
        const toProperty = inputIsFilter ? Object.getOwnPropertyDescriptor(inputFilter, 'toBlock') : undefined;
        if ((fromProperty && !('value' in fromProperty)) || (toProperty && !('value' in toProperty))) {
          throw new Error('LOG_CHUNKS_ARGUMENTS_INVALID');
        }
        const args = cloneArgs(inputArgs);
        const filter = args[0] as LogFilter | undefined;
        if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return bound(...args);
        const fromBlock = fromProperty?.value;
        const toBlock = toProperty?.value;
        if (typeof fromBlock !== 'bigint' || typeof toBlock !== 'bigint') return bound(...args);
        if (fromBlock < 0n || toBlock < 0n || fromBlock > toBlock) throw new Error('LOG_CHUNKS_RANGE_INVALID');
        if (Object.hasOwn(inputFilter!, 'blockHash')) return bound(...args);

        const width = BigInt(maxBlocks);
        const count = (toBlock - fromBlock) / width + 1n;
        if (count > 1_000n) throw new Error('LOG_CHUNKS_LIMIT_EXCEEDED');

        const logs: unknown[] = [];
        for (let start = fromBlock; start <= toBlock; start += width) {
          const end = start + width - 1n < toBlock ? start + width - 1n : toBlock;
          const chunkArgs = [...args];
          chunkArgs[0] = { ...filter, fromBlock: start, toBlock: end };
          const result = await bound(...chunkArgs);
          if (!Array.isArray(result)) throw new Error('LOG_CHUNKS_RESPONSE_INVALID');
          logs.push(...result);
        }
        return logs;
      };
    },
  });
}
