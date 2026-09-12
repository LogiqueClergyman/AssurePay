import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import algosdk from 'algosdk'

const root = path.resolve(import.meta.dirname, '..')
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'AssuranceCore.arc32.json'), 'utf8'))
const compiled = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'AssuranceCore.arc56.json'), 'utf8'))
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
const rejected = async (txn, account, label) => {
  let error
  try {
    const { txid } = await algod.sendRawTransaction(sign(txn, account)).do()
    await wait(txid)
  } catch (caught) {
    error = caught
  }
  if (error) {
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
const checkEvent = (pending, signature, type, values) => {
  const log = logBytes(pending)
  const prefix = requireHash(signature)
  assert.deepEqual([...log.subarray(0, 4)], [...prefix], `${signature} prefix`)
  assert.deepEqual(algosdk.ABIType.from(type).decode(log.subarray(4)), values, `${signature} fields`)
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
  suggestedParams: await params(),
})
const app2 = await send(app2Create, payer)
const app2Id = Number(pendingField(app2.pending, 'application-index', 'applicationIndex'))
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
  amount: 300_000,
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

console.log(JSON.stringify({
  network: 'LocalNet',
  genesisId: (await algod.genesis().do()).genesisId,
  lastRound: Number((await algod.status().do()).lastRound),
  assetId,
  appId,
  appAddress,
  appMinBalance: Number(holdings.minBalance),
  creationTxId: created.txid,
  configReadTxId: configRead.txid,
  accountingReadTxId: accountingRead.txid,
  optInTxId: optedIn.txid,
  app2Id,
  evidence: 'creation and ASA opt-in confirmed; rejection paths left state unchanged',
}, null, 2))
