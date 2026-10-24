import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';

const POLICY_TYPEHASH = keccak256(stringToHex(
  'AssuredPolicyV1(bytes32 providerId,bytes32 policyId,address providerOwner,address providerPayout,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)',
));

export function canonicalPolicyHash(input: {
  providerId: Hex; policyId: Hex; owner: Address; payout: Address;
  premiumBps: number; stakeBps: number; withholdingBps: number; duration: bigint; poolOnlyAllowed: boolean;
}): Hex {
  return keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'address' },
    { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'bool' },
  ], [POLICY_TYPEHASH, input.providerId, input.policyId, input.owner, input.payout,
    input.premiumBps, input.stakeBps, input.withholdingBps, input.duration, input.poolOnlyAllowed]));
}
