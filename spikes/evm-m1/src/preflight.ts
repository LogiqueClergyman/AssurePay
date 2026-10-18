import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const NATIVE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const EXPECTED_RECEIVE_REJECTION = "FiatTokenV2: invalid signature";

const TOKEN_ABI = [
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

export interface ReadOnlyRpcClient {
  getChainId(): Promise<number>;
  getBlock(args?: { blockNumber?: bigint }): Promise<{
    number: bigint | null;
    hash: Hex | null;
    timestamp: bigint;
  }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  call(args: { from?: Address; to: Address; data: Hex; blockNumber: bigint; gas: bigint }): Promise<Hex>;
}

export type PreflightCode =
  | "ok"
  | "wrong_chain"
  | "no_token_code"
  | "wrong_token_decimals"
  | "token_metadata_unavailable"
  | "domain_mismatch"
  | "nonce_state_unavailable"
  | "nonce_already_used"
  | "receive_call_unavailable"
  | "receive_rejection_unrecognized"
  | "block_unavailable"
  | "block_changed"
  | "rpc_unavailable";

export interface PreflightResult {
  ok: boolean;
  code: PreflightCode;
  chainId: number;
  token: Address;
  block?: { number: string; hash: Hex; timestamp: string };
  tokenName?: string;
  tokenVersion?: string;
  decimals?: number;
  domainMatches?: boolean;
  nonceUnused?: boolean;
  receiveAuthorizationAbi?: "vrs";
}

const TEST_FROM = "0x1111111111111111111111111111111111111111" as Address;
const TEST_TO = "0x2222222222222222222222222222222222222222" as Address;
const TEST_NONCE = `0x${"11".repeat(32)}` as Hex;
// Degenerate zero scalars fail in ECDSA recovery before Circle's signer check.
const PROBE_SCALAR = `0x${"00".repeat(31)}01` as Hex;
const RECEIVE_CALL_GAS = 300_000n;

function domainSeparator(name: string, version: string, chainId: number, verifyingContract: Address): Hex {
  const typeHash = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [typeHash, keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), verifyingContract],
  ));
}

function extractRevertData(error: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  for (let i = 0; i < 16 && pending.length; i++) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as { data?: unknown; cause?: unknown; details?: unknown };
    if (typeof value.data === "string" && /^0x[0-9a-fA-F]*$/.test(value.data)) return value.data as Hex;
    if (value.cause) pending.push(value.cause);
    if (value.details && typeof value.details === "object") pending.push(value.details);
  }
  return undefined;
}

function isExpectedInvalidSignature(data: Hex): boolean {
  if (!/^0x08c379a0[0-9a-fA-F]+$/.test(data)) return false;
  try {
    const [reason] = decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}` as Hex);
    if (reason !== EXPECTED_RECEIVE_REJECTION) return false;
    const canonicalData = `0x08c379a0${encodeAbiParameters([{ type: "string" }], [reason]).slice(2)}`;
    return canonicalData.toLowerCase() === data.toLowerCase();
  } catch {
    return false;
  }
}

function result(code: PreflightCode, extra: Partial<PreflightResult> = {}): PreflightResult {
  return { ok: code === "ok", code, chainId: BASE_SEPOLIA_CHAIN_ID, token: NATIVE_USDC, ...extra };
}

export async function runPreflight(client: ReadOnlyRpcClient): Promise<PreflightResult> {
  try {
    const chainId = await client.getChainId();
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) return result("wrong_chain", { chainId });

    const initialBlock = await client.getBlock();
    if (initialBlock.number === null || initialBlock.hash === null) return result("block_unavailable");
    const block = { number: initialBlock.number.toString(), hash: initialBlock.hash, timestamp: initialBlock.timestamp.toString() };
    const blockNumber = initialBlock.number;

    const code = await client.getCode({ address: NATIVE_USDC, blockNumber });
    if (!code || code === "0x") return result("no_token_code", { block });

    const call = async (functionName: string, args: readonly unknown[] = []): Promise<Hex> => client.call({
      to: NATIVE_USDC,
      data: encodeFunctionData({ abi: TOKEN_ABI, functionName: functionName as never, args: args as never }),
      from: TEST_TO,
      blockNumber,
      gas: 100_000n,
    });
    let decimals: number;
    let name: string;
    let version: string;
    let actualDomain: Hex;
    try {
      [decimals, name, version, actualDomain] = await Promise.all([
        call("decimals").then((data) => decodeFunctionResult({ abi: TOKEN_ABI, functionName: "decimals", data })),
        call("name").then((data) => decodeFunctionResult({ abi: TOKEN_ABI, functionName: "name", data })),
        call("version").then((data) => decodeFunctionResult({ abi: TOKEN_ABI, functionName: "version", data })),
        call("DOMAIN_SEPARATOR").then((data) => decodeFunctionResult({ abi: TOKEN_ABI, functionName: "DOMAIN_SEPARATOR", data })),
      ]);
    } catch {
      return result("token_metadata_unavailable", { block });
    }
    if (name.length > 64 || version.length > 64) return result("token_metadata_unavailable", { block });
    if (decimals !== 6) return result("wrong_token_decimals", { block, decimals, tokenName: name, tokenVersion: version });
    if (!name || !version || actualDomain.toLowerCase() !== domainSeparator(name, version, chainId, NATIVE_USDC).toLowerCase()) {
      return result("domain_mismatch", { block, decimals, tokenName: name, tokenVersion: version, domainMatches: false });
    }

    let nonceUsed: boolean;
    try {
      const data = await call("authorizationState", [TEST_FROM, TEST_NONCE]);
      nonceUsed = decodeFunctionResult({ abi: TOKEN_ABI, functionName: "authorizationState", data });
    } catch {
      return result("nonce_state_unavailable", { block, decimals, tokenName: name, tokenVersion: version, domainMatches: true });
    }
    if (nonceUsed) return result("nonce_already_used", { block, decimals, tokenName: name, tokenVersion: version, domainMatches: true, nonceUnused: false });

    const validAfter = initialBlock.timestamp > 0n ? initialBlock.timestamp - 1n : 0n;
    const validBefore = initialBlock.timestamp + 300n;
    const receiveData = encodeFunctionData({
      abi: TOKEN_ABI,
      functionName: "receiveWithAuthorization",
      args: [TEST_FROM, TEST_TO, 1n, validAfter, validBefore, TEST_NONCE, 27, PROBE_SCALAR, PROBE_SCALAR],
    });
    try {
      await client.call({ from: TEST_TO, to: NATIVE_USDC, data: receiveData, blockNumber, gas: RECEIVE_CALL_GAS });
      return result("receive_rejection_unrecognized", { block, decimals, tokenName: name, tokenVersion: version, domainMatches: true, nonceUnused: true });
    } catch (error) {
      const revertData = extractRevertData(error);
      if (!revertData) {
        return result("receive_call_unavailable", { block, decimals, tokenName: name, tokenVersion: version, domainMatches: true, nonceUnused: true });
      }
      if (!isExpectedInvalidSignature(revertData)) {
        return result("receive_rejection_unrecognized", { block, decimals, tokenName: name, tokenVersion: version, domainMatches: true, nonceUnused: true });
      }
    }

    const finalBlock = await client.getBlock({ blockNumber });
    if (finalBlock.hash?.toLowerCase() !== initialBlock.hash.toLowerCase()) {
      return result("block_changed", { block, decimals, tokenName: name, tokenVersion: version, domainMatches: true, nonceUnused: true, receiveAuthorizationAbi: "vrs" });
    }
    return result("ok", { block, decimals, tokenName: name, tokenVersion: version, domainMatches: true, nonceUnused: true, receiveAuthorizationAbi: "vrs" });
  } catch {
    return result("rpc_unavailable");
  }
}

export function validateRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}
