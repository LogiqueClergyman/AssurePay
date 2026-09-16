import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import algosdk from 'algosdk'
import { ed25519Verifier } from '@algorandfoundation/algokit-utils/crypto'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'
import { buildAssuredExactPayloadWithSigner } from '../src/assured-exact.mjs'
import { createPeraHdSigner, validatePeraHdMnemonic } from '../src/pera-hd-signer.mjs'
import { EXECUTION_STAGES, TESTNET_CAPACITY_METHOD_SIGNATURE, TESTNET_CAPACITY_SELECTOR, TESTNET_COVERAGE_RECORD_TYPE, applicationSnapshot, assertCompleteRollback, assertComputedInvariants, assertConfiguredOpenCoverage, assertPocLifecycleObservations, calculateTestnetBudget, compactFailure, computeLifecycleInvariants, createExecutionDiagnostics, coverageRecordPublic, executionFailureResult, isIntendedApplicationAssertionFailure, loadDotEnv, matchApplicationAssertionFailures, plannedTransactionTable, preflight, publicEvidenceSafe, proveTransaction, runnerMode, sameSignedByteArrays, testnetConfig, validatePublicEvidence, verifyClaimRefund, verifyPublicEvidence, writePublicEvidence } from '../scripts/run-testnet.mjs'

const mnemonic = 'salon zoo engage submit smile frost later decide wing sight chaos renew lizard rely canal coral scene hobby scare step bus leaf tobacco slice'
const params = { fee: 1_000, minFee: 1_000, firstValid: 1, lastValid: 1_000, genesisHash: new Uint8Array(32), genesisID: 'v1', flatFee: true }
const payerAddress = 'PPNHVQJGE6ZMEWPR35UHLUYMCCZV6VNTHLJMZDVCONXKUPV47K4WGQJWGI'

test('P1 TestNet capacity selector matches committed ARC-56 scalar ABI', () => {
  const arc56 = JSON.parse(fs.readFileSync(new URL('../artifacts/AssuranceCore.arc56.json', import.meta.url), 'utf8'))
  const method = arc56.methods.find(({ name }) => name === 'getAvailableCapacity')
  const committedSignature = `${method.name}(${method.args.map(({ type }) => type).join(',')})${method.returns.type}`
  assert.equal(TESTNET_CAPACITY_METHOD_SIGNATURE, committedSignature)
  assert.deepEqual(TESTNET_CAPACITY_SELECTOR, algosdk.ABIMethod.fromSignature(committedSignature).getSelector())
  assert.notDeepEqual(TESTNET_CAPACITY_SELECTOR, algosdk.ABIMethod.fromSignature('getAvailableCapacity(byte[32],byte[32])(uint64)').getSelector())
})

test('P1 decoded open coverage guard compares ARC-4 uint64 status as bigint and fails closed', () => {
  const providerId = '01'.repeat(32)
  const policyId = '02'.repeat(32)
  const encoded = algosdk.ABIType.from(TESTNET_COVERAGE_RECORD_TYPE).encode([new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), algosdk.decodeAddress(payerAddress).publicKey, 100n, 50n, 50n, 0n, 75n, new Uint8Array(32).fill(3), 0n, 0n, 1n, false])
  const decoded = algosdk.ABIType.from(TESTNET_COVERAGE_RECORD_TYPE).decode(encoded)
  const record = coverageRecordPublic(decoded)
  const expected = { providerId, policyId, payer: payerAddress }
  assert.equal(decoded[11], 1n)
  assert.equal(assertConfiguredOpenCoverage(record, expected), true)
  assert.throws(() => assertConfiguredOpenCoverage({ ...record, status: 2n }, expected), (error) => error.publicCode === 'TESTNET_OPEN_COVERAGE_MISMATCH')
  assert.throws(() => assertConfiguredOpenCoverage({ ...record, providerId: '03'.repeat(32) }, expected), (error) => error.publicCode === 'TESTNET_OPEN_COVERAGE_MISMATCH')
})

test('P1 Pera signer derives Peikert addresses and exposes no private material', async () => {
  assert.equal(validatePeraHdMnemonic(mnemonic), true)
  const signer = await createPeraHdSigner({ mnemonic, accountIndex: 0, addressIndex: 0 })
  try {
    assert.equal(signer.address, payerAddress)
    assert.deepEqual(Object.keys(signer).sort(), ['address', 'dispose', 'signTransaction', 'toJSON'].sort())
    assert.equal(JSON.stringify(signer).includes(mnemonic), false)
    assert.equal('addr' in signer, false)
    assert.equal('sk' in signer, false)
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: signer.address, receiver: payerAddress, amount: 0, suggestedParams: params })
    const signed = await signer.signTransaction(txn)
    const decoded = algosdk.decodeSignedTransaction(signed)
    assert.equal(await ed25519Verifier(new Uint8Array(decoded.sig), decoded.txn.bytesToSign(), decoded.txn.sender.publicKey), true)
    signer.dispose()
    await assert.rejects(signer.signTransaction(txn), /disposed/)
  } finally { signer.dispose() }
})

test('P1 signer rejects invalid phrases, bounded indices, and sanitizes errors', async () => {
  const invalid = `${mnemonic} extra`
  assert.equal(validatePeraHdMnemonic(invalid), false)
  await assert.rejects(createPeraHdSigner({ mnemonic: invalid, accountIndex: 0, addressIndex: 0 }), (error) => !error.message.includes(invalid))
  await assert.rejects(createPeraHdSigner({ mnemonic, accountIndex: -1, addressIndex: 0 }), /invalid Pera HD signer configuration/)
})

test('P1 configuration parser preserves process environment precedence', () => {
  const target = { PRESENT: 'process-value' }
  loadDotEnv('PRESENT=file-value\nNEW_VALUE="quoted"\n# ignored\nBAD LINE', target)
  assert.deepEqual(target, { PRESENT: 'process-value', NEW_VALUE: 'quoted' })
})

test('P1 address mismatch is reported before any endpoint dependency is used', async () => {
  const settings = await testnetConfig({ TESTNET_PAYER_HD_MNEMONIC: mnemonic, TESTNET_PAYER_ADDRESS: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ', TESTNET_PAYER_ACCOUNT_INDEX: '0', TESTNET_PAYER_ADDRESS_INDEX: '0', TESTNET_ASA_ID: '77', TESTNET_ALGOD_SERVER: 'https://testnet.example' })
  try {
    assert.ok(settings.missing.some((item) => item.includes('derived Pera address does not match')))
    let called = false
    const result = await preflight(settings, { algod: { versionsCheck: () => { called = true; throw new Error('must not call network') } } })
    assert.equal(result.ok, false)
    assert.equal(called, false)
    assert.equal(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value).includes(mnemonic), false)
  } finally { settings.payer?.dispose() }
})

test('P1 preflight reports network, ASA holding, spendable, and exact budget branches', async () => {
  const budget = calculateTestnetBudget()
  const settings = { missing: [], expectedAddress: payerAddress, payer: { address: payerAddress }, assetId: 77n }
  let calls = 0
  const fake = {
    versionsCheck: () => ({ do: async () => { calls += 1; return { genesisId: 'v1' } } }),
    genesis: () => ({ do: async () => ({ network: 'testnet', id: 'v1' }) }),
    getAssetByID: () => ({ do: async () => ({ params: { name: 'ASSURE', unitName: 'ASR', decimals: 0 } }) }),
    accountInformation: () => ({ do: async () => ({ amount: Number(budget.totalConservativeRequiredSpendableMicroAlgos + 100_000n), minBalance: 100_000 }) }),
    accountAssetInformation: () => ({ do: async () => ({ assetHolding: { amount: Number(budget.requiredAsaUnits) } }) }),
  }
  const result = await preflight(settings, { algod: fake })
  assert.equal(calls, 1)
  assert.equal(result.ok, true)
  assert.equal(result.genesisId, 'v1')
  assert.equal(result.asset.id, 77n)
  assert.equal(result.payerHolding.atomicUnits, budget.requiredAsaUnits)
  assert.equal(result.budget.approvalByteLength, 3_517n)
  assert.equal(result.budget.extraPages, 1n)
  assert.equal(result.budget.calculatedApplicationBoxFundingBudget, 517_700n)
})

test('P1 budget names every ASA and ALGO term without hidden prefunding', () => {
  const budget = calculateTestnetBudget()
  assert.deepEqual(budget.requiredAsaScenario, { primaryStake: 123n, unrelatedProviderStake: 10n, successfulCoverageGross: 100n, margin: 10n, equation: '123 + 10 + 100 + 10 = 243' })
  assert.equal(budget.requiredAsaUnits, 243n)
  assert.equal(budget.applicationFundingLines.baseAndAsset, 200_000n)
  assert.equal(budget.applicationFundingLines.providerBox, 67_300n)
  assert.equal(budget.applicationFundingLines.unrelatedProviderBox, 67_300n)
  assert.equal(budget.applicationFundingLines.policyBox, 44_900n)
  assert.equal(budget.applicationFundingLines.coverageBox, 92_900n)
  assert.equal(budget.applicationFundingLines.claimBox, 45_300n)
  assert.equal(budget.applicationFundingTotal, 517_700n)
  assert.equal(budget.ephemeralFundingLines.primaryProvider, 201_000n)
  assert.equal(budget.ephemeralFundingLines.authorizationNegative, 102_000n)
  assert.equal(budget.ephemeralAccountFundingBudget, 303_000n)
  assert.equal(budget.payerPaidTransactionFees, 27_000n)
  assert.equal(budget.plannedPayerTransactionFees, 29_000n)
  assert.equal(budget.totalConservativeRequiredSpendableMicroAlgos, 1_418_700n)
  assert.equal(budget.spendableEquation, '471000 + 517700 + 303000 + 27000 + 100000 = 1418700')
  assert.ok(plannedTransactionTable().some((item) => item.name === 'application-asset-opt-in' && item.fee === 2_000n))
  assert.ok(plannedTransactionTable().some((item) => item.name === 'provider-fault-claim' && item.fee === 2_000n))
})

test('P1 preflight fails closed for invalid network, absent ASA/opt-in, and spendable balance', async () => {
  const settings = { missing: [], expectedAddress: payerAddress, payer: { address: payerAddress }, assetId: 77n }
  const fake = {
    versionsCheck: () => ({ do: async () => ({ genesisId: 'mainnet-v1' }) }),
    genesis: () => ({ do: async () => ({ network: 'mainnet', id: 'mainnet-v1' }) }),
    getAssetByID: () => ({ do: async () => { const error = new Error('not found'); error.status = 404; throw error } }),
    accountInformation: () => ({ do: async () => ({ amount: 100_001, minBalance: 100_000 }) }),
    accountAssetInformation: () => ({ do: async () => { const error = new Error('not opted in'); error.status = 404; throw error } }),
  }
  const result = await preflight(settings, { algod: fake })
  assert.equal(result.ok, false)
  assert.ok(result.missingPrerequisites.some((item) => item.includes('not LocalNet or MainNet')))
  assert.ok(result.missingPrerequisites.some((item) => item.includes('not found')))
  assert.ok(result.missingPrerequisites.some((item) => item.includes('not opted into')))
  assert.ok(result.missingPrerequisites.some((item) => item.includes('spendable microAlgos')))
})

test('P1 config validation rejects malformed indices, asset, endpoint, and phrase without echoing values', async () => {
  const settings = await testnetConfig({ TESTNET_PAYER_HD_MNEMONIC: 'not a mnemonic', TESTNET_PAYER_ADDRESS: payerAddress, TESTNET_PAYER_ACCOUNT_INDEX: '-1', TESTNET_PAYER_ADDRESS_INDEX: '01', TESTNET_ASA_ID: '0', TESTNET_ALGOD_SERVER: 'not-a-url' })
  assert.equal(settings.payer, undefined)
  assert.ok(settings.missing.length >= 4)
  assert.equal(JSON.stringify(settings).includes('not a mnemonic'), false)
})

test('P1 assurance builder creates the exact immutable three-member profile', async () => {
  const signer = await createPeraHdSigner({ mnemonic, accountIndex: 0, addressIndex: 0 })
  const provider = algosdk.generateAccount().addr.toString()
  const application = algosdk.getApplicationAddress(42).toString()
  try {
    const built = await buildAssuredExactPayloadWithSigner({
      payer: signer.address,
      signTransaction: (txn) => signer.signTransaction(txn),
      provider,
      application,
      assetId: 77,
      providerNet: 50n,
      premium: 50n,
      applicationId: 42,
      coverageId: new Uint8Array(32).fill(1),
      providerId: new Uint8Array(32).fill(2),
      policyId: new Uint8Array(32).fill(3),
      requestCommitment: new Uint8Array(32).fill(4),
      params,
    })
    const members = built.paymentGroup.map((encoded) => algosdk.decodeSignedTransaction(Buffer.from(encoded, 'base64')))
    assert.deepEqual(members.map(({ txn }) => txn.type), ['axfer', 'axfer', 'appl'])
    assert.deepEqual(members.map(({ txn }) => txn.sender.toString()), [signer.address, signer.address, signer.address])
    assert.ok(members.every(({ txn }) => Buffer.from(txn.group).equals(Buffer.from(members[0].txn.group))))
    assert.equal(built.requirements.scheme, 'assured-exact')
    assert.equal(built.requirements.extra.profile, 'assurance-core-v1')
    assert.equal(built.requirements.amount, '100')
    assert.equal(JSON.stringify(built, (_key, value) => typeof value === 'bigint' ? value.toString() : value).includes(mnemonic), false)
  } finally { signer.dispose() }
})

test('P1 public evidence rejects secret, signed, pending, and simulation material', () => {
  assert.equal(publicEvidenceSafe({ network: 'testnet', transactionId: 'PUBLIC' }), true)
  assert.equal(publicEvidenceSafe({ mnemonic: 'never serialize this' }), false)
  assert.equal(publicEvidenceSafe({ signedBytes: ['AA=='] }), false)
  assert.equal(publicEvidenceSafe({ pendingResponse: {} }), false)
  assert.equal(publicEvidenceSafe({ simulationResponse: {} }), false)
  assert.equal(publicEvidenceSafe({ ordinaryField: Array.from({ length: 128 }, () => 7) }), false)
  assert.equal(publicEvidenceSafe({ ordinaryField: 'A'.repeat(160) }), false)
  assert.equal(publicEvidenceSafe({ txId: 'PUBLIC', round: 10n, delta: -3 }), true)
  assert.equal(publicEvidenceSafe({ simulationReason: 'simulation', simulationResponsesNotRecorded: true }), true)
  assert.equal(publicEvidenceSafe({ sameSignedBytes: true }), true)
  assert.equal(publicEvidenceSafe({ sameSignedBytes: 'true' }), false)
  assert.equal(publicEvidenceSafe({ ordinaryField: 'runtime-token' }, ['runtime-token']), false)
  assert.equal(publicEvidenceSafe({ ordinaryField: mnemonic }, [mnemonic]), false)
})

test('P1 execution failures expose only allowlisted stages and confirmed public progress', () => {
  const secret = 'mnemonic token signed-bytes pending-response'
  const transactionId = 'A'.repeat(52)
  const groupId = Buffer.alloc(32, 1).toString('base64')
  for (const stage of EXECUTION_STAGES) {
    const diagnostics = createExecutionDiagnostics()
    diagnostics.setStage(stage)
    diagnostics.recordConfirmed({ transactionId, confirmedRound: 67328937, groupId, pendingResponse: { secret }, signedBytes: [secret] })
    const failure = executionFailureResult(new Error(secret), diagnostics)
    assert.equal(failure.stage, stage)
    assert.equal(failure.code, 'TESTNET_EXECUTION_FAILED')
    assert.equal(failure.message.includes(secret), false)
    assert.deepEqual(failure.confirmedPublicTransactions, [{ transactionId, confirmedRound: 67328937, groupId }])
    assert.equal(JSON.stringify(failure).includes(secret), false)
    assert.equal('pendingResponse' in failure, false)
  }
  assert.throws(() => createExecutionDiagnostics().setStage('capacity-read.signed-bytes'), /invalid execution diagnostic stage/)
  const invalidGroupDiagnostics = createExecutionDiagnostics()
  invalidGroupDiagnostics.recordConfirmed({ transactionId, confirmedRound: 67328937, groupId: 'secret-marker' })
  const invalidGroupFailure = executionFailureResult(new Error(secret), invalidGroupDiagnostics)
  assert.equal(JSON.stringify(invalidGroupFailure).includes('secret-marker'), false)
  assert.deepEqual(invalidGroupFailure.confirmedPublicTransactions, [{ transactionId, confirmedRound: 67328937 }])
  const untrustedCode = Object.assign(new Error(secret), { publicCode: 'TESTNET_EXECUTION_FAILED' })
  assert.equal(executionFailureResult(untrustedCode).message.includes(secret), false)
})

function representativeEvidence() {
  const application = algosdk.getApplicationAddress(42).toString()
  const failure = { applicationId: 42, assertionPc: 123, kind: 'application-assertion' }
  const rejection = (extra = {}) => ({ simulation: { ...failure }, pool: { ...failure }, sameSignedBytes: true, completeRollback: true, ...extra })
  return {
    schema: 'assurepay-p1-testnet-evidence-v1',
    network: { caip2: ALGORAND_TESTNET_CAIP2, genesisId: 'testnet-v1', label: 'TestNet' },
    asset: { id: 77, name: 'ASSURE', unitName: 'ASR', decimals: 0 },
    application: { id: 42, address: application, approvalProgramBytes: 4, extraPages: 1, approvalProgramHash: 'hash', globalStateSchema: { numUint: 6, numByteSlice: 2 } },
    actors: { payer: payerAddress, application },
    funding: { payments: [], applicationMbr: { total: 0 }, reconciliation: { actualApplicationFunding: 0, plannedApplicationFunding: 0 } },
    steps: {
      createApplication: { transactionId: 'CREATE', confirmedRound: 7 },
      successfulCoverage: { groupId: 'GROUP', memberTransactionIds: ['A', 'B', 'C'], confirmedRound: 7, applicationId: 42 },
      insufficientCapacity: rejection({ simulationReason: 'simulation', facilitatorSubmissionCount: 0, coverageBoxRemainsAbsent: true }),
      rejectedWithdrawal: rejection({ classification: 'application-assertion', label: 'over/lock-crossing withdrawal' }),
      authorizationNegative: rejection({ classification: 'authorization' }),
      providerFaultClaim: { transactionId: 'CLAIM', confirmedRound: 7, waterfall: { approvedAmount: 100 } },
      zeroCapacity: rejection({ simulationReason: 'simulation', facilitatorSubmissionCount: 0, remainingCapacity: 0 }),
    },
    final: { providers: [{ providerId: '01'.repeat(32), record: {} }, { providerId: '02'.repeat(32), record: {} }], tombstones: [{ prefix: 'c', id: '03'.repeat(32), type: 'coverage', status: 2 }, { prefix: 'f', id: '04'.repeat(32), type: 'claim', status: true }], accounting: {}, applicationMinimumBalance: 0, invariants: {} },
    acceptanceNotes: { simulationResponsesNotRecorded: true, rejectedTransactionBytesNotRecorded: true },
  }
}

test('P1 complete evidence-write seam validates a representative result before invoking the writer', async () => {
  const evidence = representativeEvidence()
  assert.equal(validatePublicEvidence(evidence), true)
  let call
  await writePublicEvidence(evidence, { writeFile: async (filePath, serialized, options) => { call = { filePath, length: serialized.length, options, containsMnemonic: serialized.includes(mnemonic) } } })
  assert.ok(call.filePath.endsWith('contracts/assurance-core/testnet-evidence.json'))
  assert.ok(call.length > 0)
  assert.equal(call.options.mode, 0o644)
  assert.equal(call.containsMnemonic, false)
  await assert.rejects(writePublicEvidence({ ...evidence, pendingResponse: { secret: true } }, { writeFile: async () => { throw new Error('writer must not be called') } }), (error) => error.publicCode === 'PUBLIC_EVIDENCE_UNSAFE')
  const signedMutation = { ...evidence, steps: { ...evidence.steps, zeroCapacity: { ...evidence.steps.zeroCapacity, signedBytes: ['AA=='] } } }
  await assert.rejects(writePublicEvidence(signedMutation, { writeFile: async () => { throw new Error('writer must not be called') } }), (error) => error.publicCode === 'PUBLIC_EVIDENCE_UNSAFE')
})

test('P1 POC monetary and terminal predicates fail closed for each observed checkpoint', () => {
  const valid = {
    capacityAfterDeposit: 164n, successfulSubmissions: 1, successfulConfirmationRound: 7,
    successBalances: { payer: { assetUnits: -100n }, provider: { assetUnits: 50n }, application: { assetUnits: 50n } },
    successState: { provider: { stakeLocked: 75n, openFaultExposure: 100n }, global: { premiumReserve: 50n, totalOpenFaultExposure: 100n } },
    providerId: '01'.repeat(32), policyId: '02'.repeat(32), payer: payerAddress,
    openCoverage: { providerId: '01'.repeat(32), policyId: '02'.repeat(32), payer: payerAddress, grossAmount: 100n, providerNetAmount: 50n, premiumAmount: 50n, lockedStakeAmount: 75n, status: 1, exposureReleased: false },
    claimRecord: { finalized: true, providerFault: true, approvedAmount: 100n, stakeDebit: 75n, poolDebit: 25n }, refund: { receiver: payerAddress, amount: 100n }, refundCount: 1,
    claimDeltas: { provider: { stakeTotal: -75n, stakeLocked: -75n, openFaultExposure: -100n }, global: { totalProviderStake: -75n, premiumReserve: -25n, totalOpenFaultExposure: -100n }, physicalApplicationAsset: -100n },
    unrelatedProvider: { stakeTotal: 10n, stakeLocked: 0n, openFaultExposure: 0n }, finalCoverage: { status: 2, exposureReleased: true }, finalPrimary: { stakeTotal: 0n, stakeLocked: 0n, openFaultExposure: 0n }, finalCapacity: 0n, finalAccounting: { totalProviderStake: 10n, premiumReserve: 25n, totalOpenFaultExposure: 0n }, finalAsset: 35n, tombstones: { coverage: true, claim: true, rejectedCoverage: false, zeroCoverage: false },
  }
  assert.equal(assertPocLifecycleObservations(valid), true)
  for (const [field, value] of [['capacityAfterDeposit', 163n], ['finalCapacity', 1n], ['finalAsset', 36n]]) assert.throws(() => assertPocLifecycleObservations({ ...valid, [field]: value }), (error) => error.publicCode === 'TESTNET_POC_ASSERTION_MISMATCH')
  assert.throws(() => assertPocLifecycleObservations({ ...valid, successBalances: { ...valid.successBalances, payer: { assetUnits: -99n } } }), (error) => error.publicCode === 'TESTNET_POC_ASSERTION_MISMATCH')
  assert.throws(() => assertPocLifecycleObservations({ ...valid, claimRecord: { ...valid.claimRecord, poolDebit: 24n } }), (error) => error.publicCode === 'TESTNET_POC_ASSERTION_MISMATCH')
  assert.throws(() => assertPocLifecycleObservations({ ...valid, unrelatedProvider: { ...valid.unrelatedProvider, stakeTotal: 11n } }), (error) => error.publicCode === 'TESTNET_POC_ASSERTION_MISMATCH')
  assert.throws(() => assertPocLifecycleObservations({ ...valid, tombstones: { ...valid.tombstones, rejectedCoverage: true } }), (error) => error.publicCode === 'TESTNET_POC_ASSERTION_MISMATCH')
})

test('P1 intended application failure matching distinguishes endpoint errors', () => {
  assert.equal(isIntendedApplicationAssertionFailure('logic eval error: assert failed app=42 pc=123', 42), true)
  assert.equal(isIntendedApplicationAssertionFailure('connection timeout app=42', 42), false)
  assert.equal(isIntendedApplicationAssertionFailure('logic eval error: assert failed app=99 pc=123', 42), false)
  assert.equal(matchApplicationAssertionFailures(compactFailure('assert failed app=42 pc=123'), compactFailure('assert failed app=42 pc=123'), 42), true)
  assert.equal(matchApplicationAssertionFailures(compactFailure('assert failed app=42 pc=123'), compactFailure('assert failed app=42'), 42), false)
  assert.equal(matchApplicationAssertionFailures(compactFailure('timeout'), compactFailure('assert failed app=42 pc=123'), 42), false)
  assert.equal(matchApplicationAssertionFailures(compactFailure('assert failed app=42'), compactFailure('assert failed app=42 pc=123'), 42), false)
  assert.equal(compactFailure('rate limit app=42 pc=123').kind, 'endpoint-or-resource')
})

test('P1 computed invariants fail before evidence can be accepted', () => {
  const observed = {
    providers: [{ record: { stakeTotal: 10n, stakeLocked: 0n, openFaultExposure: 0n } }],
    coverages: [{ record: { grossAmount: 0n, lockedStakeAmount: 0n, status: 2, exposureReleased: true } }],
    claims: [{ record: { finalized: true, approvedAmount: 100n, stakeDebit: 75n, poolDebit: 25n } }],
    accounting: { totalProviderStake: 10n, premiumReserve: 25n, totalOpenFaultExposure: 0n },
    physicalApplicationAsset: 35n,
    rejectedBoxes: [undefined, undefined],
    claimDelta: { approvedAmount: 100n, stakeDebit: 75n, poolDebit: 25n, physicalApplicationAsset: -100n, storedPayer: payerAddress },
    refund: { receiver: payerAddress, amount: 100n },
  }
  const result = computeLifecycleInvariants(observed)
  assert.ok(Object.values(result.flags).every(Boolean))
  assert.deepEqual(assertComputedInvariants(observed).flags, result.flags)
  assert.throws(() => assertComputedInvariants({ ...observed, physicalApplicationAsset: 36n }), (error) => error.publicCode === 'TESTNET_INVARIANT_MISMATCH')
})

test('P1 byte identity and runner modes keep preflight/verifier non-mutating', () => {
  assert.equal(sameSignedByteArrays([Buffer.from('a')], [Buffer.from('a')]), true)
  assert.equal(sameSignedByteArrays([Buffer.from('a')], [Buffer.from('b')]), false)
  assert.equal(runnerMode(['node', 'runner', '--preflight']), 'preflight')
  assert.equal(runnerMode(['node', 'runner', '--verify-evidence']), 'verify-evidence')
  assert.equal(runnerMode(['node', 'runner']), 'mutating-acceptance')
})

test('P1 fake public client rollback snapshot detects changed box, MBR, and balance state', async () => {
  const app = algosdk.getApplicationAddress(42).toString()
  const providerId = new Uint8Array(32).fill(1)
  const providerBox = new Uint8Array(Buffer.concat([Buffer.from('p'), Buffer.from(providerId)]))
  const providerType = '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)'
  const encodeProvider = (stake) => algosdk.ABIType.from(providerType).encode([algosdk.decodeAddress(payerAddress).publicKey, algosdk.decodeAddress(payerAddress).publicKey, new Uint8Array(32), true, stake, 0n, 0n, 0n])
  let version = 0
  const fake = {
    accountInformation: (address) => ({ do: async () => ({ amount: address === app ? 1_000 + version : 2_000 + version, minBalance: address === app ? 500 + version : 1_000 }) }),
    accountAssetInformation: () => ({ do: async () => ({ assetHolding: { amount: 10 } }) }),
    getApplicationByID: () => ({ do: async () => ({ params: { globalState: [] } }) }),
    getApplicationBoxByName: () => ({ do: async () => ({ value: Buffer.from(encodeProvider(10n + BigInt(version))).toString('base64') }) }),
  }
  const before = await applicationSnapshot(fake, 42, payerAddress, 77n, providerId, providerBox)
  version = 1
  const after = await applicationSnapshot(fake, 42, payerAddress, 77n, providerId, providerBox)
  assert.notDeepEqual(before.boxes, after.boxes)
  assert.notEqual(before.applicationMbr, after.applicationMbr)
  assert.notEqual(before.balances.application.totalMicroAlgos, after.balances.application.totalMicroAlgos)
  assert.throws(() => assertCompleteRollback(before, after), (error) => error.publicCode === 'TESTNET_REJECTION_ROLLBACK_MISMATCH')
})

test('P1 rollback snapshot canonicalizes global-state order but rejects value changes', async () => {
  const app = algosdk.getApplicationAddress(42).toString()
  const providerId = new Uint8Array(32).fill(1)
  const providerBox = new Uint8Array(Buffer.concat([Buffer.from('p'), Buffer.from(providerId)]))
  const providerType = '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)'
  const providerValue = algosdk.ABIType.from(providerType).encode([algosdk.decodeAddress(payerAddress).publicKey, algosdk.decodeAddress(payerAddress).publicKey, new Uint8Array(32), true, 10n, 0n, 0n, 0n])
  const stateEntry = (key, uint) => ({ key: Buffer.from(key).toString('base64'), value: { uint } })
  let globalState = [stateEntry('b', 2), stateEntry('a', 1)]
  const fake = {
    accountInformation: (address) => ({ do: async () => ({ amount: address === app ? 1_000 : 2_000, minBalance: address === app ? 500 : 1_000 }) }),
    accountAssetInformation: () => ({ do: async () => ({ assetHolding: { amount: 10 } }) }),
    getApplicationByID: () => ({ do: async () => ({ params: { globalState } }) }),
    getApplicationBoxByName: () => ({ do: async () => ({ value: Buffer.from(providerValue).toString('base64') }) }),
  }
  const before = await applicationSnapshot(fake, 42, payerAddress, 77n, providerId, providerBox)
  globalState = [stateEntry('a', 1), stateEntry('b', 2)]
  const reordered = await applicationSnapshot(fake, 42, payerAddress, 77n, providerId, providerBox)
  assert.equal(assertCompleteRollback(before, reordered), true)
  globalState = [stateEntry('a', 1), stateEntry('b', 3)]
  const changed = await applicationSnapshot(fake, 42, payerAddress, 77n, providerId, providerBox)
  assert.throws(() => assertCompleteRollback(before, changed), (error) => error.publicCode === 'TESTNET_REJECTION_ROLLBACK_MISMATCH')
})

test('P1 verifier transaction proof falls back to the historical block without mutation', async () => {
  const groupId = Buffer.alloc(32, 9).toString('base64')
  const fake = {
    pendingTransactionInformation: () => ({ do: async () => { throw new Error('pruned') } }),
    block: () => ({ do: async () => ({ block: { payset: [{ txid: 'TXID', txn: { group: Buffer.alloc(32, 9) } }] } }) }),
    getBlockTxids: () => ({ do: async () => ({ blockTxids: ['TXID'] }) }),
  }
  const proof = await proveTransaction(fake, 'TXID', 77, groupId)
  assert.deepEqual(proof, { transactionId: 'TXID', confirmedRound: 77n, source: 'block' })
})

test('P1 verifier rejects exact-round mismatch and unrelated same-block groups', async () => {
  const pendingFake = { pendingTransactionInformation: () => ({ do: async () => ({ confirmedRound: 78, txn: { group: Buffer.alloc(32, 9) } }) }) }
  await assert.rejects(proveTransaction(pendingFake, 'TXID', 77, Buffer.alloc(32, 9).toString('base64')), (error) => error.publicCode === 'PUBLIC_EVIDENCE_ROUND_MISMATCH')
  const groupId = Buffer.alloc(32, 9).toString('base64')
  const unrelated = {
    pendingTransactionInformation: () => ({ do: async () => { throw new Error('pruned') } }),
    block: () => ({ do: async () => ({ block: { payset: [{ txid: 'OTHER', txn: { group: Buffer.alloc(32, 9) } }, { txid: 'TXID', txn: { group: Buffer.alloc(32, 8) } }] } }) }),
    getBlockTxids: () => ({ do: async () => ({ blockTxids: ['TXID'] }) }),
  }
  await assert.rejects(proveTransaction(unrelated, 'TXID', 77, groupId), (error) => error.publicCode === 'PUBLIC_EVIDENCE_BLOCK_GROUP_MISMATCH')
})

test('P1 verifier distinguishes refund mismatch from pruned refund history', async () => {
  const evidence = representativeEvidence()
  evidence.steps.providerFaultClaim = { transactionId: 'CLAIM', confirmedRound: 7, groupId: 'GROUP', waterfall: { approvedAmount: 100 } }
  const wrongRefund = { pendingTransactionInformation: () => ({ do: async () => ({ confirmedRound: 7, 'inner-txns': [{ txn: { type: 'axfer', sender: evidence.application.address, assetTransfer: { receiver: evidence.actors.payer, assetIndex: 77, amount: 99 }, fee: 0 } }] }) }) }
  await assert.rejects(verifyClaimRefund(wrongRefund, evidence), (error) => error.publicCode === 'PUBLIC_EVIDENCE_REFUND_MISMATCH')
  const unavailable = { pendingTransactionInformation: () => ({ do: async () => { throw new Error('pruned') } }), block: () => ({ do: async () => { throw new Error('pruned') } }) }
  await assert.rejects(verifyClaimRefund(unavailable, evidence), (error) => error.publicCode === 'PUBLIC_EVIDENCE_REFUND_UNAVAILABLE')
})

test('P1 verifier validates public success evidence and rejects accounting/program/schema/box mismatches', async () => {
  const appId = 42
  const assetId = 77
  const payer = payerAddress
  const application = algosdk.getApplicationAddress(appId).toString()
  const group = Buffer.alloc(32, 9)
  const groupId = group.toString('base64')
  const providerId = '01'.repeat(32)
  const secondProviderId = '04'.repeat(32)
  const coverageId = '02'.repeat(32)
  const claimId = '03'.repeat(32)
  const providerType = '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)'
  const coverageType = '(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)'
  const claimType = '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)'
  const addressBytes = (value) => algosdk.decodeAddress(value).publicKey
  const boxes = new Map([
    [Buffer.concat([Buffer.from('p'), Buffer.from(providerId, 'hex')]).toString('hex'), algosdk.ABIType.from(providerType).encode([addressBytes(payer), addressBytes(payer), new Uint8Array(32), true, 10n, 0n, 0n, 0n])],
    [Buffer.concat([Buffer.from('p'), Buffer.from(secondProviderId, 'hex')]).toString('hex'), algosdk.ABIType.from(providerType).encode([addressBytes(payer), addressBytes(payer), new Uint8Array(32), true, 0n, 0n, 0n, 0n])],
    [Buffer.concat([Buffer.from('c'), Buffer.from(coverageId, 'hex')]).toString('hex'), algosdk.ABIType.from(coverageType).encode([new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), addressBytes(payer), 100n, 50n, 50n, 0n, 0n, new Uint8Array(32).fill(4), 0n, 0n, 2n, true])],
    [Buffer.concat([Buffer.from('f'), Buffer.from(claimId, 'hex')]).toString('hex'), algosdk.ABIType.from(claimType).encode([new Uint8Array(32).fill(2), true, 100n, true, 0n, 75n, 25n, 0n])],
  ])
  const approval = Buffer.from([1, 2, 3, 4]).toString('base64')
  const key = (name) => Buffer.from(name).toString('base64')
  const state = [
    ['totalProviderStake', 10],
    ['premiumReserve', 25],
    ['totalOpenFaultExposure', 0],
  ].map(([name, uint]) => ({ key: key(name), value: { uint } }))
  const evidence = {
    schema: 'assurepay-p1-testnet-evidence-v1',
    network: { caip2: ALGORAND_TESTNET_CAIP2, genesisId: 'testnet-v1', label: 'TestNet' },
    asset: { id: assetId, name: 'ASSURE', unitName: 'ASR', decimals: 0 },
    application: { id: appId, address: application, approvalProgramBytes: 4, extraPages: 1, approvalProgramHash: (await import('node:crypto')).createHash('sha256').update(Buffer.from([1, 2, 3, 4])).digest('base64'), globalStateSchema: { numUint: 6, numByteSlice: 2 } },
    actors: { payer, application },
    funding: { payments: [{ amount: 517700 }], applicationMbr: { total: 517700 }, reconciliation: { actualApplicationFunding: 517700, plannedApplicationFunding: 517700 } },
    steps: { createApplication: { transactionId: 'CREATE', confirmedRound: 7 }, successfulCoverage: { groupId, memberTransactionIds: ['A', 'B', 'C'], confirmedRound: 7, applicationId: appId }, providerFaultClaim: { transactionId: 'CLAIM', confirmedRound: 7, waterfall: { approvedAmount: 100 } } },
    final: {
      providers: [{ providerId, record: { owner: payer, payout: payer, active: true, stakeTotal: 10, stakeLocked: 0, openFaultExposure: 0 } }, { providerId: secondProviderId, record: { owner: payer, payout: payer, active: true, stakeTotal: 0, stakeLocked: 0, openFaultExposure: 0 } }],
      tombstones: [{ prefix: 'c', id: coverageId, type: coverageType, statusIndex: 11, status: 2 }, { prefix: 'f', id: claimId, type: claimType, statusIndex: 1, status: true }],
      accounting: { totalProviderStake: 10, premiumReserve: 25, totalOpenFaultExposure: 0, physicalApplicationAssetBalance: 35, providerSum: 10, exposureSum: 0, assetLiabilityMatches: true },
      applicationMinimumBalance: 1_234,
      invariants: {},
    },
    acceptanceNotes: { acceptanceTimePoolRejectionsAreLedgerUnreconstructable: true },
  }
  const pending = (transactionId) => ({ confirmedRound: 7, txn: { group }, ...(transactionId === 'CLAIM' ? { 'inner-txns': [{ txn: { type: 'axfer', sender: application, fee: 0, assetTransfer: { receiver: payer, assetIndex: assetId, amount: 100 } } }] } : {}) })
  const fake = {
    versionsCheck: () => ({ do: async () => ({ genesisId: 'testnet-v1' }) }),
    genesis: () => ({ do: async () => ({ network: 'testnet', id: 'testnet-v1' }) }),
    getAssetByID: () => ({ do: async () => ({ params: { name: 'ASSURE', unitName: 'ASR', decimals: 0 } }) }),
    getApplicationByID: () => ({ do: async () => ({ params: { 'approval-program': approval, 'global-state-schema': { 'num-uint': 6, 'num-byte-slice': 2 }, globalState: state } }) }),
    pendingTransactionInformation: (transactionId) => ({ do: async () => pending(transactionId) }),
    accountInformation: () => ({ do: async () => ({ amount: 35, minBalance: 1_234 }) }),
    accountAssetInformation: () => ({ do: async () => ({ assetHolding: { amount: 35 } }) }),
    getApplicationBoxByName: (_id, name) => ({ do: async () => ({ value: Buffer.from(boxes.get(Buffer.from(name).toString('hex'))).toString('base64') }) }),
  }
  const result = await verifyPublicEvidence({}, { evidence, algod: fake })
  assert.equal(result.code, 'PUBLIC_EVIDENCE_VERIFIED')
  assert.equal(result.claimRefund, 'publicly observable')
  await assert.rejects(verifyPublicEvidence({}, { evidence: { ...evidence, final: { ...evidence.final, accounting: { ...evidence.final.accounting, physicalApplicationAssetBalance: 36 } } }, algod: fake }), (error) => error.publicCode === 'PUBLIC_EVIDENCE_ACCOUNTING_MISMATCH')
  await assert.rejects(verifyPublicEvidence({}, { evidence: { ...evidence, application: { ...evidence.application, approvalProgramHash: 'wrong' } }, algod: fake }), (error) => error.publicCode === 'PUBLIC_EVIDENCE_PROGRAM_MISMATCH')
  await assert.rejects(verifyPublicEvidence({}, { evidence: { ...evidence, application: { ...evidence.application, globalStateSchema: { numUint: 5, numByteSlice: 2 } } }, algod: fake }), (error) => error.publicCode === 'PUBLIC_EVIDENCE_SCHEMA_MISMATCH')
  await assert.rejects(verifyPublicEvidence({}, { evidence: { ...evidence, final: { ...evidence.final, providers: [{ ...evidence.final.providers[0], record: { ...evidence.final.providers[0].record, stakeTotal: 11 } }, evidence.final.providers[1]] } }, algod: fake }), (error) => error.publicCode === 'PUBLIC_EVIDENCE_BOX_STATE_MISMATCH')
})

test('P1 deterministic tests do not dispatch the mutating TestNet runner', async () => {
  const packageJson = await import('../../../package.json', { with: { type: 'json' } })
  assert.equal(packageJson.default.scripts['test:p1'].includes('testnet'), false)
})
