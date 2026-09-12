// This file is auto-generated, do not modify
/* eslint-disable */
import { Contract, abimethod, arc4, err } from '@algorandfoundation/algorand-typescript'

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

  @abimethod({ readonly: true })
  getConfig(): AssuranceConfig {
    err('stub only')
  }

  @abimethod({ readonly: true })
  getAccounting(): AssuranceAccounting {
    err('stub only')
  }
}
