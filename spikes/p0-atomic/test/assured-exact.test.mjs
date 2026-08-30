import assert from 'node:assert/strict'
import test from 'node:test'
import algosdk from 'algosdk'
import { x402Facilitator } from '@x402/core/facilitator'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'
import { AssuredExactAvmScheme, buildAssuredExactPayload } from '../src/assured-exact.mjs'

const ERROR = Object.freeze({ payload: 'invalid_assured_exact_payload', group: 'invalid_assured_exact_group', role: 'invalid_assured_exact_role', signature: 'invalid_assured_exact_signature', binding: 'invalid_assured_exact_binding', simulation: 'invalid_assured_exact_simulation', submission: 'invalid_assured_exact_submission', confirmation: 'invalid_assured_exact_confirmation' })
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const transactions = (payload) => payload.payload.paymentGroup.map((encoded) => algosdk.decodeSignedTransaction(Buffer.from(encoded, 'base64')).txn)

async function fixture() {
  const payer = algosdk.generateAccount(), alternate = algosdk.generateAccount(), provider = algosdk.generateAccount().addr, app = algosdk.generateAccount().addr, facilitator = algosdk.generateAccount().addr
  const built = buildAssuredExactPayload({ payer, provider, application: app, assetId: 77n, providerNet: 93n, premium: 7n, applicationId: 42n, commitment: new Uint8Array(32).fill(7), params: { fee: 1000, firstValid: 1, lastValid: 1000, genesisHash: new Uint8Array(32), genesisID: 'testnet-v1.0', flatFee: true } })
  const requirements = { ...built.requirements, network: ALGORAND_TESTNET_CAIP2, maxTimeoutSeconds: 60 }
  const payload = { x402Version: 2, accepted: requirements, payload: { paymentGroup: built.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const calls = { simulations: [], submissions: [], confirmations: [] }
  const signer = { getAddresses: () => [facilitator.toString()], simulateTransactions: async (g) => { calls.simulations.push(g); return { txnGroups: [{}] } }, sendTransactions: async (g) => { calls.submissions.push(g); return 'ok' }, waitForConfirmation: async (id) => { calls.confirmations.push(id); return {} } }
  return { payload, requirements, signer, calls, payer, alternate }
}

function regroupAndSign(payload, accounts, mutate) {
  const txns = transactions(payload)
  mutate(txns)
  algosdk.assignGroupID(txns)
  payload.payload.paymentGroup = txns.map((txn, index) => b64(txn.signTxn(accounts[index].sk)))
}
function replaceMember(payload, index, transaction, account) { payload.payload.paymentGroup[index] = b64(transaction.signTxn(account.sk)) }
function signedMap(payload, index) { return algosdk.msgpackRawDecodeAsMap(Buffer.from(payload.payload.paymentGroup[index], 'base64')) }
function replaceSignedMap(payload, index, map) { payload.payload.paymentGroup[index] = b64(algosdk.msgpackRawEncode(map)) }

async function assertRejected(name, mutate, reason, simulation = 0) {
  const context = await fixture()
  await mutate(context.payload, context.requirements, context)
  const result = await new AssuredExactAvmScheme(context.signer).verify(context.payload, context.requirements)
  assert.equal(result.isValid, false, name)
  assert.equal(result.invalidReason, reason, `${name}: stable reason`)
  assert.equal(context.calls.simulations.length, simulation, `${name}: simulation reachability`)
  assert.equal(context.calls.submissions.length, 0, `${name}: submission must not be reached before settlement`)
}

test('mocked core path: ABI-valid assured-exact settles immutable prepared bytes', async () => {
  const { payload, requirements, signer, calls } = await fixture()
  let original
  signer.simulateTransactions = async (g) => { calls.simulations.push(g); original = b64(g[0]); payload.payload.paymentGroup[0] = payload.payload.paymentGroup[1]; return { txnGroups: [{}] } }
  const result = await new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, new AssuredExactAvmScheme(signer)).settle(payload, requirements)
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(calls.submissions.length, 1); assert.deepEqual(calls.submissions[0], calls.simulations[0]); assert.equal(b64(calls.submissions[0][0]), original); assert.match(calls.confirmations[0], /^[A-Z2-7]+$/)
})

for (const [name, mutate, reason] of [
  ['wrong provider metadata', (p) => { p.accepted.extra.provider = p.accepted.extra.applicationAddress }, ERROR.binding],
  ['wrong asset metadata', (p) => { p.accepted.asset = '78' }, ERROR.binding],
  ['bad commitment encoding', (p) => { p.accepted.extra.requestCommitment = 'AA==' }, ERROR.payload],
  ['role index metadata', (p) => { p.payload.providerIndex = 1 }, ERROR.group],
  ['explicit fourth member under D-017', (p) => { p.payload.paymentGroup.push(p.payload.paymentGroup[0]) }, ERROR.group],
  ['malformed number', (p) => { p.accepted.extra.premium = '01' }, ERROR.payload],
  ['malformed asset number', (p) => { p.accepted.asset = ' 77' }, ERROR.payload],
]) test(`mocked core path: rejects ${name}`, async () => { await assertRejected(name, mutate, reason) })

for (const [name, mutate, reason] of [
  ['provider transfer receiver mutation', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[0].assetTransfer.receiver = c.alternate.addr }), ERROR.binding],
  ['premium transfer receiver mutation', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[1].assetTransfer.receiver = c.alternate.addr }), ERROR.binding],
  ['provider transfer asset mutation', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[0].assetTransfer.assetIndex = 78n }), ERROR.binding],
  ['premium transfer asset mutation', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[1].assetTransfer.assetIndex = 78n }), ERROR.binding],
  ['provider net signed-byte mutation', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[0].assetTransfer.amount = 92n }), ERROR.binding],
  ['premium signed-byte mutation', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[1].assetTransfer.amount = 8n }), ERROR.binding],
  ['gross ABI signed-byte mutation', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[2].applicationCall.appArgs[1] = algosdk.ABIType.from('uint64').encode(101n) }), ERROR.binding],
  ['application id signed-byte mutation', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[2].applicationCall.appIndex = 43n }), ERROR.binding],
  ['ABI selector corruption', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[2].applicationCall.appArgs[0] = new Uint8Array(4) }), ERROR.binding],
  ['ABI argument corruption', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[2].applicationCall.appArgs[3] = new Uint8Array([1]) }), ERROR.payload],
  ['signed commitment mismatch', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[2].applicationCall.appArgs[3] = algosdk.ABIType.from('byte[]').encode(new Uint8Array(32).fill(8)) }), ERROR.binding],
  ['ABI rejection flag', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[2].applicationCall.appArgs[4] = algosdk.ABIType.from('bool').encode(true) }), ERROR.binding],
  ['payer mismatch in premium role', (p, _r, c) => regroupAndSign(p, [c.payer, c.alternate, c.payer], (t) => { t[1].sender = c.alternate.addr }), ERROR.binding],
  ['payer mismatch in application role', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.alternate], (t) => { t[2].sender = c.alternate.addr }), ERROR.binding],
  ['rekey provider role', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[0].rekeyTo = c.alternate.addr }), ERROR.binding],
  ['rekey premium role', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[1].rekeyTo = c.alternate.addr }), ERROR.binding],
  ['rekey application role', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[2].rekeyTo = c.alternate.addr }), ERROR.binding],
  ['close provider transfer', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[0].assetTransfer.closeRemainderTo = c.alternate.addr }), ERROR.binding],
  ['close premium transfer', (p, _r, c) => regroupAndSign(p, [c.payer, c.payer, c.payer], (t) => { t[1].assetTransfer.closeRemainderTo = c.alternate.addr }), ERROR.binding],
  ['reordered group roles', (p) => { [p.payload.paymentGroup[0], p.payload.paymentGroup[2]] = [p.payload.paymentGroup[2], p.payload.paymentGroup[0]] }, ERROR.role],
]) test(`signed-byte matrix: rejects ${name}`, async () => { await assertRejected(name, mutate, reason) })

for (const [name, mutate, reason] of [
  ['missing group id', (p, _r, c) => { const t = transactions(p)[0]; t.group = undefined; replaceMember(p, 0, t, c.payer) }, ERROR.group],
  ['inconsistent group id', (p, _r, c) => { const t = transactions(p)[0]; t.group = new Uint8Array(32).fill(9); replaceMember(p, 0, t, c.payer) }, ERROR.group],
  ['missing provider signature', (p) => { const m = signedMap(p, 0); m.delete('sig'); replaceSignedMap(p, 0, m) }, ERROR.signature],
  ['missing premium signature', (p) => { const m = signedMap(p, 1); m.delete('sig'); replaceSignedMap(p, 1, m) }, ERROR.signature],
  ['missing application signature', (p) => { const m = signedMap(p, 2); m.delete('sig'); replaceSignedMap(p, 2, m) }, ERROR.signature],
  ['corrupt provider signature', (p) => { const m = signedMap(p, 0); m.get('sig')[0] ^= 1; replaceSignedMap(p, 0, m) }, ERROR.signature],
  ['corrupt premium signature', (p) => { const m = signedMap(p, 1); m.get('sig')[0] ^= 1; replaceSignedMap(p, 1, m) }, ERROR.signature],
  ['corrupt application signature', (p) => { const m = signedMap(p, 2); m.get('sig')[0] ^= 1; replaceSignedMap(p, 2, m) }, ERROR.signature],
  ['wrong-key provider signature', (p, _r, c) => replaceMember(p, 0, transactions(p)[0], c.alternate), ERROR.signature],
  ['wrong-key premium signature', (p, _r, c) => replaceMember(p, 1, transactions(p)[1], c.alternate), ERROR.signature],
  ['wrong-key application signature', (p, _r, c) => replaceMember(p, 2, transactions(p)[2], c.alternate), ERROR.signature],
  ['malformed signed wrapper', (p) => { p.payload.paymentGroup[1] = b64(Buffer.from('{}')) }, ERROR.signature],
]) test(`signed-byte matrix: rejects ${name}`, async () => { await assertRejected(name, mutate, reason) })

test('mocked core path: simulation failure reaches simulation and never submits', async () => {
  const { payload, requirements, signer, calls } = await fixture()
  signer.simulateTransactions = async (group) => { calls.simulations.push(group); return { txnGroups: [{ failureMessage: 'forced' }] } }
  const result = await new AssuredExactAvmScheme(signer).verify(payload, requirements)
  assert.equal(result.isValid, false); assert.equal(result.invalidReason, ERROR.simulation); assert.equal(calls.simulations.length, 1); assert.equal(calls.submissions.length, 0)
})

test('mocked core path: submission and confirmation errors are distinct', async () => {
  const a = await fixture(); a.signer.sendTransactions = async (group) => { a.calls.submissions.push(group); throw new Error('send') }
  const submission = await new AssuredExactAvmScheme(a.signer).settle(a.payload, a.requirements)
  assert.equal(submission.success, false); assert.equal(submission.errorReason, ERROR.submission); assert.equal(a.calls.simulations.length, 1); assert.equal(a.calls.submissions.length, 1); assert.equal(a.calls.confirmations.length, 0)
  const b = await fixture(); b.signer.waitForConfirmation = async (id) => { b.calls.confirmations.push(id); throw new Error('confirm') }
  const confirmation = await new AssuredExactAvmScheme(b.signer).settle(b.payload, b.requirements)
  assert.equal(confirmation.success, false); assert.equal(confirmation.errorReason, ERROR.confirmation); assert.equal(b.calls.simulations.length, 1); assert.equal(b.calls.submissions.length, 1); assert.equal(b.calls.confirmations.length, 1)
})
