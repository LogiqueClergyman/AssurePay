import assert from 'node:assert/strict'
import test from 'node:test'
import algosdk from 'algosdk'
import { ed25519Verifier } from '@algorandfoundation/algokit-utils/crypto'
import { buildAssuredExactPayloadWithSigner } from '../src/assured-exact.mjs'
import { createPeraHdSigner, validatePeraHdMnemonic } from '../src/pera-hd-signer.mjs'
import { calculateTestnetBudget, isIntendedApplicationAssertionFailure, loadDotEnv, preflight, publicEvidenceSafe, proveTransaction, testnetConfig } from '../scripts/run-testnet.mjs'

const mnemonic = 'salon zoo engage submit smile frost later decide wing sight chaos renew lizard rely canal coral scene hobby scare step bus leaf tobacco slice'
const params = { fee: 1_000, minFee: 1_000, firstValid: 1, lastValid: 1_000, genesisHash: new Uint8Array(32), genesisID: 'v1', flatFee: true }
const payerAddress = 'PPNHVQJGE6ZMEWPR35UHLUYMCCZV6VNTHLJMZDVCONXKUPV47K4WGQJWGI'

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
  assert.equal(result.budget.calculatedApplicationBoxFundingBudget, 450_400n)
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
})

test('P1 intended application failure matching distinguishes endpoint errors', () => {
  assert.equal(isIntendedApplicationAssertionFailure('logic eval error: assert failed app=42 pc=123', 42), true)
  assert.equal(isIntendedApplicationAssertionFailure('connection timeout app=42', 42), false)
  assert.equal(isIntendedApplicationAssertionFailure('logic eval error: assert failed app=99 pc=123', 42), false)
})

test('P1 verifier transaction proof falls back to the historical block without mutation', async () => {
  const groupId = Buffer.alloc(32, 9).toString('base64')
  const fake = {
    pendingTransactionInformation: () => ({ do: async () => { throw new Error('pruned') } }),
    block: () => ({ do: async () => ({ block: { payset: [{ txn: { group: Buffer.alloc(32, 9) } }] } }) }),
    getBlockTxids: () => ({ do: async () => ({ blockTxids: ['TXID'] }) }),
  }
  const proof = await proveTransaction(fake, 'TXID', 77, groupId)
  assert.deepEqual(proof, { transactionId: 'TXID', confirmedRound: 77n, source: 'block' })
})

test('P1 deterministic tests do not dispatch the mutating TestNet runner', async () => {
  const packageJson = await import('../../../package.json', { with: { type: 'json' } })
  assert.equal(packageJson.default.scripts['test:p1'].includes('testnet'), false)
})
