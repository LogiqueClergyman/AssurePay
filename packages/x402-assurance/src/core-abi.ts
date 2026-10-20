import { parseAbi } from 'viem';

/** Frozen read/call/event subset of the accepted M2 Core ABI. */
export const CORE_ABI = parseAbi([
  'function token() view returns (address)',
  'function providers(bytes32) view returns (address owner,address payout,uint256 freeStake,uint256 lockedStake)',
  'function policies(bytes32) view returns (bytes32 providerId,bytes32 policyHash,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)',
  'function quoteSettlement(bytes32,uint256) view returns (uint256 premium,uint256 withheld,uint256 net,uint256 stakeLock,uint256 poolReservation)',
  'function hashIntent((uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore) intent) pure returns (bytes32)',
  'function settleAssured((uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore) intent,uint8 v,bytes32 r,bytes32 s) returns (bytes32 coverageId)',
  'function coverages(bytes32) view returns (address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,uint256 premium,uint256 withheld,uint256 stakeLock,uint256 poolReservation,uint64 openedAt,uint64 expiresAt,bool poolOnlyAllowed,uint8 status,bytes32 evidenceHash,bytes32 decisionHash,uint256 refundAmount,uint8 outcome)',
  'event CoverageOpened(bytes32 indexed coverageId,address indexed payer,bytes32 indexed providerId,bytes32 policyId,bytes32 requestHash,uint256 gross,uint256 premium,uint256 withheld,uint256 net,uint256 stakeLock,uint256 poolReservation,uint64 expiresAt)',
]);
