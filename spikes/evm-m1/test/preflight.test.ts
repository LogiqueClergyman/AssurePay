import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  BASE_SEPOLIA_CHAIN_ID,
  EXPECTED_RECEIVE_REJECTION,
  NATIVE_USDC,
  runPreflight,
  validateRpcUrl,
  type ReadOnlyRpcClient,
} from "../src/preflight.js";

const ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "receiveWithAuthorization", stateMutability: "nonpayable", inputs: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
  ], outputs: [] },
] as const;
const BLOCK = { number: 20_000_000n, hash: `0x${"ab".repeat(32)}` as Hex, timestamp: 1_800_000_000n };
const REVERT = {
  data: `0x08c379a0${encodeAbiParameters([{ type: "string" }], [EXPECTED_RECEIVE_REJECTION]).slice(2)}` as Hex,
};

function validDomain(): Hex {
  const typeHash = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [typeHash, keccak256(stringToHex("USDC")), keccak256(stringToHex("2")), BigInt(BASE_SEPOLIA_CHAIN_ID), NATIVE_USDC],
  ));
}

function fixture(overrides: {
  chainId?: number;
  code?: Hex;
  decimals?: number;
  domain?: Hex;
  nonceUsed?: boolean;
  rejection?: unknown;
  callFailure?: boolean;
  receiveCallFailure?: boolean;
  changeBlock?: boolean;
} = {}) {
  const calls: Array<{ from: Address | undefined; to: Address; blockNumber: bigint; gas: bigint; name: string }> = [];
  let receiveCalls = 0;
  let receiveArgs: readonly unknown[] | undefined;
  const client: ReadOnlyRpcClient = {
    getChainId: async () => overrides.chainId ?? BASE_SEPOLIA_CHAIN_ID,
    getBlock: async ({ blockNumber } = {}) => overrides.changeBlock && blockNumber !== undefined
      ? { ...BLOCK, hash: `0x${"cd".repeat(32)}` as Hex }
      : BLOCK,
    getCode: async ({ address, blockNumber }) => {
      assert.equal(address, NATIVE_USDC);
      assert.equal(blockNumber, BLOCK.number);
      return overrides.code ?? "0x60006000";
    },
    call: async ({ from, to, data, blockNumber, gas }) => {
      assert.equal(to, NATIVE_USDC);
      assert.equal(blockNumber, BLOCK.number);
      calls.push({ from, to, blockNumber, gas, name: decodeFunctionData({ abi: ABI, data }).functionName });
      if (overrides.callFailure) throw new Error("transport unavailable");
      const { functionName } = decodeFunctionData({ abi: ABI, data });
      if (functionName === "decimals") return encodeFunctionResult({ abi: ABI, functionName, result: overrides.decimals ?? 6 });
      if (functionName === "name") return encodeFunctionResult({ abi: ABI, functionName, result: "USDC" });
      if (functionName === "version") return encodeFunctionResult({ abi: ABI, functionName, result: "2" });
      if (functionName === "DOMAIN_SEPARATOR") return encodeFunctionResult({ abi: ABI, functionName, result: overrides.domain ?? validDomain() });
      if (functionName === "authorizationState") return encodeFunctionResult({ abi: ABI, functionName, result: overrides.nonceUsed ?? false });
      receiveCalls++;
      receiveArgs = decodeFunctionData({ abi: ABI, data }).args;
      if (overrides.receiveCallFailure) throw new Error("transport unavailable");
      throw overrides.rejection ?? REVERT;
    },
  };
  return { client, calls, receiveCalls: () => receiveCalls, receiveArgs: () => receiveArgs };
}

describe("signer-free Base Sepolia preflight", () => {
  it("checks token identity and receiveWithAuthorization at one canonical block", async () => {
    const f = fixture();
    const result = await runPreflight(f.client);
    assert.deepEqual(result, {
      ok: true,
      code: "ok",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      token: NATIVE_USDC,
      block: { number: BLOCK.number.toString(), hash: BLOCK.hash, timestamp: BLOCK.timestamp.toString() },
      tokenName: "USDC",
      tokenVersion: "2",
      decimals: 6,
      domainMatches: true,
      nonceUnused: true,
      receiveAuthorizationAbi: "vrs",
    });
    assert.ok(f.calls.every((call) => call.blockNumber === BLOCK.number && call.to === NATIVE_USDC));
    assert.equal(f.calls.find((call) => call.name === "receiveWithAuthorization")?.gas, 300_000n);
    assert.equal(f.calls.find((call) => call.name === "receiveWithAuthorization")?.from, "0x2222222222222222222222222222222222222222");
    const args = f.receiveArgs();
    assert.ok(args);
    assert.equal(args[1], f.calls.find((call) => call.name === "receiveWithAuthorization")?.from);
    assert.equal(args[6], 27);
    assert.equal(args[7], `0x${"00".repeat(31)}01`);
    assert.equal(args[8], `0x${"00".repeat(31)}01`);
    assert.equal(f.receiveCalls(), 1);
  });

  it("rejects the wrong chain before querying token state", async () => {
    const f = fixture({ chainId: 1 });
    const result = await runPreflight(f.client);
    assert.equal(result.code, "wrong_chain");
    assert.equal(f.calls.length, 0);
  });

  it("rejects missing code, unexpected decimals, domain mismatch and used nonce", async () => {
    assert.equal((await runPreflight(fixture({ code: "0x" }).client)).code, "no_token_code");
    assert.equal((await runPreflight(fixture({ decimals: 18 }).client)).code, "wrong_token_decimals");
    assert.equal((await runPreflight(fixture({ domain: `0x${"00".repeat(32)}` as Hex }).client)).code, "domain_mismatch");
    assert.equal((await runPreflight(fixture({ nonceUsed: true }).client)).code, "nonce_already_used");
  });

  it("requires the exact recognized invalid-signature revert and catches read failures", async () => {
    const unknown = await runPreflight(fixture({ rejection: { cause: { data: "0x" } } }).client);
    assert.equal(unknown.code, "receive_rejection_unrecognized");
    const noTransport = await runPreflight(fixture({ receiveCallFailure: true }).client);
    assert.equal(noTransport.code, "receive_call_unavailable");
    const unavailable = await runPreflight(fixture({ callFailure: true }).client);
    assert.equal(unavailable.code, "token_metadata_unavailable");
  });

  it("detects a changed canonical block and restricts endpoint schemes", async () => {
    assert.equal((await runPreflight(fixture({ changeBlock: true }).client)).code, "block_changed");
    assert.equal(validateRpcUrl("https://rpc.example"), true);
    assert.equal(validateRpcUrl("http://localhost:8545"), true);
    assert.equal(validateRpcUrl("http://[::1]:8545"), true);
    assert.equal(validateRpcUrl("http://rpc.example"), false);
    assert.equal(validateRpcUrl("file:///tmp/rpc"), false);
    assert.equal(validateRpcUrl("https://user:secret@rpc.example"), false);
    assert.equal(validateRpcUrl("https://rpc.example/#credential"), false);
  });

  it("exposes no broadcast capability on its injected client contract", () => {
    const f = fixture();
    assert.equal("sendTransaction" in f.client, false);
    assert.equal("request" in f.client, false);
  });
});
