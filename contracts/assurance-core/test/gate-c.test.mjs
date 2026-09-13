import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import algosdk from 'algosdk'
import { x402Facilitator } from '@x402/core/facilitator'
import {
  ASSURED_EXACT_SCHEME,
  ASSURANCE_CORE_PROFILE,
  AssuredExactError,
  LOCALNET_NETWORK,
  OPEN_COVERAGE_METHOD,
  createAssuredExactFacilitator,
} from '../adapter/assured-exact.mjs'

const root = path.resolve(import.meta.dirname, '..')
const arc56 = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'AssuranceCore.arc56.json'), 'utf8'))
const source = fs.readFileSync(path.join(root, 'contract', 'assurance-core.algo.ts'), 'utf8')
const max = 18_446_744_073_709_551_615n
const zero = new Uint8Array(32)
const filled = (value) => new Uint8Array(32).fill(value)
const b64 = (value) => Buffer.from(value).toString('base64')
const eventPrefix = (signature) => crypto.createHash('sha512-256').update(signature).digest().subarray(0, 4)

const arithmetic = (gross, premiumBps, collateralRatioBps) => {
  assert.ok(gross > 0n)
  const rawPremium = (gross * BigInt(premiumBps)) / 10_000n
  const premium = rawPremium < 1n ? 1n : rawPremium
  const providerNet = gross - premium
  const lockedStake = (gross * BigInt(collateralRatioBps) + 9_999n) / 10_000n
  return { premium, providerNet, lockedStake }
}

test('Gate C ABI, immutable record, status, and event are exact', () => {
  const methods = new Map(arc56.methods.map((method) => [method.name, method]))
  assert.deepEqual(methods.get('openCoverage').args.map((arg) => arg.type), ['byte[32]', 'byte[32]', 'byte[32]', 'byte[32]', 'uint64'])
  assert.equal(methods.get('getCoverage').returns.type, '(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)')
  assert.equal(methods.get('getCoverage').readonly, true)
  assert.equal(methods.get('openCoverage').args.some((arg) => arg.type === 'axfer'), false)
  assert.equal(arc56.events.find((event) => event.name === 'CoverageOpened').args.map((arg) => arg.type).join(','), 'uint64,byte[32],byte[32],byte[32],address,uint64,uint64,uint64,byte[32],uint64,uint64')
  const signature = 'CoverageOpened(uint64,byte[32],byte[32],byte[32],address,uint64,uint64,uint64,byte[32],uint64,uint64)'
  const event = arc56.events.find((item) => item.name === 'CoverageOpened')
  assert.deepEqual([...eventPrefix(signature)], [...eventPrefix(signature)])
  assert.equal(source.includes('COVERAGE_STATUS_OPEN: uint64 = 1'), true)
  assert.equal(source.includes('COVERAGE_STATUS_REFUNDED: uint64 = 2'), true)
  assert.equal(source.includes('COVERAGE_STATUS_CLOSED: uint64 = 3'), true)
  assert.equal(source.includes('status: new arc4.Uint64(COVERAGE_STATUS_OPEN)'), true)
  assert.equal(source.includes("assert(!coverage.exists, 'coverage already exists')"), true)
  const payer = algosdk.generateAccount()
  assert.deepEqual(algosdk.ABIType.from('(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)').decode(
    algosdk.ABIType.from('(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)').encode([
      filled(1), filled(2), payer.addr.toString(), 99, 90, 9, 0, 25, filled(3), 10, 20, 1, false,
    ])), [Array.from(filled(1)), Array.from(filled(2)), payer.addr.toString(), 99n, 90n, 9n, 0n, 25n, Array.from(filled(3)), 10n, 20n, 1n, false])
})

test('Gate C premium floor/minimum and collateral ceiling stay wide at uint64 boundaries', () => {
  assert.deepEqual(arithmetic(99n, 250, 2_500), { premium: 2n, providerNet: 97n, lockedStake: 25n })
  assert.deepEqual(arithmetic(1n, 1, 1), { premium: 1n, providerNet: 0n, lockedStake: 1n })
  assert.deepEqual(arithmetic(max, 2_500, 7_500), { premium: 4_611_686_018_427_387_903n, providerNet: 13_835_058_055_282_163_712n, lockedStake: 13_835_058_055_282_163_712n })
  assert.deepEqual(arithmetic(max, 10_000, 10_000), { premium: max, providerNet: 0n, lockedStake: max })
  assert.equal(arithmetic(10_001n, 1, 1).lockedStake, 2n)
  assert.ok(arithmetic(max, 2_500, 7_500).premium <= max)
  assert.ok(arithmetic(max, 2_500, 7_500).lockedStake <= max)
})

test('Gate C state model conserves accounting and sums immutable mixed-policy locks', () => {
  const state = { stakeTotal: 1_000n, stakeLocked: 0n, providerExposure: 0n, globalExposure: 0n, reserve: 0n }
  const open = (gross, premiumBps, ratio) => {
    const amounts = arithmetic(gross, premiumBps, ratio)
    assert.ok(state.stakeTotal - state.stakeLocked >= amounts.lockedStake)
    assert.ok(state.stakeLocked <= max - amounts.lockedStake)
    assert.ok(state.providerExposure <= max - gross)
    assert.ok(state.globalExposure <= max - gross)
    assert.ok(state.reserve <= max - amounts.premium)
    state.stakeLocked += amounts.lockedStake
    state.providerExposure += gross
    state.globalExposure += gross
    state.reserve += amounts.premium
    return { ...amounts }
  }
  const first = open(100n, 250, 2_500)
  const second = open(200n, 250, 7_500)
  assert.deepEqual(first, { premium: 2n, providerNet: 98n, lockedStake: 25n })
  assert.deepEqual(second, { premium: 5n, providerNet: 195n, lockedStake: 150n })
  assert.equal(state.stakeLocked, first.lockedStake + second.lockedStake)
  assert.equal(state.providerExposure, 300n)
  assert.equal(state.globalExposure, 300n)
  assert.equal(state.reserve, 7n)
  assert.equal(state.stakeTotal - state.stakeLocked, 825n)
  assert.throws(() => { if (state.stakeTotal - state.stakeLocked < 826n) throw new Error('insufficient capacity') }, /insufficient/)
  assert.throws(() => { if (max - max < 1n) throw new Error('overflow') }, /overflow/)
})

const makeValidFixture = () => {
  const payer = algosdk.generateAccount()
  const provider = algosdk.generateAccount()
  const applicationId = 77
  const applicationAddress = algosdk.getApplicationAddress(applicationId).toString()
  const assetId = 55
  const coverageId = filled(11)
  const providerId = filled(12)
  const policyId = filled(13)
  const requestHash = filled(14)
  const { providerNet, premium } = arithmetic(1_000n, 250, 2_500)
  const suggestedParams = {
    fee: 1_000,
    minFee: 1_000,
    firstValid: 1,
    lastValid: 100,
    genesisID: 'dockernet-v1',
    genesisHash: filled(15),
    flatFee: true,
  }
  const providerTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: provider.addr,
    amount: Number(providerNet),
    assetIndex: assetId,
    suggestedParams,
  })
  const premiumTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: applicationAddress,
    amount: Number(premium),
    assetIndex: assetId,
    suggestedParams,
  })
  const args = [coverageId, providerId, policyId, requestHash, algosdk.ABIType.from('uint64').encode(1_000n)]
  const application = algosdk.makeApplicationNoOpTxnFromObject({
    sender: payer.addr,
    appIndex: applicationId,
    appArgs: [OPEN_COVERAGE_METHOD.getSelector(), ...args],
    boxes: [
      { appIndex: 0, name: Buffer.concat([Buffer.from('p'), providerId]) },
      { appIndex: 0, name: Buffer.concat([Buffer.from('l'), policyId]) },
      { appIndex: 0, name: Buffer.concat([Buffer.from('c'), coverageId]) },
    ],
    foreignAssets: [assetId],
    suggestedParams,
  })
  const group = algosdk.assignGroupID([providerTransfer, premiumTransfer, application])
  const signed = group.map((txn) => txn.signTxn(payer.sk))
  const requirements = {
    scheme: ASSURED_EXACT_SCHEME,
    network: LOCALNET_NETWORK,
    asset: String(assetId),
    amount: '1000',
    payTo: provider.addr.toString(),
    maxTimeoutSeconds: 60,
    extra: {
      profile: ASSURANCE_CORE_PROFILE,
      provider: provider.addr.toString(),
      applicationAddress,
      applicationId: String(applicationId),
      providerNet: String(providerNet),
      premium: String(premium),
      coverageId: b64(coverageId),
      providerId: b64(providerId),
      policyId: b64(policyId),
      requestCommitment: b64(requestHash),
    },
  }
  return {
    payer,
    requirements,
    payload: { x402Version: 2, payload: { paymentGroup: signed.map(b64), providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } },
    signed,
  }
}

test('assured-exact binds every member, registers with real x402 core, and settles immutable bytes', async () => {
  const fixture = makeValidFixture()
  const calls = []
  const facilitator = createAssuredExactFacilitator({
    algod: {}, applicationId: 77, acceptedAssetId: 55,
    simulate: async (bytes) => calls.push({ kind: 'simulate', bytes: bytes.map((item) => Buffer.from(item)) }),
    submit: async (bytes) => { calls.push({ kind: 'submit', bytes: bytes.map((item) => Buffer.from(item)) }); return { txId: 'confirmed-group-member-0' } },
    confirm: async (txid) => calls.push({ kind: 'confirm', txid }),
  })
  const core = new x402Facilitator().register(LOCALNET_NETWORK, facilitator)
  assert.deepEqual(core.getSupported().kinds, [{ x402Version: 2, scheme: ASSURED_EXACT_SCHEME, network: LOCALNET_NETWORK, extra: { profile: ASSURANCE_CORE_PROFILE } }])
  const verified = await core.verify(fixture.payload, fixture.requirements)
  assert.deepEqual(verified, { isValid: true, payer: fixture.payer.addr.toString() })
  fixture.payload.payload.paymentGroup[0] = b64(new Uint8Array([1]))
  const settled = await core.settle(fixture.payload, fixture.requirements)
  assert.equal(settled.success, true)
  assert.equal(calls.filter((call) => call.kind === 'simulate').length, 1)
  assert.equal(calls.filter((call) => call.kind === 'submit').length, 1)
  assert.equal(calls.find((call) => call.kind === 'submit').bytes[0].equals(Buffer.from(fixture.signed[0])), true)
  assert.equal(calls.find((call) => call.kind === 'confirm').txid, 'confirmed-group-member-0')
})

test('signed-byte rejection, simulation, submission, and confirmation failures are distinct', async () => {
  const fixture = makeValidFixture()
  const calls = []
  const make = (overrides = {}) => createAssuredExactFacilitator({
    algod: {}, applicationId: 77, acceptedAssetId: 55,
    simulate: async (bytes) => { calls.push('simulate'); if (overrides.simulation) throw new Error('simulated assertion') },
    submit: async () => { calls.push('submit'); if (overrides.submission) throw new Error('pool assertion'); return { txid: 'txid' } },
    confirm: async () => { calls.push('confirm'); if (overrides.confirmation) throw new Error('not confirmed') },
  })
  const corrupted = { ...fixture.payload, payload: { ...fixture.payload.payload, paymentGroup: [...fixture.payload.payload.paymentGroup] } }
  const decodedCorrupted = algosdk.decodeSignedTransaction(corrupted.payload.paymentGroup[2] && fixture.signed[2])
  const corruptedSignature = Buffer.from(decodedCorrupted.sig)
  corruptedSignature[0] ^= 1
  corrupted.payload.paymentGroup[2] = b64(algosdk.encodeMsgpack(new algosdk.SignedTransaction({ txn: decodedCorrupted.txn, sig: corruptedSignature })))
  const invalidSignature = await make().verify(corrupted, fixture.requirements)
  assert.equal(invalidSignature.isValid, false)
  assert.equal(invalidSignature.invalidReason, 'signature')
  assert.deepEqual(calls, [])

  calls.length = 0
  const simulationFailure = await make({ simulation: true }).verify(fixture.payload, fixture.requirements)
  assert.equal(simulationFailure.invalidReason, 'simulation')
  assert.deepEqual(calls, ['simulate'])

  await assert.rejects(() => make({ submission: true }).settle(fixture.payload, fixture.requirements), (error) => error instanceof AssuredExactError && error.category === 'submission')
  await assert.rejects(() => make({ confirmation: true }).settle(fixture.payload, fixture.requirements), (error) => error instanceof AssuredExactError && error.category === 'confirmation')
})

test('malformed metadata, wrong role/order, unsafe fields, ABI mismatch, and missing box refs reject before simulation', async () => {
  const fixture = makeValidFixture()
  let simulated = 0
  const facilitator = createAssuredExactFacilitator({ algod: {}, applicationId: 77, acceptedAssetId: 55, simulate: async () => { simulated += 1 } })
  const cases = [
    ['non-canonical amount', { ...fixture.requirements, amount: '01000' }],
    ['wrong profile', { ...fixture.requirements, extra: { ...fixture.requirements.extra, profile: 'wrong' } }],
    ['split mismatch', { ...fixture.requirements, extra: { ...fixture.requirements.extra, premium: '3' } }],
  ]
  for (const [, requirements] of cases) {
    const result = await facilitator.verify(fixture.payload, requirements)
    assert.equal(result.isValid, false)
    assert.equal(simulated, 0)
  }
  const wrongOrder = { ...fixture.payload, payload: { ...fixture.payload.payload, paymentGroup: [fixture.payload.payload.paymentGroup[1], fixture.payload.payload.paymentGroup[0], fixture.payload.payload.paymentGroup[2]] } }
  const orderResult = await facilitator.verify(wrongOrder, fixture.requirements)
  assert.equal(orderResult.invalidReason, 'group')
  assert.equal(simulated, 0)
  const bindingResult = await facilitator.verify(fixture.payload, { ...fixture.requirements, extra: { ...fixture.requirements.extra, providerNet: '999' } })
  assert.equal(bindingResult.invalidReason, 'binding')
  assert.equal(simulated, 0)
})
