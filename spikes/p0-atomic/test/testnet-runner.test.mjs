import assert from 'node:assert/strict'
import test from 'node:test'
import { balanceDeltas, compactTestnetResult, isIntendedApplicationAssertionFailure, loadDotEnv, publicBalance } from '../scripts/run-testnet.mjs'

test('TestNet runner preserves process environment over ignored local .env values', () => {
  const environment = { TESTNET_ASA_ID: '77' }
  loadDotEnv('TESTNET_ASA_ID=99\nTESTNET_ALGOD_SERVER=https://testnet.example\nTESTNET_ALGOD_TOKEN="not-printed"', environment)
  assert.deepEqual(environment, { TESTNET_ASA_ID: '77', TESTNET_ALGOD_SERVER: 'https://testnet.example', TESTNET_ALGOD_TOKEN: 'not-printed' })
})

test('TestNet preflight reports total, minimum, and spendable microALGOs', () => {
  assert.deepEqual(publicBalance({ amount: 4_000_000n, minBalance: 1_250_000n }, 100n, 'PUBLIC'), { address: 'PUBLIC', totalMicroAlgos: 4_000_000n, minimumBalanceMicroAlgos: 1_250_000n, spendableMicroAlgos: 2_750_000n, asset: 100n })
})

test('TestNet acceptance recognizes only the intended application assertion failure', () => {
  const intended = 'transaction ABC: logic eval error: assert failed pc=329. Details: app=42, pc=329, opcodes=assert'
  assert.equal(isIntendedApplicationAssertionFailure(intended, 42n), true)
  for (const unrelated of ['401 unauthorized', '429 rate limit', 'timeout waiting for confirmation', 'stale round', 'logic eval error: assert failed pc=10. Details: app=99']) assert.equal(isIntendedApplicationAssertionFailure(unrelated, 42n), false)
})

test('TestNet runner emits only compact public settlement evidence', () => {
  const balance = (totalMicroAlgos, asset) => ({ totalMicroAlgos, asset })
  const result = compactTestnetResult({
    network: 'testnet-v1.0', payer: 'PAYER', provider: 'PROVIDER', application: 'APPLICATION', asset: { id: 77n, unitName: 'USDC', name: 'USD Coin', decimals: 6 }, applicationId: 42n,
    setup: { funding: { txId: 'FUND', confirmedRound: 10n, pending: { private: 'excluded' } }, create: { txId: 'CREATE', confirmedRound: 11n, pending: { private: 'excluded' } } },
    successfulSettlement: { groupId: 'SUCCESS-GROUP', memberTransactionIds: ['A', 'B', 'C'], confirmedRound: 12n, before: { payer: balance(1_000n, 100n), provider: balance(0n, 0n), application: balance(0n, 0n) }, after: { payer: balance(997n, 0n), provider: balance(0n, 93n), application: balance(0n, 7n) }, markerBefore: 0n, markerAfter: 1n },
    actualPoolRejectedGroup: { groupId: 'REJECTED-GROUP', memberTransactionIds: ['D', 'E', 'F'], poolRejection: 'TestNet transaction pool rejected the intended application assertion failure', before: { payer: balance(997n, 0n), provider: balance(0n, 93n), application: balance(0n, 7n) }, after: { payer: balance(997n, 0n), provider: balance(0n, 93n), application: balance(0n, 7n) }, markerBefore: 1n, markerAfter: 1n },
  })
  assert.deepEqual(result.successfulSettlement.balanceDeltas, { payer: { algoMicroAlgos: -3n, assetUnits: -100n }, provider: { algoMicroAlgos: 0n, assetUnits: 93n }, application: { algoMicroAlgos: 0n, assetUnits: 7n } })
  assert.deepEqual(result.actualPoolRejectedGroup.balanceDeltas, { payer: { algoMicroAlgos: 0n, assetUnits: 0n }, provider: { algoMicroAlgos: 0n, assetUnits: 0n }, application: { algoMicroAlgos: 0n, assetUnits: 0n } })
  assert.equal('pending' in result.setup.funding, false)
  assert.equal(Object.values(result.setup).some((entry) => 'pending' in entry), false)
  assert.deepEqual(Object.keys(result), ['network', 'asset', 'applicationId', 'addresses', 'setup', 'successfulSettlement', 'actualPoolRejectedGroup'])
})

test('TestNet balance delta helper reports only public numeric changes', () => {
  assert.deepEqual(balanceDeltas({ payer: { totalMicroAlgos: 5n, asset: 7n } }, { payer: { totalMicroAlgos: 3n, asset: 2n } }), { payer: { algoMicroAlgos: -2n, assetUnits: -5n } })
})
