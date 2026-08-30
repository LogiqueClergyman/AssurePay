import assert from 'node:assert/strict'
import test from 'node:test'
import algosdk from 'algosdk'
import { x402Facilitator } from '@x402/core/facilitator'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'
import { ASSURED_EXACT, AssuredExactAvmScheme, buildAssuredExactPayload } from '../src/assured-exact.mjs'

async function fixture() {
  const payer = algosdk.generateAccount(), provider = algosdk.generateAccount().addr, app = algosdk.generateAccount().addr, facilitator = algosdk.generateAccount().addr
  const built = buildAssuredExactPayload({ payer, provider, application: app, assetId: 77n, providerNet: 93n, premium: 7n, applicationId: 42n, commitment: new Uint8Array(32).fill(7), params: { fee: 1000, firstValid: 1, lastValid: 1000, genesisHash: new Uint8Array(32), genesisID: 'testnet-v1.0', flatFee: true } })
  const requirements = { ...built.requirements, network: ALGORAND_TESTNET_CAIP2, maxTimeoutSeconds: 60 }
  const payload = { x402Version: 2, accepted: requirements, payload: { paymentGroup: built.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const calls = { simulations: [], submissions: [], confirmations: [] }
  const signer = { getAddresses: () => [facilitator.toString()], simulateTransactions: async (g) => { calls.simulations.push(g); return { txnGroups: [{}] } }, sendTransactions: async (g) => { calls.submissions.push(g); return 'ok' }, waitForConfirmation: async (id) => { calls.confirmations.push(id); return {} } }
  return { payload, requirements, signer, calls }
}
test('mocked core path: ABI-valid assured-exact settles immutable prepared bytes', async () => {
  const { payload, requirements, signer, calls } = await fixture()
  signer.simulateTransactions = async (g) => { calls.simulations.push(g); payload.payload.paymentGroup[0] = payload.payload.paymentGroup[1]; return { txnGroups: [{}] } }
  const result = await new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, new AssuredExactAvmScheme(signer)).settle(payload, requirements)
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(calls.submissions.length, 1); assert.deepEqual(calls.submissions[0], calls.simulations[0]); assert.match(calls.confirmations[0], /^[A-Z2-7]+$/)
})
for (const [name, mutate] of [
  ['wrong provider', (p) => { p.accepted.extra.provider = p.accepted.extra.applicationAddress }],
  ['wrong asset', (p) => { p.accepted.asset = '78' }],
  ['bad commitment', (p) => { p.accepted.extra.requestCommitment = 'AA==' }],
  ['role index', (p) => { p.payload.providerIndex = 1 }],
  ['extra member', (p) => { p.payload.paymentGroup.push(p.payload.paymentGroup[0]) }],
  ['corrupt signature', (p) => { const b = Buffer.from(p.payload.paymentGroup[2], 'base64'); b[5] ^= 1; p.payload.paymentGroup[2] = b.toString('base64') }],
  ['malformed number', (p) => { p.accepted.extra.premium = '01' }],
]) test(`mocked core path: rejects ${name}`, async () => {
  const { payload, requirements, signer } = await fixture(); mutate(payload)
  const result = await new AssuredExactAvmScheme(signer).verify(payload, requirements)
  assert.equal(result.isValid, false)
})
