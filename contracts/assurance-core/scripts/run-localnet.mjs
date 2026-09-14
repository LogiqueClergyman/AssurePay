import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import algosdk from 'algosdk'
import { x402Facilitator } from '@x402/core/facilitator'
import {
  LOCALNET_NETWORK,
  createAssuredExactFacilitator,
} from '../adapter/assured-exact.mjs'

const root = path.resolve(import.meta.dirname, '..')
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'AssuranceCore.arc32.json'), 'utf8'))
const compiled = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'AssuranceCore.arc56.json'), 'utf8'))
const approvalProgramBytes = Buffer.from(compiled.byteCode.approval, 'base64').length
const approvalExtraPages = Math.max(0, Math.ceil(approvalProgramBytes / 2_048) - 1)
const algodServer = process.env.LOCALNET_ALGOD_SERVER ?? 'http://127.0.0.1'
const algodPort = Number(process.env.LOCALNET_ALGOD_PORT ?? 4001)
const algodToken = process.env.LOCALNET_ALGOD_TOKEN ?? 'a'.repeat(64)
const kmdServer = process.env.LOCALNET_KMD_SERVER ?? 'http://127.0.0.1'
const kmdPort = Number(process.env.LOCALNET_KMD_PORT ?? 4002)
const kmdToken = process.env.LOCALNET_KMD_TOKEN ?? 'a'.repeat(64)
const algod = new algosdk.Algodv2(algodToken, algodServer, algodPort)

const args = (signature, values) => {
  const parsed = algosdk.ABIMethod.fromSignature(signature)
  return [parsed.getSelector(), ...parsed.args.map((arg, index) => arg.type.encode(values[index]))]
}
const params = async (fee = undefined) => {
  const suggested = await algod.getTransactionParams().do()
  return fee === undefined ? suggested : { ...suggested, fee, flatFee: true }
}
const sign = (txn, account) => txn.signTxn(account.sk)
const wait = async (txid) => algosdk.waitForConfirmation(algod, txid, 4)
const pendingField = (pending, dashed, camel) => pending[dashed] ?? pending[camel]
const send = async (txn, account) => {
  const { txid } = await algod.sendRawTransaction(sign(txn, account)).do()
  return { txid, pending: await wait(txid) }
}
let rejectedCount = 0
const rejected = async (txn, account, label) => {
  let error
  try {
    const { txid } = await algod.sendRawTransaction(sign(txn, account)).do()
    await wait(txid)
  } catch (caught) {
    error = caught
  }
  if (error) {
    rejectedCount += 1
    assert.match(String(error), /reject|pool|assert|overspend|balance|fee|rekey|asset|application/i, label)
    return
  }
  assert.fail(`${label} unexpectedly entered the pool`)
}
const applicationState = async (appId) => {
  const response = await algod.getApplicationByID(appId).do()
  const decode = (value) => typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value)
  return new Map((response.params.globalState ?? []).map((entry) => [decode(entry.key).toString(), entry.value]))
}
const logBytes = (pending, index = 0) => Buffer.from(pending.logs[index], 'base64')
const decodeEvent = (pending, signature, type, index = 0) => {
  const log = logBytes(pending, index)
  assert.deepEqual([...log.subarray(0, 4)], [...requireHash(signature)], `${signature} prefix`)
  return algosdk.ABIType.from(type).decode(log.subarray(4))
}
const checkEvent = (pending, signature, type, values, index = 0) => {
  assert.deepEqual(decodeEvent(pending, signature, type, index), values, `${signature} fields`)
}
const checkReturn = (pending, type, values) => {
  const log = logBytes(pending)
  assert.deepEqual([...log.subarray(0, 4)], [...requireHash('return')], 'ABI return prefix')
  assert.deepEqual(algosdk.ABIType.from(type).decode(log.subarray(4)), values, 'ABI return fields')
}
const requireHash = (signature) => {
  return crypto.createHash('sha512-256').update(signature).digest().subarray(0, 4)
}

async function getPayer() {
  if (process.env.LOCALNET_PAYER_MNEMONIC) return algosdk.mnemonicToSecretKey(process.env.LOCALNET_PAYER_MNEMONIC)
  const kmd = new algosdk.Kmd(kmdToken, kmdServer, kmdPort)
  const wallets = await kmd.listWallets()
  const wallet = wallets.wallets.find((item) => item.name === 'unencrypted-default-wallet') ?? wallets.wallets[0]
  assert.ok(wallet, 'LocalNet KMD has no wallet')
  const handle = await kmd.initWalletHandle(wallet.id, '')
  const keys = await kmd.listKeys(handle.wallet_handle_token)
  assert.ok(keys.addresses?.[0], 'LocalNet KMD has no account')
  const exported = await kmd.exportKey(handle.wallet_handle_token, '', keys.addresses[0])
  return { addr: keys.addresses[0], sk: exported.private_key }
}

const payer = await getPayer()
const other = algosdk.generateAccount()
const payerAddress = payer.addr.toString()
const otherAddress = other.addr.toString()
const zeroAddress = algosdk.encodeAddress(new Uint8Array(32))
const adjudicator = otherAddress
const assetCreate = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  total: 1_000_000,
  decimals: 0,
  assetName: 'GateA',
  unitName: 'GTA',
  defaultFrozen: false,
  manager: payerAddress,
  reserve: payerAddress,
  freeze: payerAddress,
  clawback: payerAddress,
  suggestedParams: await params(),
})
const assetCreated = await send(assetCreate, payer)
const assetId = Number(pendingField(assetCreated.pending, 'asset-index', 'assetIndex'))
assert.ok(assetId > 0)

const createTxn = async (asset, adjudicatorAddress, rekeyTo = undefined) => algosdk.makeApplicationCreateTxnFromObject({
  sender: payerAddress,
  onComplete: algosdk.OnApplicationComplete.NoOpOC,
  appArgs: args('createApplication(uint64,address)void', [asset, adjudicatorAddress]),
  approvalProgram: new Uint8Array(Buffer.from(compiled.byteCode.approval, 'base64')),
  clearProgram: new Uint8Array(Buffer.from(compiled.byteCode.clear, 'base64')),
  numGlobalInts: 6,
  numGlobalByteSlices: 2,
  numLocalInts: 0,
  numLocalByteSlices: 0,
  extraPages: 1,
  rekeyTo,
  suggestedParams: await params(),
})

// These calls are constructed with fresh suggested params and prove creation rejection paths.
await rejected(await createTxn(0, adjudicator), payer, 'zero asset creation')
await rejected(await createTxn(assetId, zeroAddress), payer, 'zero adjudicator creation')
await rejected(await createTxn(assetId, adjudicator, otherAddress), payer, 'unsafe rekey creation')

const create = algosdk.makeApplicationCreateTxnFromObject({
  sender: payerAddress,
  onComplete: algosdk.OnApplicationComplete.NoOpOC,
  appArgs: args('createApplication(uint64,address)void', [assetId, adjudicator]),
  approvalProgram: new Uint8Array(Buffer.from(compiled.byteCode.approval, 'base64')),
  clearProgram: new Uint8Array(Buffer.from(compiled.byteCode.clear, 'base64')),
  numGlobalInts: 6,
  numGlobalByteSlices: 2,
  numLocalInts: 0,
  numLocalByteSlices: 0,
  extraPages: 1,
  suggestedParams: await params(),
})
const created = await send(create, payer)
const appId = Number(pendingField(created.pending, 'application-index', 'applicationIndex'))
const appAddress = algosdk.getApplicationAddress(appId).toString()
checkEvent(created.pending, 'ProtocolCreated(uint64,address,address,uint64)', '(uint64,address,address,uint64)', [1n, payerAddress, adjudicator, BigInt(assetId)])
const initial = await applicationState(appId)
assert.equal(algosdk.encodeAddress(new Uint8Array(Buffer.from(initial.get('admin').bytes, 'base64'))), payerAddress)
assert.equal(algosdk.encodeAddress(new Uint8Array(Buffer.from(initial.get('adjudicator').bytes, 'base64'))), adjudicator)
assert.equal(Number(initial.get('acceptedAssetId').uint), assetId)
assert.equal(Number(initial.get('assetOptedIn').uint), 0)
assert.equal(Number(initial.get('totalProviderStake').uint), 0)
assert.equal(Number(initial.get('premiumReserve').uint), 0)
assert.equal(Number(initial.get('totalOpenFaultExposure').uint), 0)

const readConfig = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: [algosdk.ABIMethod.fromSignature('getConfig()(address,address,uint64,uint64,uint64)').getSelector()],
  suggestedParams: await params(),
})
const configRead = await send(readConfig, payer)
checkReturn(configRead.pending, '(address,address,uint64,uint64,uint64)', [payerAddress, adjudicator, BigInt(assetId), 0n, 0n])

const readAccounting = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: [algosdk.ABIMethod.fromSignature('getAccounting()(uint64,uint64,uint64)').getSelector()],
  suggestedParams: await params(),
})
const accountingRead = await send(readAccounting, payer)
checkReturn(accountingRead.pending, '(uint64,uint64,uint64)', [0n, 0n, 0n])

const app2Create = algosdk.makeApplicationCreateTxnFromObject({
  sender: payerAddress,
  onComplete: algosdk.OnApplicationComplete.NoOpOC,
  appArgs: args('createApplication(uint64,address)void', [assetId, adjudicator]),
  approvalProgram: new Uint8Array(Buffer.from(compiled.byteCode.approval, 'base64')),
  clearProgram: new Uint8Array(Buffer.from(compiled.byteCode.clear, 'base64')),
  numGlobalInts: 6,
  numGlobalByteSlices: 2,
  numLocalInts: 0,
  numLocalByteSlices: 0,
  extraPages: 1,
  suggestedParams: await params(),
})
const app2 = await send(app2Create, payer)
const app2Id = Number(pendingField(app2.pending, 'application-index', 'applicationIndex'))
const app2Address = algosdk.getApplicationAddress(app2Id).toString()
const insufficient = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: app2Id,
  appArgs: args('optInAcceptedAsset(uint64)void', [assetId]),
  foreignAssets: [assetId],
  suggestedParams: await params(2000),
})
await rejected(insufficient, payer, 'insufficient application ALGO opt-in')
assert.equal(Number((await applicationState(app2Id)).get('assetOptedIn').uint), 0)

const funding = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: appAddress,
  amount: 600_000,
  suggestedParams: await params(),
})
await send(funding, payer)

const otherFunding = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: otherAddress,
  amount: 2_000_000,
  suggestedParams: await params(),
})
await send(otherFunding, payer)

const nonAdmin = algosdk.makeApplicationNoOpTxnFromObject({
  sender: otherAddress,
  appIndex: appId,
  appArgs: args('optInAcceptedAsset(uint64)void', [assetId]),
  foreignAssets: [assetId],
  suggestedParams: await params(2000),
})
await rejected(nonAdmin, other, 'non-admin opt-in')

const wrongAsset = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: args('optInAcceptedAsset(uint64)void', [assetId + 1]),
  suggestedParams: await params(2000),
})
await rejected(wrongAsset, payer, 'wrong-asset opt-in')

const unsafeOptIn = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payer.addr,
  appIndex: appId,
  appArgs: args('optInAcceptedAsset(uint64)void', [assetId]),
  foreignAssets: [assetId],
  rekeyTo: otherAddress,
  suggestedParams: await params(2000),
})
await rejected(unsafeOptIn, payer, 'unsafe rekey opt-in')

const optIn = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: args('optInAcceptedAsset(uint64)void', [assetId]),
  foreignAssets: [assetId],
  suggestedParams: await params(2000),
})
const optedIn = await send(optIn, payer)
checkEvent(optedIn.pending, 'ProtocolAssetOptedIn(uint64,uint64)', '(uint64,uint64)', [1n, BigInt(assetId)])
const holdings = await algod.accountInformation(appAddress).do()
assert.ok((holdings.assets ?? []).some((holding) => Number(holding.assetId) === assetId && Number(holding.amount) === 0), 'application ASA holding')
assert.equal(Number(holdings.minBalance), 200_000, 'application base + ASA holding MBR')
assert.equal(Number((await applicationState(appId)).get('assetOptedIn').uint), 1)

const repeated = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: args('optInAcceptedAsset(uint64)void', [assetId]),
  foreignAssets: [assetId],
  suggestedParams: await params(2000),
})
await rejected(repeated, payer, 'repeated opt-in')
assert.equal(Number((await applicationState(appId)).get('assetOptedIn').uint), 1)

const boxKey = (prefix, id) => new Uint8Array(Buffer.concat([Buffer.from(prefix), Buffer.from(id)]))
const providerId = new Uint8Array(32).fill(7)
const providerId2 = new Uint8Array(32).fill(8)
const policyId1 = new Uint8Array(32).fill(9)
const policyId2 = new Uint8Array(32).fill(10)
const policyId3 = new Uint8Array(32).fill(11)
const providerBox = boxKey('p', providerId)
const providerBox2 = boxKey('p', providerId2)
const policyBox1 = boxKey('l', policyId1)
const policyBox2 = boxKey('l', policyId2)
const policyBox3 = boxKey('l', policyId3)
const decodedBytes = (value) => Array.from(value)
const boxes = (...names) => names.map((name) => ({ appIndex: 0, name }))
const call = async (sender, appArgs, refs = [], foreignAssets = [], fee = undefined, rekeyTo = undefined, accounts = []) => {
  const txn = algosdk.makeApplicationNoOpTxnFromObject({
    sender: sender.addr.toString(),
    appIndex: appId,
    appArgs,
    boxes: refs,
    foreignAssets,
    accounts,
    rekeyTo,
    suggestedParams: await params(fee),
  })
  return send(txn, sender)
}
const appArgs = (signature, values) => args(`${signature}void`, values)
const rejectCall = async (sender, signature, values, refs, label, foreignAssets = [], rekeyTo = undefined) => {
  const txn = algosdk.makeApplicationNoOpTxnFromObject({
    sender: sender.addr.toString(),
    appIndex: appId,
    appArgs: appArgs(signature, values),
    boxes: refs,
    foreignAssets,
    rekeyTo,
    suggestedParams: await params(),
  })
  await rejected(txn, sender, label)
}
const typedDepositArgs = (id) => [algosdk.ABIMethod.fromSignature('depositStake(byte[32],axfer)void').getSelector(), id]
const decodeStateUInt = (state, key) => Number(state.get(key).uint)
const algoBalance = async (address) => Number((await algod.accountInformation(address).do()).amount)
const payerAlgoBalance = async () => algoBalance(payerAddress)
const providerAlgoBalance = async () => algoBalance(otherAddress)
const appBalance = async () => algoBalance(appAddress)
const appMinBalance = async () => Number((await algod.accountInformation(appAddress).do()).minBalance)
const appAssetBalance = async () => {
  const account = await algod.accountInformation(appAddress).do()
  return Number((account.assets ?? []).find((holding) => Number(holding.assetId) === assetId)?.amount ?? 0)
}
const makeDepositGroup = async ({
  targetAppId = appId,
  targetAppAddress = appAddress,
  provider = providerId,
  amount = 1,
  transferSender = payerAddress,
  callSender = payerAddress,
  receiver = targetAppAddress,
  transferAsset = assetId,
  assetSender = undefined,
  assetCloseTo = undefined,
  transferRekeyTo = undefined,
  appRekeyTo = undefined,
} = {}) => {
  const transfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: transferSender,
    receiver,
    amount,
    assetIndex: transferAsset,
    assetSender,
    closeRemainderTo: assetCloseTo,
    rekeyTo: transferRekeyTo,
    suggestedParams: await params(),
  })
  const application = algosdk.makeApplicationNoOpTxnFromObject({
    sender: callSender,
    appIndex: targetAppId,
    appArgs: typedDepositArgs(provider),
    boxes: [
      { appIndex: 0, name: boxKey('p', provider) },
    ],
    foreignAssets: [transferAsset],
    rekeyTo: appRekeyTo,
    suggestedParams: await params(),
  })
  return [transfer, application]
}
const rejectedGroup = async (transactions, accounts, label) => {
  let error
  try {
    const grouped = algosdk.assignGroupID(transactions)
    const signed = grouped.map((txn, index) => sign(txn, accounts[index]))
    const response = await algod.sendRawTransaction(signed).do()
    await wait(response.txId ?? response.txid)
  } catch (caught) {
    error = caught
  }
  if (error) {
    rejectedCount += 1
    assert.match(String(error), /reject|pool|assert|overspend|balance|fee|rekey|asset|application/i, label)
    return
  }
  assert.fail(`${label} unexpectedly entered the pool`)
}
await rejectedGroup(
  await makeDepositGroup({ targetAppId: app2Id, targetAppAddress: app2Address, amount: 1 }),
  [payer, payer],
  'deposit before application ASA opt-in',
)

const minAfterOptIn = await appMinBalance()
const beforeProvider = await appBalance()
const registered = await call(
  payer,
  appArgs('registerProvider(byte[32],address,byte[32])', [providerId, payerAddress, new Uint8Array(32).fill(3)]),
  boxes(providerBox),
)
const registeredEvent = decodeEvent(registered.pending, 'ProviderRegistered(uint64,byte[32],address,address,byte[32],uint64)', '(uint64,byte[32],address,address,byte[32],uint64)')
assert.deepEqual(registeredEvent.slice(0, 5), [1n, decodedBytes(providerId), payerAddress, payerAddress, decodedBytes(new Uint8Array(32).fill(3))])
const providerCreatedAt = registeredEvent[5]
assert.equal(await appBalance(), beforeProvider, 'provider box creation does not debit balance')
assert.equal(await appMinBalance(), minAfterOptIn + 67_300, 'provider box MBR')

await rejected(await (async () => algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: appArgs('registerProvider(byte[32],address,byte[32])', [providerId, payerAddress, new Uint8Array(32).fill(3)]),
  boxes: boxes(providerBox),
  suggestedParams: await params(),
}))(), payer, 'duplicate provider')
await rejected(await (async () => algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: appArgs('registerProvider(byte[32],address,byte[32])', [new Uint8Array(32), payerAddress, new Uint8Array(32).fill(3)]),
  boxes: boxes(boxKey('p', new Uint8Array(32))),
  suggestedParams: await params(),
}))(), payer, 'zero provider id')
await rejected(await (async () => algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: appArgs('registerProvider(byte[32],address,byte[32])', [providerId2, zeroAddress, new Uint8Array(32).fill(3)]),
  boxes: boxes(providerBox2),
  suggestedParams: await params(),
}))(), payer, 'zero payout')
await rejected(await (async () => algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: appArgs('registerProvider(byte[32],address,byte[32])', [providerId2, payerAddress, new Uint8Array(32)]),
  boxes: boxes(providerBox2),
  suggestedParams: await params(),
}))(), payer, 'zero receipt key')
await rejected(await (async () => algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: [algosdk.ABIMethod.fromSignature('getProvider(byte[32])(address,address,byte[32],bool,uint64,uint64,uint64,uint64)').getSelector(), providerId],
  suggestedParams: await params(),
}))(), payer, 'missing provider box reference')

const readProvider = await call(
  payer,
  [algosdk.ABIMethod.fromSignature('getProvider(byte[32])(address,address,byte[32],bool,uint64,uint64,uint64,uint64)').getSelector(), providerId],
  boxes(providerBox),
)
checkReturn(readProvider.pending, '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)', [payerAddress, payerAddress, decodedBytes(new Uint8Array(32).fill(3)), true, 0n, 0n, 0n, providerCreatedAt])

const createPolicy = async (id, ratio, ref) => {
  const createdPolicy = await call(
    payer,
    appArgs('createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [id, providerId, 250, ratio, 1_000_000, 3_600]),
    boxes(providerBox, ref),
  )
  const event = decodeEvent(createdPolicy.pending, 'PolicyCreated(uint64,byte[32],byte[32],uint64,uint64,uint64,uint64,uint64)', '(uint64,byte[32],byte[32],uint64,uint64,uint64,uint64,uint64)')
  assert.deepEqual(event.slice(0, 7), [1n, decodedBytes(id), decodedBytes(providerId), 250n, BigInt(ratio), 1_000_000n, 3_600n])
  return { createdAt: event[7], txid: createdPolicy.txid }
}
const policy1Created = await createPolicy(policyId1, 2_500, policyBox1)
const policyCreatedAt1 = policy1Created.createdAt
assert.equal(await appMinBalance(), minAfterOptIn + 67_300 + 44_900, 'first policy box MBR')
const policy2Created = await createPolicy(policyId2, 7_500, policyBox2)
assert.equal(await appMinBalance(), minAfterOptIn + 67_300 + 2 * 44_900, 'second policy box MBR')

await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId1, providerId, 250, 2_500, 1_000_000, 3_600], boxes(providerBox, policyBox1), 'duplicate policy')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId2, 250, 2_500, 1_000_000, 3_600], boxes(providerBox2, policyBox3), 'missing provider')
await rejectCall(other, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 250, 2_500, 1_000_000, 3_600], boxes(providerBox, policyBox3), 'non-owner policy creation')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 0, 2_500, 1_000_000, 3_600], boxes(providerBox, policyBox3), 'zero premium bps')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 10_001, 2_500, 1_000_000, 3_600], boxes(providerBox, policyBox3), 'premium bps above maximum')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 250, 0, 1_000_000, 3_600], boxes(providerBox, policyBox3), 'zero collateral bps')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 250, 10_001, 1_000_000, 3_600], boxes(providerBox, policyBox3), 'collateral bps above maximum')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 250, 2_500, 0, 3_600], boxes(providerBox, policyBox3), 'zero maximum coverage')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 250, 2_500, 1_000_000, 0], boxes(providerBox, policyBox3), 'zero claim window')

const readPolicy = await call(
  payer,
  [algosdk.ABIMethod.fromSignature('getPolicy(byte[32])(byte[32],bool,uint64,uint64,uint64,uint64,uint64)').getSelector(), policyId1],
  boxes(policyBox1),
)
checkReturn(readPolicy.pending, '(byte[32],bool,uint64,uint64,uint64,uint64,uint64)', [decodedBytes(providerId), true, 250n, 2_500n, 1_000_000n, 3_600n, policyCreatedAt1])

const readCapacity = async (provider, policy, refs) => {
  const result = await call(
    payer,
    [algosdk.ABIMethod.fromSignature('getAvailableCapacity(byte[32],byte[32])uint64').getSelector(), provider, policy],
    refs,
  )
  const log = logBytes(result.pending)
  assert.deepEqual([...log.subarray(0, 4)], [...requireHash('return')], 'capacity return prefix')
  return algosdk.ABIType.from('uint64').decode(log.subarray(4))
}

const paused = await call(payer, appArgs('setPaused(bool)', [true]))
checkEvent(paused.pending, 'ProtocolPauseChanged(uint64,bool)', '(uint64,bool)', [1n, true])
assert.equal(decodeStateUInt(await applicationState(appId), 'paused'), 1)
const pausedState = await applicationState(appId)
await rejected(await (async () => algosdk.makeApplicationNoOpTxnFromObject({
  sender: otherAddress,
  appIndex: appId,
  appArgs: appArgs('setPaused(bool)', [false]),
  suggestedParams: await params(),
}))(), other, 'non-admin pause')
await rejected(await (async () => algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: appArgs('setPaused(bool)', [true]),
  suggestedParams: await params(),
}))(), payer, 'pause no-op')
await rejected(await (async () => algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: appArgs('registerProvider(byte[32],address,byte[32])', [providerId2, payerAddress, new Uint8Array(32).fill(4)]),
  boxes: boxes(providerBox2),
  suggestedParams: await params(),
}))(), payer, 'paused provider registration')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 250, 2_500, 1_000_000, 3_600], boxes(providerBox, policyBox3), 'paused policy creation')
await rejectCall(payer, 'setProviderStatus(byte[32],bool)', [providerId, false], boxes(providerBox), 'paused provider status')
await rejectCall(payer, 'setPolicyStatus(byte[32],bool)', [policyId1, false], boxes(providerBox, policyBox1), 'paused policy status')
const pausedDeposit = await makeDepositGroup({ amount: 1 })
await rejectedGroup(pausedDeposit, [payer, payer], 'paused stake deposit')
assert.equal(decodeStateUInt(await applicationState(appId), 'paused'), decodeStateUInt(pausedState, 'paused'))
const unpaused = await call(payer, appArgs('setPaused(bool)', [false]))

await rejectCall(other, 'setProviderStatus(byte[32],bool)', [providerId, false], boxes(providerBox), 'non-admin provider status')
await rejectCall(payer, 'setProviderStatus(byte[32],bool)', [providerId, true], boxes(providerBox), 'provider status no-op')
await rejectCall(other, 'setPolicyStatus(byte[32],bool)', [policyId1, false], boxes(providerBox, policyBox1), 'non-owner policy status')
await rejectCall(payer, 'setPolicyStatus(byte[32],bool)', [policyId1, true], boxes(providerBox, policyBox1), 'policy status no-op')
const policyOff = await call(payer, appArgs('setPolicyStatus(byte[32],bool)', [policyId1, false]), boxes(providerBox, policyBox1))
checkEvent(policyOff.pending, 'PolicyStatusChanged(uint64,byte[32],bool)', '(uint64,byte[32],bool)', [1n, decodedBytes(policyId1), false])
const policyOn = await call(payer, appArgs('setPolicyStatus(byte[32],bool)', [policyId1, true]), boxes(providerBox, policyBox1))
checkEvent(policyOn.pending, 'PolicyStatusChanged(uint64,byte[32],bool)', '(uint64,byte[32],bool)', [1n, decodedBytes(policyId1), true])

const deactivated = await call(payer, appArgs('setProviderStatus(byte[32],bool)', [providerId, false]), boxes(providerBox))
checkEvent(deactivated.pending, 'ProviderStatusChanged(uint64,byte[32],bool)', '(uint64,byte[32],bool)', [1n, decodedBytes(providerId), false])
const inactivePolicy = await call(payer, [algosdk.ABIMethod.fromSignature('getPolicy(byte[32])(byte[32],bool,uint64,uint64,uint64,uint64,uint64)').getSelector(), policyId1], boxes(policyBox1))
checkReturn(inactivePolicy.pending, '(byte[32],bool,uint64,uint64,uint64,uint64,uint64)', [decodedBytes(providerId), true, 250n, 2_500n, 1_000_000n, 3_600n, policyCreatedAt1])
const inactiveDeposit = await makeDepositGroup({ amount: 1 })
await rejectedGroup(inactiveDeposit, [payer, payer], 'inactive provider deposit')
await rejectCall(payer, 'createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyId3, providerId, 250, 2_500, 1_000_000, 3_600], boxes(providerBox, policyBox3), 'inactive provider policy creation')
const reactivated = await call(payer, appArgs('setProviderStatus(byte[32],bool)', [providerId, true]), boxes(providerBox))

await send(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: otherAddress,
  receiver: otherAddress,
  amount: 0,
  assetIndex: assetId,
  suggestedParams: await params(),
}), other)
await send(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: otherAddress,
  amount: 10,
  assetIndex: assetId,
  suggestedParams: await params(),
}), payer)
const assertDepositRollback = async (transactions, accounts, label) => {
  const before = {
    appBalance: await appBalance(),
    appAssetBalance: await appAssetBalance(),
    totalProviderStake: decodeStateUInt(await applicationState(appId), 'totalProviderStake'),
  }
  await rejectedGroup(transactions, accounts, label)
  assert.equal(await appBalance(), before.appBalance, `${label} ALGO rollback`)
  assert.equal(await appAssetBalance(), before.appAssetBalance, `${label} ASA rollback`)
  assert.equal(decodeStateUInt(await applicationState(appId), 'totalProviderStake'), before.totalProviderStake, `${label} accounting rollback`)
}

const validNegativeBase = await makeDepositGroup({ amount: 1 })
await rejected(validNegativeBase[1], payer, 'deposit wrong group size')
await assertDepositRollback([validNegativeBase[1], validNegativeBase[0]], [payer, payer], 'deposit wrong order')
await assertDepositRollback(await makeDepositGroup({ amount: 1, receiver: otherAddress }), [payer, payer], 'deposit receiver mismatch')
await assertDepositRollback(await makeDepositGroup({ amount: 1, transferAsset: assetId + 1 }), [payer, payer], 'deposit wrong ASA')
await assertDepositRollback(await makeDepositGroup({ amount: 0 }), [payer, payer], 'deposit zero amount')
await assertDepositRollback(await makeDepositGroup({ amount: 1, assetSender: otherAddress }), [payer, payer], 'deposit asset sender')
await assertDepositRollback(await makeDepositGroup({ amount: 1, assetCloseTo: otherAddress }), [payer, payer], 'deposit asset close-to')
await assertDepositRollback(await makeDepositGroup({ amount: 1, transferRekeyTo: otherAddress }), [payer, payer], 'deposit transfer rekey')
await assertDepositRollback(await makeDepositGroup({ amount: 1, appRekeyTo: otherAddress }), [payer, payer], 'deposit application rekey')
await assertDepositRollback(await makeDepositGroup({ amount: 1, transferSender: otherAddress }), [other, payer], 'deposit sender mismatch')
await assertDepositRollback(await makeDepositGroup({ amount: 1, callSender: otherAddress }), [payer, other], 'deposit non-owner')

const depositAmount = 123
const depositTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: appAddress,
  amount: depositAmount,
  assetIndex: assetId,
  suggestedParams: await params(),
})
const depositCall = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: typedDepositArgs(providerId),
  boxes: boxes(providerBox),
  foreignAssets: [assetId],
  suggestedParams: await params(),
})
const depositGroup = algosdk.assignGroupID([depositTransfer, depositCall])
const balanceBeforeDeposit = await appAssetBalance()
const signedDeposit = depositGroup.map((txn) => sign(txn, payer))
await algod.sendRawTransaction(signedDeposit).do()
const deposited = await wait(depositCall.txID())
checkEvent(deposited, 'StakeDeposited(uint64,byte[32],uint64,uint64)', '(uint64,byte[32],uint64,uint64)', [1n, decodedBytes(providerId), BigInt(depositAmount), BigInt(depositAmount)])
assert.equal(await appAssetBalance(), balanceBeforeDeposit + depositAmount, 'application ASA balance')
assert.equal(decodeStateUInt(await applicationState(appId), 'totalProviderStake'), depositAmount, 'global stake')
const providerAfterDeposit = await call(payer, [algosdk.ABIMethod.fromSignature('getProvider(byte[32])(address,address,byte[32],bool,uint64,uint64,uint64,uint64)').getSelector(), providerId], boxes(providerBox))
checkReturn(providerAfterDeposit.pending, '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)', [payerAddress, payerAddress, decodedBytes(new Uint8Array(32).fill(3)), true, BigInt(depositAmount), 0n, 0n, providerCreatedAt])

const capacity1 = await readCapacity(providerId, policyId1, boxes(providerBox, policyBox1))
const capacity2 = await readCapacity(providerId, policyId2, boxes(providerBox, policyBox2))
assert.equal(capacity1, 492n)
assert.equal(capacity2, 164n)

const registered2 = await call(
  payer,
  appArgs('registerProvider(byte[32],address,byte[32])', [providerId2, payerAddress, new Uint8Array(32).fill(5)]),
  boxes(providerBox2),
)
const registered2Event = decodeEvent(registered2.pending, 'ProviderRegistered(uint64,byte[32],address,address,byte[32],uint64)', '(uint64,byte[32],address,address,byte[32],uint64)')
assert.deepEqual(registered2Event.slice(0, 5), [1n, decodedBytes(providerId2), payerAddress, payerAddress, decodedBytes(new Uint8Array(32).fill(5))])
const mismatchCapacity = algosdk.makeApplicationNoOpTxnFromObject({
  sender: payerAddress,
  appIndex: appId,
  appArgs: [algosdk.ABIMethod.fromSignature('getAvailableCapacity(byte[32],byte[32])uint64').getSelector(), providerId2, policyId1],
  boxes: boxes(providerBox2, policyBox1),
  suggestedParams: await params(),
})
await rejected(mismatchCapacity, payer, 'provider and policy mismatch')

const duplicate = async () => {
  let error
  try { await algod.sendRawTransaction(signedDeposit).do() } catch (caught) { error = caught }
  assert.ok(error, 'duplicate deposit replay rejected')
}
await duplicate()

// Gate C: use a provider whose payout address is distinct from the payer so
// the three ASA legs can be observed independently.
const providerId3 = new Uint8Array(32).fill(12)
const policyIdGate3 = new Uint8Array(32).fill(11)
const policyIdGate4 = new Uint8Array(32).fill(13)
const providerBox3 = boxKey('p', providerId3)
const policyBoxGate3 = boxKey('l', policyIdGate3)
const policyBoxGate4 = boxKey('l', policyIdGate4)
const coverageId1 = new Uint8Array(32).fill(21)
const coverageId2 = new Uint8Array(32).fill(22)
const coverageIdBad = new Uint8Array(32).fill(23)
const coverageId3 = new Uint8Array(32).fill(41)
const coverageId4 = new Uint8Array(32).fill(42)
const coverageId5 = new Uint8Array(32).fill(43)
const claimId1 = new Uint8Array(32).fill(51)
const claimId2 = new Uint8Array(32).fill(52)
const claimId3 = new Uint8Array(32).fill(53)
const coverageBox1 = boxKey('c', coverageId1)
const coverageBox2 = boxKey('c', coverageId2)
const coverageBoxBad = boxKey('c', coverageIdBad)
const coverageBox3 = boxKey('c', coverageId3)
const coverageBox4 = boxKey('c', coverageId4)
const coverageBox5 = boxKey('c', coverageId5)
const claimBox1 = boxKey('f', claimId1)
const claimBox2 = boxKey('f', claimId2)
const claimBox3 = boxKey('f', claimId3)

await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: appAddress,
  amount: 300_000,
  suggestedParams: await params(),
}), payer)

const registered3 = await call(
  payer,
  appArgs('registerProvider(byte[32],address,byte[32])', [providerId3, otherAddress, new Uint8Array(32).fill(6)]),
  boxes(providerBox3),
)
const createPolicyFor = async (id, provider, ratio, ref) => call(
  payer,
  appArgs('createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [id, provider, 250, ratio, 1_000_000, 3_600]),
  boxes(boxKey('p', provider), ref),
)
await createPolicyFor(policyIdGate3, providerId3, 2_500, policyBoxGate3)
await createPolicyFor(policyIdGate4, providerId3, 7_500, policyBoxGate4)
const policyIdGate5 = new Uint8Array(32).fill(14)
const policyIdGate6 = new Uint8Array(32).fill(15)
const policyBoxGate5 = boxKey('l', policyIdGate5)
const policyBoxGate6 = boxKey('l', policyIdGate6)
await call(payer, appArgs('createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyIdGate5, providerId3, 10_000, 2_500, 1_000_000, 3_600]), boxes(providerBox3, policyBoxGate5))
await call(payer, appArgs('createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)', [policyIdGate6, providerId2, 250, 10_000, 1_000_000, 30]), boxes(providerBox2, policyBoxGate6))
const deposit3 = await makeDepositGroup({ provider: providerId3, amount: 123 })
const signedDeposit3 = algosdk.assignGroupID(deposit3).map((txn) => sign(txn, payer))
await algod.sendRawTransaction(signedDeposit3).do()
await wait(deposit3[1].txID())

const coverageArgs = (coverageId, provider, policy, requestHash, gross) => args(
  'openCoverage(byte[32],byte[32],byte[32],byte[32],uint64)void',
  [coverageId, provider, policy, requestHash, gross],
)
const coverageRequirements = ({ coverageId, provider, providerPayout = otherAddress, policy, requestHash, gross, providerNet, premium }) => ({
  scheme: 'assured-exact',
  network: LOCALNET_NETWORK,
  asset: String(assetId),
  amount: String(gross),
  payTo: providerPayout,
  maxTimeoutSeconds: 120,
  extra: {
    profile: 'assurance-core-v1',
    provider: providerPayout,
    applicationAddress: appAddress,
    applicationId: String(appId),
    providerNet: String(providerNet),
    premium: String(premium),
    coverageId: Buffer.from(coverageId).toString('base64'),
    providerId: Buffer.from(provider).toString('base64'),
    policyId: Buffer.from(policy).toString('base64'),
    requestCommitment: Buffer.from(requestHash).toString('base64'),
  },
})
const makeCoverageGroup = async ({ coverageId, provider = providerId3, providerPayout = otherAddress, policy, premiumBps = 250, gross, requestHash = new Uint8Array(32).fill(31), transferReceiver = providerPayout, transferAsset = assetId, transferAmount = undefined, transferSender = payerAddress, callSender = payerAddress, assetSender = undefined, appRekeyTo = undefined, transferRekeyTo = undefined, transferCloseTo = undefined, includeCoverageBox = true }) => {
  const premium = Math.max(1, Math.floor(gross * premiumBps / 10_000))
  const providerNet = gross - premium
  const providerTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: transferSender,
    receiver: transferReceiver,
    amount: transferAmount ?? providerNet,
    assetIndex: transferAsset,
    assetSender,
    closeRemainderTo: transferCloseTo,
    rekeyTo: transferRekeyTo,
    suggestedParams: await params(),
  })
  const premiumTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payerAddress,
    receiver: appAddress,
    amount: premium,
    assetIndex: assetId,
    suggestedParams: await params(),
  })
  const application = algosdk.makeApplicationNoOpTxnFromObject({
    sender: callSender,
    appIndex: appId,
    appArgs: coverageArgs(coverageId, provider, policy, requestHash, gross),
    boxes: [
      { appIndex: 0, name: boxKey('p', provider) },
      { appIndex: 0, name: boxKey('l', policy) },
      ...(includeCoverageBox ? [{ appIndex: 0, name: boxKey('c', coverageId) }] : []),
    ],
    foreignAssets: [assetId],
    rekeyTo: appRekeyTo,
    suggestedParams: await params(),
  })
  const group = algosdk.assignGroupID([providerTransfer, premiumTransfer, application])
  const signed = group.map((txn, index) => sign(txn, index === 0 && transferSender === otherAddress ? other : payer))
  return { group, signed, providerNet, premium, requirements: coverageRequirements({ coverageId, provider, providerPayout, policy, requestHash, gross, providerNet, premium }) }
}
const submitViaCore = async (fixture) => {
  const x402 = new x402Facilitator()
  let submissions = 0
  const scheme = createAssuredExactFacilitator({
    algod,
    network: LOCALNET_NETWORK,
    genesisId: 'dockernet-v1',
    applicationId: appId,
    applicationAddress: appAddress,
    acceptedAssetId: assetId,
    submit: async (bytes) => { submissions += 1; return algod.sendRawTransaction(bytes).do() },
  })
  x402.register(LOCALNET_NETWORK, scheme)
  const paymentPayload = {
    x402Version: 2,
    accepted: fixture.requirements,
    payload: { paymentGroup: fixture.signed.map((item) => Buffer.from(item).toString('base64')), providerIndex: 0, premiumIndex: 1, applicationIndex: 2 },
  }
  const verification = await x402.verify(paymentPayload, fixture.requirements)
  assert.equal(verification.isValid, true, `x402 simulation accepted coverage: ${verification.invalidReason ?? ''} ${verification.invalidMessage ?? ''}`)
  const settlement = await x402.settle(paymentPayload, fixture.requirements)
  assert.equal(settlement.success, true, 'x402 settlement succeeded')
  return { settlement, submissions }
}
const coverageState = async (id, ref) => {
  const read = await call(payer, [algosdk.ABIMethod.fromSignature('getCoverage(byte[32])(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)').getSelector(), id], boxes(ref))
  return algosdk.ABIType.from('(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)').decode(logBytes(read.pending).subarray(4))
}
const asaBalance = async (address) => Number((await algod.accountInformation(address).do()).assets?.find((holding) => Number(holding.assetId) === assetId)?.amount ?? 0)
const boxSnapshot = async (name) => {
  try { return (await algod.getApplicationBoxByName(appId, name).do()).value }
  catch { return undefined }
}
const gateCStateSnapshot = async (extraBoxes = []) => ({
  payerAlgo: await payerAlgoBalance(),
  providerAlgo: await providerAlgoBalance(),
  applicationAlgo: await appBalance(),
  payerAsset: await asaBalance(payerAddress),
  providerAsset: await asaBalance(otherAddress),
  applicationAsset: await appAssetBalance(),
  applicationMinBalance: await appMinBalance(),
  boxes: Object.fromEntries(await Promise.all([...new Set([
    providerBox3, policyBoxGate3, policyBoxGate4, coverageBox1, coverageBox2, coverageBoxBad, ...extraBoxes,
  ].map((name) => Buffer.from(name).toString('base64')))].map(async (encoded) => [encoded, await boxSnapshot(Buffer.from(encoded, 'base64'))]))),
  globalState: await applicationState(appId),
})
const gateDStateSnapshot = async (extraBoxes = []) => ({
  payerAlgo: await payerAlgoBalance(),
  otherAlgo: await algoBalance(otherAddress),
  applicationAlgo: await appBalance(),
  payerAsset: await asaBalance(payerAddress),
  providerAsset: await asaBalance(otherAddress),
  applicationAsset: await appAssetBalance(),
  applicationMinBalance: await appMinBalance(),
  boxes: Object.fromEntries(await Promise.all([...new Set([
    providerBox, providerBox2, providerBox3, policyBoxGate3, policyBoxGate4, policyBoxGate5, policyBoxGate6,
    coverageBox1, coverageBox2, coverageBox3, coverageBox4, coverageBox5, claimBox1, claimBox2, claimBox3,
    ...extraBoxes.map((item) => item?.name ?? item),
  ].map((name) => Buffer.from(name).toString('base64')))].map(async (encoded) => [encoded, await boxSnapshot(Buffer.from(encoded, 'base64'))]))),
  globalState: await applicationState(appId),
})
const claimState = async (id, ref) => {
  const read = await call(payer, [algosdk.ABIMethod.fromSignature('getClaim(byte[32])(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)').getSelector(), id], boxes(ref))
  return algosdk.ABIType.from('(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)').decode(logBytes(read.pending).subarray(4))
}
const coverageMbrFunding = await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: appAddress,
  amount: 92_900,
  suggestedParams: await params(),
}), payer)
const coverageBeforeMin = await appMinBalance()
const beforeFirst = { payer: await asaBalance(payerAddress), provider: await asaBalance(otherAddress), application: await appAssetBalance() }
const firstCoverage = await makeCoverageGroup({ coverageId: coverageId1, policy: policyIdGate3, gross: 40 })
const firstResult = await submitViaCore(firstCoverage)
await wait(firstCoverage.group[0].txID())
const firstPendings = await Promise.all(firstCoverage.group.map((txn) => wait(txn.txID())))
const firstOpenedAt = decodeEvent(firstPendings[2], 'CoverageOpened(uint64,byte[32],byte[32],byte[32],address,uint64,uint64,uint64,byte[32],uint64,uint64)', '(uint64,byte[32],byte[32],byte[32],address,uint64,uint64,uint64,byte[32],uint64,uint64)',)
assert.deepEqual(firstOpenedAt.slice(0, 9), [1n, decodedBytes(coverageId1), decodedBytes(providerId3), decodedBytes(policyIdGate3), payerAddress, 40n, 39n, 1n, decodedBytes(new Uint8Array(32).fill(31))])
const firstRecord = await coverageState(coverageId1, coverageBox1)
assert.deepEqual(firstRecord.slice(0, 9), [decodedBytes(providerId3), decodedBytes(policyIdGate3), payerAddress, 40n, 39n, 1n, 0n, 10n, decodedBytes(new Uint8Array(32).fill(31))])
assert.equal(firstRecord[11], 1n)
assert.equal(firstRecord[12], false)
assert.equal(await appMinBalance(), coverageBeforeMin + 92_900, 'coverage box MBR delta')
assert.deepEqual({ payer: await asaBalance(payerAddress), provider: await asaBalance(otherAddress), application: await appAssetBalance() }, { payer: beforeFirst.payer - 40, provider: beforeFirst.provider + 39, application: beforeFirst.application + 1 })

const secondCoverage = await makeCoverageGroup({ coverageId: coverageId2, policy: policyIdGate4, gross: 100, requestHash: new Uint8Array(32).fill(32) })
const secondResult = await submitViaCore(secondCoverage)
await wait(secondCoverage.group[0].txID())
const secondPendings = await Promise.all(secondCoverage.group.map((txn) => wait(txn.txID())))
const secondRecord = await coverageState(coverageId2, coverageBox2)
assert.deepEqual(secondRecord.slice(0, 9), [decodedBytes(providerId3), decodedBytes(policyIdGate4), payerAddress, 100n, 98n, 2n, 0n, 75n, decodedBytes(new Uint8Array(32).fill(32))])
assert.equal(await appMinBalance(), coverageBeforeMin + 2 * 92_900, 'two coverage box MBR deltas')
assert.deepEqual({ payer: await asaBalance(payerAddress), provider: await asaBalance(otherAddress), application: await appAssetBalance() }, { payer: beforeFirst.payer - 140, provider: beforeFirst.provider + 137, application: beforeFirst.application + 3 })
const providerAfterCoverage = await call(payer, [algosdk.ABIMethod.fromSignature('getProvider(byte[32])(address,address,byte[32],bool,uint64,uint64,uint64,uint64)').getSelector(), providerId3], boxes(providerBox3))
checkReturn(providerAfterCoverage.pending, '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)', [payerAddress, otherAddress, decodedBytes(new Uint8Array(32).fill(6)), true, 123n, 85n, 140n, (await decodeEvent(registered3.pending, 'ProviderRegistered(uint64,byte[32],address,address,byte[32],uint64)', '(uint64,byte[32],address,address,byte[32],uint64)'))[5]])
const finalGateCAccounting = await applicationState(appId)
assert.equal(decodeStateUInt(finalGateCAccounting, 'totalProviderStake'), 246)
assert.equal(decodeStateUInt(finalGateCAccounting, 'premiumReserve'), 3)
assert.equal(decodeStateUInt(finalGateCAccounting, 'totalOpenFaultExposure'), 140)
const capacityAfterFirst = await readCapacity(providerId3, policyIdGate3, boxes(providerBox3, policyBoxGate3))
const capacityAfterSecond = await readCapacity(providerId3, policyIdGate4, boxes(providerBox3, policyBoxGate4))
assert.equal(capacityAfterFirst, 152n)
assert.equal(capacityAfterSecond, 50n)

const insufficientCoverage = await makeCoverageGroup({ coverageId: coverageIdBad, policy: policyIdGate4, gross: 51, requestHash: new Uint8Array(32).fill(33) })
const gateCRejectionCases = []
let simulationSubmissions = 0
const rejectionScheme = createAssuredExactFacilitator({ algod, network: LOCALNET_NETWORK, applicationId: appId, applicationAddress: appAddress, acceptedAssetId: assetId, submit: async (bytes) => { simulationSubmissions += 1; return algod.sendRawTransaction(bytes).do() } })
const rejectionCore = new x402Facilitator().register(LOCALNET_NETWORK, rejectionScheme)
const insufficientPayload = {
  x402Version: 2,
  accepted: insufficientCoverage.requirements,
  payload: { paymentGroup: insufficientCoverage.signed.map((item) => Buffer.from(item).toString('base64')), providerIndex: 0, premiumIndex: 1, applicationIndex: 2 },
}
const insufficientVerification = await rejectionCore.verify(insufficientPayload, insufficientCoverage.requirements)
assert.equal(insufficientVerification.isValid, false)
assert.equal(insufficientVerification.invalidReason, 'simulation')
assert.equal(simulationSubmissions, 0, 'x402 did not submit simulated rejection')
assert.match(insufficientVerification.invalidMessage, /assert failed pc=\d+/i)
const simulationFingerprint = insufficientVerification.invalidMessage.match(/pc=\d+/i)?.[0]
assert.ok(simulationFingerprint, 'simulation identified an application assertion PC')
const rollbackBefore = await gateCStateSnapshot()
let poolError
try {
  const response = await algod.sendRawTransaction(insufficientCoverage.signed).do()
  await wait(response.txId ?? response.txid)
} catch (error) { poolError = error }
assert.ok(poolError, 'insufficient capacity entered and was rejected by the transaction pool')
rejectedCount += 1
gateCRejectionCases.push('insufficient capacity')
const poolErrorText = JSON.stringify(poolError, Object.getOwnPropertyNames(poolError))
assert.match(poolErrorText, /reject|pool|assert|application/i)
assert.match(poolErrorText, /insufficient capacity|assert/i)
const poolFingerprint = poolErrorText.match(/failedAt[=: ]+\d+|pc[=: ]+\d+/i)?.[0]?.replace(/[=: ]+/, '=')
assert.ok(poolFingerprint, 'pool rejection identified an application assertion PC')
assert.equal(poolFingerprint, simulationFingerprint, 'simulation and pool identify the same application assertion/PC')
assert.deepEqual(await gateCStateSnapshot(), rollbackBefore, 'insufficient capacity atomically rolled back all Gate C state')

// Representative on-chain binding negatives. Each group is ABI-validly
// signed, but the application assertion must reject the whole group.
const rejectedSignedCoverage = async (signed, label) => {
  const applicationArgs = algosdk.decodeSignedTransaction(signed[2]).txn.applicationCall.appArgs
  const relevantBox = boxKey('c', applicationArgs[1])
  const before = await gateCStateSnapshot([relevantBox])
  let error
  try {
    const response = await algod.sendRawTransaction(signed).do()
    await wait(response.txId ?? response.txid)
  } catch (caught) { error = caught }
  assert.ok(error, `${label} unexpectedly succeeded`)
  rejectedCount += 1
  assert.match(String(error), /reject|pool|assert|overspend|balance|rekey|asset|application|incomplete|group/i, label)
  assert.deepEqual(await gateCStateSnapshot([relevantBox]), before, `${label} atomic rollback`)
  gateCRejectionCases.push(label)
}
const duplicateCoverage = await makeCoverageGroup({ coverageId: coverageId1, policy: policyIdGate3, gross: 40 })
await rejectedSignedCoverage(duplicateCoverage.signed, 'duplicate coverage id')
const wrongPayout = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(24), policy: policyIdGate3, gross: 40, transferReceiver: payerAddress })
await rejectedSignedCoverage(wrongPayout.signed, 'wrong payout')
const wrongAmount = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(25), policy: policyIdGate3, gross: 40, transferAmount: 40 })
await rejectedSignedCoverage(wrongAmount.signed, 'wrong provider amount')
const wrongCoverageAsset = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(38), policy: policyIdGate3, gross: 40, transferAsset: assetId + 1 })
await rejectedSignedCoverage(wrongCoverageAsset.signed, 'wrong coverage ASA')
const wrongSender = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(26), policy: policyIdGate3, gross: 40, transferSender: otherAddress, transferAmount: 39 })
await rejectedSignedCoverage(wrongSender.signed, 'wrong payer sender')
const reordered = [wrongAmount.group[1], wrongAmount.group[0], wrongAmount.group[2]]
reordered.forEach((txn) => { txn.group = undefined })
const wrongOrder = algosdk.assignGroupID(reordered).map((txn) => sign(txn, payer))
await rejectedSignedCoverage(wrongOrder, 'wrong group order')
const exactGroupBase = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(39), policy: policyIdGate3, gross: 40 })
const extraGroupPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payerAddress, receiver: payerAddress, amount: 0, suggestedParams: await params() })
const exactGroupTransactions = algosdk.assignGroupID([...exactGroupBase.group, extraGroupPayment])
await rejectedSignedCoverage(exactGroupTransactions.map((txn) => sign(txn, payer)), 'wrong exact group size')
const missingCoverageBox = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(27), policy: policyIdGate3, gross: 40, includeCoverageBox: false })
await rejectedSignedCoverage(missingCoverageBox.signed, 'missing coverage box reference')
const zeroHash = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(28), policy: policyIdGate3, gross: 40, requestHash: new Uint8Array(32) })
await rejectedSignedCoverage(zeroHash.signed, 'zero request hash')
const unsafeTransferAssetSender = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(29), policy: policyIdGate3, gross: 40, assetSender: otherAddress })
await rejectedSignedCoverage(unsafeTransferAssetSender.signed, 'unsafe transfer assetSender')
const unsafeTransferCloseTo = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(36), policy: policyIdGate3, gross: 40, transferCloseTo: otherAddress })
await rejectedSignedCoverage(unsafeTransferCloseTo.signed, 'unsafe transfer close-to')
const unsafeTransferRekey = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(37), policy: policyIdGate3, gross: 40, transferRekeyTo: otherAddress })
await rejectedSignedCoverage(unsafeTransferRekey.signed, 'unsafe transfer rekey')
const unsafeRekey = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(29), policy: policyIdGate3, gross: 40, appRekeyTo: otherAddress })
await rejectedSignedCoverage(unsafeRekey.signed, 'unsafe application rekey')
await call(payer, appArgs('setPaused(bool)', [true]))
await rejectedSignedCoverage((await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(30), policy: policyIdGate3, gross: 40 })).signed, 'paused coverage')
await call(payer, appArgs('setPaused(bool)', [false]))
await call(payer, appArgs('setPolicyStatus(byte[32],bool)', [policyIdGate3, false]), boxes(providerBox3, policyBoxGate3))
await rejectedSignedCoverage((await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(34), policy: policyIdGate3, gross: 40 })).signed, 'inactive policy coverage')
await call(payer, appArgs('setPolicyStatus(byte[32],bool)', [policyIdGate3, true]), boxes(providerBox3, policyBoxGate3))
await call(payer, appArgs('setProviderStatus(byte[32],bool)', [providerId3, false]), boxes(providerBox3))
await rejectedSignedCoverage((await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(35), policy: policyIdGate3, gross: 40 })).signed, 'inactive provider coverage')
await call(payer, appArgs('setProviderStatus(byte[32],bool)', [providerId3, true]), boxes(providerBox3))

// Gate D: lifecycle, refunds, and collateral-preserving rollback evidence.
const lifecycleArgs = (signature, values) => args(`${signature}void`, values)
const lifecycleTxn = async (sender, signature, values, refs, foreignAssets = [], fee = undefined, rekeyTo = undefined, accounts = []) => algosdk.makeApplicationNoOpTxnFromObject({
  sender: sender.addr.toString(),
  appIndex: appId,
  appArgs: lifecycleArgs(signature, values),
  boxes: refs,
  foreignAssets,
  accounts,
  rekeyTo,
  suggestedParams: await params(fee),
})
const errorText = (error) => JSON.stringify(error, Object.getOwnPropertyNames(error))
const simulationText = (response) => {
  const group = response['txn-groups']?.[0] ?? response.txnGroups?.[0] ?? {}
  const results = group['txn-results'] ?? group.txnResults ?? []
  return [group['failure-message'], group.failureMessage, ...results.flatMap((result) => [result['failure-message'], result.failureMessage])].filter(Boolean).join(' | ')
}
const assertionPc = (text) => text.match(/(?:assert failed|pc)[^\d]{0,32}(\d+)/i)?.[1]
const simulateLifecycle = async (signed) => {
  try {
    const response = await algod.simulateRawTransactions(signed).do()
    return { text: simulationText(response), response }
  } catch (error) {
    return { text: errorText(error), error }
  }
}
const rejectedLifecycle = async (sender, signature, values, refs, label, foreignAssets = [], fee = undefined, rekeyTo = undefined, accounts = [], extraBoxes = refs, classification = 'application', expected = /assert failed/i) => {
  const before = await gateDStateSnapshot(extraBoxes)
  const txn = await lifecycleTxn(sender, signature, values, refs, foreignAssets, fee, rekeyTo, accounts)
  const signed = sign(txn, sender)
  const simulation = await simulateLifecycle([signed])
  const appIndex = txn.applicationCall.appIndex
  assert.equal(Number(appIndex), appId, `${label} deployed app binding`)
  if (classification === 'application') {
    assert.match(simulation.text, expected, `${label} simulation classification`)
    const pc = assertionPc(simulation.text)
    assert.ok(pc, `${label} simulation assertion PC`)
    const poolError = await (async () => {
      try {
        const response = await algod.sendRawTransaction(signed).do()
        await wait(response.txId ?? response.txid)
      } catch (error) { return error }
      return undefined
    })()
    assert.ok(poolError, `${label} unexpectedly entered the pool`)
    const poolText = errorText(poolError)
    assert.match(poolText, expected, `${label} pool classification`)
    const poolPc = assertionPc(poolText)
    assert.equal(poolPc, pc, `${label} simulation and pool assertion PC`)
    gateDRejectionEvidence.push({ label, classification: 'application-assertion', applicationId: appId, simulationPc: Number(pc), poolPc: Number(poolPc) })
  } else {
    assert.match(simulation.text, expected, `${label} simulation pre-application classification`)
    const poolError = await (async () => {
      try {
        const response = await algod.sendRawTransaction(signed).do()
        await wait(response.txId ?? response.txid)
      } catch (error) { return error }
      return undefined
    })()
    assert.ok(poolError, `${label} unexpectedly entered the pool`)
    const poolText = errorText(poolError)
    assert.match(poolText, expected, `${label} pool pre-application classification`)
    gateDRejectionEvidence.push({ label, classification, simulationMessage: simulation.text, poolMessage: poolText })
  }
  rejectedCount += 1
  gateDRejectionCases.push(label)
  assert.deepEqual(await gateDStateSnapshot(extraBoxes), before, `${label} complete rollback`)
}
const gateDRejectionCases = []
const gateDRejectionEvidence = []
const finalizeSignature = 'finalizeClaim(byte[32],byte[32],bool,uint64,bool,uint64)'
const closeSignature = 'closeCoverage(byte[32])'
const withdrawSignature = 'withdrawStake(byte[32],uint64)'
const claimSignature = 'getClaim(byte[32])(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)'
const coverageSignature = 'getCoverage(byte[32])(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)'
const providerSignature = 'getProvider(byte[32])(address,address,byte[32],bool,uint64,uint64,uint64,uint64)'
const claimType = '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)'
const coverageType = '(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)'

const gateDApplicationFunding = await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: appAddress,
  amount: 300_000,
  suggestedParams: await params(),
}), payer)
const claimFundingAmount = 3 * 45_300
const claimFunding = await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: appAddress,
  amount: claimFundingAmount,
  suggestedParams: await params(),
}), payer)
await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: otherAddress,
  receiver: payerAddress,
  amount: 100_000,
  suggestedParams: await params(),
}), other)
await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: otherAddress,
  amount: 20_000,
  suggestedParams: await params(),
}), payer)
assert.ok(await payerAlgoBalance() > 1_133_500, `payer ALGO below ASA minimum after top-up: ${await payerAlgoBalance()}, other=${await algoBalance(otherAddress)}`)
assert.ok(await algoBalance(otherAddress) > 1_133_500, `adjudicator ALGO below ASA minimum after top-up: ${await algoBalance(otherAddress)}, payer=${await payerAlgoBalance()}`)
const claimMinBefore = await appMinBalance()
const claimMinDeltas = []
const recordClaimMbr = async (before) => {
  claimMinDeltas.push((await appMinBalance()) - before)
  assert.equal(claimMinDeltas.at(-1), 45_300, 'claim tombstone MBR delta')
}

await rejectedLifecycle(payer, withdrawSignature, [providerId3, 124], boxes(providerBox3), 'withdraw over total', [assetId], undefined, undefined, [], [providerBox3])
await rejectedLifecycle(payer, withdrawSignature, [providerId3, 39], boxes(providerBox3), 'withdraw across locked stake', [assetId], undefined, undefined, [], [providerBox3])
await rejectedLifecycle(payer, withdrawSignature, [providerId3, 23], boxes(providerBox3), 'withdraw below protocol fee', [assetId], 0, undefined, [], [providerBox3], 'application', /assert failed/i)
await rejectedLifecycle(other, withdrawSignature, [providerId3, 1], boxes(providerBox3), 'withdraw wrong owner', [assetId], undefined, undefined, [], [providerBox3])
await rejectedLifecycle(payer, withdrawSignature, [new Uint8Array(32), 1], boxes(boxKey('p', new Uint8Array(32))), 'withdraw zero provider id', [assetId], undefined, undefined, [], [boxKey('p', new Uint8Array(32))])
await rejectedLifecycle(payer, withdrawSignature, [providerId3, 0], boxes(providerBox3), 'withdraw zero amount', [assetId], undefined, undefined, [], [providerBox3])

await call(payer, appArgs('setPaused(bool)', [true]))
await rejectedLifecycle(payer, withdrawSignature, [providerId3, 1], boxes(providerBox3), 'withdraw while paused', [assetId], undefined, undefined, [], [providerBox3])
const rejectedClaim = await call(
  other,
  lifecycleArgs(finalizeSignature, [claimId1, coverageId1, false, 0, false, 1]),
  boxes(claimBox1, coverageBox1, providerBox3),
  [],
  undefined,
  undefined,
)
checkEvent(rejectedClaim.pending, 'ClaimFinalized(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)', '(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)', [1n, decodedBytes(claimId1), decodedBytes(coverageId1), false, 0n, false, 1n, decodeEvent(rejectedClaim.pending, 'ClaimFinalized(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)', '(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)')[7]])
const rejectedClaimResolvedAt = decodeEvent(rejectedClaim.pending, 'ClaimFinalized(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)', '(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)')[7]
checkEvent(rejectedClaim.pending, 'CoverageClosed(uint64,byte[32],uint64,bool)', '(uint64,byte[32],uint64,bool)', [1n, decodedBytes(coverageId1), rejectedClaimResolvedAt, false], 1)
assert.deepEqual(await claimState(claimId1, claimBox1), [decodedBytes(coverageId1), false, 0n, false, 1n, 0n, 0n, rejectedClaimResolvedAt])
await recordClaimMbr(claimMinBefore)
const rejectedCoverage = await call(payer, [algosdk.ABIMethod.fromSignature(coverageSignature).getSelector(), coverageId1], boxes(coverageBox1))
const rejectedCoverageRecord = algosdk.ABIType.from(coverageType).decode(logBytes(rejectedCoverage.pending).subarray(4))
assert.deepEqual([rejectedCoverageRecord[11], rejectedCoverageRecord[12]], [3n, true], 'rejected claim closes and releases')
await call(payer, appArgs('setPaused(bool)', [false]))

await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: otherAddress,
  amount: 200_000,
  suggestedParams: await params(),
}), payer)
assert.ok(await payerAlgoBalance() > 1_133_500, `payer ALGO below ASA minimum before pool coverage: ${await payerAlgoBalance()}`)
assert.ok(await algoBalance(otherAddress) > 1_133_500, `adjudicator ALGO below ASA minimum before pool coverage: ${await algoBalance(otherAddress)}`)

const poolCoverage = await makeCoverageGroup({ coverageId: coverageId3, policy: policyIdGate3, gross: 40, requestHash: new Uint8Array(32).fill(44) })
const poolResult = await submitViaCore(poolCoverage)
await wait(poolCoverage.group[2].txID())
const claim2MinBefore = await appMinBalance()
const poolPayerAssetBefore = await asaBalance(payerAddress)
const poolApplicationAssetBefore = await appAssetBalance()
const poolProviderBefore = await call(payer, [algosdk.ABIMethod.fromSignature(providerSignature).getSelector(), providerId3], boxes(providerBox3))
const poolProviderBytesBefore = logBytes(poolProviderBefore.pending)
const poolClaim = await call(
  other,
  lifecycleArgs(finalizeSignature, [claimId2, coverageId3, true, 1, false, 2]),
  boxes(claimBox2, coverageBox3, providerBox3),
  [assetId],
  2_000,
  undefined,
  [payerAddress],
)
assert.equal(poolClaim.pending.logs.length, 2, 'pool-only claim emits only finalization and refund')
const poolClaimEvent = decodeEvent(poolClaim.pending, 'ClaimFinalized(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)', '(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)')
assert.deepEqual(poolClaimEvent.slice(0, 7), [1n, decodedBytes(claimId2), decodedBytes(coverageId3), true, 1n, false, 2n])
checkEvent(poolClaim.pending, 'RefundPaid(uint64,byte[32],byte[32],address,uint64)', '(uint64,byte[32],byte[32],address,uint64)', [1n, decodedBytes(claimId2), decodedBytes(coverageId3), payerAddress, 1n], 1)
assert.equal(await asaBalance(payerAddress), poolPayerAssetBefore + 1, 'pool-only refund pays stored payer exactly')
assert.equal(await appAssetBalance(), poolApplicationAssetBefore - 1, 'pool-only debit changes application ASA exactly')
const poolProviderAfter = await call(payer, [algosdk.ABIMethod.fromSignature(providerSignature).getSelector(), providerId3], boxes(providerBox3))
const poolProviderRecordBefore = algosdk.ABIType.from('(address,address,byte[32],bool,uint64,uint64,uint64,uint64)').decode(poolProviderBytesBefore.subarray(4))
const poolProviderRecordAfter = algosdk.ABIType.from('(address,address,byte[32],bool,uint64,uint64,uint64,uint64)').decode(logBytes(poolProviderAfter.pending).subarray(4))
assert.deepEqual(poolProviderRecordAfter.slice(0, 5), poolProviderRecordBefore.slice(0, 5), 'pool-only refund leaves provider stake total record unchanged')
assert.deepEqual(poolProviderRecordAfter.slice(5, 7), [75n, 100n], 'pool-only refund releases only its own lock and exposure')
assert.deepEqual(await claimState(claimId2, claimBox2), [decodedBytes(coverageId3), true, 1n, false, 2n, 0n, 1n, poolClaimEvent[7]])
await recordClaimMbr(claim2MinBefore)

const faultCoverage = await makeCoverageGroup({ coverageId: coverageId4, policy: policyIdGate5, premiumBps: 10_000, gross: 100, requestHash: new Uint8Array(32).fill(45) })
const faultResult = await submitViaCore(faultCoverage)
await wait(faultCoverage.group[2].txID())
const claim3MinBefore = await appMinBalance()
const providerBeforeFault = await call(payer, [algosdk.ABIMethod.fromSignature(providerSignature).getSelector(), providerId2], boxes(providerBox2))
const provider2BeforeFault = logBytes(providerBeforeFault.pending)
const beforeOwnerAsset = await asaBalance(payerAddress)
const beforeProvider3Record = await call(payer, [algosdk.ABIMethod.fromSignature(providerSignature).getSelector(), providerId3], boxes(providerBox3))
const beforeProvider3 = logBytes(beforeProvider3Record.pending)
await rejectedLifecycle(payer, withdrawSignature, [providerId3, 23], boxes(providerBox3), 'insufficient withdrawal fee', [assetId], 1_000, undefined, [], [providerBox3], 'application', /outer fee must pool inner fee|assert failed/i)
const withdraw = await call(payer, lifecycleArgs(withdrawSignature, [providerId3, 23]), boxes(providerBox3), [assetId], 2_000)
checkEvent(withdraw.pending, 'StakeWithdrawn(uint64,byte[32],uint64,uint64)', '(uint64,byte[32],uint64,uint64)', [1n, decodedBytes(providerId3), 23n, 100n])
assert.equal(await asaBalance(payerAddress), beforeOwnerAsset + 23, 'withdraw transfers exact ASA to stored owner')
const faultClaim = await call(
  other,
  lifecycleArgs(finalizeSignature, [claimId3, coverageId4, true, 100, true, 3]),
  boxes(claimBox3, coverageBox4, providerBox3),
  [assetId],
  2_000,
  undefined,
  [payerAddress],
)
const faultClaimEvent = decodeEvent(faultClaim.pending, 'ClaimFinalized(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)', '(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)')
assert.deepEqual(faultClaimEvent.slice(0, 7), [1n, decodedBytes(claimId3), decodedBytes(coverageId4), true, 100n, true, 3n])
checkEvent(faultClaim.pending, 'RefundPaid(uint64,byte[32],byte[32],address,uint64)', '(uint64,byte[32],byte[32],address,uint64)', [1n, decodedBytes(claimId3), decodedBytes(coverageId4), payerAddress, 100n], 1)
assert.deepEqual(await claimState(claimId3, claimBox3), [decodedBytes(coverageId4), true, 100n, true, 3n, 25n, 75n, faultClaimEvent[7]])
await recordClaimMbr(claim3MinBefore)
const providerAfterFault = await call(payer, [algosdk.ABIMethod.fromSignature(providerSignature).getSelector(), providerId3], boxes(providerBox3))
const providerAfterFaultRecord = algosdk.ABIType.from(providerSignature.replace('getProvider(byte[32])', '')).decode(logBytes(providerAfterFault.pending).subarray(4))
assert.deepEqual(providerAfterFaultRecord.slice(4, 7), [75n, 75n, 100n], 'fault waterfall preserves other open coverage')
const provider2AfterFault = await call(payer, [algosdk.ABIMethod.fromSignature(providerSignature).getSelector(), providerId2], boxes(providerBox2))
assert.deepEqual(logBytes(provider2AfterFault.pending), provider2BeforeFault, 'other provider record unchanged')
assert.equal(await asaBalance(payerAddress), beforeOwnerAsset + 123, 'refunds use stored payer and exact amount')

await rejectedLifecycle(payer, finalizeSignature, [claimId2, coverageId2, true, 1, false, 4], boxes(claimBox2, coverageBox2, providerBox3), 'duplicate claim', [assetId], 2_000, undefined, [payerAddress])
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(54), coverageId2, false, 1, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(54)), coverageBox2, providerBox3), 'invalid rejected amount')
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(55), coverageId2, true, 101, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(55)), coverageBox2, providerBox3), 'claim above gross')
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(56), coverageId2, true, 1, false, 0], boxes(boxKey('f', new Uint8Array(32).fill(56)), coverageBox2, providerBox3), 'zero resolution')
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(57), coverageId2, true, 1, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(57)), coverageBox2, providerBox3), 'insufficient claim fee', [assetId], 1_000, undefined, [payerAddress])
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(58), coverageId2, true, 29, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(58)), coverageBox2, providerBox3), 'insufficient reserve', [assetId], 2_000, undefined, [payerAddress])
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(59), coverageId2, false, 0, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(59)), coverageBox2), 'missing provider resource', [], undefined, undefined, [], [boxKey('f', new Uint8Array(32).fill(59)), coverageBox2], 'application', /assert failed/i)
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(63), coverageId2, true, 1, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(63)), coverageBox2, providerBox3), 'missing asset resource', [], 2_000, undefined, [payerAddress], [boxKey('f', new Uint8Array(32).fill(63)), coverageBox2, providerBox3], 'application', /assert failed/i)
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32), coverageId2, false, 0, false, 4], boxes(boxKey('f', new Uint8Array(32)), coverageBox2, providerBox3), 'zero claim id', [], undefined, undefined, [], [boxKey('f', new Uint8Array(32)), coverageBox2, providerBox3])
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(64), new Uint8Array(32), false, 0, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(64)), boxKey('c', new Uint8Array(32)), providerBox3), 'zero coverage id', [], undefined, undefined, [], [boxKey('f', new Uint8Array(32).fill(64)), boxKey('c', new Uint8Array(32)), providerBox3])
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(65), coverageId2, true, 0, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(65)), coverageBox2, providerBox3), 'approved zero amount', [], undefined, undefined, [payerAddress])
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(66), coverageId2, false, 0, true, 4], boxes(boxKey('f', new Uint8Array(32).fill(66)), coverageBox2, providerBox3), 'rejected provider fault', [], undefined, undefined, [payerAddress])
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(60), coverageId2, false, 0, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(60)), coverageBox2, providerBox3), 'unsafe claim rekey', [], undefined, otherAddress)
await rejectedLifecycle(payer, finalizeSignature, [new Uint8Array(32).fill(61), coverageId2, false, 0, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(61)), coverageBox2, providerBox3), 'non-adjudicator claim')

const clawback = await algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: payerAddress,
  receiver: payerAddress,
  assetSender: appAddress,
  amount: 1,
  assetIndex: assetId,
  suggestedParams: await params(),
})
await send(clawback, payer)
await rejectedLifecycle(other, finalizeSignature, [new Uint8Array(32).fill(62), coverageId2, true, 1, false, 4], boxes(boxKey('f', new Uint8Array(32).fill(62)), coverageBox2, providerBox3), 'insufficient actual balance', [assetId], 2_000, undefined, [payerAddress])
const restore = await algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payerAddress, receiver: appAddress, amount: 1, assetIndex: assetId, suggestedParams: await params() })
await send(restore, payer)

const deposit5 = await makeDepositGroup({ provider: providerId2, amount: 10 })
const signedDeposit5 = algosdk.assignGroupID(deposit5).map((txn) => sign(txn, payer))
await algod.sendRawTransaction(signedDeposit5).do()
await wait(deposit5[1].txID())
const shortCoverage = await makeCoverageGroup({ coverageId: coverageId5, provider: providerId2, providerPayout: payerAddress, policy: policyIdGate6, premiumBps: 250, gross: 10, requestHash: new Uint8Array(32).fill(46) })
const shortResult = await submitViaCore(shortCoverage)
await wait(shortCoverage.group[2].txID())
const shortOpened = decodeEvent(await wait(shortCoverage.group[2].txID()), 'CoverageOpened(uint64,byte[32],byte[32],byte[32],address,uint64,uint64,uint64,byte[32],uint64,uint64)', '(uint64,byte[32],byte[32],byte[32],address,uint64,uint64,uint64,byte[32],uint64,uint64)')
await rejectedLifecycle(other, closeSignature, [coverageId5], boxes(providerBox2, coverageBox5), 'early expiry close', [], undefined, undefined, [], [providerBox2, coverageBox5])
await rejectedLifecycle(other, closeSignature, [coverageId5], boxes(coverageBox5), 'missing close provider resource', [], undefined, undefined, [], [coverageBox5], 'application', /assert failed/i)
await rejectedLifecycle(other, closeSignature, [coverageId5], boxes(providerBox2, coverageBox5), 'unsafe close rekey', [], undefined, otherAddress, [], [providerBox2, coverageBox5])
const latestBlockTimestamp = async () => {
  const status = await algod.status().do()
  return Number((await algod.block(status.lastRound).do()).block.header.timestamp)
}
const advanceTo = async (target) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await latestBlockTimestamp() >= Number(target)) return
    await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payerAddress, receiver: payerAddress, amount: 0, suggestedParams: await params() }), payer)
  }
  assert.fail(`LocalNet timestamp did not reach ${target} in bounded advancement (current ${await latestBlockTimestamp()})`)
}
await advanceTo(shortOpened[10])
await call(payer, appArgs('setPaused(bool)', [true]))
const shortClosed = await call(other, lifecycleArgs(closeSignature, [coverageId5]), boxes(providerBox2, coverageBox5))
const shortClosedEvent = decodeEvent(shortClosed.pending, 'CoverageClosed(uint64,byte[32],uint64,bool)', '(uint64,byte[32],uint64,bool)')
assert.deepEqual(shortClosedEvent.slice(0, 2), [1n, decodedBytes(coverageId5)])
assert.equal(shortClosedEvent[3], true)
await rejectedLifecycle(other, closeSignature, [coverageId5], boxes(providerBox2, coverageBox5), 'duplicate expiry close', [], undefined, undefined, [], [providerBox2, coverageBox5])
await call(payer, appArgs('setPaused(bool)', [false]))
const fullWithdrawal = await call(payer, lifecycleArgs(withdrawSignature, [providerId2, 10]), boxes(providerBox2), [assetId], 2_000)
checkEvent(fullWithdrawal.pending, 'StakeWithdrawn(uint64,byte[32],uint64,uint64)', '(uint64,byte[32],uint64,uint64)', [1n, decodedBytes(providerId2), 10n, 0n])
assert.equal(await readCapacity(providerId2, policyIdGate6, boxes(providerBox2, policyBoxGate6)), 0n)
const zeroCapacityCoverage = await makeCoverageGroup({ coverageId: new Uint8Array(32).fill(47), provider: providerId2, providerPayout: payerAddress, policy: policyIdGate6, premiumBps: 250, gross: 1, requestHash: new Uint8Array(32).fill(48) })
const zeroCapacityPayload = { x402Version: 2, accepted: zeroCapacityCoverage.requirements, payload: { paymentGroup: zeroCapacityCoverage.signed.map((item) => Buffer.from(item).toString('base64')), providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
const zeroCapacityVerification = await rejectionCore.verify(zeroCapacityPayload, zeroCapacityCoverage.requirements)
assert.equal(zeroCapacityVerification.isValid, false)
assert.equal(zeroCapacityVerification.invalidReason, 'simulation')
const zeroCapacitySimulationPc = assertionPc(zeroCapacityVerification.invalidMessage)
assert.ok(zeroCapacitySimulationPc, 'zero-capacity simulation assertion PC')
assert.equal(Number(zeroCapacityCoverage.group[2].applicationCall.appIndex), appId, 'zero-capacity simulation app binding')
assert.equal(zeroCapacityCoverage.requirements.extra.applicationId, String(appId), 'zero-capacity metadata app binding')
const zeroCapacityBefore = await gateDStateSnapshot([boxKey('c', zeroCapacityCoverage.requirements.extra.coverageId)])
let zeroCapacityPoolError
try { const response = await algod.sendRawTransaction(zeroCapacityCoverage.signed).do(); await wait(response.txId ?? response.txid) } catch (error) { zeroCapacityPoolError = error }
assert.ok(zeroCapacityPoolError, 'zero-capacity group rejected by LocalNet pool')
rejectedCount += 1
const zeroCapacityPoolText = errorText(zeroCapacityPoolError)
assert.match(zeroCapacityPoolText, /assert failed|application/i)
assert.equal(assertionPc(zeroCapacityPoolText), zeroCapacitySimulationPc, 'zero-capacity simulation and pool assertion PC')
assert.deepEqual(await gateDStateSnapshot([boxKey('c', zeroCapacityCoverage.requirements.extra.coverageId)]), zeroCapacityBefore, 'zero-capacity group rollback')

const finalAccounting = await applicationState(appId)
const providerType = '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)'
const readProviderRecord = async (id, ref) => {
  const read = await call(payer, [algosdk.ABIMethod.fromSignature(providerSignature).getSelector(), id], boxes(ref))
  return algosdk.ABIType.from(providerType).decode(logBytes(read.pending).subarray(4))
}
const finalProvider1 = await readProviderRecord(providerId, providerBox)
const finalProvider2 = await readProviderRecord(providerId2, providerBox2)
const finalProvider3 = await readProviderRecord(providerId3, providerBox3)
assert.deepEqual(finalProvider1.slice(4, 7), [123n, 0n, 0n])
assert.deepEqual(finalProvider2.slice(4, 7), [0n, 0n, 0n])
assert.deepEqual(finalProvider3.slice(4, 7), [75n, 75n, 100n])
const finalCoverage1 = await coverageState(coverageId1, coverageBox1)
const finalCoverage2 = await coverageState(coverageId2, coverageBox2)
const finalCoverage3 = await coverageState(coverageId3, coverageBox3)
const finalCoverage4 = await coverageState(coverageId4, coverageBox4)
const finalCoverage5 = await coverageState(coverageId5, coverageBox5)
assert.deepEqual([finalCoverage1[11], finalCoverage1[12]], [3n, true])
assert.deepEqual([finalCoverage2[11], finalCoverage2[12]], [1n, false])
assert.deepEqual([finalCoverage3[11], finalCoverage3[12]], [2n, true])
assert.deepEqual([finalCoverage4[11], finalCoverage4[12]], [2n, true])
assert.deepEqual([finalCoverage5[11], finalCoverage5[12]], [3n, true])
assert.equal(decodeStateUInt(finalAccounting, 'totalProviderStake'), Number(finalProvider1[4] + finalProvider2[4] + finalProvider3[4]))
assert.equal(decodeStateUInt(finalAccounting, 'totalOpenFaultExposure'), Number(finalProvider1[6] + finalProvider2[6] + finalProvider3[6]))
assert.equal(decodeStateUInt(finalAccounting, 'totalProviderStake'), 198)
assert.equal(decodeStateUInt(finalAccounting, 'premiumReserve'), 29)
assert.equal(decodeStateUInt(finalAccounting, 'totalOpenFaultExposure'), 100)
assert.equal(decodeStateUInt(finalAccounting, 'totalProviderStake') + decodeStateUInt(finalAccounting, 'premiumReserve'), await appAssetBalance(), 'tracked stake and premium reserve equal actual ASA balance')
assert.equal(await appMinBalance(), minAfterOptIn + 3 * 67_300 + 6 * 44_900 + 5 * 92_900 + 3 * 45_300, 'Gate D tombstone MBR')
const genesis = JSON.parse(await algod.genesis().do())

console.log(JSON.stringify({
  network: 'LocalNet',
  genesisId: `${genesis.network}-${genesis.id}`,
  lastRound: Number((await algod.status().do()).lastRound),
  assetId,
  appId,
  appAddress,
  approvalProgramBytes,
  extraPages: approvalExtraPages,
  appMinBalance: await appMinBalance(),
  appBalance: await appBalance(),
  appAssetBalance: await appAssetBalance(),
  oneProviderTwoPolicyMinBalance: minAfterOptIn + 67_300 + 2 * 44_900,
  providerId: Buffer.from(providerId).toString('hex'),
  policyIds: [Buffer.from(policyId1).toString('hex'), Buffer.from(policyId2).toString('hex')],
  stakeAmount: depositAmount,
  totalProviderStake: decodeStateUInt(finalAccounting, 'totalProviderStake'),
  capacityPolicy1: Number(capacity1),
  capacityPolicy2: Number(capacity2),
  rejectedCases: rejectedCount,
  creationTxId: created.txid,
  configReadTxId: configRead.txid,
  accountingReadTxId: accountingRead.txid,
  optInTxId: optedIn.txid,
  providerRegisteredTxId: registered.txid,
  policyCreatedTxIds: [policy1Created.txid, policy2Created.txid],
  pauseTxId: paused.txid,
  unpauseTxId: unpaused.txid,
  policyStatusTxIds: [policyOff.txid, policyOn.txid],
  providerStatusTxIds: [deactivated.txid, reactivated.txid],
  depositApplicationTxId: depositCall.txID(),
  app2Id,
  gateD: {
    applicationFundingTxId: gateDApplicationFunding.txid,
    claimFundingTxId: claimFunding.txid,
    claimBoxMbrEach: 45_300,
    claimBoxMbrDeltas: claimMinDeltas,
    claimIds: [Buffer.from(claimId1).toString('hex'), Buffer.from(claimId2).toString('hex'), Buffer.from(claimId3).toString('hex')],
    rejectedClaimTxId: rejectedClaim.txid,
    poolCoverageId: Buffer.from(coverageId3).toString('hex'),
    poolClaimTxId: poolClaim.txid,
    poolSettlementTxId: poolResult.settlement.transaction,
    poolWaterfall: { stakeDebit: 0, poolDebit: 1, refund: 1, storedPayer: payerAddress },
    faultCoverageId: Buffer.from(coverageId4).toString('hex'),
    faultClaimTxId: faultClaim.txid,
    faultSettlementTxId: faultResult.settlement.transaction,
    faultWaterfall: { stakeDebit: 25, poolDebit: 75, approvedAmount: 100, storedPayer: payerAddress },
    stakeWithdrawalTxId: withdraw.txid,
    stakeWithdrawal: { providerId: Buffer.from(providerId3).toString('hex'), amount: 23, newProviderStake: 100, owner: payerAddress, ownerAssetDelta: 23 },
    closeTxId: shortClosed.txid,
    closeTimestamp: shortClosedEvent[2].toString(),
    expiry: { openedAt: shortOpened[9].toString(), expiresAt: shortOpened[10].toString(), boundedAdvancement: true, pausedClose: true, duplicateRejected: true },
    fullWithdrawalTxId: fullWithdrawal.txid,
    zeroCapacity: { providerId: Buffer.from(providerId2).toString('hex'), applicationId: appId, fullWithdrawal: 10, remainingCapacity: 0, simulationReason: zeroCapacityVerification.invalidReason, simulationAssertionPc: `pc=${zeroCapacitySimulationPc}`, poolAssertionPc: `pc=${assertionPc(zeroCapacityPoolText)}`, actualPoolRollback: true },
    rejectionCases: gateDRejectionCases,
    rejectionClassification: {
      applicationAssertion: { count: gateDRejectionEvidence.filter((item) => item.classification === 'application-assertion').length, applicationId: appId, assertionPcs: [...new Set(gateDRejectionEvidence.filter((item) => item.classification === 'application-assertion').map((item) => item.simulationPc))] },
      preApplication: gateDRejectionEvidence.filter((item) => item.classification !== 'application-assertion').map(({ label, classification, simulationMessage, poolMessage }) => ({ label, classification, simulationMessage, poolMessage })),
    },
    finalAccounting: { totalProviderStake: 198, premiumReserve: 29, totalOpenFaultExposure: 100, actualApplicationAsset: await appAssetBalance() },
    invariants: { providerLockBounds: true, providerLockSums: true, providerExposureSums: true, globalStakeSum: true, globalExposureSum: true, assetLiabilityBound: true, terminalReleaseFlags: true, permanentIds: true, debitConservation: true, storedPayerRefunds: true },
  },
  gateC: {
    providerId: Buffer.from(providerId3).toString('hex'),
    policyIds: [Buffer.from(policyIdGate3).toString('hex'), Buffer.from(policyIdGate4).toString('hex')],
    coverageIds: [Buffer.from(coverageId1).toString('hex'), Buffer.from(coverageId2).toString('hex')],
    coverageBoxMbrDelta: 92_900,
    coverageBoxMbrTotalDelta: 185_800,
    coverageMbrFundingTxId: coverageMbrFunding.txid,
    firstGross: 40,
    firstProviderNet: 39,
    firstPremium: 1,
    firstLockedStake: 10,
    secondGross: 100,
    secondProviderNet: 98,
    secondPremium: 2,
    secondLockedStake: 75,
    mixedPolicyLockedStake: 85,
    providerStake: 123,
    providerLockedStake: 85,
    providerExposure: 140,
    globalExposure: 140,
    premiumReserve: 3,
    capacityPolicy3: Number(capacityAfterFirst),
    capacityPolicy4: Number(capacityAfterSecond),
    firstSettlementTxId: firstResult.settlement.transaction,
    secondSettlementTxId: secondResult.settlement.transaction,
    firstTransactionIds: firstCoverage.group.map((txn) => txn.txID()),
    secondTransactionIds: secondCoverage.group.map((txn) => txn.txID()),
    firstGroupId: firstResult.settlement.groupId,
    secondGroupId: secondResult.settlement.groupId,
    insufficientCapacity: { simulationReason: insufficientVerification.invalidReason, simulationAssertionPc: simulationFingerprint, poolAssertionPc: poolFingerprint, facilitatorSubmissions: simulationSubmissions, actualPoolRollback: true },
    rejectionCases: gateCRejectionCases.length,
  },
  evidence: 'provider/policy/pause/status/deposit and CoverageOpened events/reads decoded; Gate C x402 simulation and actual-pool rollback passed',
}, null, 2))
