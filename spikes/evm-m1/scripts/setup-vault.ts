import { setupVault, VaultStorageError } from "../src/vault-storage.js";

if (process.argv.length !== 2) {
  process.stdout.write('{"ok":false,"code":"invalid_arguments"}\n');
  process.exitCode = 1;
} else {
  try {
    const result = await setupVault();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof VaultStorageError ? error.code : "configuration_write_failed";
    process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  }
}
