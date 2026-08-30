import assert from 'node:assert/strict'
import test from 'node:test'
import { ed25519Generator } from '@algorandfoundation/algokit-utils/crypto'
import { Transaction, TransactionType, groupTransactions, generateAddressWithSigners } from '@algorandfoundation/algokit-utils/transact'
import { x402Facilitator } from '@x402/core/facilitator'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'
import { ASSURED_EXACT, AssuredExactAvmScheme, buildAssuredExactPayload } from '../src/assured-exact.mjs'

const params = (sender, type, fields) => new Transaction({ type, sender, fee: 1_000n, firstValid: 1n, lastValid: 1_000n, genesisHash: new Uint8Array(32), ...fields })

async function fixture() {
  const payer = generateAddressWithSigners(ed25519Generator())
  const provider = generateAddressWithSigners(ed25519Generator()).addr
  const application = generateAddressWithSigners(ed25519Generator()).addr
  const facilitatorAddress = generateAddressWithSigners(ed25519Generator()).addr
  const commitment = new Uint8Array(32).fill(7)
  const txns = groupTransactions([
    params(payer.addr, TransactionType.AssetTransfer, { assetTransfer: { assetId: 77n, amount: 93n, receiver: provider } }),
    params(payer.addr, TransactionType.AssetTransfer, { assetTransfer: { assetId: 77n, amount: 7n, receiver: application } }),
    params(payer.addr, TransactionType.ApplicationCall, { appCall: { appId: 42n, onComplete: 0, args: [new TextEncoder().encode('openCoverage'), new TextEncoder().encode('100'), new TextEncoder().encode('7'), commitment] } }),
  ])
  const built = await buildAssuredExactPayload({ payer, provider, application, assetId: 77n, providerNet: 93n, premium: 7n, applicationId: 42n, commitment, transactions: txns })
  const requirements = { ...built.requirements, network: ALGORAND_TESTNET_CAIP2, maxTimeoutSeconds: 60 }
  const payload = { x402Version: 2, accepted: requirements, payload: { paymentGroup: built.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const calls = { simulations: [], submissions: [] }
  const signer = { getAddresses: () => [facilitatorAddress.toString()], simulateTransactions: async (group) => { calls.simulations.push(group); return { txnGroups: [{}] } }, sendTransactions: async (group) => { calls.submissions.push(group); return 'submitted' }, waitForConfirmation: async () => ({}) }
  return { payload, requirements, signer, calls }
}

test('mocked facilitator integration: assured-exact verifies, simulates, and submits identical bytes through x402 core', async () => {
  const { payload, requirements, signer, calls } = await fixture()
  const core = new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, new AssuredExactAvmScheme(signer))
  const result = await core.settle(payload, requirements)
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(calls.simulations.length, 1)
  assert.equal(calls.submissions.length, 1)
  assert.deepEqual(calls.submissions[0], calls.simulations.at(-1))
})

test('mocked facilitator integration: simulation rejection submits nothing', async () => {
  const { payload, requirements, signer, calls } = await fixture()
  signer.simulateTransactions = async (group) => { calls.simulations.push(group); return { txnGroups: [{ failureMessage: 'forced rejection' }] } }
  const result = await new AssuredExactAvmScheme(signer).settle(payload, requirements)
  assert.equal(result.success, false)
  assert.equal(result.errorReason, 'invalid_assured_exact_simulation', JSON.stringify(result))
  assert.equal(calls.submissions.length, 0)
})

for (const [name, mutate] of [
  ['wrong provider receiver', (p) => { p.accepted.extra.provider = p.accepted.extra.applicationAddress }],
  ['wrong application id', (p) => { p.accepted.extra.applicationId = '9' }],
  ['non-32-byte commitment', (p) => { p.accepted.extra.requestCommitment = Buffer.from([1]).toString('base64') }],
  ['role substitution', (p) => { p.payload.providerIndex = 1 }],
  ['unexpected extra member', (p) => { p.payload.paymentGroup.push(p.payload.paymentGroup[0]) }],
]) test(`mocked facilitator integration: rejects ${name}`, async () => {
  const { payload, requirements, signer, calls } = await fixture(); mutate(payload)
  const result = await new AssuredExactAvmScheme(signer).verify(payload, requirements)
  assert.equal(result.isValid, false); assert.equal(calls.simulations.length, 0)
})
