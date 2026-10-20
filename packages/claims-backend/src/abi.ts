import { parseAbi } from 'viem';

/** The read and claim surface of the frozen M2 AssuranceCore. */
export const CORE_ABI = parseAbi([
  'function token() view returns (address)',
  'function adjudicator() view returns (address)',
  'function coverageCount() view returns (uint256)',
  'function coverages(bytes32) view returns (address payer, bytes32 providerId, bytes32 policyId, bytes32 policyHash, bytes32 requestHash, uint256 gross, uint256 premium, uint256 withheld, uint256 stakeLock, uint256 poolReservation, uint64 openedAt, uint64 expiresAt, bool poolOnlyAllowed, uint8 status, bytes32 evidenceHash, bytes32 decisionHash, uint256 refundAmount, uint8 outcome)',
  'function fileClaim(bytes32 coverageId, bytes32 evidenceHash)',
  'function finalizeClaim(bytes32 coverageId, uint8 outcome, uint256 refundAmount, bytes32 decisionHash)',
  'event CoverageOpened(bytes32 indexed coverageId, address indexed payer, bytes32 indexed providerId, bytes32 policyId, bytes32 requestHash, uint256 gross, uint256 premium, uint256 withheld, uint256 net, uint256 stakeLock, uint256 poolReservation, uint64 expiresAt)',
]);
