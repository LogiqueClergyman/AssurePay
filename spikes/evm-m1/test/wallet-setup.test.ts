import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { WalletSetupError, setupTestWallets } from "../src/wallet-setup.js";

describe("disposable public-test wallet bootstrap", () => {
  it("returns only addresses and writes a private, exclusive runtime configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "assurepay-wallet-setup-"));
    try {
      const configurationPath = join(directory, ".env.local");
      const summary = await setupTestWallets(configurationPath);
      assert.equal(summary.configurationPath, resolve(configurationPath));
      assert.equal(summary.relayerRequiredWei, "410000000000000");
      assert.equal(summary.payerMinimumUsdcAtomic, "200");
      assert.notEqual(summary.payer, summary.relayer);
      assert.notEqual(summary.payer, summary.providerPayout);
      assert.notEqual(summary.relayer, summary.providerPayout);
      assert.deepEqual(Object.keys(summary).sort(), [
        "configurationPath",
        "payer",
        "payerMinimumUsdcAtomic",
        "providerPayout",
        "relayer",
        "relayerRequiredWei",
      ]);
      assert.equal(JSON.stringify(summary).includes("PRIVATE_KEY"), false);

      const fileInfo = await stat(configurationPath);
      assert.equal(fileInfo.mode & 0o777, 0o600);

      const secondAttempt = await setupTestWallets(configurationPath).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(secondAttempt instanceof WalletSetupError);
      assert.equal(secondAttempt.code, "configuration_exists");
      const unchanged = await stat(configurationPath);
      assert.equal(unchanged.ino, fileInfo.ino);
      assert.equal(unchanged.mtimeMs, fileInfo.mtimeMs);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads the private values through Node's --env-file without exposing them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "assurepay-wallet-runtime-"));
    try {
      const configurationPath = join(directory, ".env.local");
      const summary = await setupTestWallets(configurationPath);
      const probe = [
        'import { privateKeyToAccount } from "viem/accounts";',
        'const payer = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY);',
        'const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY);',
        'const payout = privateKeyToAccount(process.env.PROVIDER_PAYOUT_PRIVATE_KEY);',
        'process.stdout.write(JSON.stringify({ payer: payer.address === process.env.EXPECTED_PAYER, relayer: relayer.address === process.env.RELAYER_ADDRESS, payout: payout.address === process.env.PROVIDER_PAYOUT }));',
      ].join("\n");
      const child = spawnSync(
        process.execPath,
        [`--env-file=${configurationPath}`, "--input-type=module", "-e", probe],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(child.status, 0);
      assert.deepEqual(JSON.parse(child.stdout), { payer: true, relayer: true, payout: true });
      assert.equal(child.stdout.includes("0x"), false);
      assert.equal(child.stdout.includes("PRIVATE_KEY"), false);
      assert.equal(summary.payer.length, 42);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails with fixed codes for an existing file and a missing parent directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "assurepay-wallet-errors-"));
    try {
      const existingPath = join(directory, "existing.env");
      await writeFile(existingPath, "sentinel", { mode: 0o600 });
      await assert.rejects(setupTestWallets(existingPath), (error: unknown) => {
        assert.ok(error instanceof WalletSetupError);
        assert.equal(error.code, "configuration_exists");
        assert.equal(error.message, "M1_WALLET_SETUP_CONFIGURATION_EXISTS");
        return true;
      });

      const missingParent = join(directory, "missing", ".env.local");
      await assert.rejects(setupTestWallets(missingParent), (error: unknown) => {
        assert.ok(error instanceof WalletSetupError);
        assert.equal(error.code, "configuration_write_failed");
        assert.equal(error.message, "M1_WALLET_SETUP_CONFIGURATION_WRITE_FAILED");
        return true;
      });
      await assert.rejects(stat(missingParent));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
