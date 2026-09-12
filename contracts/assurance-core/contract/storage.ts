import { arc4 } from '@algorandfoundation/algorand-typescript'

export class ProviderRecord extends arc4.Struct<{
  ownerAddress: arc4.Address
  payoutAddress: arc4.Address
  receiptSigningPublicKey: arc4.StaticBytes<32>
  active: arc4.Bool
  stakeTotal: arc4.Uint64
  stakeLocked: arc4.Uint64
  openFaultExposure: arc4.Uint64
  createdAt: arc4.Uint64
}> {}

export class PolicyRecord extends arc4.Struct<{
  providerId: arc4.StaticBytes<32>
  active: arc4.Bool
  premiumBps: arc4.Uint64
  collateralRatioBps: arc4.Uint64
  maxCoverageAmount: arc4.Uint64
  claimWindowSeconds: arc4.Uint64
  createdAt: arc4.Uint64
}> {}

export class CoverageRecord extends arc4.Struct<{
  providerId: arc4.StaticBytes<32>
  policyId: arc4.StaticBytes<32>
  payerAddress: arc4.Address
  grossAmount: arc4.Uint64
  providerNetAmount: arc4.Uint64
  premiumAmount: arc4.Uint64
  stakeTopupAmount: arc4.Uint64
  lockedStakeAmount: arc4.Uint64
  requestHash: arc4.StaticBytes<32>
  openedAt: arc4.Uint64
  expiresAt: arc4.Uint64
  status: arc4.Uint64
  exposureReleased: arc4.Bool
}> {}

export class FinalizedClaimRecord extends arc4.Struct<{
  coverageId: arc4.StaticBytes<32>
  approved: arc4.Bool
  approvedAmount: arc4.Uint64
  providerFault: arc4.Bool
  resolutionCode: arc4.Uint64
  stakeDebit: arc4.Uint64
  poolDebit: arc4.Uint64
  resolvedAt: arc4.Uint64
}> {}

export type RecordId = arc4.StaticBytes<32>
