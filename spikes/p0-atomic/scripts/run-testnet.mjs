import { readFile } from 'node:fs/promises'
import algosdk from 'algosdk'
import { x402Facilitator } from '@x402/core/facilitator'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'
import { AssuredExactAvmScheme, buildAssuredExactPayload } from '../src/assured-exact.mjs'

const GROSS = 100n, PROVIDER_NET = 93n, PREMIUM = 7n
const PROVIDER_FUNDING = 500_000n, APPLICATION_FUNDING = 300_000n, MIN_SPENDABLE_ALGOS = 3_000_000n
const OPEN_COVERAGE = new algosdk.ABIMethod({ name: 'openCoverage', args: [{ type: 'uint64' }, { type: 'uint64' }, { type: 'byte[]' }, { type: 'bool' }], returns: { type: 'void' } })
const OPT_IN_ASSET = new algosdk.ABIMethod({ name: 'optInAsset', args: [{ type: 'uint64' }], returns: { type: 'void' } })
const CREATE = new algosdk.ABIMethod({ name: 'create', args: [{ type: 'uint64' }, { type: 'address' }], returns: { type: 'void' } })
const asJson = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)
const canonicalPositive = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)

function config() {
  const missing = []
  const mnemonic = process.env.TESTNET_PAYER_MNEMONIC
  const assetId = process.env.TESTNET_ASA_ID
  const server = process.env.TESTNET_ALGOD_SERVER
  if (!mnemonic) missing.push('TESTNET_PAYER_MNEMONIC: provide a funded TestNet payer mnemonic through the environment or ignored local .env')
  if (!canonicalPositive(assetId)) missing.push('TESTNET_ASA_ID: provide the existing selected TestNet ASA ID as a positive decimal integer; it will not be guessed or created')
  if (!server) missing.push('TESTNET_ALGOD_SERVER: provide a reachable TestNet Algod endpoint URL')
  else { try { new URL(server) } catch { missing.push('TESTNET_ALGOD_SERVER: provide a valid endpoint URL') } }
  let payer
  if (mnemonic) { try { payer = algosdk.mnemonicToSecretKey(mnemonic) } catch { missing.push('TESTNET_PAYER_MNEMONIC: provide a valid Algorand mnemonic') } }
  return { missing, payer, assetId: canonicalPositive(assetId) ? BigInt(assetId) : undefined, server, port: process.env.TESTNET_ALGOD_PORT ?? '', token: process.env.TESTNET_ALGOD_TOKEN ?? '', tokenHeader: process.env.TESTNET_ALGOD_TOKEN_HEADER || 'X-Algo-API-Token' }
}

function client(settings) {
  const headers = settings.token ? { [settings.tokenHeader]: settings.token } : undefined
  return new algosdk.Algodv2('', settings.server, settings.port, headers)
}

async function submit(algod, txns, signer) {
  const signed = txns.map((txn) => txn.signTxn(signer.sk))
  const txId = txns[0].txID()
  await algod.sendRawTransaction(signed).do()
  const pending = await algosdk.waitForConfirmation(algod, txId, 10)
  return { txId, confirmedRound: pending.confirmedRound, pending }
}

async function balance(algod, address, assetId) {
  const account = await algod.accountInformation(address).do()
  let asset = 0n
  try { asset = (await algod.accountAssetInformation(address, assetId).do()).assetHolding.amount } catch { /* absent holding is reported by preflight */ }
  return { address: String(address), microAlgos: account.amount, asset }
}

async function balances(algod, addresses, assetId) {
  return Object.fromEntries(await Promise.all(Object.entries(addresses).map(async ([role, address]) => [role, await balance(algod, address, assetId)])))
}

async function marker(algod, appId) {
  const state = (await algod.getApplicationByID(appId).do()).params.globalState ?? []
  const opened = state.find((entry) => Buffer.from(entry.key, 'base64').toString() === 'opened')
  return opened?.value.uint ?? 0n
}

function rejectedTransactions({ payer, provider, application, assetId, appId, params }) {
  const appArgs = [OPEN_COVERAGE.getSelector(), algosdk.ABIType.from('uint64').encode(GROSS), algosdk.ABIType.from('uint64').encode(PREMIUM), algosdk.ABIType.from('byte[]').encode(new Uint8Array(32).fill(9)), algosdk.ABIType.from('bool').encode(true)]
  const txns = [
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: provider, assetIndex: assetId, amount: PROVIDER_NET, suggestedParams: params }),
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: application, assetIndex: assetId, amount: PREMIUM, suggestedParams: params }),
    algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.addr, appIndex: appId, appArgs, suggestedParams: params }),
  ]
  algosdk.assignGroupID(txns)
  return txns
}

async function preflight(settings) {
  if (settings.missing.length) return { ok: false, phase: 'configuration', missingPrerequisites: settings.missing }
  const algod = client(settings)
  let version
  try { version = await algod.versionsCheck().do() } catch { return { ok: false, phase: 'endpoint', payer: settings.payer.addr.toString(), missingPrerequisites: ['TestNet Algod endpoint access failed: verify TESTNET_ALGOD_SERVER and optional token/header without exposing credentials'] } }
  if (!String(version.genesisId).toLowerCase().includes('testnet')) return { ok: false, phase: 'network', payer: settings.payer.addr.toString(), network: version.genesisId, missingPrerequisites: ['TESTNET_ALGOD_SERVER must connect to Algorand TestNet, not LocalNet or MainNet'] }
  const missing = []
  let payerBalance, asset
  try { payerBalance = await balance(algod, settings.payer.addr, settings.assetId) } catch { missing.push('TestNet payer account could not be queried; verify endpoint access and funded account') }
  try { asset = await algod.getAssetByID(settings.assetId).do() } catch { missing.push('TESTNET_ASA_ID was not found through the configured TestNet endpoint') }
  if (payerBalance) {
    if (payerBalance.microAlgos < MIN_SPENDABLE_ALGOS) missing.push(`payer needs at least ${MIN_SPENDABLE_ALGOS} spendable microALGOs for disposable app/provider setup and fees`)
    if (payerBalance.asset < GROSS) missing.push(`payer must be opted into ASA ${settings.assetId} and hold at least ${GROSS} atomic units`)
  }
  return { ok: missing.length === 0, phase: 'preflight', network: version.genesisId, payer: settings.payer.addr.toString(), asset: asset ? { id: settings.assetId, unitName: asset.params.unitName ?? '', name: asset.params.name ?? '', decimals: asset.params.decimals } : undefined, payerBalance, required: { gross: GROSS, providerNet: PROVIDER_NET, premium: PREMIUM, minSpendableMicroAlgos: MIN_SPENDABLE_ALGOS }, missingPrerequisites: missing }
}

async function run(settings, readiness) {
  const algod = client(settings), payer = settings.payer, assetId = settings.assetId
  const provider = algosdk.generateAccount()
  const funding = await submit(algod, [algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: provider.addr, amount: PROVIDER_FUNDING, suggestedParams: await algod.getTransactionParams().do() })], payer)
  const artifact = JSON.parse(await readFile(new URL('../artifacts/AssuranceCoreSpike.arc56.json', import.meta.url), 'utf8'))
  const approval = (await algod.compile(Buffer.from(artifact.source.approval, 'base64').toString()).do()).result
  const clear = (await algod.compile(Buffer.from(artifact.source.clear, 'base64').toString()).do()).result
  const create = algosdk.makeApplicationCreateTxnFromObject({ sender: payer.addr, onComplete: algosdk.OnApplicationComplete.NoOpOC, approvalProgram: new Uint8Array(Buffer.from(approval, 'base64')), clearProgram: new Uint8Array(Buffer.from(clear, 'base64')), numGlobalInts: 2, numGlobalByteSlices: 1, numLocalInts: 0, numLocalByteSlices: 0, appArgs: [CREATE.getSelector(), algosdk.ABIType.from('uint64').encode(assetId), algosdk.ABIType.from('address').encode(provider.addr.publicKey)], suggestedParams: await algod.getTransactionParams().do() })
  const created = await submit(algod, [create], payer)
  const appId = created.pending.applicationIndex
  if (!appId) throw new Error('TestNet app creation did not return an application index')
  const application = algosdk.getApplicationAddress(appId)
  const providerOptIn = await submit(algod, [algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: provider.addr, receiver: provider.addr, assetIndex: assetId, amount: 0, suggestedParams: await algod.getTransactionParams().do() })], provider)
  const appFunding = await submit(algod, [algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: application, amount: APPLICATION_FUNDING, suggestedParams: await algod.getTransactionParams().do() })], payer)
  const appOptIn = await submit(algod, [algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.addr, appIndex: appId, appArgs: [OPT_IN_ASSET.getSelector(), algosdk.ABIType.from('uint64').encode(assetId)], foreignAssets: [assetId], suggestedParams: { ...(await algod.getTransactionParams().do()), fee: 2_000n, flatFee: true } })], payer)
  const accounts = { payer: payer.addr, provider: provider.addr, application }
  const before = await balances(algod, accounts, assetId), markerBefore = await marker(algod, appId)
  const signer = { getAddresses: () => [payer.addr.toString()], simulateTransactions: async (group) => algod.simulateRawTransactions(group).do(), sendTransactions: async (group) => algod.sendRawTransaction(group).do(), waitForConfirmation: async (id) => algosdk.waitForConfirmation(algod, id, 10) }
  const built = buildAssuredExactPayload({ payer, provider: provider.addr, application, assetId, providerNet: PROVIDER_NET, premium: PREMIUM, applicationId: appId, commitment: new Uint8Array(32).fill(7), params: await algod.getTransactionParams().do() })
  const requirements = { ...built.requirements, network: ALGORAND_TESTNET_CAIP2, maxTimeoutSeconds: 60 }
  const payload = { x402Version: 2, accepted: requirements, payload: { paymentGroup: built.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const settlement = await new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, new AssuredExactAvmScheme(signer)).settle(payload, requirements)
  if (!settlement.success) throw new Error(`TestNet assured-exact settlement failed: ${settlement.errorReason ?? 'unknown'}`)
  const after = await balances(algod, accounts, assetId), markerAfter = await marker(algod, appId)
  if (before.payer.asset - after.payer.asset !== GROSS || after.provider.asset - before.provider.asset !== PROVIDER_NET || after.application.asset - before.application.asset !== PREMIUM || markerAfter !== markerBefore + 1n) throw new Error('confirmed TestNet settlement did not produce the required balances/marker')
  const successTxns = built.paymentGroup.map((encoded) => algosdk.decodeSignedTransaction(Buffer.from(encoded, 'base64')).txn)
  const rejected = rejectedTransactions({ payer, provider: provider.addr, application, assetId, appId, params: await algod.getTransactionParams().do() })
  const rejectedSigned = rejected.map((txn) => txn.signTxn(payer.sk))
  const rejectionBefore = await balances(algod, accounts, assetId), rejectionMarkerBefore = await marker(algod, appId)
  const simulation = await algod.simulateRawTransactions(rejectedSigned).do()
  let poolRejection = ''
  try { await algod.sendRawTransaction(rejectedSigned).do() } catch { poolRejection = 'TestNet transaction pool rejected the ABI-valid forced-rejection group' }
  if (!poolRejection) throw new Error('forced-rejection TestNet group was unexpectedly accepted by the transaction pool')
  const rejectionAfter = await balances(algod, accounts, assetId), rejectionMarkerAfter = await marker(algod, appId)
  if (asJson(rejectionBefore) !== asJson(rejectionAfter) || rejectionMarkerBefore !== rejectionMarkerAfter) throw new Error('TestNet rejected group changed ASA balances or marker')
  return { network: readiness.network, payer: payer.addr.toString(), provider: provider.addr.toString(), application: application.toString(), asset: readiness.asset, applicationId: appId, setup: { funding, create: created, providerOptIn, appFunding, appOptIn }, successfulSettlement: { groupId: Buffer.from(successTxns[0].group).toString('base64'), memberTransactionIds: successTxns.map((txn) => txn.txID()), confirmedRound: (await algod.pendingTransactionInformation(settlement.transaction).do()).confirmedRound, before, after, markerBefore, markerAfter }, actualPoolRejectedGroup: { groupId: Buffer.from(rejected[0].group).toString('base64'), memberTransactionIds: rejected.map((txn) => txn.txID()), simulationFailure: simulation.txnGroups?.[0]?.failureMessage ?? null, poolRejection, before: rejectionBefore, after: rejectionAfter, markerBefore: rejectionMarkerBefore, markerAfter: rejectionMarkerAfter } }
}

async function main() {
  const settings = config(), readiness = await preflight(settings)
  if (process.argv.includes('--preflight') || !readiness.ok) { console.log(asJson(readiness)); process.exitCode = readiness.ok ? 0 : 2; return }
  console.log(asJson(await run(settings, readiness)))
}

main().catch(() => { console.error(asJson({ ok: false, phase: 'execution', message: 'TestNet execution failed; inspect public endpoint access, account funds/ASA holding, and network state without exposing credentials.' })); process.exitCode = 1 })
