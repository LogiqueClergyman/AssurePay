import assert from 'node:assert/strict'
import test from 'node:test'
import { isIntendedApplicationAssertionFailure, loadDotEnv, publicBalance } from '../scripts/run-testnet.mjs'

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
