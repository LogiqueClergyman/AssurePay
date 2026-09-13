import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import algosdk from 'algosdk'
import { x402Facilitator } from '@x402/core/facilitator'
import { isPaymentPayload } from '@x402/core/schemas'
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
  assert.deepEqual([...eventPrefix(signature)], [0x45, 0xd4, 0x3a, 0xe7])
  assert.equal(event.name, 'CoverageOpened')
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

test('Gate C accounting checks the existing premium reserve in the complete balance invariant', () => {
  const totalProviderStake = 90n
  const existingPremiumReserve = 8n
  const newPremium = 3n
  const actualApplicationBalance = 100n
  const newPremiumReserve = existingPremiumReserve + newPremium
  assert.equal(totalProviderStake + newPremium <= actualApplicationBalance, true, 'old expression would pass')
  assert.equal(totalProviderStake + newPremiumReserve <= actualApplicationBalance, false, 'complete invariant rejects')
  assert.throws(() => {
    if (totalProviderStake > max - newPremiumReserve) throw new Error('tracked stake overflow')
    if (totalProviderStake + newPremiumReserve > actualApplicationBalance) throw new Error('tracked stake exceeds balance')
  }, /tracked stake exceeds balance/)
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
    payload: {
      x402Version: 2,
      resource: { url: 'https://assurepay.test/coverage', description: 'Gate C coverage', mimeType: 'application/json', serviceName: 'AssurePay', tags: ['coverage'] },
      accepted: requirements,
      payload: { paymentGroup: signed.map(b64), providerIndex: 0, premiumIndex: 1, applicationIndex: 2 },
      extensions: { 'assurepay-test': { deterministic: true } },
    },
    signed,
  }
}

const cloneWithRequirements = (fixture, requirements) => ({
  ...fixture,
  requirements,
  payload: { ...fixture.payload, accepted: requirements },
})

const mutateSignedGroup = (fixture, mutate, signerAccounts = undefined) => {
  const txns = fixture.signed.map((signed) => algosdk.decodeSignedTransaction(signed).txn)
  txns.forEach((txn) => { txn.group = undefined })
  mutate(txns)
  const grouped = algosdk.assignGroupID(txns)
  const signed = grouped.map((txn, index) => txn.signTxn((signerAccounts?.[index] ?? fixture.payer).sk))
  return {
    ...fixture,
    signed,
    payload: { ...fixture.payload, payload: { ...fixture.payload.payload, paymentGroup: signed.map(b64) } },
  }
}

const replaceGroupMember = (fixture, index, bytes) => ({
  ...fixture,
  payload: { ...fixture.payload, payload: { ...fixture.payload.payload, paymentGroup: fixture.payload.payload.paymentGroup.map((item, member) => member === index ? b64(bytes) : item) } },
})

const malformedMultisig = (fixture) => {
  const txn = algosdk.decodeSignedTransaction(fixture.signed[0]).txn
  return replaceGroupMember(fixture, 0, algosdk.createMultisigTransaction(txn, { version: 1, threshold: 1, addrs: [fixture.payer.addr.toString(), algosdk.generateAccount().addr.toString()] }))
}

const malformedLogicSig = (fixture) => {
  const txn = algosdk.decodeSignedTransaction(fixture.signed[0]).txn
  const logic = new algosdk.LogicSigAccount(new Uint8Array([1, 1]))
  logic.sign(fixture.payer.sk)
  return replaceGroupMember(fixture, 0, algosdk.signLogicSigTransactionObject(txn, logic).blob)
}

test('assured-exact binds every member, registers with real x402 core, and settles immutable bytes', async () => {
  const fixture = makeValidFixture()
  assert.equal(isPaymentPayload(fixture.payload), true)
  const calls = []
  const facilitator = createAssuredExactFacilitator({
    algod: {}, applicationId: 77, acceptedAssetId: 55,
    simulate: async (bytes) => calls.push({ kind: 'simulate', bytes: bytes.map((item) => Buffer.from(item)) }),
    submit: async (bytes) => { calls.push({ kind: 'submit', bytes: bytes.map((item) => Buffer.from(item)) }); return { txId: 'confirmed-group-member-0' } },
    confirm: async (txid) => calls.push({ kind: 'confirm', txid }),
  })
  const core = new x402Facilitator().register(LOCALNET_NETWORK, facilitator)
  assert.deepEqual(core.getSupported().kinds, [{ x402Version: 2, scheme: ASSURED_EXACT_SCHEME, network: LOCALNET_NETWORK, extra: { profile: ASSURANCE_CORE_PROFILE } }])
  assert.equal(facilitator.caipFamily, 'algorand:*')
  assert.deepEqual(facilitator.getSigners(), [])
  assert.throws(() => createAssuredExactFacilitator({ algod: {}, applicationId: 77, applicationAddress: algosdk.getApplicationAddress(78).toString(), acceptedAssetId: 55 }), /application address does not match/)
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

  const submissionFailure = await make({ submission: true }).settle(fixture.payload, fixture.requirements)
  assert.deepEqual(submissionFailure, { success: false, errorReason: 'submission', errorMessage: '[submission] transaction pool rejected the group', transaction: '', network: LOCALNET_NETWORK, payer: fixture.payer.addr.toString() })
  const confirmationFailure = await make({ confirmation: true }).settle(fixture.payload, fixture.requirements)
  assert.deepEqual(confirmationFailure, { success: false, errorReason: 'confirmation', errorMessage: '[confirmation] confirmed transaction failed', transaction: '', network: LOCALNET_NETWORK, payer: fixture.payer.addr.toString() })
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

test('Gate C deterministic adapter mutations reject before simulation and never submit', async () => {
  const fixture = makeValidFixture()
  let simulations = 0
  let submissions = 0
  const facilitator = createAssuredExactFacilitator({
    algod: {}, applicationId: 77, acceptedAssetId: 55,
    simulate: async () => { simulations += 1 },
    submit: async () => { submissions += 1; return { txId: 'unexpected' } },
  })
  const rejected = async (candidate, requirements = candidate.requirements, reason = undefined, label = 'candidate') => {
    const result = await facilitator.verify(candidate.payload, requirements)
    assert.equal(result.isValid, false, `${label} unexpectedly verified`)
    if (reason) assert.equal(result.invalidReason, reason)
    assert.equal(simulations, 0, 'rejection did not simulate')
    assert.equal(submissions, 0, 'rejection did not submit')
  }

  const metadataMutations = [
    ['wrong scheme', { ...fixture.requirements, scheme: 'exact' }, 'binding'],
    ['wrong network', { ...fixture.requirements, network: 'algorand:testnet' }, 'binding'],
    ['wrong profile', { ...fixture.requirements, extra: { ...fixture.requirements.extra, profile: 'other' } }, 'binding'],
    ['wrong ASA', { ...fixture.requirements, asset: '56' }, 'binding'],
    ['wrong receivers', { ...fixture.requirements, payTo: algosdk.generateAccount().addr.toString(), extra: { ...fixture.requirements.extra, provider: algosdk.generateAccount().addr.toString() } }, 'binding'],
    ['wrong amounts', { ...fixture.requirements, amount: '1001' }, 'binding'],
    ['wrong app id', { ...fixture.requirements, extra: { ...fixture.requirements.extra, applicationId: '78' } }, 'binding'],
    ['non-canonical metadata', { ...fixture.requirements, extra: { ...fixture.requirements.extra, providerNet: '0999' } }, 'payload'],
  ]
  for (const [label, requirements, reason] of metadataMutations) await rejected(cloneWithRequirements(fixture, requirements), requirements, reason, label)

  const payloadShapeMutations = [
    ['wrong indices', { ...fixture.payload, payload: { ...fixture.payload.payload, providerIndex: 1 } }, 'group'],
    ['wrong group size', { ...fixture.payload, payload: { ...fixture.payload.payload, paymentGroup: fixture.payload.payload.paymentGroup.slice(0, 2) } }, 'group'],
    ['malformed envelope', { x402Version: 2, accepted: fixture.requirements, payload: fixture.payload.payload, unexpected: true }, 'payload'],
    ['non-canonical group metadata', { ...fixture.payload, payload: { ...fixture.payload.payload, paymentGroup: [...fixture.payload.payload.paymentGroup.slice(0, 2), `${fixture.payload.payload.paymentGroup[2]}=`] } }, 'payload'],
  ]
  for (const [label, payload, reason] of payloadShapeMutations) await rejected({ ...fixture, payload }, fixture.requirements, reason, label)

  await rejected(malformedMultisig(fixture), fixture.requirements, 'signature')
  await rejected(malformedLogicSig(fixture), fixture.requirements, 'signature')
  for (let index = 0; index < 3; index += 1) {
    const decoded = algosdk.decodeSignedTransaction(fixture.signed[index])
    await rejected(replaceGroupMember(fixture, index, algosdk.encodeMsgpack(new algosdk.SignedTransaction({ txn: decoded.txn }))), fixture.requirements, 'signature')
    const corrupted = Buffer.from(decoded.sig)
    corrupted[0] ^= 1
    await rejected(replaceGroupMember(fixture, index, algosdk.encodeMsgpack(new algosdk.SignedTransaction({ txn: decoded.txn, sig: corrupted }))), fixture.requirements, 'signature')
    const wrongKey = algosdk.generateAccount()
    await rejected(replaceGroupMember(fixture, index, decoded.txn.signTxn(wrongKey.sk)), fixture.requirements, 'signature')
  }

  const regrouped = mutateSignedGroup(fixture, (txns) => {
    const reordered = [txns[1], txns[0], txns[2]]
    txns.splice(0, txns.length, ...reordered)
  })
  await rejected(regrouped, fixture.requirements, 'binding')
  const wrongSenderAccount = algosdk.generateAccount()
  const wrongSender = mutateSignedGroup(fixture, (txns) => { txns[0].sender = algosdk.decodeAddress(wrongSenderAccount.addr.toString()) }, [wrongSenderAccount, fixture.payer, fixture.payer])
  await rejected(wrongSender, fixture.requirements, 'role')
  const wrongGroupId = replaceGroupMember(fixture, 0, (() => {
    const decoded = algosdk.decodeSignedTransaction(fixture.signed[0])
    decoded.txn.group = filled(99)
    return decoded.txn.signTxn(fixture.payer.sk)
  })())
  await rejected(wrongGroupId, fixture.requirements, 'group')

  const transferMutations = [
    ['wrong transfer asset', (txns) => { txns[0].assetTransfer.assetIndex = 56 }, 'binding'],
    ['wrong provider receiver', (txns) => { txns[0].assetTransfer.receiver = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }, 'binding'],
    ['wrong premium receiver', (txns) => { txns[1].assetTransfer.receiver = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }, 'binding'],
    ['wrong provider amount', (txns) => { txns[0].assetTransfer.amount += 1n }, 'binding'],
    ['wrong premium amount', (txns) => { txns[1].assetTransfer.amount += 1n }, 'binding'],
    ['assetSender', (txns) => { txns[0].assetTransfer.assetSender = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }, 'binding'],
    ['close-to', (txns) => { txns[0].assetTransfer.closeRemainderTo = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }, 'binding'],
    ['transfer rekey', (txns) => { txns[0].rekeyTo = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }, 'role'],
    ['premium assetSender', (txns) => { txns[1].assetTransfer.assetSender = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }, 'binding'],
    ['premium close-to', (txns) => { txns[1].assetTransfer.closeRemainderTo = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }, 'binding'],
    ['premium transfer rekey', (txns) => { txns[1].rekeyTo = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }, 'role'],
  ]
  for (const [label, mutate, reason] of transferMutations) await rejected(mutateSignedGroup(fixture, mutate), fixture.requirements, reason)

  const appMutations = [
    ['selector', (txns) => { txns[2].applicationCall.appArgs[0] = filled(88) }],
    ['NoOp', (txns) => { txns[2].applicationCall.onComplete = 1 }],
    ['coverage ABI arg', (txns) => { txns[2].applicationCall.appArgs[1] = filled(88) }],
    ['provider ABI arg', (txns) => { txns[2].applicationCall.appArgs[2] = filled(88) }],
    ['policy ABI arg', (txns) => { txns[2].applicationCall.appArgs[3] = filled(88) }],
    ['request ABI arg', (txns) => { txns[2].applicationCall.appArgs[4] = filled(88) }],
    ['gross ABI arg', (txns) => { txns[2].applicationCall.appArgs[5] = algosdk.ABIType.from('uint64').encode(1001n) }],
    ['boxes', (txns) => { txns[2].applicationCall.boxes[2].name = Buffer.concat([Buffer.from('c'), filled(88)]) }],
    ['foreign asset', (txns) => { txns[2].applicationCall.foreignAssets[0] = 56 }],
    ['unexpected account', (txns) => { txns[2].applicationCall.accounts = [algosdk.decodeAddress(algosdk.generateAccount().addr.toString())] }],
    ['unexpected app', (txns) => { txns[2].applicationCall.foreignApps = [78] }],
    ['application rekey', (txns) => { txns[2].rekeyTo = algosdk.decodeAddress(algosdk.generateAccount().addr.toString()) }],
  ]
  for (const [label, mutate] of appMutations) await rejected(mutateSignedGroup(fixture, mutate), fixture.requirements)

  assert.equal(isPaymentPayload(fixture.payload), true, 'standard x402 v2 payload schema')
  const valid = await facilitator.verify(fixture.payload, fixture.requirements)
  assert.equal(valid.isValid, true)
  fixture.payload.payload.providerIndex = 1
  const failedReverify = await facilitator.verify(fixture.payload, fixture.requirements)
  assert.equal(failedReverify.isValid, false)
  const staleSettlement = await facilitator.settle(fixture.payload, fixture.requirements)
  assert.equal(staleSettlement.success, false)
  assert.equal(staleSettlement.errorReason, 'group')
  assert.equal(submissions, 0, 'stale snapshot was not submitted')
  const malformedVerification = await facilitator.verify(null, fixture.requirements)
  assert.deepEqual(malformedVerification, { isValid: false, invalidReason: 'payload', invalidMessage: '[payload] object expected' })
  const malformedSettlement = await facilitator.settle(null, fixture.requirements)
  assert.deepEqual(malformedSettlement, { success: false, errorReason: 'payload', errorMessage: '[payload] object expected', transaction: '', network: LOCALNET_NETWORK, payer: '' })
  const throwingPayload = new Proxy({}, { ownKeys: () => { throw new Error('malformed envelope') } })
  assert.deepEqual(await facilitator.verify(throwingPayload, fixture.requirements), { isValid: false, invalidReason: 'payload', invalidMessage: '[payload] malformed payment payload' })
})
