import { setupTestWallets, WalletSetupError } from "../src/wallet-setup.js";

if (process.argv.length !== 2) {
  process.stdout.write('{"ok":false,"code":"invalid_arguments"}\n');
  process.exitCode = 1;
} else {
  try {
    const summary = await setupTestWallets();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const code = error instanceof WalletSetupError ? error.code : "configuration_write_failed";
    process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  }
}
