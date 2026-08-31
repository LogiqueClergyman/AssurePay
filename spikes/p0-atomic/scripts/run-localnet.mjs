import { readFile } from 'node:fs/promises'
import algosdk from 'algosdk'
import { x402Facilitator } from '@x402/core/facilitator'
import { AssuredExactAvmScheme, buildAssuredExactPayload } from '../src/assured-exact.mjs'

const TOKEN = 'a'.repeat(64)
const algod = new algosdk.Algodv2(TOKEN, 'http://localhost', 4001)
const kmd = new algosdk.Kmd(TOKEN, 'http://localhost', 4002)
const LOCALNET = 'algorand:localnet'
const OPEN_COVERAGE = new algosdk.ABIMethod({ name: 'openCoverage', args: [{ type: 'uint64' }, { type: 'uint64' }, { type: 'byte[]' }, { type: 'bool' }], returns: { type: 'void' } })
const OPT_IN_ASSET = new algosdk.ABIMethod({ name: 'optInAsset', args: [{ type: 'uint64' }], returns: { type: 'void' } })

async function submit(txns, signer) {
  const signed = txns.map((txn) => txn.signTxn(signer.sk))
  const txId = txns[0].txID()
  await algod.sendRawTransaction(signed).do()
  return { txId, pending: await algosdk.waitForConfirmation(algod, txId, 10) }
}

async function localAccount() {
  const wallet = (await kmd.listWallets()).wallets.find((item) => item.name === 'unencrypted-default-wallet')
  if (!wallet) throw new Error('LocalNet unencrypted-default-wallet is unavailable')
  const handle = (await kmd.initWalletHandle(wallet.id, '')).wallet_handle_token
  const address = (await kmd.listKeys(handle)).addresses[0]
  const secretKey = (await kmd.exportKey(handle, '', address)).private_key
  return { addr: algosdk.decodeAddress(address), sk: secretKey }
}

async function fund(faucet, receiver, amount) {
  const params = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: faucet.addr, receiver, amount, suggestedParams: params })
  return submit([txn], faucet)
}

async function balances(addresses, assetId) {
  return Object.fromEntries(await Promise.all(Object.entries(addresses).map(async ([role, address]) => {
    const account = await algod.accountInformation(address).do()
    let asset = 0n
    try { asset = (await algod.accountAssetInformation(address, assetId).do()).assetHolding.amount } catch { /* intentionally absent before opt-in */ }
    return [role, { address: String(address), microAlgos: account.amount, asset }]
  })))
}

async function marker(appId) {
  const state = (await algod.getApplicationByID(appId).do()).params.globalState ?? []
  const opened = state.find((entry) => Buffer.from(entry.key, 'base64').toString() === 'opened')
  return opened?.value.uint ?? 0n
}

function rejectionPayload({ payer, provider, application, assetId, appId, params }) {
  const providerNet = 93n, premium = 7n, commitment = new Uint8Array(32).fill(9)
  const appArgs = [OPEN_COVERAGE.getSelector(), algosdk.ABIType.from('uint64').encode(providerNet + premium), algosdk.ABIType.from('uint64').encode(premium), algosdk.ABIType.from('byte[]').encode(commitment), algosdk.ABIType.from('bool').encode(true)]
  const txns = [
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: provider, assetIndex: assetId, amount: providerNet, suggestedParams: params }),
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: application, assetIndex: assetId, amount: premium, suggestedParams: params }),
    algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.addr, appIndex: appId, appArgs, suggestedParams: params }),
  ]
  algosdk.assignGroupID(txns)
  return txns
}

async function main() {
  const faucet = await localAccount()
  const payer = algosdk.generateAccount(), provider = algosdk.generateAccount()
  const funding = await Promise.all([fund(faucet, payer.addr, 5_000_000), fund(faucet, provider.addr, 1_000_000)])
  const params = await algod.getTransactionParams().do()
  const assetCreate = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({ sender: faucet.addr, total: 1_000_000n, decimals: 0, defaultFrozen: false, manager: faucet.addr, reserve: faucet.addr, freeze: faucet.addr, clawback: faucet.addr, unitName: 'P0ASA', assetName: 'AssurePay P0', suggestedParams: params })
  const assetCreateResult = await submit([assetCreate], faucet)
  const assetId = assetCreateResult.pending.assetIndex
  if (!assetId) throw new Error('LocalNet asset creation did not return an asset index')

  const artifact = JSON.parse(await readFile(new URL('../artifacts/AssuranceCoreSpike.arc56.json', import.meta.url), 'utf8'))
  const approval = (await algod.compile(Buffer.from(artifact.source.approval, 'base64').toString()).do()).result
  const clear = (await algod.compile(Buffer.from(artifact.source.clear, 'base64').toString()).do()).result
  const createArgs = [new algosdk.ABIMethod({ name: 'create', args: [{ type: 'uint64' }, { type: 'address' }], returns: { type: 'void' } }).getSelector(), algosdk.ABIType.from('uint64').encode(assetId), algosdk.ABIType.from('address').encode(provider.addr.publicKey)]
  const create = algosdk.makeApplicationCreateTxnFromObject({ sender: faucet.addr, onComplete: algosdk.OnApplicationComplete.NoOpOC, approvalProgram: new Uint8Array(Buffer.from(approval, 'base64')), clearProgram: new Uint8Array(Buffer.from(clear, 'base64')), numGlobalInts: 2, numGlobalByteSlices: 1, numLocalInts: 0, numLocalByteSlices: 0, appArgs: createArgs, suggestedParams: await algod.getTransactionParams().do() })
  const createResult = await submit([create], faucet)
  const appId = createResult.pending.applicationIndex
  if (!appId) throw new Error('LocalNet app creation did not return an application index')
  const application = algosdk.getApplicationAddress(appId)

  const optInPayer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: payer.addr, assetIndex: assetId, amount: 0, suggestedParams: await algod.getTransactionParams().do() })
  const optInProvider = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: provider.addr, receiver: provider.addr, assetIndex: assetId, amount: 0, suggestedParams: await algod.getTransactionParams().do() })
  const distribute = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: faucet.addr, receiver: payer.addr, assetIndex: assetId, amount: 1_000n, suggestedParams: await algod.getTransactionParams().do() })
  const payerOptIn = await submit([optInPayer], payer)
  const providerOptIn = await submit([optInProvider], provider)
  const distribution = await submit([distribute], faucet)
  const appFunding = await fund(faucet, application, 300_000)
  const appOptIn = algosdk.makeApplicationNoOpTxnFromObject({ sender: faucet.addr, appIndex: appId, appArgs: [OPT_IN_ASSET.getSelector(), algosdk.ABIType.from('uint64').encode(assetId)], foreignAssets: [assetId], suggestedParams: { ...(await algod.getTransactionParams().do()), fee: 2_000n, flatFee: true } })
  const appOptInResult = await submit([appOptIn], faucet)

  const accounts = { payer: payer.addr, provider: provider.addr, application }
  const beforeSuccess = await balances(accounts, assetId)
  const markerBeforeSuccess = await marker(appId)
  const signer = {
    getAddresses: () => [faucet.addr.toString()],
    simulateTransactions: async (group) => algod.simulateRawTransactions(group).do(),
    sendTransactions: async (group) => algod.sendRawTransaction(group).do(),
    waitForConfirmation: async (txId) => algosdk.waitForConfirmation(algod, txId, 10),
  }
  const built = buildAssuredExactPayload({ payer, provider: provider.addr, application, assetId, providerNet: 93n, premium: 7n, applicationId: appId, commitment: new Uint8Array(32).fill(7), params: await algod.getTransactionParams().do() })
  const requirements = { ...built.requirements, network: LOCALNET, maxTimeoutSeconds: 60 }
  const payload = { x402Version: 2, accepted: requirements, payload: { paymentGroup: built.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const successfulSettlement = await new x402Facilitator().register(LOCALNET, new AssuredExactAvmScheme(signer)).settle(payload, requirements)
  if (!successfulSettlement.success) throw new Error(`assured-exact LocalNet settlement failed: ${successfulSettlement.errorReason}: ${successfulSettlement.errorMessage}`)
  const afterSuccess = await balances(accounts, assetId)
  const markerAfterSuccess = await marker(appId)

  const beforeRejected = await balances(accounts, assetId)
  const markerBeforeRejected = await marker(appId)
  const rejectedTxns = rejectionPayload({ payer, provider: provider.addr, application, assetId, appId, params: await algod.getTransactionParams().do() })
  const rejectedSigned = rejectedTxns.map((txn) => txn.signTxn(payer.sk))
  const rejectedGroupId = Buffer.from(rejectedTxns[0].group).toString('base64')
  const rejectedProviderTxId = rejectedTxns[0].txID()
  const rejectedApplicationTxId = rejectedTxns[2].txID()
  const rejectedSimulation = await algod.simulateRawTransactions(rejectedSigned).do()
  let networkSubmissionError = ''
  try { await algod.sendRawTransaction(rejectedSigned).do() } catch (error) { networkSubmissionError = error instanceof Error ? error.message : String(error) }
  if (!networkSubmissionError) throw new Error('forced-rejection group was accepted for submission unexpectedly')
  const afterRejected = await balances(accounts, assetId)
  const markerAfterRejected = await marker(appId)
  const canonicalJson = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
  if (canonicalJson(beforeRejected) !== canonicalJson(afterRejected) || markerBeforeRejected !== markerAfterRejected) throw new Error('rejected group changed ASA balances or contract marker')

  console.log(JSON.stringify({
    network: LOCALNET,
    localnetGenesis: (await algod.versionsCheck().do()).genesisId,
    assetId, appId, application: application.toString(),
    setupTransactionIds: { funding: funding.map((entry) => entry.txId), assetCreate: assetCreateResult.txId, payerOptIn: payerOptIn.txId, providerOptIn: providerOptIn.txId, distribution: distribution.txId, appFunding: appFunding.txId, appOptIn: appOptInResult.txId },
    successfulSettlement: { providerTransactionId: successfulSettlement.transaction, before: beforeSuccess, after: afterSuccess, markerBefore: markerBeforeSuccess, markerAfter: markerAfterSuccess },
    actualNetworkRejectedGroup: { groupId: rejectedGroupId, providerTransactionId: rejectedProviderTxId, applicationTransactionId: rejectedApplicationTxId, simulationFailure: rejectedSimulation.txnGroups?.[0]?.failureMessage ?? null, submissionError: networkSubmissionError, before: beforeRejected, after: afterRejected, markerBefore: markerBeforeRejected, markerAfter: markerAfterRejected },
  }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
