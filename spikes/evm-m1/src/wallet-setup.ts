import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const WALLET_SETUP_DEFAULT_PATH = fileURLToPath(new URL("../.env.local", import.meta.url));
export const WALLET_SETUP_RELAYER_REQUIRED_WEI = "410000000000000";
export const WALLET_SETUP_PAYER_MINIMUM_USDC_ATOMIC = "200";

export type WalletSetupSummary = Readonly<{
  payer: `0x${string}`;
  relayer: `0x${string}`;
  providerPayout: `0x${string}`;
  configurationPath: string;
  relayerRequiredWei: typeof WALLET_SETUP_RELAYER_REQUIRED_WEI;
  payerMinimumUsdcAtomic: typeof WALLET_SETUP_PAYER_MINIMUM_USDC_ATOMIC;
}>;

export type WalletSetupCode = "configuration_exists" | "configuration_write_failed";

export class WalletSetupError extends Error {
  constructor(readonly code: WalletSetupCode) {
    super(`M1_WALLET_SETUP_${code.toUpperCase()}`);
    this.name = "WalletSetupError";
  }
}

function newAccount() {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/** Create a fresh local runtime file once. The file is exclusive and private (0600). */
export async function setupTestWallets(
  configurationPath = WALLET_SETUP_DEFAULT_PATH,
): Promise<WalletSetupSummary> {
  const payer = newAccount();
  const relayer = newAccount();
  const providerPayout = newAccount();
  const resolvedConfigurationPath = resolve(configurationPath);
  const spikeDirectory = dirname(WALLET_SETUP_DEFAULT_PATH);
  const journalPath = resolve(spikeDirectory, ".local-public-run");
  const contents = [
    "# Fresh disposable Base Sepolia M1 runtime wallets. Keep this file private.",
    `EXPECTED_PAYER=${payer.address}`,
    `RELAYER_ADDRESS=${relayer.address}`,
    `PROVIDER_PAYOUT=${providerPayout.address}`,
    "MAX_FEE_PER_GAS_ATOMIC=100000000",
    "MAX_PRIORITY_FEE_PER_GAS_ATOMIC=1000000",
    "MAX_TOTAL_GAS=3100000",
    "MAX_L1_FEE_WEI=100000000000000",
    "M1_PUBLIC_SCOPE=deploy-success-admission-revert-once",
    `M1_PUBLIC_JOURNAL_DIR=${journalPath}`,
    `PAYER_PRIVATE_KEY=${payer.privateKey}`,
    `RELAYER_PRIVATE_KEY=${relayer.privateKey}`,
    `PROVIDER_PAYOUT_PRIVATE_KEY=${providerPayout.privateKey}`,
    "",
  ].join("\n");

  let handle;
  try {
    handle = await open(resolvedConfigurationPath, "wx", 0o600);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new WalletSetupError("configuration_exists");
    }
    throw new WalletSetupError("configuration_write_failed");
  }

  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } catch {
    try {
      await handle.close();
    } catch {
      // Preserve the fixed failure surface.
    }
    throw new WalletSetupError("configuration_write_failed");
  }
  try {
    await handle.close();
    const directoryHandle = await open(dirname(resolvedConfigurationPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    throw new WalletSetupError("configuration_write_failed");
  }

  return Object.freeze({
    payer: payer.address,
    relayer: relayer.address,
    providerPayout: providerPayout.address,
    configurationPath: resolvedConfigurationPath,
    relayerRequiredWei: WALLET_SETUP_RELAYER_REQUIRED_WEI,
    payerMinimumUsdcAtomic: WALLET_SETUP_PAYER_MINIMUM_USDC_ATOMIC,
  });
}
