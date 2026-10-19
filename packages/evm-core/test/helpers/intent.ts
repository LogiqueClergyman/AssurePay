import {
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';

/** Kept byte-for-byte aligned with the accepted M1 twelve-field tuple. */
export const INTENT_TYPE_LITERAL =
  'AssuredIntentV1(uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore)' as const;

export const POLICY_TYPE_LITERAL =
  'AssuredPolicyV1(bytes32 providerId,bytes32 policyId,address providerOwner,address providerPayout,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)' as const;

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

export type PolicyTerms = {
  providerId: Hex;
  policyId: Hex;
  providerOwner: Address;
  providerPayout: Address;
  premiumBps: number;
  stakeBps: number;
  withholdingBps: number;
  duration: bigint;
  poolOnlyAllowed: boolean;
};

export function hashIntent(intent: Intent): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' },
      { type: 'address' }, { type: 'address' }, { type: 'bytes32' },
      { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
      { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' },
      { type: 'uint256' },
    ],
    [
      keccak256(toBytes(INTENT_TYPE_LITERAL)), BigInt(intent.chainId),
      intent.core, intent.token, intent.payer, intent.providerId,
      intent.policyId, intent.policyHash, intent.requestHash,
      BigInt(intent.gross), intent.payerSalt, BigInt(intent.validAfter),
      BigInt(intent.validBefore),
    ],
  ));
}

export function hashPolicy(policy: PolicyTerms): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
      { type: 'address' }, { type: 'address' }, { type: 'uint16' },
      { type: 'uint16' }, { type: 'uint16' }, { type: 'uint64' },
      { type: 'bool' },
    ],
    [
      keccak256(toBytes(POLICY_TYPE_LITERAL)), policy.providerId,
      policy.policyId, policy.providerOwner, policy.providerPayout,
      policy.premiumBps, policy.stakeBps, policy.withholdingBps,
      policy.duration, policy.poolOnlyAllowed,
    ],
  ));
}

export function typeIntent(intent: Intent) {
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
  } as const;
}
