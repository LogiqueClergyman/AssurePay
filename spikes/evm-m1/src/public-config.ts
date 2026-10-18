import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC,
  NATIVE_USDC,
  validateRpcUrl,
} from "./preflight.js";
import type { Address } from "viem";

export const PUBLIC_EXECUTION_SCOPE = "deploy-success-admission-revert-once" as const;
export const PUBLIC_GAS_CAPS = Object.freeze({
  deploy: 2_000_000n,
  success: 500_000n,
  admission: 100_000n,
  revert: 500_000n,
});
export const PUBLIC_GAS_CAP_TOTAL = Object.values(PUBLIC_GAS_CAPS).reduce((sum, value) => sum + value, 0n);
export const PUBLIC_MAX_TOTAL_GAS = 4_000_000n;

export type PublicConfig = Readonly<{
  mode: "check" | "execute";
  rpcUrl: string;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  token: typeof NATIVE_USDC;
  payer: Address;
  relayer: Address;
  providerPayout: Address;
  budget: Readonly<{
    maxFeePerGasAtomic: bigint;
    maxPriorityFeePerGasAtomic: bigint;
    maxTotalGas: bigint;
    maxL1FeeWei: bigint;
    gasCaps: typeof PUBLIC_GAS_CAPS;
  }>;
}>;

export type PublicConfigCode =
  | "missing_configuration"
  | "invalid_address"
  | "address_collision"
  | "invalid_rpc_url"
  | "invalid_budget"
  | "insufficient_budget"
  | "execution_scope_required"
  | "signer_configuration_missing";

export class PublicConfigError extends Error {
  constructor(readonly code: PublicConfigCode, readonly missing: readonly string[] = []) {
    super(`M1_PUBLIC_CONFIG_${code.toUpperCase()}`);
    this.name = "PublicConfigError";
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const CONFIG_NAMES = [
  "EXPECTED_PAYER",
  "RELAYER_ADDRESS",
  "PROVIDER_PAYOUT",
  "MAX_FEE_PER_GAS_ATOMIC",
  "MAX_PRIORITY_FEE_PER_GAS_ATOMIC",
  "MAX_TOTAL_GAS",
  "MAX_L1_FEE_WEI",
] as const;
const EXECUTE_NAMES = ["PAYER_PRIVATE_KEY", "RELAYER_PRIVATE_KEY"] as const;

function parseAddress(value: string | undefined, name: string): Address {
  if (typeof value !== "string" || !ADDRESS_RE.test(value) || /^0x0{40}$/i.test(value)) {
    throw new PublicConfigError("invalid_address", [name]);
  }
  return value.toLowerCase() as Address;
}

function parseUint(value: string | undefined, name: string): bigint {
  if (typeof value !== "string" || value.length > 78 || !UINT_RE.test(value)) {
    throw new PublicConfigError("invalid_budget", [name]);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new PublicConfigError("invalid_budget", [name]);
  return parsed;
}

function assertDeepFrozen(config: PublicConfig): PublicConfig {
  Object.freeze(config.budget);
  return Object.freeze(config);
}

/** Parse only caller-supplied runtime values. This function never reads process.env itself. */
export function parsePublicConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: Readonly<{ execute?: boolean }> = {},
): PublicConfig {
  const execute = options.execute === true;
  const missing = CONFIG_NAMES.filter((name) => typeof env[name] !== "string" || env[name] === "");
  if (missing.length > 0) throw new PublicConfigError("missing_configuration", missing);

  const payer = parseAddress(env.EXPECTED_PAYER, "EXPECTED_PAYER");
  const relayer = parseAddress(env.RELAYER_ADDRESS, "RELAYER_ADDRESS");
  const providerPayout = parseAddress(env.PROVIDER_PAYOUT, "PROVIDER_PAYOUT");
  if (new Set([payer, relayer, providerPayout, NATIVE_USDC.toLowerCase()]).size !== 4) {
    throw new PublicConfigError("address_collision");
  }

  const rpcUrl = env.BASE_SEPOLIA_RPC_URL ?? BASE_SEPOLIA_RPC;
  if (!validateRpcUrl(rpcUrl)) throw new PublicConfigError("invalid_rpc_url", ["BASE_SEPOLIA_RPC_URL"]);

  const maxFeePerGasAtomic = parseUint(env.MAX_FEE_PER_GAS_ATOMIC, "MAX_FEE_PER_GAS_ATOMIC");
  const maxPriorityFeePerGasAtomic = parseUint(
    env.MAX_PRIORITY_FEE_PER_GAS_ATOMIC,
    "MAX_PRIORITY_FEE_PER_GAS_ATOMIC",
  );
  const maxTotalGas = parseUint(env.MAX_TOTAL_GAS, "MAX_TOTAL_GAS");
  const maxL1FeeWei = parseUint(env.MAX_L1_FEE_WEI, "MAX_L1_FEE_WEI");
  if (maxFeePerGasAtomic === 0n) throw new PublicConfigError("invalid_budget", ["MAX_FEE_PER_GAS_ATOMIC"]);
  if (maxPriorityFeePerGasAtomic > maxFeePerGasAtomic) {
    throw new PublicConfigError("invalid_budget", ["MAX_PRIORITY_FEE_PER_GAS_ATOMIC"]);
  }
  if (maxTotalGas === 0n || maxTotalGas > PUBLIC_MAX_TOTAL_GAS) {
    throw new PublicConfigError("invalid_budget", ["MAX_TOTAL_GAS"]);
  }
  if (maxL1FeeWei === 0n) throw new PublicConfigError("invalid_budget", ["MAX_L1_FEE_WEI"]);
  if (maxTotalGas < PUBLIC_GAS_CAP_TOTAL) throw new PublicConfigError("insufficient_budget");

  if (execute) {
    if (env.M1_PUBLIC_SCOPE !== PUBLIC_EXECUTION_SCOPE) {
      throw new PublicConfigError("execution_scope_required", ["M1_PUBLIC_SCOPE"]);
    }
    const missingSigners = EXECUTE_NAMES.filter((name) => typeof env[name] !== "string" || env[name] === "");
    if (missingSigners.length > 0) throw new PublicConfigError("signer_configuration_missing", missingSigners);
  }

  return assertDeepFrozen({
    mode: execute ? "execute" : "check",
    rpcUrl,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    token: NATIVE_USDC,
    payer,
    relayer,
    providerPayout,
    budget: {
      maxFeePerGasAtomic,
      maxPriorityFeePerGasAtomic,
      maxTotalGas,
      maxL1FeeWei,
      gasCaps: PUBLIC_GAS_CAPS,
    },
  });
}

/** Safe summary for CLI output. Never includes endpoint or signer material. */
export function publicConfigSummary(config: PublicConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    mode: config.mode,
    chainId: config.chainId,
    token: config.token,
    payer: config.payer,
    relayer: config.relayer,
    providerPayout: config.providerPayout,
    maxFeePerGasAtomic: config.budget.maxFeePerGasAtomic.toString(),
    maxPriorityFeePerGasAtomic: config.budget.maxPriorityFeePerGasAtomic.toString(),
    maxTotalGas: config.budget.maxTotalGas.toString(),
    maxL1FeeWei: config.budget.maxL1FeeWei.toString(),
    gasCaps: Object.fromEntries(Object.entries(config.budget.gasCaps).map(([kind, gas]) => [kind, gas.toString()])),
  });
}
