import {
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";

/** M1 candidate selected for evaluation; the production wire API remains experimental. */
export const INTENT_TYPE_LITERAL =
  "AssuredIntentV1(uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore)" as const;

export const INTENT_FIELDS = [
  "chainId",
  "core",
  "token",
  "payer",
  "providerId",
  "policyId",
  "policyHash",
  "requestHash",
  "gross",
  "payerSalt",
  "validAfter",
  "validBefore",
] as const;

export const MAX_AUTHORIZATION_SECONDS = 300n;
export const FIXTURE_GROSS = "100" as const;
export const RECEIVE_WITH_AUTHORIZATION_TYPE =
  "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)" as const;

export type Intent = {
  chainId: string;
  core: Address;
  token: Address;
  payer: Address;
  providerId: Hex;
  policyId: Hex;
  policyHash: Hex;
  requestHash: Hex;
  gross: string;
  payerSalt: Hex;
  validAfter: string;
  validBefore: string;
};

export type TrustedIntentBindings = {
  chainId: bigint;
  core: Address;
  token: Address;
  providerId: Hex;
  policyId: Hex;
  policyHash: Hex;
  requestHash: Hex;
  gross?: string;
};

export class IntentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentValidationError";
  }
}

const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

function invalid(message: string): never {
  throw new IntentValidationError(message);
}

function parseUint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || value.length > 78 || !DECIMAL_RE.test(value)) {
    return invalid(`${field} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) return invalid(`${field} exceeds uint256`);
  return parsed;
}

function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    return invalid(`${field} must be a canonical lowercase 0x address`);
  }
  if (/^0x0{40}$/.test(value)) return invalid(`${field} must be nonzero`);
  return value as Address;
}

function parseBytes32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !BYTES32_RE.test(value)) {
    return invalid(`${field} must be canonical lowercase bytes32`);
  }
  if (/^0x0{64}$/.test(value)) return invalid(`${field} must be nonzero`);
  return value as Hex;
}

function assertPlainExactObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("intent must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid("intent must be a plain object");
  }
  const keys = Object.keys(value);
  if (keys.length !== INTENT_FIELDS.length || INTENT_FIELDS.some((key) => !Object.hasOwn(value, key))) {
    return invalid("intent must contain exactly the AssuredIntentV1 fields");
  }
}

/** Parse an untrusted JSON object and compare every trusted binding explicitly. */
export function parseIntent(
  input: unknown,
  trusted: TrustedIntentBindings,
  nowSeconds: bigint,
): Intent {
  assertPlainExactObject(input);

  const intent: Intent = {
    chainId: input.chainId as string,
    core: parseAddress(input.core, "core"),
    token: parseAddress(input.token, "token"),
    payer: parseAddress(input.payer, "payer"),
    providerId: parseBytes32(input.providerId, "providerId"),
    policyId: parseBytes32(input.policyId, "policyId"),
    policyHash: parseBytes32(input.policyHash, "policyHash"),
    requestHash: parseBytes32(input.requestHash, "requestHash"),
    gross: input.gross as string,
    payerSalt: parseBytes32(input.payerSalt, "payerSalt"),
    validAfter: input.validAfter as string,
    validBefore: input.validBefore as string,
  };

  const chainId = parseUint(intent.chainId, "chainId");
  const gross = parseUint(intent.gross, "gross");
  const validAfter = parseUint(intent.validAfter, "validAfter");
  const validBefore = parseUint(intent.validBefore, "validBefore");
  const trustedGross = parseUint(trusted.gross ?? FIXTURE_GROSS, "trusted gross");
  const trustedCore = parseAddress(trusted.core.toLowerCase(), "trusted Core");
  const trustedToken = parseAddress(trusted.token.toLowerCase(), "trusted token");
  if (nowSeconds < 0n) return invalid("nowSeconds must be nonnegative");
  if (trusted.chainId <= 0n || trusted.chainId > UINT256_MAX) {
    return invalid("trusted chainId is outside uint256");
  }
  if (chainId !== trusted.chainId) return invalid("chainId does not match trusted chain");
  if (intent.core !== trustedCore) return invalid("core does not match trusted Core");
  if (intent.token !== trustedToken) return invalid("token does not match trusted token");
  if (intent.providerId !== trusted.providerId) return invalid("providerId does not match trusted provider");
  if (intent.policyId !== trusted.policyId) return invalid("policyId does not match trusted policy");
  if (intent.policyHash !== trusted.policyHash) return invalid("policyHash does not match trusted policy hash");
  if (intent.requestHash !== trusted.requestHash) return invalid("requestHash does not match trusted request");
  if (gross === 0n) return invalid("gross must be nonzero");
  if (trustedGross === 0n) return invalid("trusted gross must be nonzero");
  if (gross !== trustedGross) {
    return invalid("gross does not match trusted fixture amount");
  }
  if (validAfter === 0n || validBefore === 0n) return invalid("authorization bounds must be nonzero");
  if (validAfter >= validBefore) return invalid("validAfter must be before validBefore");
  if (validBefore - validAfter > MAX_AUTHORIZATION_SECONDS) {
    return invalid("authorization duration exceeds 300 seconds");
  }
  if (!(validAfter < nowSeconds && nowSeconds < validBefore)) {
    return invalid("authorization is not currently valid");
  }
  return intent;
}

/** Hash is keccak256(abi.encode(typeHash, all fields)), never packed encoding. */
export function hashIntent(intent: Intent): Hex {
  const typeHash = keccak256(toBytes(INTENT_TYPE_LITERAL));
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      typeHash,
      BigInt(intent.chainId),
      intent.core,
      intent.token,
      intent.payer,
      intent.providerId,
      intent.policyId,
      intent.policyHash,
      intent.requestHash,
      BigInt(intent.gross),
      intent.payerSalt,
      BigInt(intent.validAfter),
      BigInt(intent.validBefore),
    ],
  );
  return keccak256(encoded);
}

export type ReceiveWithAuthorizationTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: Address;
  };
  types: {
    ReceiveWithAuthorization: readonly [
      { name: "from"; type: "address" },
      { name: "to"; type: "address" },
      { name: "value"; type: "uint256" },
      { name: "validAfter"; type: "uint256" },
      { name: "validBefore"; type: "uint256" },
      { name: "nonce"; type: "bytes32" },
    ];
  };
  primaryType: "ReceiveWithAuthorization";
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
};

/** Build token receive authorization typed data from trusted token preflight metadata. */
export function buildReceiveWithAuthorization(
  intent: Intent,
  intentHash: Hex,
  tokenMetadata: { name: string; version: string; chainId: bigint; token: Address },
): ReceiveWithAuthorizationTypedData {
  if (!tokenMetadata.name || !tokenMetadata.version) {
    return invalid("trusted token EIP-712 name and version are required");
  }
  const domainToken = parseAddress(tokenMetadata.token.toLowerCase(), "trusted token domain address");
  if (tokenMetadata.chainId !== BigInt(intent.chainId) || domainToken !== intent.token) {
    return invalid("trusted token EIP-712 domain does not match intent token and chain");
  }
  if (intentHash !== hashIntent(intent)) {
    return invalid("receive authorization nonce must equal the intent hash");
  }
  return {
    domain: {
      name: tokenMetadata.name,
      version: tokenMetadata.version,
      chainId: tokenMetadata.chainId,
      verifyingContract: domainToken,
    },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: intent.payer,
      to: intent.core,
      value: BigInt(intent.gross),
      validAfter: BigInt(intent.validAfter),
      validBefore: BigInt(intent.validBefore),
      nonce: intentHash,
    },
  };
}
