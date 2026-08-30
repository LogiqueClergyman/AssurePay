import assert from 'node:assert/strict'
import test from 'node:test'
import { ed25519Generator } from '@algorandfoundation/algokit-utils/crypto'
import { Transaction, TransactionType, groupTransactions } from '@algorandfoundation/algokit-utils/transact'
import { generateAddressWithSigners } from '@algorandfoundation/algokit-utils/transact'
import { ExactAvmScheme } from '@x402/avm/exact/facilitator'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'
import { validateAssuranceGroup } from '../src/group-validator.mjs'

const address = () => generateAddressWithSigners(ed25519Generator()).addr
const params = (sender, type, fields) => new Transaction({ type, sender, fee: 1_000n, firstValid: 1n, lastValid: 1_000n, genesisHash: new Uint8Array(32), ...fields })

function logicalGroup(overrides = {}) {
  const payer = address().toString()
  const provider = address().toString()
  const appAddress = address().toString()
  const base = {
    assetId: 77n,
    provider,
    appAddress,
    gross: 100n,
    premium: 7n,
    commitment: new Uint8Array([1]),
    reject: false,
  }
  return {
    ...base,
    ...overrides,
    group: [
      { type: 'axfer', sender: payer, assetId: 77n, receiver: provider, amount: 93n },
      { type: 'axfer', sender: payer, assetId: 77n, receiver: appAddress, amount: 7n },
      { type: 'appl', sender: payer },
    ],
  }
}

test('P0 validation accepts the exact provider + premium + application profile', () => {
  const input = logicalGroup()
  assert.deepEqual(validateAssuranceGroup(input), { marker: 'coverage-opened' })
})

for (const [name, mutate, code] of [
  ['wrong provider receiver', (x) => { x.group[0].receiver = x.appAddress }, 'PROVIDER_RECEIVER'],
  ['wrong premium receiver', (x) => { x.group[1].receiver = x.provider }, 'PREMIUM_RECEIVER'],
  ['wrong asset', (x) => { x.group[1].assetId = 9n }, 'ASSET_MISMATCH'],
  ['incorrect arithmetic', (x) => { x.group[0].amount = 94n }, 'AMOUNT_MISMATCH'],
  ['malformed commitment', (x) => { x.commitment = new Uint8Array() }, 'COMMITMENT'],
  ['unsafe rekey', (x) => { x.group[0].rekeyTo = x.provider }, 'UNSAFE_TRANSACTION_CONTROL'],
  ['unsafe asset close', (x) => { x.group[1].closeTo = x.provider }, 'UNSAFE_TRANSACTION_CONTROL'],
  ['forced application rejection', (x) => { x.reject = true }, 'FORCED_REJECTION'],
]) {
  test(`P0 validation rejects ${name}`, () => {
    const input = logicalGroup()
    mutate(input)
    assert.throws(() => validateAssuranceGroup(input), { message: code })
  })
}

test('current @x402/avm exact facilitator rejects the signed assurance group before simulation', async () => {
  const payer = generateAddressWithSigners(ed25519Generator())
  const provider = address()
  const app = address()
  const facilitator = generateAddressWithSigners(ed25519Generator())
  const txns = groupTransactions([
    params(payer.addr, TransactionType.AssetTransfer, { assetTransfer: { assetId: 77n, amount: 93n, receiver: provider } }),
    params(payer.addr, TransactionType.AssetTransfer, { assetTransfer: { assetId: 77n, amount: 7n, receiver: app } }),
    params(payer.addr, TransactionType.ApplicationCall, { appCall: { appId: 42n, onComplete: 0, args: [new TextEncoder().encode('openCoverage')] } }),
  ])
  const signed = await payer.signer(txns, [0, 1, 2])
  const paymentGroup = signed.map((bytes) => Buffer.from(bytes).toString('base64'))
  const sent = []
  const facilitatorSigner = {
    getAddresses: () => [facilitator.addr.toString()],
    signTransaction: async () => { throw new Error('fee abstraction must not be used in this profile') },
    simulateTransactions: async (txns) => {
      assert.equal(txns.length, 3)
      return { txnGroups: [{}] }
    },
    sendTransactions: async (txns) => { sent.push(...txns); return 'submitted-group' },
    waitForConfirmation: async () => ({}),
  }
  const scheme = new ExactAvmScheme(facilitatorSigner)
  const requirements = { scheme: 'exact', network: ALGORAND_TESTNET_CAIP2, amount: '93', asset: '77', payTo: provider.toString(), maxTimeoutSeconds: 60, extra: {} }
  const payload = { x402Version: 2, accepted: requirements, payload: { paymentGroup, paymentIndex: 0 } }
  const result = await scheme.settle(payload, requirements)
  assert.equal(result.success, false)
  assert.equal(result.errorReason, 'invalid_exact_avm_invalid_transaction')
  assert.equal(sent.length, 0)
})
