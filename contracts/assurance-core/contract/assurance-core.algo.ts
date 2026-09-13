import {
  Account,
  Asset,
  BoxMap,
  Bytes,
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
  gtxn,
  itxn,
} from '@algorandfoundation/algorand-typescript'

import type { biguint, bytes, uint64 } from '@algorandfoundation/algorand-typescript'

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

  @abimethod({ allowActions: 'NoOp' })
  setPaused(paused: boolean): void {
    assert(Txn.sender.bytes === this.admin.value.bytes, 'admin only')
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    const requested: uint64 = paused ? 1 : 0
    assert(this.paused.value !== requested, 'pause state unchanged')
    this.paused.value = requested
    emit('ProtocolPauseChanged', new arc4.Uint64(1), new arc4.Bool(paused))
  }

  @abimethod({ allowActions: 'NoOp' })
  registerProvider(
    providerId: arc4.StaticBytes<32>,
    payoutAddress: Account,
    receiptSigningPublicKey: arc4.StaticBytes<32>,
  ): void {
    this.requireUnpaused()
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    assert(!this.isZeroId(providerId), 'provider id must be non-zero')
    const provider = this.providers(providerId)
    assert(!provider.exists, 'provider already exists')
    assert(payoutAddress.bytes !== Global.zeroAddress.bytes, 'payout must be non-zero')
    assert(!this.isZeroBytes(receiptSigningPublicKey.bytes), 'receipt key must be non-zero')

    const createdAt = Global.latestTimestamp
    provider.value = new ProviderRecord({
      ownerAddress: new arc4.Address(Txn.sender),
      payoutAddress: new arc4.Address(payoutAddress),
      receiptSigningPublicKey,
      active: new arc4.Bool(true),
      stakeTotal: new arc4.Uint64(0),
      stakeLocked: new arc4.Uint64(0),
      openFaultExposure: new arc4.Uint64(0),
      createdAt: new arc4.Uint64(createdAt),
    })
    emit(
      'ProviderRegistered',
      new arc4.Uint64(1),
      providerId,
      new arc4.Address(Txn.sender),
      new arc4.Address(payoutAddress),
      receiptSigningPublicKey,
      new arc4.Uint64(createdAt),
    )
  }

  @abimethod({ allowActions: 'NoOp' })
  setProviderStatus(providerId: arc4.StaticBytes<32>, active: boolean): void {
    this.requireUnpaused()
    assert(Txn.sender.bytes === this.admin.value.bytes, 'admin only')
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    const provider = this.providers(providerId)
    assert(provider.exists, 'provider missing')
    assert(provider.value.active.native !== active, 'provider status unchanged')
    provider.value.active = new arc4.Bool(active)
    emit('ProviderStatusChanged', new arc4.Uint64(1), providerId, new arc4.Bool(active))
  }

  @abimethod({ readonly: true })
  getProvider(providerId: arc4.StaticBytes<32>): ProviderRecord {
    const provider = this.providers(providerId)
    assert(provider.exists, 'provider missing')
    return provider.value
  }

  @abimethod({ allowActions: 'NoOp' })
  createPolicy(
    policyId: arc4.StaticBytes<32>,
    providerId: arc4.StaticBytes<32>,
    premiumBps: uint64,
    collateralRatioBps: uint64,
    maxCoverageAmount: uint64,
    claimWindowSeconds: uint64,
  ): void {
    this.requireUnpaused()
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    assert(!this.isZeroId(policyId), 'policy id must be non-zero')
    assert(!this.isZeroId(providerId), 'provider id must be non-zero')
    const provider = this.providers(providerId)
    assert(provider.exists, 'provider missing')
    assert(provider.value.active.native === true, 'provider inactive')
    assert(provider.value.ownerAddress.bytes === Txn.sender.bytes, 'provider owner only')
    const policy = this.policies(policyId)
    assert(!policy.exists, 'policy already exists')
    assert(premiumBps >= 1 && premiumBps <= 10_000, 'invalid premium bps')
    assert(collateralRatioBps >= 1 && collateralRatioBps <= 10_000, 'invalid collateral bps')
    assert(maxCoverageAmount > 0, 'maximum coverage must be positive')
    assert(claimWindowSeconds > 0, 'claim window must be positive')

    const createdAt = Global.latestTimestamp
    policy.value = new PolicyRecord({
      providerId,
      active: new arc4.Bool(true),
      premiumBps: new arc4.Uint64(premiumBps),
      collateralRatioBps: new arc4.Uint64(collateralRatioBps),
      maxCoverageAmount: new arc4.Uint64(maxCoverageAmount),
      claimWindowSeconds: new arc4.Uint64(claimWindowSeconds),
      createdAt: new arc4.Uint64(createdAt),
    })
    emit(
      'PolicyCreated',
      new arc4.Uint64(1),
      policyId,
      providerId,
      new arc4.Uint64(premiumBps),
      new arc4.Uint64(collateralRatioBps),
      new arc4.Uint64(maxCoverageAmount),
      new arc4.Uint64(claimWindowSeconds),
      new arc4.Uint64(createdAt),
    )
  }

  @abimethod({ allowActions: 'NoOp' })
  setPolicyStatus(policyId: arc4.StaticBytes<32>, active: boolean): void {
    this.requireUnpaused()
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    const policy = this.policies(policyId)
    assert(policy.exists, 'policy missing')
    const provider = this.providers(policy.value.providerId)
    assert(provider.exists, 'provider missing')
    assert(provider.value.ownerAddress.bytes === Txn.sender.bytes, 'provider owner only')
    assert(policy.value.active.native !== active, 'policy status unchanged')
    policy.value.active = new arc4.Bool(active)
    emit('PolicyStatusChanged', new arc4.Uint64(1), policyId, new arc4.Bool(active))
  }

  @abimethod({ readonly: true })
  getPolicy(policyId: arc4.StaticBytes<32>): PolicyRecord {
    const policy = this.policies(policyId)
    assert(policy.exists, 'policy missing')
    return policy.value
  }

  @abimethod({ allowActions: 'NoOp' })
  depositStake(providerId: arc4.StaticBytes<32>, transfer: gtxn.AssetTransferTxn): void {
    this.requireUnpaused()
    assert(this.assetOptedIn.value === 1, 'asset not opted in')
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    assert(Global.groupSize === 2, 'exactly two group members required')
    assert(Txn.groupIndex === 1, 'application call must be second')

    const provider = this.providers(providerId)
    assert(provider.exists, 'provider missing')
    assert(provider.value.active.native === true, 'provider inactive')
    assert(provider.value.ownerAddress.bytes === Txn.sender.bytes, 'provider owner only')
    assert(transfer.sender.bytes === Txn.sender.bytes, 'transfer sender mismatch')
    assert(transfer.assetReceiver.bytes === Global.currentApplicationAddress.bytes, 'transfer receiver mismatch')
    assert(transfer.xferAsset.id === this.acceptedAssetId.value, 'wrong asset')
    assert(transfer.assetAmount > 0, 'stake amount must be positive')
    assert(transfer.assetSender.bytes === Global.zeroAddress.bytes, 'asset sender is not allowed')
    assert(transfer.assetCloseTo.bytes === Global.zeroAddress.bytes, 'asset close-to is not allowed')
    assert(transfer.rekeyTo.bytes === Global.zeroAddress.bytes, 'transfer rekey is not allowed')
    const maxUint64 = new arc4.Uint64(18446744073709551615n).asUint64()
    assert(provider.value.stakeTotal.asUint64() <= maxUint64 - transfer.assetAmount, 'provider stake overflow')
    assert(this.totalProviderStake.value <= maxUint64 - transfer.assetAmount, 'global stake overflow')
    const applicationHolding = Asset(this.acceptedAssetId.value).balance(Global.currentApplicationAddress)
    assert(this.totalProviderStake.value + transfer.assetAmount <= applicationHolding, 'tracked stake exceeds balance')

    provider.value.stakeTotal = new arc4.Uint64(provider.value.stakeTotal.asUint64() + transfer.assetAmount)
    this.totalProviderStake.value += transfer.assetAmount
    emit(
      'StakeDeposited',
      new arc4.Uint64(1),
      providerId,
      new arc4.Uint64(transfer.assetAmount),
      new arc4.Uint64(provider.value.stakeTotal.asUint64()),
    )
  }

  @abimethod({ readonly: true })
  getAvailableCapacity(providerId: arc4.StaticBytes<32>, policyId: arc4.StaticBytes<32>): uint64 {
    const provider = this.providers(providerId)
    assert(provider.exists, 'provider missing')
    const policy = this.policies(policyId)
    assert(policy.exists, 'policy missing')
    assert(policy.value.providerId.bytes === providerId.bytes, 'policy provider mismatch')
    assert(provider.value.stakeTotal.asUint64() >= provider.value.stakeLocked.asUint64(), 'locked stake exceeds total')

    // AVM biguint (b-, b*, b/) performs the ratio without uint64 wrap. The
    // uint64 projection saturates mathematical results above max uint64.
    const maxUint64 = new arc4.Uint64(18446744073709551615n).asUint64()
    const maxBigUint: biguint = 18446744073709551615n
    const unencumberedStake: biguint = provider.value.stakeTotal.asBigUint() - provider.value.stakeLocked.asBigUint()
    const capacity: biguint = (unencumberedStake * 10_000n) / policy.value.collateralRatioBps.asBigUint()
    if (capacity > maxBigUint) return maxUint64
    return new arc4.Uint64(capacity).asUint64()
  }

  private requireUnpaused(): void {
    assert(this.paused.value === 0, 'protocol paused')
  }

  private isZeroId(id: arc4.StaticBytes<32>): boolean {
    return this.isZeroBytes(id.bytes)
  }

  private isZeroBytes(value: bytes): boolean {
    return value === Bytes.fromHex('0000000000000000000000000000000000000000000000000000000000000000')
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
