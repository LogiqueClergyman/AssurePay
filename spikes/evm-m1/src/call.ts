import { encodeFunctionData, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { buildReceiveWithAuthorization, type Intent } from "./intent.js";
import { validatePayment, type ProfileConfiguration } from "./profile.js";

const INTENT_ABI_TUPLE =
  "(uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore)";
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export const SPIKE_CORE_ABI = parseAbi([
  `function settleAssured(${INTENT_ABI_TUPLE} intent,uint8 v,bytes32 r,bytes32 s) returns (bytes32 coverageId)`,
  `function hashIntent(${INTENT_ABI_TUPLE} intent) pure returns (bytes32)`,
  "function coverages(bytes32 coverageId) view returns (address payer,bytes32 requestHash,uint256 gross)",
  "function coverageCount() view returns (uint256)",
  "function premiumReserve() view returns (uint256)",
  "event CoverageOpened(bytes32 indexed coverageId,address indexed payer,bytes32 indexed providerId,bytes32 policyId,bytes32 requestHash,uint256 gross,uint256 net,uint256 premium)",
]);

export type PreparedCoreCall = Readonly<{
  to: Address;
  data: Hex;
  intentHash: Hex;
  payer: Address;
}>;

export class CoreCallError extends Error {
  constructor(readonly code: "INVALID_PAYMENT" | "INVALID_SIGNATURE" | "CALL_ENCODING_FAILED" | "CALL_REVALIDATION_FAILED") {
    super(`M1_CORE_CALL_${code}`);
    this.name = "CoreCallError";
  }
}

function signatureParts(signature: Hex): { v: number; r: Hex; s: Hex } {
  const body = signature.slice(2);
  const recovery = Number.parseInt(body.slice(128, 130), 16);
  const s = BigInt(`0x${body.slice(64, 128)}`);
  if ((recovery !== 27 && recovery !== 28) || s === 0n || s > SECP256K1_HALF_ORDER) {
    throw new CoreCallError("INVALID_SIGNATURE");
  }
  return {
    v: recovery,
    r: `0x${body.slice(0, 64)}` as Hex,
    s: `0x${body.slice(64, 128)}` as Hex,
  };
}

function solidityIntent(intent: Intent) {
  return {
    chainId: BigInt(intent.chainId),
    core: intent.core,
    token: intent.token,
    payer: intent.payer,
    providerId: intent.providerId,
    policyId: intent.policyId,
    policyHash: intent.policyHash,
    requestHash: intent.requestHash,
    gross: BigInt(intent.gross),
    payerSalt: intent.payerSalt,
    validAfter: BigInt(intent.validAfter),
    validBefore: BigInt(intent.validBefore),
  };
}

/** Validate the signed payload and prepare only the fixed Core settlement call. */
export async function prepareCoreCall(
  payload: unknown,
  configuration: ProfileConfiguration,
  now: bigint,
): Promise<PreparedCoreCall> {
  let validated;
  try {
    validated = validatePayment(payload, configuration, now);
  } catch {
    throw new CoreCallError("INVALID_PAYMENT");
  }

  const signature = signatureParts(validated.signature);
  let recovered: Address;
  try {
    const typed = buildReceiveWithAuthorization(validated.intent, validated.intentHash, {
      name: configuration.tokenName,
      version: configuration.tokenVersion,
      chainId: configuration.bindings.chainId,
      token: configuration.bindings.token,
    });
    recovered = await recoverTypedDataAddress({ ...typed, signature: validated.signature });
  } catch {
    throw new CoreCallError("INVALID_SIGNATURE");
  }
  if (recovered.toLowerCase() !== validated.intent.payer.toLowerCase()) {
    throw new CoreCallError("INVALID_SIGNATURE");
  }

  try {
    const data = encodeFunctionData({
      abi: SPIKE_CORE_ABI,
      functionName: "settleAssured",
      args: [solidityIntent(validated.intent), signature.v, signature.r, signature.s],
    });
    return Object.freeze({
      to: validated.intent.core,
      data,
      intentHash: validated.intentHash,
      payer: validated.intent.payer,
    });
  } catch {
    throw new CoreCallError("CALL_ENCODING_FAILED");
  }
}

/** Recompute immediately before submission and preserve the previously prepared bytes. */
export async function revalidateCoreCall(
  prepared: PreparedCoreCall,
  payload: unknown,
  configuration: ProfileConfiguration,
  now: bigint,
): Promise<PreparedCoreCall> {
  let recomputed: PreparedCoreCall;
  try {
    recomputed = await prepareCoreCall(payload, configuration, now);
  } catch {
    throw new CoreCallError("CALL_REVALIDATION_FAILED");
  }
  if (
    prepared.to !== recomputed.to || prepared.data !== recomputed.data
      || prepared.intentHash !== recomputed.intentHash || prepared.payer !== recomputed.payer
  ) {
    throw new CoreCallError("CALL_REVALIDATION_FAILED");
  }
  return prepared;
}
