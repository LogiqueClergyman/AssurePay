import { parseAbi } from 'viem';

/** Fixed AssuranceCore read, action, and registry/event surface used by M11. */
export const CORE_ABI = parseAbi([
  'function admin() view returns (address)',
  'function adjudicator() view returns (address)',
  'function token() view returns (address)',
  'function paused() view returns (bool)',
  'function poolAssets() view returns (uint256)',
  'function totalPoolReserved() view returns (uint256)',
  'function totalProviderStake() view returns (uint256)',
  'function totalLockedStake() view returns (uint256)',
  'function coverageCount() view returns (uint256)',
  'function activeCoverageCount() view returns (uint256)',
  'function providers(bytes32) view returns (address owner, address payout, uint256 freeStake, uint256 lockedStake)',
  'function policies(bytes32) view returns (bytes32 providerId, bytes32 policyHash, uint16 premiumBps, uint16 stakeBps, uint16 withholdingBps, uint64 duration, bool poolOnlyAllowed)',
  'function coverages(bytes32) view returns (address payer, bytes32 providerId, bytes32 policyId, bytes32 policyHash, bytes32 requestHash, uint256 gross, uint256 premium, uint256 withheld, uint256 stakeLock, uint256 poolReservation, uint64 openedAt, uint64 expiresAt, bool poolOnlyAllowed, uint8 status, bytes32 evidenceHash, bytes32 decisionHash, uint256 refundAmount, uint8 outcome)',
  'function registerProvider(bytes32 providerId, address owner, address payout)',
  'function registerPolicy(bytes32 policyId, bytes32 providerId, uint16 premiumBps, uint16 stakeBps, uint16 withholdingBps, uint64 duration, bool poolOnlyAllowed)',
  'function setPaused(bool paused)',
  'function depositStake(bytes32 providerId, uint256 amount)',
  'function withdrawStake(bytes32 providerId, uint256 amount)',
  'function fundPool(uint256 amount)',
  'function finalizeClaim(bytes32 coverageId, uint8 outcome, uint256 refundAmount, bytes32 decisionHash)',
  'event ProviderRegistered(bytes32 indexed providerId, address indexed owner, address indexed payout)',
  'event PolicyRegistered(bytes32 indexed policyId, bytes32 indexed providerId, bytes32 policyHash, uint16 premiumBps, uint16 stakeBps, uint16 withholdingBps, uint64 duration, bool poolOnlyAllowed)',
  'event PauseUpdated(bool paused)',
  'event StakeDeposited(bytes32 indexed providerId, address indexed funder, uint256 amount)',
  'event PoolFunded(address indexed funder, uint256 amount)',
  'event StakeWithdrawn(bytes32 indexed providerId, address indexed owner, uint256 amount)',
  'event CoverageOpened(bytes32 indexed coverageId, address indexed payer, bytes32 indexed providerId, bytes32 policyId, bytes32 requestHash, uint256 gross, uint256 premium, uint256 withheld, uint256 net, uint256 stakeLock, uint256 poolReservation, uint64 expiresAt)',
  'event ClaimFiled(bytes32 indexed coverageId, address indexed payer, bytes32 evidenceHash)',
  'event ClaimFinalized(bytes32 indexed coverageId, uint8 outcome, uint256 refundAmount, bytes32 decisionHash)',
  'event CoverageExpired(bytes32 indexed coverageId, uint256 stakeReleased, uint256 poolReservationReleased)',
]);

export const TOKEN_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);
