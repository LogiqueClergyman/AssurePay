import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { createRelay, RelayError, type RelayReceipt } from "../src/relay.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const OTHER_HASH = `0x${"cd".repeat(32)}` as Hex;

function receipt(status: RelayReceipt["status"] = "success", transactionHash = HASH): RelayReceipt {
  return { transactionHash: transactionHash as Hex, status };
}

describe("submit-once confirmation relay", () => {
  it("recovers a confirmed transaction after the broadcast response is lost", async () => {
    let broadcasts = 0;
    const relay = createRelay({
      prepareCall: async () => ({ hash: HASH, broadcast: async () => { broadcasts++; throw new Error("lost response"); } }),
      getReceipt: async (hash) => { assert.equal(hash, HASH); return receipt(); },
      verifySuccess: async () => true,
    });

    assert.deepEqual(await relay.settle("payment-1"), { status: "confirmed", transaction: HASH });
    assert.equal(broadcasts, 1);
    assert.deepEqual(await relay.settle("payment-1"), { status: "confirmed", transaction: HASH });
    assert.equal(broadcasts, 1);
  });

  it("retries confirmation reads for the identical hash without resubmitting", async () => {
    let prepares = 0;
    let broadcasts = 0;
    let reads = 0;
    const relay = createRelay({
      prepareCall: async () => { prepares++; return { hash: HASH, broadcast: async () => { broadcasts++; } }; },
      getReceipt: async () => ++reads === 1 ? null : receipt(),
      verifySuccess: async () => true,
      maxReceiptReads: 1,
    });

    assert.deepEqual(await relay.settle("payment-2"), { status: "pending", transaction: HASH });
    assert.deepEqual(await relay.settle("payment-2"), { status: "confirmed", transaction: HASH });
    assert.equal(prepares, 1);
    assert.equal(broadcasts, 1);
    assert.equal(reads, 2);
  });

  it("returns pending on receipt lookup failure and later recovers by read only", async () => {
    let broadcasts = 0;
    let reads = 0;
    const relay = createRelay({
      prepareCall: async () => ({ hash: HASH, broadcast: async () => { broadcasts++; } }),
      getReceipt: async () => { if (++reads === 1) throw new Error("rpc unavailable"); return receipt(); },
      verifySuccess: async () => true,
      maxReceiptReads: 1,
    });

    assert.deepEqual(await relay.settle("payment-3"), { status: "pending", transaction: HASH });
    assert.deepEqual(await relay.settle("payment-3"), { status: "confirmed", transaction: HASH });
    assert.equal(broadcasts, 1);
    assert.equal(reads, 2);
  });

  it("treats a matching reverted receipt as terminal", async () => {
    let broadcasts = 0;
    let reads = 0;
    const relay = createRelay({
      prepareCall: async () => ({ hash: HASH, broadcast: async () => { broadcasts++; } }),
      getReceipt: async () => { reads++; return receipt("reverted"); },
      verifySuccess: async () => { throw new Error("must not verify reverted receipt"); },
    });

    assert.deepEqual(await relay.settle("payment-4"), { status: "reverted", transaction: HASH });
    assert.deepEqual(await relay.settle("payment-4"), { status: "reverted", transaction: HASH });
    assert.equal(broadcasts, 1);
    assert.equal(reads, 1);
  });

  it("returns mismatch for wrong-hash receipts or failed success verification", async () => {
    const wrongHash = createRelay({
      prepareCall: async () => ({ hash: HASH, broadcast: async () => {} }),
      getReceipt: async () => receipt("success", OTHER_HASH),
      verifySuccess: async () => true,
    });
    assert.deepEqual(await wrongHash.settle("wrong-receipt"), { status: "mismatch", transaction: HASH });

    const failedVerification = createRelay({
      prepareCall: async () => ({ hash: HASH, broadcast: async () => {} }),
      getReceipt: async () => receipt(),
      verifySuccess: async () => false,
    });
    assert.deepEqual(await failedVerification.settle("bad-state"), { status: "mismatch", transaction: HASH });
  });

  it("fails closed when success verification throws, then can verify on a later read", async () => {
    let verifies = 0;
    let broadcasts = 0;
    const relay = createRelay({
      prepareCall: async () => ({ hash: HASH, broadcast: async () => { broadcasts++; } }),
      getReceipt: async () => receipt(),
      verifySuccess: async () => { if (++verifies === 1) throw new Error("state read unavailable"); return true; },
      maxReceiptReads: 1,
    });

    assert.deepEqual(await relay.settle("verify-retry"), { status: "pending", transaction: HASH });
    assert.deepEqual(await relay.settle("verify-retry"), { status: "confirmed", transaction: HASH });
    assert.equal(broadcasts, 1);
  });

  it("coalesces concurrent settlement calls into one preparation and broadcast", async () => {
    let prepares = 0;
    let broadcasts = 0;
    let finishPrepare!: (value: { hash: Hex; broadcast: () => Promise<void> }) => void;
    const prepareGate = new Promise<{ hash: Hex; broadcast: () => Promise<void> }>((resolve) => { finishPrepare = resolve; });
    const relay = createRelay({
      prepareCall: async () => { prepares++; return prepareGate; },
      getReceipt: async () => receipt(),
      verifySuccess: async () => true,
    });

    const first = relay.settle("same-key");
    const second = relay.settle("same-key");
    finishPrepare({ hash: HASH, broadcast: async () => { broadcasts++; } });
    const results = await Promise.all([first, second]);
    assert.deepEqual(results, [
      { status: "confirmed", transaction: HASH },
      { status: "confirmed", transaction: HASH },
    ]);
    assert.equal(prepares, 1);
    assert.equal(broadcasts, 1);
  });

  it("rejects malformed prepared hashes before broadcast", async () => {
    let broadcasts = 0;
    const relay = createRelay({
      prepareCall: async () => ({ hash: "0x1234" as Hex, broadcast: async () => { broadcasts++; } }),
      getReceipt: async () => null,
      verifySuccess: async () => false,
    });

    await assert.rejects(relay.settle("invalid-hash"), (error: unknown) =>
      error instanceof RelayError && error.message === "INVALID_TRANSACTION_HASH");
    assert.equal(broadcasts, 0);
  });

  it("rejects receipt-read bounds outside one through ten", () => {
    const options = {
      prepareCall: async () => ({ hash: HASH, broadcast: async () => {} }),
      getReceipt: async () => null,
      verifySuccess: async () => false,
    };
    assert.throws(() => createRelay({ ...options, maxReceiptReads: 0 }), { message: "INVALID_MAX_RECEIPT_READS" });
    assert.throws(() => createRelay({ ...options, maxReceiptReads: 11 }), { message: "INVALID_MAX_RECEIPT_READS" });
    assert.doesNotThrow(() => createRelay({ ...options, maxReceiptReads: 10 }));
  });
});
