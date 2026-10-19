import type { Hex } from 'viem';

type Receipt = {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  status: 'success' | 'reverted';
  [key: string]: unknown;
};

type FeeRpcReceipt = {
  transactionHash?: unknown;
  blockHash?: unknown;
  blockNumber?: unknown;
  status?: unknown;
  l1Fee?: unknown;
  operatorFee?: unknown;
};

type FeeClient = {
  getTransactionReceipt: (...args: any[]) => Promise<any>;
  request: (...args: any[]) => Promise<any>;
};

export class BaseReceiptFeeReadError extends Error {
  constructor() {
    super('M1_BASE_RECEIPT_FEE_READ_FAILED');
    this.name = 'BaseReceiptFeeReadError';
  }
}

function quantity(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new BaseReceiptFeeReadError();
  }
  return BigInt(value);
}

function matchesFormatted(raw: FeeRpcReceipt, formatted: Receipt, requestedHash: Hex): boolean {
  if (typeof raw.transactionHash !== 'string' || typeof raw.blockHash !== 'string' ||
      typeof raw.blockNumber !== 'string' || typeof raw.status !== 'string') return false;
  let blockNumber: bigint;
  try {
    if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(raw.blockNumber)) return false;
    blockNumber = BigInt(raw.blockNumber);
  } catch { return false; }
  const status = raw.status === '0x1' ? 'success' : raw.status === '0x0' ? 'reverted' : undefined;
  return status !== undefined && raw.transactionHash.toLowerCase() === requestedHash.toLowerCase() &&
    formatted.transactionHash.toLowerCase() === requestedHash.toLowerCase() &&
    raw.blockHash.toLowerCase() === formatted.blockHash.toLowerCase() &&
    blockNumber === formatted.blockNumber && status === formatted.status;
}

/** Attach Base fee fields from the raw RPC receipt after matching canonical identity. */
export function withBaseReceiptFees<T extends FeeClient>(client: T): T {
  const wrappedReceipt = async ({ hash }: { hash: Hex }): Promise<Receipt> => {
    try {
      const formatted = await client.getTransactionReceipt({ hash });
      if (!formatted) return formatted;
      const rawValue = await client.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) throw new BaseReceiptFeeReadError();
      const raw = rawValue as FeeRpcReceipt;
      if (!matchesFormatted(raw, formatted, hash)) throw new BaseReceiptFeeReadError();
      const l1Fee = quantity(raw.l1Fee);
      const operatorFee = quantity(raw.operatorFee);
      return { ...formatted, l1Fee, operatorFee };
    } catch {
      // Do not expose raw RPC errors or receipt contents; callers must reconcile later.
      throw new BaseReceiptFeeReadError();
    }
  };

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'getTransactionReceipt') return wrappedReceipt;
      return Reflect.get(target, property, receiver);
    },
  });
}
