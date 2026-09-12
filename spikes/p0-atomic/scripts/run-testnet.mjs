import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import algosdk from 'algosdk'
import { x402Facilitator } from '@x402/core/facilitator'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'
import { AssuredExactAvmScheme, buildAssuredExactPayloadWithSigner } from '../src/assured-exact.mjs'
import { createPeraHdSigner } from '../src/pera-hd-signer.mjs'

const GROSS = 100n, PROVIDER_NET = 93n, PREMIUM = 7n
const PROVIDER_FUNDING = 500_000n, APPLICATION_FUNDING = 300_000n, MIN_SPENDABLE_ALGOS = 3_000_000n
const OPEN_COVERAGE = new algosdk.ABIMethod({ name: 'openCoverage', args: [{ type: 'uint64' }, { type: 'uint64' }, { type: 'byte[]' }, { type: 'bool' }], returns: { type: 'void' } })
const OPT_IN_ASSET = new algosdk.ABIMethod({ name: 'optInAsset', args: [{ type: 'uint64' }], returns: { type: 'void' } })
const CREATE = new algosdk.ABIMethod({ name: 'create', args: [{ type: 'uint64' }, { type: 'address' }], returns: { type: 'void' } })
const asJson = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)
const canonicalPositive = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
const canonicalIndex = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 0x7fffffff
const ACCEPTED_TESTNET_EVIDENCE = Object.freeze({
  assetId: 10_458_941n,
  applicationId: 771_586_806n,
  successfulGroupId: 'P/UeimX9rfN7M9bX+GVkRLVn3w8Ch0LmcnxtVVnm5/0=',
  successfulTransactionIds: ['2FLY2PVDH6TNTYP3YKF7JY4OM5LCQZOGMDN4AUGFPITF5GDRAVBA', 'O37H5XIJ2OHO5HRYWD446OQGXU2RUV5LSOVMHODGKKHL7DHJ4SLQ', '7TIGGAWFQUTY2RUEJCKPIEEGG3Q6C7EONYIL2EIMQOS2U4D3BV2Q'],
  confirmedRound: 67_235_792n,
  rejectedGroupId: '2kqU7jR+J/+R/u0IhVfrPSJVylJHi1XB24UAKoAmBgc=',
  rejectedTransactionIds: ['NR6I4JKAFWP4ERTWRQTWNSDQLDN76IQQU7JIWQMZ52JOM4IAATJA', 'U3WEAJFODDDMQX7QQZ7PMCYARDBQODZMW7RQUEU2UYECCCE75V2A', 'P4VOKN44QWSXZFL23TN7DIBS2LGWJJHUAU26RQV3HRZ5YJ474DOQ'],
})

export function loadDotEnv(text, target = process.env) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || Object.prototype.hasOwnProperty.call(target, match[1])) continue
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2')
    target[match[1]] = value
  }
}

async function loadLocalEnv() {
  try { loadDotEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

export function publicBalance(account, asset = 0n, address = '') {
  const totalMicroAlgos = BigInt(account.amount)
  const minimumBalanceMicroAlgos = BigInt(account.minBalance ?? 0)
  return { address, totalMicroAlgos, minimumBalanceMicroAlgos, spendableMicroAlgos: totalMicroAlgos - minimumBalanceMicroAlgos, asset }
}

export function isIntendedApplicationAssertionFailure(error, appId) {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return text.includes('logic eval error') && text.includes('assert failed') && text.includes(`app=${appId}`)
}

export async function testnetConfig(environment = process.env) {
  const missing = []
  const mnemonic = environment.TESTNET_PAYER_HD_MNEMONIC
  const expectedAddress = environment.TESTNET_PAYER_ADDRESS
  const accountIndex = environment.TESTNET_PAYER_ACCOUNT_INDEX ?? '0'
  const addressIndex = environment.TESTNET_PAYER_ADDRESS_INDEX ?? '0'
  const assetId = environment.TESTNET_ASA_ID
  const server = environment.TESTNET_ALGOD_SERVER
  if (!mnemonic) missing.push('TESTNET_PAYER_HD_MNEMONIC: provide a valid 24-word Pera BIP-39 recovery phrase through the environment or ignored local .env')
  if (!expectedAddress || !algosdk.isValidAddress(expectedAddress)) missing.push('TESTNET_PAYER_ADDRESS: provide the expected public Pera address as an Algorand address safety assertion')
  if (!canonicalIndex(accountIndex)) missing.push('TESTNET_PAYER_ACCOUNT_INDEX: provide a non-negative safe decimal Pera account index')
  if (!canonicalIndex(addressIndex)) missing.push('TESTNET_PAYER_ADDRESS_INDEX: provide a non-negative safe decimal Pera address index')
  if (!canonicalPositive(assetId)) missing.push('TESTNET_ASA_ID: provide the existing selected TestNet ASA ID as a positive decimal integer; it will not be guessed or created')
  if (!server) missing.push('TESTNET_ALGOD_SERVER: provide a reachable TestNet Algod endpoint URL')
  else { try { new URL(server) } catch { missing.push('TESTNET_ALGOD_SERVER: provide a valid endpoint URL') } }
  let payer
  if (mnemonic && canonicalIndex(accountIndex) && canonicalIndex(addressIndex)) {
    try {
      payer = await createPeraHdSigner({ mnemonic, accountIndex: Number(accountIndex), addressIndex: Number(addressIndex) })
      if (expectedAddress && algosdk.isValidAddress(expectedAddress) && payer.address !== expectedAddress) missing.push('TESTNET_PAYER_ADDRESS: derived Pera address does not match the required public safety assertion')
    } catch { missing.push('TESTNET_PAYER_HD_MNEMONIC: provide a valid 24-word BIP-39 mnemonic with a valid checksum') }
  }
  return { missing, payer, expectedAddress, assetId: canonicalPositive(assetId) ? BigInt(assetId) : undefined, server, port: environment.TESTNET_ALGOD_PORT ?? '', token: environment.TESTNET_ALGOD_TOKEN ?? '', tokenHeader: environment.TESTNET_ALGOD_TOKEN_HEADER || 'X-Algo-API-Token' }
}

function client(settings) {
  const headers = settings.token ? { [settings.tokenHeader]: settings.token } : undefined
  return new algosdk.Algodv2('', settings.server, settings.port, headers)
}

function endpointConfig(environment = process.env) {
  const server = environment.TESTNET_ALGOD_SERVER
  if (!server) throw new Error('TESTNET_ALGOD_SERVER is required for public evidence verification')
  try { new URL(server) } catch { throw new Error('TESTNET_ALGOD_SERVER must be a valid endpoint URL') }
  return { server, port: environment.TESTNET_ALGOD_PORT ?? '', token: environment.TESTNET_ALGOD_TOKEN ?? '', tokenHeader: environment.TESTNET_ALGOD_TOKEN_HEADER || 'X-Algo-API-Token' }
}

const compactSubmission = ({ txId, confirmedRound }) => ({ transactionId: txId, confirmedRound })

export function balanceDeltas(before, after) {
  return Object.fromEntries(Object.keys(before).map((role) => [role, {
    algoMicroAlgos: after[role].totalMicroAlgos - before[role].totalMicroAlgos,
    assetUnits: after[role].asset - before[role].asset,
  }]))
}

export function compactTestnetResult({ network, payer, provider, application, asset, applicationId, setup, successfulSettlement, actualPoolRejectedGroup }) {
  return {
    network,
    asset: { id: asset.id, unitName: asset.unitName, name: asset.name, decimals: asset.decimals },
    applicationId,
    addresses: { payer, provider, application },
    setup: Object.fromEntries(Object.entries(setup).map(([step, result]) => [step, compactSubmission(result)])),
    successfulSettlement: {
      groupId: successfulSettlement.groupId,
      memberTransactionIds: successfulSettlement.memberTransactionIds,
      confirmedRound: successfulSettlement.confirmedRound,
      balanceDeltas: balanceDeltas(successfulSettlement.before, successfulSettlement.after),
      marker: { before: successfulSettlement.markerBefore, after: successfulSettlement.markerAfter, delta: successfulSettlement.markerAfter - successfulSettlement.markerBefore },
    },
    actualPoolRejectedGroup: {
      groupId: actualPoolRejectedGroup.groupId,
      memberTransactionIds: actualPoolRejectedGroup.memberTransactionIds,
      simulationRejection: 'intended application assertion failure',
      poolRejection: actualPoolRejectedGroup.poolRejection,
      balanceDeltas: balanceDeltas(actualPoolRejectedGroup.before, actualPoolRejectedGroup.after),
      marker: { before: actualPoolRejectedGroup.markerBefore, after: actualPoolRejectedGroup.markerAfter, delta: actualPoolRejectedGroup.markerAfter - actualPoolRejectedGroup.markerBefore },
    },
  }
}

export async function verifyAcceptedPublicEvidence(settings) {
  const algod = client(settings)
  const version = await algod.versionsCheck().do()
  if (!String(version.genesisId).toLowerCase().includes('testnet')) throw new Error('TESTNET_ALGOD_SERVER must connect to Algorand TestNet')
  const asset = await algod.getAssetByID(ACCEPTED_TESTNET_EVIDENCE.assetId).do()
  await algod.getApplicationByID(ACCEPTED_TESTNET_EVIDENCE.applicationId).do()
  const applicationMarker = await marker(algod, ACCEPTED_TESTNET_EVIDENCE.applicationId)
  let transactionEvidence
  try {
    const transactions = await Promise.all(ACCEPTED_TESTNET_EVIDENCE.successfulTransactionIds.map(async (id) => ({ txn: (await algod.pendingTransactionInformation(id).do()).txn, confirmedRound: ACCEPTED_TESTNET_EVIDENCE.confirmedRound })))
    transactionEvidence = transactions.map((transaction) => {
      const txn = typeof transaction.txn.txID === 'function' ? transaction.txn : algosdk.decodeUnsignedTransaction(algosdk.encodeObj(transaction.txn))
      return { transactionId: txn.txID(), confirmedRound: transaction.confirmedRound, groupId: Buffer.from(txn.group).toString('base64') }
    })
  } catch {
    let response
    try { response = await algod.block(Number(ACCEPTED_TESTNET_EVIDENCE.confirmedRound)).do() } catch { throw new Error('PUBLIC_EVIDENCE_BLOCK_LOOKUP_UNAVAILABLE') }
    const block = response.block ?? response
    const payset = block.payset ?? []
    let blockTxids
    try { blockTxids = (await algod.getBlockTxids(ACCEPTED_TESTNET_EVIDENCE.confirmedRound).do()).blocktxids } catch { throw new Error('PUBLIC_EVIDENCE_BLOCK_TXIDS_UNAVAILABLE') }
    if (!ACCEPTED_TESTNET_EVIDENCE.successfulTransactionIds.every((id) => blockTxids.includes(id))) throw new Error('PUBLIC_EVIDENCE_BLOCK_TRANSACTION_MISSING')
    const matchedGroupMembers = payset.filter((entry) => {
      const txn = entry.signedTxn?.signedTxn?.txn ?? entry.signedTxn?.txn ?? entry.stxn?.txn ?? entry.txn
      return txn?.group && Buffer.from(txn.group).toString('base64') === ACCEPTED_TESTNET_EVIDENCE.successfulGroupId
    })
    if (matchedGroupMembers.length !== 3) throw new Error('PUBLIC_EVIDENCE_BLOCK_GROUP_MISMATCH')
    transactionEvidence = ACCEPTED_TESTNET_EVIDENCE.successfulTransactionIds.map((transactionId) => ({ transactionId, confirmedRound: ACCEPTED_TESTNET_EVIDENCE.confirmedRound, groupId: ACCEPTED_TESTNET_EVIDENCE.successfulGroupId }))
  }
  const allConfirmedAtExpectedRound = transactionEvidence.every((transaction) => transaction.confirmedRound === ACCEPTED_TESTNET_EVIDENCE.confirmedRound)
  const allInExpectedGroup = transactionEvidence.every((transaction) => transaction.groupId === ACCEPTED_TESTNET_EVIDENCE.successfulGroupId)
  if (!allConfirmedAtExpectedRound || !allInExpectedGroup) throw new Error('public TestNet evidence does not match the supplied successful group')
  return {
    network: version.genesisId,
    asset: { id: ACCEPTED_TESTNET_EVIDENCE.assetId, unitName: asset.params.unitName ?? '', name: asset.params.name ?? '', decimals: asset.params.decimals },
    applicationId: ACCEPTED_TESTNET_EVIDENCE.applicationId,
    successfulSettlement: { groupId: ACCEPTED_TESTNET_EVIDENCE.successfulGroupId, memberTransactionIds: ACCEPTED_TESTNET_EVIDENCE.successfulTransactionIds, confirmedRound: ACCEPTED_TESTNET_EVIDENCE.confirmedRound },
    rejectedGroup: { groupId: ACCEPTED_TESTNET_EVIDENCE.rejectedGroupId, memberTransactionIds: ACCEPTED_TESTNET_EVIDENCE.rejectedTransactionIds, rejection: `intended application assertion failure in app ${ACCEPTED_TESTNET_EVIDENCE.applicationId}` },
    applicationAddress: algosdk.getApplicationAddress(ACCEPTED_TESTNET_EVIDENCE.applicationId).toString(),
    applicationMarker,
  }
}

async function submit(algod, txns, signer) {
  const signed = await Promise.all(txns.map((txn) => signer.signTransaction ? signer.signTransaction(txn) : txn.signTxn(signer.sk)))
  const txId = txns[0].txID()
  await algod.sendRawTransaction(signed).do()
  const pending = await algosdk.waitForConfirmation(algod, txId, 10)
  return { txId, confirmedRound: pending.confirmedRound, pending }
}

async function balance(algod, address, assetId) {
  const account = await algod.accountInformation(address).do()
  let asset = 0n
  try { asset = (await algod.accountAssetInformation(address, assetId).do()).assetHolding.amount } catch { /* absent holding is reported by preflight */ }
  return publicBalance(account, asset, String(address))
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
  if (settings.missing.length) return { ok: false, phase: 'configuration', payer: settings.payer?.address, expectedPayer: settings.expectedAddress, missingPrerequisites: settings.missing }
  const algod = client(settings)
  let version
  try { version = await algod.versionsCheck().do() } catch { return { ok: false, phase: 'endpoint', payer: settings.payer.addr.toString(), missingPrerequisites: ['TestNet Algod endpoint access failed: verify TESTNET_ALGOD_SERVER and optional token/header without exposing credentials'] } }
  if (!String(version.genesisId).toLowerCase().includes('testnet')) return { ok: false, phase: 'network', payer: settings.payer.addr.toString(), network: version.genesisId, missingPrerequisites: ['TESTNET_ALGOD_SERVER must connect to Algorand TestNet, not LocalNet or MainNet'] }
  const missing = []
  let payerBalance, asset
  try { payerBalance = await balance(algod, settings.payer.addr, settings.assetId) } catch { missing.push('TestNet payer account could not be queried; verify endpoint access and funded account') }
  try { asset = await algod.getAssetByID(settings.assetId).do() } catch { missing.push('TESTNET_ASA_ID was not found through the configured TestNet endpoint') }
  if (payerBalance) {
    if (payerBalance.spendableMicroAlgos < MIN_SPENDABLE_ALGOS) missing.push(`payer needs at least ${MIN_SPENDABLE_ALGOS} spendable microALGOs for disposable app/provider setup and fees`)
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
  const built = await buildAssuredExactPayloadWithSigner({ payer: payer.addr, signTransaction: (txn) => payer.signTransaction(txn), provider: provider.addr, application, assetId, providerNet: PROVIDER_NET, premium: PREMIUM, applicationId: appId, commitment: new Uint8Array(32).fill(7), params: await algod.getTransactionParams().do() })
  const requirements = { ...built.requirements, network: ALGORAND_TESTNET_CAIP2, maxTimeoutSeconds: 60 }
  const payload = { x402Version: 2, accepted: requirements, payload: { paymentGroup: built.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const settlement = await new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, new AssuredExactAvmScheme(signer)).settle(payload, requirements)
  if (!settlement.success) throw new Error(`TestNet assured-exact settlement failed: ${settlement.errorReason ?? 'unknown'}`)
  const after = await balances(algod, accounts, assetId), markerAfter = await marker(algod, appId)
  if (before.payer.asset - after.payer.asset !== GROSS || after.provider.asset - before.provider.asset !== PROVIDER_NET || after.application.asset - before.application.asset !== PREMIUM || markerAfter !== markerBefore + 1n) throw new Error('confirmed TestNet settlement did not produce the required balances/marker')
  const successTxns = built.paymentGroup.map((encoded) => algosdk.decodeSignedTransaction(Buffer.from(encoded, 'base64')).txn)
  const rejected = rejectedTransactions({ payer, provider: provider.addr, application, assetId, appId, params: await algod.getTransactionParams().do() })
  const rejectedSigned = await Promise.all(rejected.map((txn) => payer.signTransaction(txn)))
  const rejectionBefore = await balances(algod, accounts, assetId), rejectionMarkerBefore = await marker(algod, appId)
  const simulation = await algod.simulateRawTransactions(rejectedSigned).do()
  const simulationFailure = simulation.txnGroups?.[0]?.failureMessage
  if (!isIntendedApplicationAssertionFailure(simulationFailure, appId)) throw new Error('forced-rejection simulation did not identify the intended application assertion failure')
  let poolRejection = ''
  try { await algod.sendRawTransaction(rejectedSigned).do() } catch (error) {
    if (!isIntendedApplicationAssertionFailure(error, appId)) throw new Error('TestNet transaction pool failure was not the intended application assertion failure')
    poolRejection = 'TestNet transaction pool rejected the intended application assertion failure'
  }
  if (!poolRejection) throw new Error('forced-rejection TestNet group was unexpectedly accepted by the transaction pool')
  const rejectionAfter = await balances(algod, accounts, assetId), rejectionMarkerAfter = await marker(algod, appId)
  if (asJson(rejectionBefore) !== asJson(rejectionAfter) || rejectionMarkerBefore !== rejectionMarkerAfter) throw new Error('TestNet rejected group changed ASA balances or marker')
  return compactTestnetResult({ network: readiness.network, payer: payer.addr.toString(), provider: provider.addr.toString(), application: application.toString(), asset: readiness.asset, applicationId: appId, setup: { funding, create: created, providerOptIn, appFunding, appOptIn }, successfulSettlement: { groupId: Buffer.from(successTxns[0].group).toString('base64'), memberTransactionIds: successTxns.map((txn) => txn.txID()), confirmedRound: (await algod.pendingTransactionInformation(settlement.transaction).do()).confirmedRound, before, after, markerBefore, markerAfter }, actualPoolRejectedGroup: { groupId: Buffer.from(rejected[0].group).toString('base64'), memberTransactionIds: rejected.map((txn) => txn.txID()), poolRejection, before: rejectionBefore, after: rejectionAfter, markerBefore: rejectionMarkerBefore, markerAfter: rejectionMarkerAfter } })
}

async function main() {
  await loadLocalEnv()
  if (process.argv.includes('--verify-evidence')) { console.log(asJson(await verifyAcceptedPublicEvidence(endpointConfig()))); return }
  const settings = await testnetConfig()
  try {
    const readiness = await preflight(settings)
    if (process.argv.includes('--preflight') || !readiness.ok) { console.log(asJson(readiness)); process.exitCode = readiness.ok ? 0 : 2; return }
    console.log(asJson(await run(settings, readiness)))
  } finally {
    settings.payer?.dispose()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { const publicCode = typeof error?.message === 'string' && error.message.startsWith('PUBLIC_EVIDENCE_') ? error.message : undefined; console.error(asJson({ ok: false, phase: 'execution', message: publicCode ?? 'TestNet execution failed; inspect public endpoint access, account funds/ASA holding, and network state without exposing credentials.' })); process.exitCode = 1 })
}
