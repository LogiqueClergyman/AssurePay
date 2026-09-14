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

export const COVERAGE_STATUS_OPEN: uint64 = 1
export const COVERAGE_STATUS_REFUNDED: uint64 = 2
export const COVERAGE_STATUS_CLOSED: uint64 = 3

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

  @abimethod({ allowActions: 'NoOp' })
  openCoverage(
    coverageId: arc4.StaticBytes<32>,
    providerId: arc4.StaticBytes<32>,
    policyId: arc4.StaticBytes<32>,
    requestHash: arc4.StaticBytes<32>,
    grossAmount: uint64,
  ): void {
    this.requireUnpaused()
    assert(this.assetOptedIn.value === 1, 'asset not opted in')
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    assert(Txn.onCompletion === OnCompleteAction.NoOp, 'application call must be NoOp')
    assert(Global.groupSize === 3, 'exactly three group members required')
    assert(Txn.groupIndex === 2, 'application call must be third')
    assert(!this.isZeroId(coverageId), 'coverage id must be non-zero')
    assert(!this.isZeroId(providerId), 'provider id must be non-zero')
    assert(!this.isZeroId(policyId), 'policy id must be non-zero')
    assert(!this.isZeroId(requestHash), 'request hash must be non-zero')

    const coverage = this.coverages(coverageId)
    assert(!coverage.exists, 'coverage already exists')
    const provider = this.providers(providerId)
    assert(provider.exists, 'provider missing')
    assert(provider.value.active.native === true, 'provider inactive')
    const policy = this.policies(policyId)
    assert(policy.exists, 'policy missing')
    assert(policy.value.active.native === true, 'policy inactive')
    assert(policy.value.providerId.bytes === providerId.bytes, 'policy provider mismatch')
    assert(grossAmount > 0, 'gross amount must be positive')
    assert(grossAmount <= policy.value.maxCoverageAmount.asUint64(), 'maximum coverage exceeded')

    const providerTransfer = gtxn.AssetTransferTxn(0)
    const premiumTransfer = gtxn.AssetTransferTxn(1)
    assert(providerTransfer.sender.bytes === Txn.sender.bytes, 'provider transfer sender mismatch')
    assert(premiumTransfer.sender.bytes === Txn.sender.bytes, 'premium transfer sender mismatch')
    assert(providerTransfer.assetReceiver.bytes === provider.value.payoutAddress.bytes, 'provider receiver mismatch')
    assert(premiumTransfer.assetReceiver.bytes === Global.currentApplicationAddress.bytes, 'premium receiver mismatch')
    assert(providerTransfer.xferAsset.id === this.acceptedAssetId.value, 'provider transfer wrong asset')
    assert(premiumTransfer.xferAsset.id === this.acceptedAssetId.value, 'premium transfer wrong asset')
    assert(providerTransfer.assetSender.bytes === Global.zeroAddress.bytes, 'provider asset sender is not allowed')
    assert(providerTransfer.assetCloseTo.bytes === Global.zeroAddress.bytes, 'provider asset close-to is not allowed')
    assert(providerTransfer.rekeyTo.bytes === Global.zeroAddress.bytes, 'provider transfer rekey is not allowed')
    assert(premiumTransfer.assetSender.bytes === Global.zeroAddress.bytes, 'premium asset sender is not allowed')
    assert(premiumTransfer.assetCloseTo.bytes === Global.zeroAddress.bytes, 'premium asset close-to is not allowed')
    assert(premiumTransfer.rekeyTo.bytes === Global.zeroAddress.bytes, 'premium transfer rekey is not allowed')

    const rawPremium: biguint = (new arc4.Uint64(grossAmount).asBigUint() * policy.value.premiumBps.asBigUint()) / 10_000n
    const premiumBig: biguint = rawPremium < 1n ? 1n : rawPremium
    const premium = new arc4.Uint64(premiumBig).asUint64()
    const providerNet: uint64 = grossAmount - premium
    const lockedBig: biguint = (
      new arc4.Uint64(grossAmount).asBigUint() * policy.value.collateralRatioBps.asBigUint() + 9_999n
    ) / 10_000n
    const lockedStake = new arc4.Uint64(lockedBig).asUint64()
    assert(providerTransfer.assetAmount === providerNet, 'provider amount mismatch')
    assert(premiumTransfer.assetAmount === premium, 'premium amount mismatch')

    assert(provider.value.stakeTotal.asUint64() >= provider.value.stakeLocked.asUint64(), 'invalid stake state')
    assert(lockedStake <= provider.value.stakeTotal.asUint64() - provider.value.stakeLocked.asUint64(), 'insufficient capacity')
    const maxUint64 = new arc4.Uint64(18446744073709551615n).asUint64()
    assert(provider.value.stakeLocked.asUint64() <= maxUint64 - lockedStake, 'provider lock overflow')
    assert(provider.value.openFaultExposure.asUint64() <= maxUint64 - grossAmount, 'provider exposure overflow')
    assert(this.totalOpenFaultExposure.value <= maxUint64 - grossAmount, 'global exposure overflow')
    assert(this.premiumReserve.value <= maxUint64 - premium, 'premium reserve overflow')
    const newPremiumReserve: uint64 = this.premiumReserve.value + premium
    assert(this.totalProviderStake.value <= maxUint64 - newPremiumReserve, 'tracked stake overflow')
    const newTrackedAssetBalance: uint64 = this.totalProviderStake.value + newPremiumReserve
    const openedAt = Global.latestTimestamp
    assert(openedAt <= maxUint64 - policy.value.claimWindowSeconds.asUint64(), 'expiry overflow')
    const expiresAt: uint64 = openedAt + policy.value.claimWindowSeconds.asUint64()
    const applicationHolding = Asset(this.acceptedAssetId.value).balance(Global.currentApplicationAddress)
    assert(newTrackedAssetBalance <= applicationHolding, 'tracked stake exceeds balance')

    coverage.value = new CoverageRecord({
      providerId,
      policyId,
      payerAddress: new arc4.Address(Txn.sender),
      grossAmount: new arc4.Uint64(grossAmount),
      providerNetAmount: new arc4.Uint64(providerNet),
      premiumAmount: new arc4.Uint64(premium),
      stakeTopupAmount: new arc4.Uint64(0),
      lockedStakeAmount: new arc4.Uint64(lockedStake),
      requestHash,
      openedAt: new arc4.Uint64(openedAt),
      expiresAt: new arc4.Uint64(expiresAt),
      status: new arc4.Uint64(COVERAGE_STATUS_OPEN),
      exposureReleased: new arc4.Bool(false),
    })
    provider.value.stakeLocked = new arc4.Uint64(provider.value.stakeLocked.asUint64() + lockedStake)
    provider.value.openFaultExposure = new arc4.Uint64(provider.value.openFaultExposure.asUint64() + grossAmount)
    this.totalOpenFaultExposure.value += grossAmount
    this.premiumReserve.value = newPremiumReserve
    emit(
      'CoverageOpened',
      new arc4.Uint64(1),
      coverageId,
      providerId,
      policyId,
      new arc4.Address(Txn.sender),
      new arc4.Uint64(grossAmount),
      new arc4.Uint64(providerNet),
      new arc4.Uint64(premium),
      requestHash,
      new arc4.Uint64(openedAt),
      new arc4.Uint64(expiresAt),
    )
  }

  @abimethod({ readonly: true })
  getCoverage(coverageId: arc4.StaticBytes<32>): CoverageRecord {
    const coverage = this.coverages(coverageId)
    assert(coverage.exists, 'coverage missing')
    return coverage.value
  }

  @abimethod({ allowActions: 'NoOp' })
  withdrawStake(providerId: arc4.StaticBytes<32>, amount: uint64): void {
    this.requireUnpaused()
    assert(this.assetOptedIn.value === 1, 'asset not opted in')
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    assert(!this.isZeroId(providerId), 'provider id must be non-zero')
    assert(amount > 0, 'withdrawal amount must be positive')

    const provider = this.providers(providerId)
    assert(provider.exists, 'provider missing')
    assert(provider.value.ownerAddress.bytes === Txn.sender.bytes, 'provider owner only')
    assert(provider.value.stakeTotal.asUint64() >= amount, 'insufficient provider stake')
    assert(provider.value.stakeTotal.asUint64() - amount >= provider.value.stakeLocked.asUint64(), 'stake is locked')
    assert(this.totalProviderStake.value >= amount, 'insufficient global stake')
    assert(Txn.fee >= Global.minTxnFee * 2, 'outer fee must pool inner fee')

    const applicationHolding = Asset(this.acceptedAssetId.value).balance(Global.currentApplicationAddress)
    assert(applicationHolding >= amount, 'insufficient application asset balance')
    const maxUint64 = new arc4.Uint64(18446744073709551615n).asUint64()
    const newProviderStake: uint64 = provider.value.stakeTotal.asUint64() - amount
    const newTotalProviderStake: uint64 = this.totalProviderStake.value - amount
    assert(newTotalProviderStake <= maxUint64 - this.premiumReserve.value, 'tracked stake overflow')
    const newTrackedAssetBalance: uint64 = newTotalProviderStake + this.premiumReserve.value
    const postWithdrawalHolding: uint64 = applicationHolding - amount
    assert(newTrackedAssetBalance <= postWithdrawalHolding, 'tracked stake exceeds balance')

    provider.value.stakeTotal = new arc4.Uint64(newProviderStake)
    this.totalProviderStake.value = newTotalProviderStake
    itxn.assetTransfer({
      sender: Global.currentApplicationAddress,
      xferAsset: this.acceptedAssetId.value,
      assetAmount: amount,
      assetReceiver: Account(provider.value.ownerAddress.bytes),
      fee: 0,
    }).submit()
    emit(
      'StakeWithdrawn',
      new arc4.Uint64(1),
      providerId,
      new arc4.Uint64(amount),
      new arc4.Uint64(newProviderStake),
    )
  }

  @abimethod({ allowActions: 'NoOp' })
  closeCoverage(coverageId: arc4.StaticBytes<32>): void {
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    assert(!this.isZeroId(coverageId), 'coverage id must be non-zero')
    const coverage = this.coverages(coverageId)
    assert(coverage.exists, 'coverage missing')
    assert(coverage.value.status.asUint64() === COVERAGE_STATUS_OPEN, 'coverage is terminal')
    assert(!coverage.value.exposureReleased.native, 'coverage exposure already released')
    assert(Global.latestTimestamp >= coverage.value.expiresAt.asUint64(), 'coverage has not expired')

    const provider = this.providers(coverage.value.providerId)
    assert(provider.exists, 'provider missing')
    this.releaseExposure(coverageId, coverage.value.providerId)
    coverage.value.status = new arc4.Uint64(COVERAGE_STATUS_CLOSED)
    const closedAt = Global.latestTimestamp
    emit('CoverageClosed', new arc4.Uint64(1), coverageId, new arc4.Uint64(closedAt), new arc4.Bool(true))
  }

  @abimethod({ allowActions: 'NoOp' })
  finalizeClaim(
    claimId: arc4.StaticBytes<32>,
    coverageId: arc4.StaticBytes<32>,
    approved: boolean,
    approvedAmount: uint64,
    providerFault: boolean,
    resolutionCode: uint64,
  ): void {
    assert(Txn.sender.bytes === this.adjudicator.value.bytes, 'adjudicator only')
    assert(Txn.rekeyTo.bytes === Global.zeroAddress.bytes, 'unsafe rekey')
    assert(!this.isZeroId(claimId), 'claim id must be non-zero')
    assert(!this.isZeroId(coverageId), 'coverage id must be non-zero')
    const claim = this.claims(claimId)
    assert(!claim.exists, 'claim already finalized')
    const coverage = this.coverages(coverageId)
    assert(coverage.exists, 'coverage missing')
    assert(coverage.value.status.asUint64() === COVERAGE_STATUS_OPEN, 'coverage is terminal')
    assert(!coverage.value.exposureReleased.native, 'coverage exposure already released')
    const provider = this.providers(coverage.value.providerId)
    assert(provider.exists, 'provider missing')
    assert(resolutionCode > 0, 'resolution code must be positive')
    assert(approvedAmount <= coverage.value.grossAmount.asUint64(), 'claim exceeds gross amount')
    if (!approved) {
      assert(approvedAmount === 0, 'rejected claim amount must be zero')
      assert(!providerFault, 'rejected claim cannot have provider fault')
    } else {
      assert(approvedAmount > 0, 'approved claim amount must be positive')
    }
    if (approved) assert(Txn.fee >= Global.minTxnFee * 2, 'outer fee must pool inner fee')

    let stakeDebit: uint64 = 0
    let poolDebit: uint64 = 0
    if (approved && providerFault) {
      assert(provider.value.stakeTotal.asUint64() >= provider.value.stakeLocked.asUint64(), 'invalid stake state')
      assert(provider.value.stakeLocked.asUint64() >= coverage.value.lockedStakeAmount.asUint64(), 'locked stake underflow')
      const remainingLockedStake: uint64 = provider.value.stakeLocked.asUint64() - coverage.value.lockedStakeAmount.asUint64()
      assert(provider.value.stakeTotal.asUint64() >= remainingLockedStake, 'stake total underflow')
      const stakeAvailable: uint64 = provider.value.stakeTotal.asUint64() - remainingLockedStake
      stakeDebit = approvedAmount <= stakeAvailable ? approvedAmount : stakeAvailable
      poolDebit = approvedAmount - stakeDebit
    } else if (approved) {
      poolDebit = approvedAmount
    }

    assert(this.totalProviderStake.value >= stakeDebit, 'global stake underflow')
    assert(this.premiumReserve.value >= poolDebit, 'insufficient premium reserve')
    const maxUint64 = new arc4.Uint64(18446744073709551615n).asUint64()
    assert(stakeDebit <= maxUint64 - poolDebit, 'claim debit overflow')
    assert(stakeDebit + poolDebit === approvedAmount, 'claim debit mismatch')
    if (approved) {
      const applicationHolding = Asset(this.acceptedAssetId.value).balance(Global.currentApplicationAddress)
      assert(applicationHolding >= approvedAmount, 'insufficient application asset balance')
      const newTotalProviderStake: uint64 = this.totalProviderStake.value - stakeDebit
      const newPremiumReserve: uint64 = this.premiumReserve.value - poolDebit
      assert(newTotalProviderStake <= maxUint64 - newPremiumReserve, 'tracked stake overflow')
      const newTrackedAssetBalance: uint64 = newTotalProviderStake + newPremiumReserve
      const postRefundHolding: uint64 = applicationHolding - approvedAmount
      assert(newTrackedAssetBalance <= postRefundHolding, 'tracked stake exceeds balance')
    }

    this.releaseExposure(coverageId, coverage.value.providerId)
    if (approved) {
      provider.value.stakeTotal = new arc4.Uint64(provider.value.stakeTotal.asUint64() - stakeDebit)
      this.totalProviderStake.value -= stakeDebit
      this.premiumReserve.value -= poolDebit
      coverage.value.status = new arc4.Uint64(COVERAGE_STATUS_REFUNDED)
    } else {
      coverage.value.status = new arc4.Uint64(COVERAGE_STATUS_CLOSED)
    }
    const resolvedAt = Global.latestTimestamp
    claim.value = new FinalizedClaimRecord({
      coverageId,
      approved: new arc4.Bool(approved),
      approvedAmount: new arc4.Uint64(approvedAmount),
      providerFault: new arc4.Bool(providerFault),
      resolutionCode: new arc4.Uint64(resolutionCode),
      stakeDebit: new arc4.Uint64(stakeDebit),
      poolDebit: new arc4.Uint64(poolDebit),
      resolvedAt: new arc4.Uint64(resolvedAt),
    })
    emit(
      'ClaimFinalized',
      new arc4.Uint64(1),
      claimId,
      coverageId,
      new arc4.Bool(approved),
      new arc4.Uint64(approvedAmount),
      new arc4.Bool(providerFault),
      new arc4.Uint64(resolutionCode),
      new arc4.Uint64(resolvedAt),
    )
    if (approved) {
      itxn.assetTransfer({
        sender: Global.currentApplicationAddress,
        xferAsset: this.acceptedAssetId.value,
        assetAmount: approvedAmount,
        assetReceiver: Account(coverage.value.payerAddress.bytes),
        fee: 0,
      }).submit()
      emit('RefundPaid', new arc4.Uint64(1), claimId, coverageId, new arc4.Address(coverage.value.payerAddress.bytes), new arc4.Uint64(approvedAmount))
    } else {
      emit('CoverageClosed', new arc4.Uint64(1), coverageId, new arc4.Uint64(resolvedAt), new arc4.Bool(false))
    }
  }

  @abimethod({ readonly: true })
  getClaim(claimId: arc4.StaticBytes<32>): FinalizedClaimRecord {
    const claim = this.claims(claimId)
    assert(claim.exists, 'claim missing')
    return claim.value
  }

  private releaseExposure(coverageId: arc4.StaticBytes<32>, providerId: arc4.StaticBytes<32>): void {
    const coverage = this.coverages(coverageId)
    const provider = this.providers(providerId)
    assert(coverage.exists, 'coverage missing')
    assert(provider.exists, 'provider missing')
    assert(coverage.value.status.asUint64() === COVERAGE_STATUS_OPEN, 'coverage is not open')
    assert(!coverage.value.exposureReleased.native, 'coverage exposure already released')
    assert(provider.value.stakeLocked.asUint64() >= coverage.value.lockedStakeAmount.asUint64(), 'locked stake underflow')
    assert(provider.value.openFaultExposure.asUint64() >= coverage.value.grossAmount.asUint64(), 'provider exposure underflow')
    assert(this.totalOpenFaultExposure.value >= coverage.value.grossAmount.asUint64(), 'global exposure underflow')
    provider.value.stakeLocked = new arc4.Uint64(provider.value.stakeLocked.asUint64() - coverage.value.lockedStakeAmount.asUint64())
    provider.value.openFaultExposure = new arc4.Uint64(provider.value.openFaultExposure.asUint64() - coverage.value.grossAmount.asUint64())
    this.totalOpenFaultExposure.value -= coverage.value.grossAmount.asUint64()
    coverage.value.exposureReleased = new arc4.Bool(true)
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
