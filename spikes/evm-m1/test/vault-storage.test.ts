import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  createFundingSession, readFundingSession, recordFundingPrepared, recordFundingConfirmed,
  setupVault, VaultStorageError,
} from "../src/vault-storage.js";
import type { Address, Hex } from "viem";

const relayer = `0x${"11".repeat(20)}` as Address;
const vault = `0x${"22".repeat(20)}` as Address;
const txHash = `0x${"aa".repeat(32)}` as Hex;
const blockHash = `0x${"bb".repeat(32)}` as Hex;
const prepared = {
  kind: "excess" as const, transactionHash: txHash, from: relayer, to: vault,
  nonce: "3", valueWei: "99500000000000000", gas: "21000" as const,
  maxFeePerGasWei: "100000000" as const, maxPriorityFeePerGasWei: "1000000" as const,
  chainId: 84532 as const, calldata: "0x" as const,
};

describe("test-fund vault storage", () => {
  it("creates a private exclusive vault env and exposes only address/path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assurepay-vault-"));
    try {
      const envPath = join(dir, ".env.vault.local");
      const result = await setupVault(envPath);
      assert.equal(result.configurationPath, resolve(envPath));
      assert.deepEqual(Object.keys(result).sort(), ["configurationPath", "vault"]);
      assert.equal((await stat(envPath)).mode & 0o777, 0o600);
      const second = await setupVault(envPath).then(() => null, (e: unknown) => e);
      assert.ok(second instanceof VaultStorageError);
      assert.equal(second.code, "configuration_exists");
      const child = spawnSync(process.execPath, [
        `--env-file=${envPath}`, "--input-type=module", "-e",
        'import {privateKeyToAccount} from "viem/accounts"; process.stdout.write(String(privateKeyToAccount(process.env.VAULT_PRIVATE_KEY).address.toLowerCase() === process.env.VAULT_ADDRESS.toLowerCase()))',
      ], { cwd: process.cwd(), encoding: "utf8" });
      assert.equal(child.status, 0);
      assert.equal(child.stdout, "true");
      assert.equal(child.stdout.includes("0x"), false);
      assert.equal(child.stdout.includes("PRIVATE_KEY"), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("persists strict public session records and permits top-up only after canonical excess confirmation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assurepay-vault-journal-"));
    try {
      const path = join(dir, "session");
      await createFundingSession(path, { chainId: 84532, relayer, vault, targetWei: "410000000000000" });
      assert.deepEqual((await readFundingSession(path)).prepared, []);
      const smallExcess = { ...prepared, valueWei: "1" };
      await recordFundingPrepared(path, smallExcess);
      await assert.rejects(recordFundingPrepared(path, smallExcess), (e: unknown) => e instanceof VaultStorageError && e.code === "record_exists");
      await assert.rejects(recordFundingPrepared(path, { ...prepared, kind: "top-up", from: vault, to: relayer, valueWei: "1" }),
        (e: unknown) => e instanceof VaultStorageError && e.code === "record_invalid");
      await recordFundingConfirmed(path, "excess", { transactionHash: txHash, blockNumber: "50", blockHash, status: "success" });
      const topUp = { ...prepared, kind: "top-up" as const, transactionHash: `0x${"cc".repeat(32)}` as Hex, from: vault, to: relayer, nonce: "1", valueWei: "100000000000000" };
      await recordFundingPrepared(path, topUp);
      const session = await readFundingSession(path);
      assert.deepEqual(session.prepared.map((r) => r.kind), ["excess", "top-up"]);
      assert.equal(session.confirmations[0]?.confirmation.blockHash, blockHash);
      for (const record of ["excess.json", "excess.confirmed.json", "top-up.json"]) {
        const content = await readFile(join(path, "records", record), "utf8");
        assert.equal(/private.?key|raw.?transaction|signature/i.test(content), false);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects unknown fields, malformed schemas, symlinks, bad bounds, and duplicate sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assurepay-vault-invalid-"));
    try {
      const path = join(dir, "session");
      await createFundingSession(path, { chainId: 84532, relayer, vault, targetWei: "410000000000000" });
      await assert.rejects(createFundingSession(path, { chainId: 84532, relayer, vault, targetWei: "410000000000000" }),
        (e: unknown) => e instanceof VaultStorageError && e.code === "session_exists");
      await assert.rejects(recordFundingPrepared(path, { ...prepared, rawTransaction: "0x1234" } as never),
        (e: unknown) => e instanceof VaultStorageError && e.code === "session_invalid");
      await assert.rejects(recordFundingPrepared(path, { ...prepared, gas: "22000" } as never),
        (e: unknown) => e instanceof VaultStorageError && e.code === "record_invalid");
      const badPath = join(dir, "bad");
      await mkdir(badPath);
      await writeFile(join(badPath, "session.json"), JSON.stringify({ version: 1, config: { chainId: 84532, relayer, vault, targetWei: "410000000000000", extra: true } }));
      await mkdir(join(badPath, "records"));
      await assert.rejects(readFundingSession(badPath), (e: unknown) => e instanceof VaultStorageError && e.code === "session_invalid");
      const linkPath = join(dir, "link");
      await symlink(path, linkPath);
      await assert.rejects(readFundingSession(linkPath), (e: unknown) => e instanceof VaultStorageError && e.code === "session_invalid");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
