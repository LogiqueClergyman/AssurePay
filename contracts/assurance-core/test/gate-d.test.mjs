import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import algosdk from 'algosdk'

const root = path.resolve(import.meta.dirname, '..')
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'AssuranceCore.arc56.json'), 'utf8'))
const source = fs.readFileSync(path.join(root, 'contract', 'assurance-core.algo.ts'), 'utf8')
const max = 18_446_744_073_709_551_615n
const OPEN = 1n
const REFUNDED = 2n
const CLOSED = 3n
const filled = (value) => new Uint8Array(32).fill(value)
const signature = (item) => `${item.name}(${item.args.map((arg) => arg.type).join(',')})`
const prefix = (value) => crypto.createHash('sha512-256').update(value).digest('hex').slice(0, 8)

test('Gate D ABI, read-only claim tombstones, records, statuses, and frozen events are exact', () => {
  const methods = new Map(artifact.methods.map((method) => [method.name, method]))
  assert.deepEqual(methods.get('withdrawStake').args.map((arg) => arg.type), ['byte[32]', 'uint64'])
  assert.deepEqual(methods.get('closeCoverage').args.map((arg) => arg.type), ['byte[32]'])
  assert.deepEqual(methods.get('finalizeClaim').args.map((arg) => arg.type), ['byte[32]', 'byte[32]', 'bool', 'uint64', 'bool', 'uint64'])
  assert.equal(methods.get('finalizeClaim').returns.type, 'void')
  assert.equal(methods.get('getClaim').returns.type, '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)')
  assert.equal(methods.get('getClaim').readonly, true)
  for (const method of ['withdrawStake', 'closeCoverage', 'finalizeClaim']) {
    assert.equal(methods.get(method).args.some((arg) => ['address', 'uint64', 'bool'].includes(arg.type) && method === 'closeCoverage'), false)
  }
  const forbidden = ['receiver', 'owner', 'payout', 'collateral', 'debit', 'status', 'exposure']
  for (const method of ['withdrawStake', 'closeCoverage', 'finalizeClaim']) {
    assert.equal(methods.get(method).args.some((arg) => forbidden.includes(arg.name)), false, method)
  }
  assert.equal(source.includes('private releaseExposure('), true)
  assert.equal((source.match(/this\.releaseExposure\(/g) ?? []).length, 2)
  const expected = {
    StakeWithdrawn: 'StakeWithdrawn(uint64,byte[32],uint64,uint64)',
    CoverageClosed: 'CoverageClosed(uint64,byte[32],uint64,bool)',
    ClaimFinalized: 'ClaimFinalized(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)',
    RefundPaid: 'RefundPaid(uint64,byte[32],byte[32],address,uint64)',
  }
  for (const [name, wanted] of Object.entries(expected)) {
    const event = artifact.events.find((item) => item.name === name)
    assert.equal(signature(event), wanted)
    assert.equal(prefix(wanted), prefix(signature(event)))
  }
  assert.deepEqual(algosdk.ABIType.from('(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)').decode(
    algosdk.ABIType.from('(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)').encode([filled(1), true, 7n, true, 9n, 5n, 2n, 100n]),
  ), [Array.from(filled(1)), true, 7n, true, 9n, 5n, 2n, 100n])
})

class LifecycleModel {
  constructor() {
    this.now = 0n
    this.totalStake = 0n
    this.reserve = 0n
    this.totalExposure = 0n
    this.actual = 0n
    this.paused = false
    this.providers = new Map()
    this.coverages = new Map()
    this.claims = new Map()
    this.payerBalances = new Map()
  }

  snapshot() { return structuredClone(this) }
  restore(snapshot) { Object.assign(this, snapshot) }
  transact(action) {
    const before = this.snapshot()
    try { return action() } catch (error) { this.restore(before); throw error }
  }
  addProvider(id, owner, stake, active = true) {
    this.providers.set(id, { owner, stakeTotal: stake, stakeLocked: 0n, exposure: 0n, active })
    this.totalStake += stake
    this.actual += stake
  }
  balance(payer) { return this.payerBalances.get(payer) ?? 0n }
  deposit(providerId, owner, amount) {
    return this.transact(() => {
      if (this.paused) throw new Error('protocol paused')
      if (amount <= 0n) throw new Error('deposit amount must be positive')
      const provider = this.providers.get(providerId)
      if (!provider || provider.owner !== owner) throw new Error('provider owner only')
      if (!provider.active) throw new Error('provider inactive')
      if (amount > max - provider.stakeTotal || amount > max - this.totalStake || amount > max - this.actual) throw new Error('overflow')
      provider.stakeTotal += amount
      this.totalStake += amount
      this.actual += amount
      return amount
    })
  }
  open(id, providerId, payer, gross, premium, locked, expiresAt) {
    return this.transact(() => {
      if (this.paused) throw new Error('protocol paused')
      if (!id) throw new Error('coverage id must be non-zero')
      if (this.coverages.has(id)) throw new Error('coverage already exists')
      const provider = this.providers.get(providerId)
      if (!provider?.active) throw new Error('provider unavailable')
      if (provider.stakeTotal - provider.stakeLocked < locked) throw new Error('insufficient capacity')
      if (this.reserve > max - premium || this.totalExposure > max - gross) throw new Error('overflow')
      if (this.totalStake > max - this.reserve - premium) throw new Error('tracked stake exceeds balance')
      provider.stakeLocked += locked
      provider.exposure += gross
      this.totalExposure += gross
      this.reserve += premium
      this.actual += premium
      this.coverages.set(id, { providerId, payer, gross, premium, locked, expiresAt, status: OPEN, released: false })
      return id
    })
  }
  release(coverage, provider) {
    if (coverage.status !== OPEN || coverage.released) throw new Error('coverage terminal')
    if (provider.stakeLocked < coverage.locked || provider.exposure < coverage.gross || this.totalExposure < coverage.gross) throw new Error('release underflow')
    provider.stakeLocked -= coverage.locked
    provider.exposure -= coverage.gross
    this.totalExposure -= coverage.gross
    coverage.released = true
  }
  withdraw(providerId, owner, amount, fee = 2n) {
    return this.transact(() => {
      if (this.paused) throw new Error('protocol paused')
      if (!providerId) throw new Error('provider id must be non-zero')
      if (fee < 2n) throw new Error('outer fee must pool inner fee')
      const provider = this.providers.get(providerId)
      if (!provider || provider.owner !== owner) throw new Error('provider owner only')
      if (amount <= 0n || provider.stakeTotal < amount || provider.stakeTotal - amount < provider.stakeLocked) throw new Error('unsafe withdrawal')
      if (this.totalStake < amount || this.actual < amount) throw new Error('balance underflow')
      const nextTotal = this.totalStake - amount
      if (nextTotal + this.reserve > this.actual - amount) throw new Error('tracked stake exceeds balance')
      provider.stakeTotal -= amount
      this.totalStake = nextTotal
      this.actual -= amount
      return amount
    })
  }
  close(id) {
    return this.transact(() => {
      if (!id) throw new Error('coverage id must be non-zero')
      const coverage = this.coverages.get(id)
      if (!coverage || coverage.status !== OPEN || coverage.released) throw new Error('coverage terminal')
      if (this.now < coverage.expiresAt) throw new Error('not expired')
      this.release(coverage, this.providers.get(coverage.providerId))
      coverage.status = CLOSED
      return id
    })
  }
  finalize(claimId, coverageId, approved, amount, providerFault, resolutionCode) {
    return this.transact(() => {
      if (!claimId || !coverageId) throw new Error('claim and coverage ids must be non-zero')
      if (this.claims.has(claimId)) throw new Error('claim already finalized')
      const coverage = this.coverages.get(coverageId)
      if (!coverage || coverage.status !== OPEN || coverage.released) throw new Error('coverage terminal')
      if (resolutionCode <= 0n || amount > coverage.gross) throw new Error('invalid outcome')
      if (!approved && (amount !== 0n || providerFault)) throw new Error('invalid rejected outcome')
      if (approved && amount <= 0n) throw new Error('invalid approved outcome')
      const provider = this.providers.get(coverage.providerId)
      let stakeDebit = 0n
      if (approved && providerFault) {
        const remainingLocked = provider.stakeLocked - coverage.locked
        const available = provider.stakeTotal - remainingLocked
        stakeDebit = amount < available ? amount : available
      }
      const poolDebit = amount - stakeDebit
      if (this.totalStake < stakeDebit || this.reserve < poolDebit) throw new Error('insufficient waterfall')
      if (approved && this.actual < amount) throw new Error('insufficient actual balance')
      if (approved && this.totalStake - stakeDebit + this.reserve - poolDebit > this.actual - amount) throw new Error('tracked stake exceeds balance')
      this.release(coverage, provider)
      if (approved) {
        provider.stakeTotal -= stakeDebit
        this.totalStake -= stakeDebit
        this.reserve -= poolDebit
        this.actual -= amount
        this.payerBalances.set(coverage.payer, this.balance(coverage.payer) + amount)
        coverage.status = REFUNDED
      } else coverage.status = CLOSED
      this.claims.set(claimId, { coverageId, approved, approvedAmount: amount, providerFault, resolutionCode, stakeDebit, poolDebit, resolvedAt: this.now })
      return this.claims.get(claimId)
    })
  }
  invariant() {
    let sumStake = 0n
    let sumExposure = 0n
    for (const provider of this.providers.values()) {
      assert.ok(provider.stakeLocked <= provider.stakeTotal)
      const open = [...this.coverages.values()].filter((coverage) => coverage.providerId === [...this.providers.entries()].find(([, item]) => item === provider)?.[0] && coverage.status === OPEN && !coverage.released)
      assert.equal(provider.stakeLocked, open.reduce((sum, coverage) => sum + coverage.locked, 0n))
      assert.equal(provider.exposure, open.reduce((sum, coverage) => sum + coverage.gross, 0n))
      sumStake += provider.stakeTotal
      sumExposure += provider.exposure
    }
    assert.equal(this.totalStake, sumStake)
    assert.equal(this.totalExposure, sumExposure)
    assert.ok(this.totalStake + this.reserve <= this.actual)
    for (const coverage of this.coverages.values()) {
      assert.equal(coverage.status === OPEN, !coverage.released)
      if (coverage.status !== OPEN) assert.equal(coverage.released, true)
    }
    for (const claim of this.claims.values()) {
      const coverage = this.coverages.get(claim.coverageId)
      assert.ok(coverage)
      assert.notEqual(coverage.status, OPEN)
      assert.equal(claim.stakeDebit + claim.poolDebit, claim.approvedAmount)
      if (!claim.approved) assert.deepEqual([claim.stakeDebit, claim.poolDebit], [0n, 0n])
    }
  }
}

test('lifecycle model proves rollback, waterfall, tombstones, stored payer, pause, and mixed collateral', () => {
  const model = new LifecycleModel()
  model.addProvider('p1', 'owner-1', 200n)
  model.addProvider('p2', 'owner-2', 100n)
  model.open('c1', 'p1', 'payer-1', 40n, 4n, 40n, 10n)
  model.open('c2', 'p1', 'payer-2', 50n, 5n, 50n, 100n)
  model.invariant()

  const beforeFailedWithdrawal = model.snapshot()
  assert.throws(() => model.withdraw('p1', 'owner-1', 161n), /unsafe withdrawal/)
  assert.deepEqual(structuredClone(model), beforeFailedWithdrawal)
  assert.throws(() => model.withdraw('p1', 'wrong-owner', 1n), /owner/)
  model.paused = true
  assert.throws(() => model.withdraw('p1', 'owner-1', 1n), /paused/)
  model.now = 10n
  model.close('c1')
  model.invariant()
  assert.throws(() => model.close('c1'), /terminal/)
  model.paused = false
  model.providers.get('p1').active = false
  model.withdraw('p1', 'owner-1', 100n)
  model.providers.get('p1').active = true
  model.invariant()

  model.paused = false
  model.open('cReject', 'p2', 'payer-rejected', 5n, 5n, 5n, 100n)
  model.paused = true
  const rejected = model.finalize('claim-rejected', 'cReject', false, 0n, false, 1n)
  assert.deepEqual([rejected.stakeDebit, rejected.poolDebit], [0n, 0n])
  assert.equal(model.balance('payer-2'), 0n)
  model.invariant()
  model.paused = false

  model.open('c3', 'p2', 'payer-3', 30n, 30n, 30n, 100n)
  const poolOnly = model.finalize('claim-pool', 'c3', true, 20n, false, 2n)
  assert.deepEqual([poolOnly.stakeDebit, poolOnly.poolDebit], [0n, 20n])
  assert.equal(model.balance('payer-3'), 20n)
  model.invariant()

  model.open('c4', 'p1', 'payer-4', 100n, 40n, 40n, 100n)
  model.open('c5', 'p1', 'payer-5', 10n, 10n, 10n, 100n)
  const waterfall = model.finalize('claim-waterfall', 'c4', true, 80n, true, 3n)
  assert.deepEqual([waterfall.stakeDebit, waterfall.poolDebit], [40n, 40n])
  assert.equal(model.coverages.get('c5').status, OPEN)
  assert.equal(model.providers.get('p1').stakeLocked, 60n)
  assert.equal(model.providers.get('p1').stakeTotal, 60n)
  assert.equal(model.balance('payer-4'), 80n)
  model.invariant()

  const claimBeforeDuplicate = model.snapshot()
  assert.throws(() => model.finalize('claim-waterfall', 'c5', true, 1n, false, 4n), /claim already/)
  assert.deepEqual(structuredClone(model), claimBeforeDuplicate)
  assert.throws(() => model.finalize('bad', 'c5', false, 1n, false, 4n), /invalid rejected/)
  assert.throws(() => model.finalize('bad-2', 'c5', true, 0n, false, 4n), /invalid approved/)
  assert.throws(() => model.finalize('bad-3', 'c5', true, 21n, true, 4n), /invalid outcome/)
  assert.throws(() => model.finalize('bad-4', 'c5', false, 0n, false, 0n), /invalid outcome/)
  model.invariant()
})

test('seeded lifecycle state machine checks rollback and invariants across every required category', () => {
  const model = new LifecycleModel()
  model.addProvider('p1', 'owner-1', 500n)
  model.addProvider('p2', 'owner-2', 350n)
  const counts = {
    deposits: { success: 0, failure: 0 },
    mixedPolicyOpens: { success: 0, failure: 0 },
    partialWithdrawals: { success: 0, failure: 0 },
    fullWithdrawals: { success: 0, failure: 0 },
    expiryCloses: { success: 0, failure: 0 },
    rejectedClaims: { success: 0, failure: 0 },
    approvedPoolClaims: { success: 0, failure: 0 },
    approvedFaultClaims: { success: 0, failure: 0 },
    zeroCapacity: { success: 0, failure: 0 },
  }
  const attempt = (category, action) => {
    const before = model.snapshot()
    try {
      const result = action()
      counts[category].success += 1
      model.invariant()
      return result
    } catch (error) {
      counts[category].failure += 1
      assert.deepEqual(model.snapshot(), before, `${category} failure restored complete state`)
      model.invariant()
      return undefined
    }
  }

  attempt('deposits', () => model.deposit('p1', 'owner-1', 50n))
  attempt('deposits', () => model.deposit('p1', 'wrong-owner', 1n))
  attempt('deposits', () => model.deposit('p1', 'owner-1', 0n))
  attempt('mixedPolicyOpens', () => model.open('m1', 'p1', 'payer-m1', 40n, 1n, 10n, 5n))
  attempt('mixedPolicyOpens', () => model.open('m2', 'p1', 'payer-m2', 100n, 2n, 75n, 100n))
  attempt('partialWithdrawals', () => model.withdraw('p1', 'owner-1', 1n))
  attempt('partialWithdrawals', () => model.withdraw('p1', 'owner-1', 466n))
  model.now = 5n
  attempt('expiryCloses', () => model.close('m1'))
  attempt('expiryCloses', () => model.close('m1'))
  attempt('expiryCloses', () => model.close(''))
  attempt('mixedPolicyOpens', () => model.open('m-expired', 'p2', 'payer-expired', 5n, 1n, 5n, 5n))
  attempt('expiryCloses', () => model.close('m-expired'))
  attempt('mixedPolicyOpens', () => model.open('m-paused-close', 'p2', 'payer-paused-close', 5n, 1n, 5n, 100n))
  model.paused = true
  model.now = 100n
  attempt('expiryCloses', () => model.close('m-paused-close'))
  model.paused = false

  attempt('mixedPolicyOpens', () => model.open('m-rejected', 'p2', 'payer-rejected', 5n, 1n, 5n, 100n))
  model.paused = true
  attempt('rejectedClaims', () => model.finalize('claim-rejected', 'm-rejected', false, 0n, false, 1n))
  model.paused = false
  attempt('mixedPolicyOpens', () => model.open('m-pool', 'p2', 'payer-pool', 30n, 3n, 30n, 100n))
  attempt('approvedPoolClaims', () => model.finalize('claim-pool', 'm-pool', true, 3n, false, 2n))

  attempt('mixedPolicyOpens', () => model.open('m-other', 'p1', 'payer-other', 10n, 10n, 10n, 100n))
  attempt('partialWithdrawals', () => model.withdraw('p1', 'owner-1', 439n))
  attempt('mixedPolicyOpens', () => model.open('m-fault', 'p1', 'payer-fault', 100n, 100n, 25n, 100n))
  const fault = attempt('approvedFaultClaims', () => model.finalize('claim-fault', 'm-fault', true, 100n, true, 3n))
  assert.deepEqual([fault.stakeDebit, fault.poolDebit], [25n, 75n])
  assert.equal(model.coverages.get('m-other').status, OPEN)
  assert.equal(model.providers.get('p1').stakeLocked, 85n)
  model.now = 100n
  attempt('expiryCloses', () => model.close('m2'))
  attempt('expiryCloses', () => model.close('m-other'))
  attempt('fullWithdrawals', () => model.withdraw('p1', 'owner-1', 85n))
  attempt('zeroCapacity', () => model.open('m-zero-capacity', 'p1', 'payer-zero', 1n, 1n, 1n, 300n))

  model.providers.get('p2').active = false
  attempt('partialWithdrawals', () => model.withdraw('p2', 'owner-2', 1n))
  model.providers.get('p2').active = true
  model.paused = true
  attempt('partialWithdrawals', () => model.withdraw('p2', 'owner-2', 1n))
  model.paused = false
  attempt('partialWithdrawals', () => model.withdraw('', 'owner-2', 1n))
  attempt('rejectedClaims', () => model.finalize('', 'm2', false, 0n, false, 1n))
  attempt('rejectedClaims', () => model.finalize('claim-bad-bool', 'm2', false, 1n, false, 1n))

  attempt('mixedPolicyOpens', () => model.open('race-claim-first', 'p2', 'payer-race-1', 5n, 1n, 5n, 300n))
  attempt('approvedPoolClaims', () => model.finalize('claim-race-1', 'race-claim-first', true, 1n, false, 4n))
  attempt('expiryCloses', () => model.close('race-claim-first'))
  attempt('mixedPolicyOpens', () => model.open('race-close-first', 'p2', 'payer-race-2', 5n, 1n, 5n, 200n))
  model.now = 200n
  attempt('expiryCloses', () => model.close('race-close-first'))
  attempt('rejectedClaims', () => model.finalize('claim-race-2', 'race-close-first', false, 0n, false, 4n))

  let seed = 0x9e3779b9
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  let nextCoverage = 10
  let nextClaim = 10
  const openIds = () => [...model.coverages.entries()].filter(([, coverage]) => coverage.status === OPEN && !coverage.released)
  for (let step = 0; step < 250 - 37; step += 1) {
    const roll = next() % 100
    const open = openIds()
    if (roll < 15) {
      const providerId = next() % 2 === 0 ? 'p1' : 'p2'
      const provider = model.providers.get(providerId)
      attempt('deposits', () => model.deposit(providerId, provider.owner, BigInt(1 + (next() % 8))))
    } else if (roll < 35) {
      const providerId = next() % 2 === 0 ? 'p1' : 'p2'
      const gross = BigInt(5 + (next() % 35))
      const locked = BigInt(1 + (next() % Number(gross)))
      const premium = BigInt(1 + (next() % 4))
      attempt('mixedPolicyOpens', () => model.open(`s${nextCoverage++}`, providerId, `payer-${next() % 4}`, gross, premium, locked, model.now + BigInt(1 + (next() % 5))))
    } else if (roll < 50) {
      const providerId = next() % 2 === 0 ? 'p1' : 'p2'
      const provider = model.providers.get(providerId)
      attempt('partialWithdrawals', () => model.withdraw(providerId, provider.owner, BigInt(1 + (next() % 8))))
    } else if (roll < 63 && open.length) {
      model.now += BigInt(next() % 6)
      const [id] = open[next() % open.length]
      attempt('expiryCloses', () => model.close(id))
    } else if (roll < 78 && open.length) {
      const [id, coverage] = open[next() % open.length]
      attempt('rejectedClaims', () => model.finalize(`sclaim${nextClaim++}`, id, false, 0n, false, 1n + BigInt(next() % 4)))
      assert.equal(coverage.status !== OPEN, true)
    } else if (open.length) {
      const [id, coverage] = open[next() % open.length]
      const amount = BigInt(1 + (next() % Number(coverage.gross)))
      const providerFault = next() % 2 === 0
      attempt(providerFault ? 'approvedFaultClaims' : 'approvedPoolClaims', () => model.finalize(`sclaim${nextClaim++}`, id, true, amount, providerFault, 1n + BigInt(next() % 4)))
    } else {
      model.now += 1n
    }
    model.invariant()
  }
  for (const category of Object.keys(counts)) {
    assert.ok(counts[category].success + counts[category].failure > 0, `${category} was attempted`)
  }
  assert.ok(counts.deposits.success > 0 && counts.deposits.failure > 0)
  assert.ok(counts.rejectedClaims.success > 0 && counts.rejectedClaims.failure > 0)
  assert.ok(counts.approvedPoolClaims.success > 0)
  assert.ok(counts.approvedFaultClaims.success > 0)
  assert.ok(counts.partialWithdrawals.success > 0 && counts.fullWithdrawals.success > 0)
  assert.ok(counts.expiryCloses.success > 0 && counts.expiryCloses.failure > 0)
  assert.ok(counts.zeroCapacity.failure > 0)
  assert.deepEqual(counts, {
    deposits: { success: 31, failure: 2 },
    mixedPolicyOpens: { success: 40, failure: 6 },
    partialWithdrawals: { success: 39, failure: 10 },
    fullWithdrawals: { success: 1, failure: 0 },
    expiryCloses: { success: 8, failure: 9 },
    rejectedClaims: { success: 13, failure: 3 },
    approvedPoolClaims: { success: 11, failure: 0 },
    approvedFaultClaims: { success: 8, failure: 0 },
    zeroCapacity: { success: 0, failure: 1 },
  })
  assert.ok(model.claims.size > 0)
  model.invariant()
})
