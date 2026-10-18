import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { createSession, JournalError, readSession, recordPrepared } from "../src/journal.js";
import { parsePublicConfig, PUBLIC_EXECUTION_SCOPE } from "../src/public-config.js";

const ENV: Record<string, string | undefined> = {
  EXPECTED_PAYER: "0x1111111111111111111111111111111111111111",
  RELAYER_ADDRESS: "0x2222222222222222222222222222222222222222",
  PROVIDER_PAYOUT: "0x3333333333333333333333333333333333333333",
  MAX_FEE_PER_GAS_ATOMIC: "10000000000",
  MAX_PRIORITY_FEE_PER_GAS_ATOMIC: "1000000000",
  MAX_TOTAL_GAS: "3100000",
  MAX_L1_FEE_WEI: "1000000000000000",
  M1_PUBLIC_SCOPE: PUBLIC_EXECUTION_SCOPE,
  PAYER_PRIVATE_KEY: "must-not-persist-payer-key",
  RELAYER_PRIVATE_KEY: "must-not-persist-relayer-key",
  BASE_SEPOLIA_RPC_URL: "https://rpc.invalid/?token=must-not-persist-rpc-token",
};

const RELAYER = ENV.RELAYER_ADDRESS as Address;
const CORE = "0x4444444444444444444444444444444444444444" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const HASH2 = `0x${"cd".repeat(32)}` as Hex;
const INTENT = `0x${"ef".repeat(32)}` as Hex;

let tempRoot = "";
afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

async function freshJournalPath(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "assurepay-m1-journal-"));
  return join(tempRoot, "session");
}

function config() {
  return parsePublicConfig(ENV, { execute: true });
}

function successRecord(transactionHash: Hex = HASH) {
  return {
    kind: "success" as const,
    chainId: 84532 as const,
    transactionHash,
    from: RELAYER,
    to: CORE,
    nonce: "0",
    calldataHash: HASH2,
    intentHash: INTENT,
  };
}

function assertJournalCode(action: () => Promise<unknown>, code: string) {
  return assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof JournalError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("public transaction journal", () => {
  it("creates a fresh exclusive session containing only public config and fixed demo terms", async () => {
    const path = await freshJournalPath();
    const created = await createSession(path, config());
    assert.deepEqual(created.transactions, []);
    assert.equal(created.config.chainId, 84532);
    assert.equal(created.config.token, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    assert.deepEqual(created.terms, { gross: "100", providerNet: "93", premium: "7" });
    assert.ok(Object.isFrozen(created));

    const raw = await readFile(join(path, "session.json"), "utf8");
    assert.ok(!raw.includes("must-not-persist"));
    assert.ok(!raw.includes("rpc.invalid"));
    assert.deepEqual((await readdir(join(path, "transactions"))).sort(), []);
  });

  it("cannot create a session from check-only config and refuses an existing session", async () => {
    const path = await freshJournalPath();
    const checkConfig = parsePublicConfig(ENV);
    await assertJournalCode(() => createSession(path, checkConfig), "EXECUTION_NOT_ENABLED");
    await createSession(path, config());
    const before = await readFile(join(path, "session.json"), "utf8");
    await assertJournalCode(() => createSession(path, config()), "SESSION_EXISTS");
    assert.equal(await readFile(join(path, "session.json"), "utf8"), before);
  });

  it("persists a public transaction identity before broadcast and reads it after restart", async () => {
    const path = await freshJournalPath();
    await createSession(path, config());
    const prepared = await recordPrepared(path, successRecord());
    assert.equal(prepared.transactionHash, HASH);
    const loaded = await readSession(path);
    assert.equal(loaded.transactions.length, 1);
    assert.deepEqual(loaded.transactions[0], prepared);
    const raw = await readFile(join(path, "transactions", "success.json"), "utf8");
    assert.ok(!raw.includes("signature"));
    assert.ok(!raw.includes("rawTransaction"));
    assert.ok(!raw.includes("signedTransaction"));
  });

  it("supports a contract-creation record with a null destination and no intent", async () => {
    const path = await freshJournalPath();
    await createSession(path, config());
    await recordPrepared(path, {
      kind: "deploy",
      chainId: 84532,
      transactionHash: HASH,
      from: RELAYER,
      to: null,
      nonce: "0",
      calldataHash: HASH2,
    });
    const loaded = await readSession(path);
    assert.equal(loaded.transactions[0]?.kind, "deploy");
    assert.equal(loaded.transactions[0]?.to, null);
  });

  it("records the admission-switch transaction without an intent hash", async () => {
    const path = await freshJournalPath();
    await createSession(path, config());
    await recordPrepared(path, {
      kind: "admission",
      chainId: 84532,
      transactionHash: HASH,
      from: RELAYER,
      to: CORE,
      nonce: "1",
      calldataHash: HASH2,
    });
    const loaded = await readSession(path);
    assert.equal(loaded.transactions[0]?.kind, "admission");
    assert.ok(!Object.hasOwn(loaded.transactions[0] ?? {}, "intentHash"));
  });

  it("fails closed on pre-existing records instead of overwriting them", async () => {
    const path = await freshJournalPath();
    await createSession(path, config());
    await recordPrepared(path, successRecord());
    const before = await readFile(join(path, "transactions", "success.json"), "utf8");
    await assertJournalCode(() => recordPrepared(path, successRecord(HASH2)), "RECORD_WRITE_FAILED");
    assert.equal(await readFile(join(path, "transactions", "success.json"), "utf8"), before);
  });

  it("rejects malformed, unexpected, or signature-bearing journal JSON", async () => {
    const path = await freshJournalPath();
    await createSession(path, config());
    await writeFile(join(path, "transactions", "success.json"), JSON.stringify({
      ...successRecord(),
      signedTransaction: "private signed bytes",
    }));
    await assertJournalCode(() => readSession(path), "SESSION_INVALID");

    const otherPath = join(tempRoot, "malformed");
    await mkdir(otherPath);
    await mkdir(join(otherPath, "transactions"));
    await writeFile(join(otherPath, "session.json"), "not-json");
    await assertJournalCode(() => readSession(otherPath), "SESSION_INVALID");
  });

  it("requires a session before recording and rejects a transaction from another relayer", async () => {
    const path = await freshJournalPath();
    await assertJournalCode(() => recordPrepared(path, successRecord()), "SESSION_UNAVAILABLE");
    await createSession(path, config());
    await assertJournalCode(() => recordPrepared(path, { ...successRecord(), from: CORE }), "RECORD_INVALID");
    assert.deepEqual(await readSession(path).then((session) => session.transactions), []);
  });

  it("requires canonical public fields and never creates a record after validation failure", async () => {
    const path = await freshJournalPath();
    await createSession(path, config());
    await assertJournalCode(() => recordPrepared(path, {
      ...successRecord(),
      nonce: "01",
    }), "RECORD_INVALID");
    await assertJournalCode(() => recordPrepared(path, {
      ...successRecord(),
      signedTransaction: "must-not-be-written",
    } as never), "SESSION_INVALID");
    assert.deepEqual(await readdir(join(path, "transactions")), []);
  });
});
