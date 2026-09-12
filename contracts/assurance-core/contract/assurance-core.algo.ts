import {
  Account,
  BoxMap,
  Contract,
  Global,
  GlobalState,
  OnCompleteAction,
  Txn,
  abimethod,
  arc4,
  assert,
  contract,
  emit,
  itxn,
} from '@algorandfoundation/algorand-typescript'

import type { uint64 } from '@algorandfoundation/algorand-typescript'

import {
  FinalizedClaimRecord,
  CoverageRecord,
  PolicyRecord,
  ProviderRecord,
  RecordId,
} from './storage'

export class AssuranceConfig extends arc4.Struct<{
  admin: arc4.Address
  adjudicator: arc4.Address
  acceptedAssetId: arc4.Uint64
  paused: arc4.Uint64
  assetOptedIn: arc4.Uint64
}> {}

export class AssuranceAccounting extends arc4.Struct<{
  totalProviderStake: arc4.Uint64
  premiumReserve: arc4.Uint64
  totalOpenFaultExposure: arc4.Uint64
}> {}

/** Gate A production scaffold. Later gates add behavior without changing these namespaces. */
@contract({
  name: 'AssuranceCore',
  avmVersion: 13,
  stateTotals: { globalUints: 6, globalBytes: 2 },
})
export class AssuranceCore extends Contract {
  admin = GlobalState<Account>()
  adjudicator = GlobalState<Account>()
  acceptedAssetId = GlobalState<uint64>()
  paused = GlobalState<uint64>()
  assetOptedIn = GlobalState<uint64>()
  totalProviderStake = GlobalState<uint64>()
  premiumReserve = GlobalState<uint64>()
  totalOpenFaultExposure = GlobalState<uint64>()

  // Stable one-byte prefixes + byte[32] IDs. These are intentionally not ABI methods.
  providers = BoxMap<RecordId, ProviderRecord>({ keyPrefix: 'p' })
  policies = BoxMap<RecordId, PolicyRecord>({ keyPrefix: 'l' })
  coverages = BoxMap<RecordId, CoverageRecord>({ keyPrefix: 'c' })
  claims = BoxMap<RecordId, FinalizedClaimRecord>({ keyPrefix: 'f' })

  /** Create the application and freeze its protocol-wide configuration. */
  @abimethod({ onCreate: 'require', allowActions: 'NoOp' })
  createApplication(assetId: uint64, adjudicator: Account): void {
    assert(assetId > 0, 'asset id must be non-zero')
    assert(adjudicator.bytes !== Global.zeroAddress.bytes, 'adjudicator must be non-zero')
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')

    this.admin.value = Txn.sender
    this.adjudicator.value = adjudicator
    this.acceptedAssetId.value = assetId
    this.paused.value = 0
    this.assetOptedIn.value = 0
    this.totalProviderStake.value = 0
    this.premiumReserve.value = 0
    this.totalOpenFaultExposure.value = 0

    emit(
      'ProtocolCreated',
      new arc4.Uint64(1),
      new arc4.Address(Txn.sender),
      new arc4.Address(adjudicator),
      new arc4.Uint64(assetId),
    )
  }

  /**
   * Opt the application account into the configured ASA.
   * The inner transaction fee is zero, so the outer application call must pay
   * two minimum fees: one for itself and one pooled fee for this inner axfer.
   */
  @abimethod({ allowActions: 'NoOp' })
  optInAcceptedAsset(assetId: uint64): void {
    assert(Txn.sender.bytes === this.admin.value.bytes, 'admin only')
    assert(this.assetOptedIn.value === 0, 'already opted in')
    assert(assetId === this.acceptedAssetId.value, 'wrong asset')
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    assert(Txn.fee >= Global.minTxnFee * 2, 'outer fee must pool inner fee')

    const optIn = itxn.assetTransfer({
      sender: Global.currentApplicationAddress,
      xferAsset: assetId,
      assetAmount: 0,
      assetReceiver: Global.currentApplicationAddress,
      fee: 0,
    }).submit()

    assert(optIn.assetAmount === 0, 'unexpected opt-in amount')
    this.assetOptedIn.value = 1
    emit('ProtocolAssetOptedIn', new arc4.Uint64(1), new arc4.Uint64(assetId))
  }

  @abimethod({ readonly: true })
  getConfig(): AssuranceConfig {
    return new AssuranceConfig({
      admin: new arc4.Address(this.admin.value),
      adjudicator: new arc4.Address(this.adjudicator.value),
      acceptedAssetId: new arc4.Uint64(this.acceptedAssetId.value),
      paused: new arc4.Uint64(this.paused.value),
      assetOptedIn: new arc4.Uint64(this.assetOptedIn.value),
    })
  }

  @abimethod({ readonly: true })
  getAccounting(): AssuranceAccounting {
    return new AssuranceAccounting({
      totalProviderStake: new arc4.Uint64(this.totalProviderStake.value),
      premiumReserve: new arc4.Uint64(this.premiumReserve.value),
      totalOpenFaultExposure: new arc4.Uint64(this.totalOpenFaultExposure.value),
    })
  }

  approvalProgram(): boolean {
    return super.approvalProgram()
  }

  clearStateProgram(): boolean {
    return true
  }
}
