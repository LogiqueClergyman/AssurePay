import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePublicConfig,
  PublicConfigError,
  publicConfigSummary,
  PUBLIC_EXECUTION_SCOPE,
  PUBLIC_GAS_CAP_TOTAL,
  PUBLIC_MAX_TOTAL_GAS,
} from "../src/public-config.js";
import { BASE_SEPOLIA_RPC, NATIVE_USDC } from "../src/preflight.js";

const BASE_ENV: Record<string, string | undefined> = {
  EXPECTED_PAYER: "0x1111111111111111111111111111111111111111",
  RELAYER_ADDRESS: "0x2222222222222222222222222222222222222222",
  PROVIDER_PAYOUT: "0x3333333333333333333333333333333333333333",
  MAX_FEE_PER_GAS_ATOMIC: "10000000000",
  MAX_PRIORITY_FEE_PER_GAS_ATOMIC: "1000000000",
  MAX_TOTAL_GAS: "3100000",
  MAX_L1_FEE_WEI: "1000000000000000",
};

function getConfigError(action: () => unknown, code: string, missing?: readonly string[]) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof PublicConfigError);
    assert.equal(error.code, code);
    if (missing !== undefined) assert.deepEqual(error.missing, missing);
    return true;
  });
}

describe("bounded public runner configuration", () => {
  it("uses fixed Base Sepolia/native USDC and a read-only default without signer values", () => {
    const config = parsePublicConfig(BASE_ENV);
    assert.equal(config.mode, "check");
    assert.equal(config.rpcUrl, BASE_SEPOLIA_RPC);
    assert.equal(config.chainId, 84532);
    assert.equal(config.token, NATIVE_USDC);
    assert.equal(config.budget.maxTotalGas, PUBLIC_GAS_CAP_TOTAL);
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.budget));

    const withRpcSecret = parsePublicConfig({
      ...BASE_ENV,
      BASE_SEPOLIA_RPC_URL: "https://rpc.invalid/path?token=must-not-print",
      PAYER_PRIVATE_KEY: "payer-secret-marker",
      RELAYER_PRIVATE_KEY: "relayer-secret-marker",
      CHAIN_ID: "1",
      TOKEN_ADDRESS: "0x4444444444444444444444444444444444444444",
    });
    const summary = JSON.stringify(publicConfigSummary(withRpcSecret));
    assert.ok(!summary.includes("must-not-print"));
    assert.ok(!summary.includes("secret-marker"));
    assert.equal(withRpcSecret.chainId, 84532);
    assert.equal(withRpcSecret.token, NATIVE_USDC);
    assert.ok(!Object.hasOwn(withRpcSecret, "PAYER_PRIVATE_KEY"));
  });

  it("reports missing variable names only", () => {
    getConfigError(() => parsePublicConfig({}), "missing_configuration", [
      "EXPECTED_PAYER",
      "RELAYER_ADDRESS",
      "PROVIDER_PAYOUT",
      "MAX_FEE_PER_GAS_ATOMIC",
      "MAX_PRIORITY_FEE_PER_GAS_ATOMIC",
      "MAX_TOTAL_GAS",
      "MAX_L1_FEE_WEI",
    ]);
  });

  it("normalizes valid addresses and rejects zero or colliding roles", () => {
    const mixedCase = { ...BASE_ENV, EXPECTED_PAYER: "0xA111111111111111111111111111111111111111" };
    assert.equal(parsePublicConfig(mixedCase).payer, "0xa111111111111111111111111111111111111111");
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, EXPECTED_PAYER: `0x${"0".repeat(40)}` }), "invalid_address", ["EXPECTED_PAYER"]);
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, RELAYER_ADDRESS: BASE_ENV.EXPECTED_PAYER }), "address_collision");
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, PROVIDER_PAYOUT: NATIVE_USDC }), "address_collision");
  });

  it("requires explicit bounded budgets covering all four fixed transaction caps", () => {
    assert.equal(PUBLIC_GAS_CAP_TOTAL, 3_100_000n);
    assert.equal(PUBLIC_MAX_TOTAL_GAS, 4_000_000n);
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, MAX_PRIORITY_FEE_PER_GAS_ATOMIC: "10000000001" }), "invalid_budget", ["MAX_PRIORITY_FEE_PER_GAS_ATOMIC"]);
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, MAX_TOTAL_GAS: "3099999" }), "insufficient_budget");
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, MAX_TOTAL_GAS: "4000001" }), "invalid_budget");
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, MAX_L1_FEE_WEI: "0" }), "invalid_budget", ["MAX_L1_FEE_WEI"]);
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, MAX_FEE_PER_GAS_ATOMIC: "1e9" }), "invalid_budget", ["MAX_FEE_PER_GAS_ATOMIC"]);
  });

  it("requires the exact one-time scope and only checks signer-variable presence in execute mode", () => {
    getConfigError(() => parsePublicConfig(BASE_ENV, { execute: true }), "execution_scope_required", ["M1_PUBLIC_SCOPE"]);
    const scoped = { ...BASE_ENV, M1_PUBLIC_SCOPE: PUBLIC_EXECUTION_SCOPE };
    getConfigError(() => parsePublicConfig(scoped, { execute: true }), "signer_configuration_missing", ["PAYER_PRIVATE_KEY", "RELAYER_PRIVATE_KEY"]);
    const configured = parsePublicConfig({
      ...scoped,
      PAYER_PRIVATE_KEY: "opaque-payer-key",
      RELAYER_PRIVATE_KEY: "opaque-relayer-key",
    }, { execute: true });
    assert.equal(configured.mode, "execute");
    const summary = JSON.stringify(publicConfigSummary(configured));
    assert.ok(!summary.includes("opaque-"));
    assert.ok(!Object.hasOwn(configured, "PAYER_PRIVATE_KEY"));
  });

  it("rejects credential-bearing RPC authority strings without echoing them", () => {
    getConfigError(() => parsePublicConfig({ ...BASE_ENV, BASE_SEPOLIA_RPC_URL: "https://user:pass@rpc.invalid/" }), "invalid_rpc_url", ["BASE_SEPOLIA_RPC_URL"]);
  });
});
