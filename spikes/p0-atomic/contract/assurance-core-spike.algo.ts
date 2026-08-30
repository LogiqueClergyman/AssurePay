import {
  abimethod,
  assert,
  Contract,
  Global,
  gtxn,
  TransactionType,
  Txn,
} from '@algorandfoundation/algorand-typescript'
import type { bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import { Account, GlobalState } from '@algorandfoundation/algorand-typescript'

/**
 * Disposable P0 contract.  It intentionally has no policy, claims, or provider
 * registry behaviour; it only proves the group validation boundary.
 */
export default class AssuranceCoreSpike extends Contract {
  configuredAsset = GlobalState<uint64>({ key: 'asset' })
  configuredProvider = GlobalState<Account>({ key: 'provider' })
  opened = GlobalState<uint64>({ key: 'opened', initialValue: 0 })

  @abimethod({ onCreate: 'require' })
  create(asset: uint64, provider: Account): void {
    this.configuredAsset.value = asset
    this.configuredProvider.value = provider
  }

  @abimethod()
  openCoverage(gross: uint64, premium: uint64, commitment: bytes, reject: boolean): void {
    const providerPayment = gtxn.AssetTransferTxn(0)
    const premiumPayment = gtxn.AssetTransferTxn(1)

    // Fixed P0 wire profile: [provider transfer, premium transfer, app call].
    assert(Global.groupSize === 3)
    assert(providerPayment.sender === premiumPayment.sender)
    assert(Txn.sender === providerPayment.sender)
    assert(providerPayment.type === TransactionType.AssetTransfer)
    assert(premiumPayment.type === TransactionType.AssetTransfer)
    assert(providerPayment.xferAsset.id === this.configuredAsset.value)
    assert(premiumPayment.xferAsset.id === this.configuredAsset.value)
    assert(providerPayment.assetReceiver === this.configuredProvider.value)
    assert(premiumPayment.assetReceiver === Global.currentApplicationAddress)
    assert(providerPayment.assetAmount + premiumPayment.assetAmount === gross)
    assert(premiumPayment.assetAmount === premium)
    assert(commitment.length === 32)
    assert(providerPayment.rekeyTo === Global.zeroAddress)
    assert(premiumPayment.rekeyTo === Global.zeroAddress)
    assert(providerPayment.assetCloseTo === Global.zeroAddress)
    assert(premiumPayment.assetCloseTo === Global.zeroAddress)
    assert(Txn.rekeyTo === Global.zeroAddress)
    assert(!reject)

    this.opened.value = this.opened.value + 1
  }
}
