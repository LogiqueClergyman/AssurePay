// This file is auto-generated, do not modify
/* eslint-disable */
import type { gtxn } from '@algorandfoundation/algorand-typescript'
import { Contract, abimethod, arc4, err } from '@algorandfoundation/algorand-typescript'

export class ProviderRecord extends arc4.Struct<{
  ownerAddress: arc4.Address
  payoutAddress: arc4.Address
  receiptSigningPublicKey: arc4.StaticArray<arc4.Byte, 32>
  active: arc4.Bool
  stakeTotal: arc4.Uint<64>
  stakeLocked: arc4.Uint<64>
  openFaultExposure: arc4.Uint<64>
  createdAt: arc4.Uint<64>
}> {}

export class PolicyRecord extends arc4.Struct<{
  providerId: arc4.StaticArray<arc4.Byte, 32>
  active: arc4.Bool
  premiumBps: arc4.Uint<64>
  collateralRatioBps: arc4.Uint<64>
  maxCoverageAmount: arc4.Uint<64>
  claimWindowSeconds: arc4.Uint<64>
  createdAt: arc4.Uint<64>
}> {}

export class CoverageRecord extends arc4.Struct<{
  providerId: arc4.StaticArray<arc4.Byte, 32>
  policyId: arc4.StaticArray<arc4.Byte, 32>
  payerAddress: arc4.Address
  grossAmount: arc4.Uint<64>
  providerNetAmount: arc4.Uint<64>
  premiumAmount: arc4.Uint<64>
  stakeTopupAmount: arc4.Uint<64>
  lockedStakeAmount: arc4.Uint<64>
  requestHash: arc4.StaticArray<arc4.Byte, 32>
  openedAt: arc4.Uint<64>
  expiresAt: arc4.Uint<64>
  status: arc4.Uint<64>
  exposureReleased: arc4.Bool
}> {}

export class FinalizedClaimRecord extends arc4.Struct<{
  coverageId: arc4.StaticArray<arc4.Byte, 32>
  approved: arc4.Bool
  approvedAmount: arc4.Uint<64>
  providerFault: arc4.Bool
  resolutionCode: arc4.Uint<64>
  stakeDebit: arc4.Uint<64>
  poolDebit: arc4.Uint<64>
  resolvedAt: arc4.Uint<64>
}> {}

export class AssuranceConfig extends arc4.Struct<{
  admin: arc4.Address
  adjudicator: arc4.Address
  acceptedAssetId: arc4.Uint<64>
  paused: arc4.Uint<64>
  assetOptedIn: arc4.Uint<64>
}> {}

export class AssuranceAccounting extends arc4.Struct<{
  totalProviderStake: arc4.Uint<64>
  premiumReserve: arc4.Uint<64>
  totalOpenFaultExposure: arc4.Uint<64>
}> {}

/**
 * Gate A production scaffold. Later gates add behavior without changing these namespaces.
 */
export abstract class AssuranceCore extends Contract {
  /**
   * Create the application and freeze its protocol-wide configuration.
   */
  @abimethod({ onCreate: 'require' })
  createApplication(
    assetId: arc4.Uint<64>,
    adjudicator: arc4.Address,
  ): void {
    err('stub only')
  }

  /**
   * Opt the application account into the configured ASA.
   * The inner transaction fee is zero, so the outer application call must pay
   * two minimum fees: one for itself and one pooled fee for this inner axfer.
   */
  @abimethod()
  optInAcceptedAsset(assetId: arc4.Uint<64>): void {
    err('stub only')
  }

  @abimethod()
  setPaused(paused: arc4.Bool): void {
    err('stub only')
  }

  @abimethod()
  registerProvider(
    providerId: arc4.StaticArray<arc4.Byte, 32>,
    payoutAddress: arc4.Address,
    receiptSigningPublicKey: arc4.StaticArray<arc4.Byte, 32>,
  ): void {
    err('stub only')
  }

  @abimethod()
  setProviderStatus(
    providerId: arc4.StaticArray<arc4.Byte, 32>,
    active: arc4.Bool,
  ): void {
    err('stub only')
  }

  @abimethod({ readonly: true })
  getProvider(providerId: arc4.StaticArray<arc4.Byte, 32>): ProviderRecord {
    err('stub only')
  }

  @abimethod()
  createPolicy(
    policyId: arc4.StaticArray<arc4.Byte, 32>,
    providerId: arc4.StaticArray<arc4.Byte, 32>,
    premiumBps: arc4.Uint<64>,
    collateralRatioBps: arc4.Uint<64>,
    maxCoverageAmount: arc4.Uint<64>,
    claimWindowSeconds: arc4.Uint<64>,
  ): void {
    err('stub only')
  }

  @abimethod()
  setPolicyStatus(
    policyId: arc4.StaticArray<arc4.Byte, 32>,
    active: arc4.Bool,
  ): void {
    err('stub only')
  }

  @abimethod({ readonly: true })
  getPolicy(policyId: arc4.StaticArray<arc4.Byte, 32>): PolicyRecord {
    err('stub only')
  }

  @abimethod()
  depositStake(
    providerId: arc4.StaticArray<arc4.Byte, 32>,
    transfer: gtxn.AssetTransferTxn,
  ): void {
    err('stub only')
  }

  @abimethod({ readonly: true })
  getAvailableCapacity(
    providerId: arc4.StaticArray<arc4.Byte, 32>,
    policyId: arc4.StaticArray<arc4.Byte, 32>,
  ): arc4.Uint<64> {
    err('stub only')
  }

  @abimethod()
  openCoverage(
    coverageId: arc4.StaticArray<arc4.Byte, 32>,
    providerId: arc4.StaticArray<arc4.Byte, 32>,
    policyId: arc4.StaticArray<arc4.Byte, 32>,
    requestHash: arc4.StaticArray<arc4.Byte, 32>,
    grossAmount: arc4.Uint<64>,
  ): void {
    err('stub only')
  }

  @abimethod({ readonly: true })
  getCoverage(coverageId: arc4.StaticArray<arc4.Byte, 32>): CoverageRecord {
    err('stub only')
  }

  @abimethod()
  withdrawStake(
    providerId: arc4.StaticArray<arc4.Byte, 32>,
    amount: arc4.Uint<64>,
  ): void {
    err('stub only')
  }

  @abimethod()
  closeCoverage(coverageId: arc4.StaticArray<arc4.Byte, 32>): void {
    err('stub only')
  }

  @abimethod()
  finalizeClaim(
    claimId: arc4.StaticArray<arc4.Byte, 32>,
    coverageId: arc4.StaticArray<arc4.Byte, 32>,
    approved: arc4.Bool,
    approvedAmount: arc4.Uint<64>,
    providerFault: arc4.Bool,
    resolutionCode: arc4.Uint<64>,
  ): void {
    err('stub only')
  }

  @abimethod({ readonly: true })
  getClaim(claimId: arc4.StaticArray<arc4.Byte, 32>): FinalizedClaimRecord {
    err('stub only')
  }

  @abimethod({ readonly: true })
  getConfig(): AssuranceConfig {
    err('stub only')
  }

  @abimethod({ readonly: true })
  getAccounting(): AssuranceAccounting {
    err('stub only')
  }
}
