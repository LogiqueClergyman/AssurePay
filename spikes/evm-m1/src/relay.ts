import type { Hex } from "viem";

export type RelayReceipt = {
  transactionHash: Hex;
  status: "success" | "reverted";
};

export type RelayResult = {
  status: "confirmed" | "pending" | "reverted" | "mismatch";
  transaction: Hex;
};

export type PreparedRelayCall = {
  /** Public transaction hash derived locally before any broadcast is attempted. */
  hash: Hex;
  /** Broadcast this exact prepared transaction at most once for this key. */
  broadcast: () => Promise<void>;
};

export type RelayOptions = {
  prepareCall: () => Promise<PreparedRelayCall>;
  getReceipt: (hash: Hex) => Promise<RelayReceipt | null>;
  verifySuccess: (receipt: RelayReceipt) => Promise<boolean>;
  maxReceiptReads?: number;
};

export class RelayError extends Error {
  constructor(code: "INVALID_KEY" | "PREPARE_FAILED" | "INVALID_TRANSACTION_HASH" | "INVALID_PREPARED_CALL") {
    super(code);
    this.name = "RelayError";
  }
}

type Entry = {
  transaction: Hex | null;
  broadcastAttempted: boolean;
  terminal: RelayResult | null;
  flight: Promise<RelayResult> | null;
};

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_MAX_RECEIPT_READS = 3;

/**
 * Submit each logical key once, then recover only by reading the same public
 * transaction hash. State is intentionally process-local for this Gate B helper.
 */
export function createRelay(options: RelayOptions): { settle(key: string): Promise<RelayResult> } {
  const maxReceiptReads = options.maxReceiptReads ?? DEFAULT_MAX_RECEIPT_READS;
  if (!Number.isSafeInteger(maxReceiptReads) || maxReceiptReads < 1 || maxReceiptReads > 10) {
    throw new RangeError("INVALID_MAX_RECEIPT_READS");
  }

  const entries = new Map<string, Entry>();

  async function readReceipts(entry: Entry): Promise<RelayResult> {
    const transaction = entry.transaction;
    if (!transaction) throw new Error("RELAY_STATE_UNAVAILABLE");

    for (let read = 0; read < maxReceiptReads; read++) {
      let receipt: RelayReceipt | null;
      try {
        receipt = await options.getReceipt(transaction);
      } catch {
        return { status: "pending", transaction };
      }

      if (receipt === null) continue;
      if (
        typeof receipt !== "object" || receipt === null
          || typeof receipt.transactionHash !== "string" || !HASH_RE.test(receipt.transactionHash)
          || receipt.transactionHash.toLowerCase() !== transaction
      ) {
        const result: RelayResult = { status: "mismatch", transaction };
        entry.terminal = result;
        return result;
      }
      if (receipt.status === "reverted") {
        const result: RelayResult = { status: "reverted", transaction };
        entry.terminal = result;
        return result;
      }
      if (receipt.status !== "success") {
        const result: RelayResult = { status: "mismatch", transaction };
        entry.terminal = result;
        return result;
      }

      try {
        if (await options.verifySuccess(receipt)) {
          const result: RelayResult = { status: "confirmed", transaction };
          entry.terminal = result;
          return result;
        }
      } catch {
        // A failed verifier cannot establish success or safe-to-retry failure.
        return { status: "pending", transaction };
      }

      const result: RelayResult = { status: "mismatch", transaction };
      entry.terminal = result;
      return result;
    }

    return { status: "pending", transaction };
  }

  async function prepareAndSubmit(key: string, entry: Entry): Promise<RelayResult> {
    let prepared: PreparedRelayCall;
    try {
      prepared = await options.prepareCall();
    } catch {
      entries.delete(key);
      throw new RelayError("PREPARE_FAILED");
    }
    if (!prepared || typeof prepared !== "object" || typeof prepared.broadcast !== "function") {
      entries.delete(key);
      throw new RelayError("INVALID_PREPARED_CALL");
    }
    if (typeof prepared.hash !== "string" || !HASH_RE.test(prepared.hash)) {
      entries.delete(key);
      throw new RelayError("INVALID_TRANSACTION_HASH");
    }

    // Normalize before storing so receipt comparison is case-insensitive.
    entry.transaction = prepared.hash.toLowerCase() as Hex;
    entry.broadcastAttempted = true;
    try {
      await prepared.broadcast();
    } catch {
      // The submitter may have accepted the transaction before its response was lost.
    }
    return readReceipts(entry);
  }

  async function settle(key: string): Promise<RelayResult> {
    if (typeof key !== "string" || key.length === 0) throw new RelayError("INVALID_KEY");

    let entry = entries.get(key);
    if (!entry) {
      entry = { transaction: null, broadcastAttempted: false, terminal: null, flight: null };
      entries.set(key, entry);
      const current = entry;
      const flight = prepareAndSubmit(key, current);
      current.flight = flight;
      try {
        return await flight;
      } finally {
        if (current.flight === flight) current.flight = null;
      }
    }

    if (entry.flight) return entry.flight;
    if (entry.terminal) return entry.terminal;
    if (!entry.transaction || entry.broadcastAttempted !== true) {
      throw new RelayError("PREPARE_FAILED");
    }

    const current = entry;
    const flight = readReceipts(current);
    current.flight = flight;
    try {
      return await flight;
    } finally {
      if (current.flight === flight) current.flight = null;
    }
  }

  return { settle };
}
