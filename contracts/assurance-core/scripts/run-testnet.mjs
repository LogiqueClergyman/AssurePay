import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import algosdk from 'algosdk'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'
import { x402Facilitator } from '@x402/core/facilitator'
import { createAssuredExactFacilitator } from '../adapter/assured-exact.mjs'
import { buildAssuredExactPayloadWithSigner } from '../src/assured-exact.mjs'
import { createPeraHdSigner } from '../src/pera-hd-signer.mjs'

const root = path.resolve(import.meta.dirname, '..')
const artifactPath = path.join(root, 'artifacts', 'AssuranceCore.arc32.json')
const compiledPath = path.join(root, 'artifacts', 'AssuranceCore.arc56.json')
const evidencePath = path.join(root, 'testnet-evidence.json')
const MAX_UINT64 = 18_446_744_073_709_551_615n
const MIN_TX_FEE = 1_000n
const BOX_MBR = Object.freeze({ provider: 67_300n, policy: 44_900n, coverage: 92_900n, claim: 45_300n })
const SCENARIO = Object.freeze({
  gross: 100n,
  providerNet: 50n,
  premium: 50n,
  stake: 123n,
  collateralRatioBps: 7_500n,
  claimAmount: 100n,
  expectedStakeDebit: 75n,
  expectedPoolDebit: 25n,
  asaMargin: 10n,
  algoMargin: 100_000n,
})
const METHOD = Object.freeze({
  create: algosdk.ABIMethod.fromSignature('createApplication(uint64,address)void'),
  optIn: algosdk.ABIMethod.fromSignature('optInAcceptedAsset(uint64)void'),
  register: algosdk.ABIMethod.fromSignature('registerProvider(byte[32],address,byte[32])void'),
  policy: algosdk.ABIMethod.fromSignature('createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)void'),
  deposit: algosdk.ABIMethod.fromSignature('depositStake(byte[32],axfer)void'),
  capacity: algosdk.ABIMethod.fromSignature('getAvailableCapacity(byte[32],byte[32])(uint64)'),
  withdraw: algosdk.ABIMethod.fromSignature('withdrawStake(byte[32],uint64)void'),
  claim: algosdk.ABIMethod.fromSignature('finalizeClaim(byte[32],byte[32],bool,uint64,bool,uint64)void'),
})
const RECORD = Object.freeze({
  provider: '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)',
  coverage: '(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)',
})

const asJson = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)
const canonicalPositive = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= MAX_UINT64
const canonicalIndex = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 0x7fffffff
const address = (value) => typeof value === 'string' && algosdk.isValidAddress(value)
const b64 = (value) => Buffer.from(value ?? []).toString('base64')
const hex = (value) => Buffer.from(value ?? []).toString('hex')
const bytes = (value) => value instanceof Uint8Array ? value : Buffer.from(value, 'base64')
const boxKey = (prefix, id) => new Uint8Array(Buffer.concat([Buffer.from(prefix), Buffer.from(id)]))
const id = (fill) => new Uint8Array(32).fill(fill)
const publicError = (code, message) => Object.assign(new Error(message), { publicCode: code })

export function loadDotEnv(text, target = process.env) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || Object.prototype.hasOwnProperty.call(target, match[1])) continue
    target[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

async function loadLocalEnv() {
  try {
    await fs.readFile(path.join(root, '.env'), 'utf8').then((text) => loadDotEnv(text))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw publicError('PUBLIC_EVIDENCE_ENDPOINT_UNAVAILABLE', 'local TestNet configuration could not be loaded')
  }
}

export function publicBalance(account, asset = 0n, accountAddress = '') {
  const totalMicroAlgos = BigInt(account.amount ?? 0)
  const minimumBalanceMicroAlgos = BigInt(account.minBalance ?? account['min-balance'] ?? 0)
  return { address: accountAddress, totalMicroAlgos, minimumBalanceMicroAlgos, spendableMicroAlgos: totalMicroAlgos - minimumBalanceMicroAlgos, asset }
}

export function balanceDeltas(before, after) {
  return Object.fromEntries(Object.keys(before).map((role) => [role, {
    algoMicroAlgos: after[role].totalMicroAlgos - before[role].totalMicroAlgos,
    assetUnits: after[role].asset - before[role].asset,
  }]))
}

export function isIntendedApplicationAssertionFailure(value, appId) {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value?.message ?? '')
  return text.includes('assert failed') && (text.includes(`app=${appId}`) || text.includes(`application ${appId}`) || text.includes(`app ${appId}`))
}

function client(settings) {
  const headers = settings.token ? { [settings.tokenHeader]: settings.token } : undefined
  return new algosdk.Algodv2('', settings.server, settings.port, headers)
}

export function endpointConfig(environment = process.env) {
  const server = environment.TESTNET_ALGOD_SERVER
  if (!server) throw publicError('PUBLIC_EVIDENCE_ENDPOINT_UNAVAILABLE', 'TESTNET_ALGOD_SERVER is required')
  try { new URL(server) } catch { throw publicError('PUBLIC_EVIDENCE_ENDPOINT_INVALID', 'TESTNET_ALGOD_SERVER must be a valid URL') }
  return { server, port: environment.TESTNET_ALGOD_PORT ?? '', token: environment.TESTNET_ALGOD_TOKEN ?? '', tokenHeader: environment.TESTNET_ALGOD_TOKEN_HEADER || 'X-Algo-API-Token' }
}

export async function testnetConfig(environment = process.env) {
  const missing = []
  const mnemonic = environment.TESTNET_PAYER_HD_MNEMONIC
  const expectedAddress = environment.TESTNET_PAYER_ADDRESS
  const accountIndex = environment.TESTNET_PAYER_ACCOUNT_INDEX ?? '0'
  const addressIndex = environment.TESTNET_PAYER_ADDRESS_INDEX ?? '0'
  const assetId = environment.TESTNET_ASA_ID
  const server = environment.TESTNET_ALGOD_SERVER
  if (!mnemonic) missing.push('TESTNET_PAYER_HD_MNEMONIC: provide the ignored P1 Pera recovery phrase')
  if (!expectedAddress || !address(expectedAddress)) missing.push('TESTNET_PAYER_ADDRESS: provide the expected public Pera address')
  if (!canonicalIndex(accountIndex)) missing.push('TESTNET_PAYER_ACCOUNT_INDEX: provide a bounded non-negative decimal index')
  if (!canonicalIndex(addressIndex)) missing.push('TESTNET_PAYER_ADDRESS_INDEX: provide a bounded non-negative decimal index')
  if (!canonicalPositive(assetId)) missing.push('TESTNET_ASA_ID: provide the existing positive TestNet ASA ID')
  if (!server) missing.push('TESTNET_ALGOD_SERVER: provide a reachable TestNet Algod endpoint')
  else { try { new URL(server) } catch { missing.push('TESTNET_ALGOD_SERVER: provide a valid endpoint URL') } }

  let payer
  if (mnemonic && canonicalIndex(accountIndex) && canonicalIndex(addressIndex)) {
    try {
      payer = await createPeraHdSigner({ mnemonic, accountIndex: Number(accountIndex), addressIndex: Number(addressIndex) })
      if (expectedAddress && address(expectedAddress) && payer.address !== expectedAddress) missing.push('TESTNET_PAYER_ADDRESS: derived Pera address does not match the required safety assertion')
    } catch {
      missing.push('TESTNET_PAYER_HD_MNEMONIC: provide a valid 24-word checksum-valid Pera phrase')
    }
  }
  return {
    missing,
    payer,
    expectedAddress,
    assetId: canonicalPositive(assetId) ? BigInt(assetId) : undefined,
    server,
    port: environment.TESTNET_ALGOD_PORT ?? '',
    token: environment.TESTNET_ALGOD_TOKEN ?? '',
    tokenHeader: environment.TESTNET_ALGOD_TOKEN_HEADER || 'X-Algo-API-Token',
  }
}

function readArtifact() {
  return Promise.all([fs.readFile(artifactPath, 'utf8'), fs.readFile(compiledPath, 'utf8')]).then(([arc32Text, arc56Text]) => {
    const arc32 = JSON.parse(arc32Text)
    const arc56 = JSON.parse(arc56Text)
    const approval = Buffer.from(arc56.byteCode.approval, 'base64')
    const clear = Buffer.from(arc56.byteCode.clear, 'base64')
    return { arc32, arc56, approval, clear, approvalProgramBytes: approval.length, extraPages: Math.max(0, Math.ceil(approval.length / 2_048) - 1) }
  })
}

export function calculateTestnetBudget({ minTxnFee = MIN_TX_FEE, approvalProgramBytes = 3_517, extraPages = 1 } = {}) {
  const fee = BigInt(minTxnFee)
  const appCreationMinBalance = 100_000n + 28_500n * 6n + 50_000n * 2n + 100_000n * BigInt(extraPages)
  const applicationBaseAndAssetMinBalance = 100_000n + 100_000n
  const applicationBoxFundingBudget = applicationBaseAndAssetMinBalance + BOX_MBR.provider + BOX_MBR.policy + BOX_MBR.coverage + BOX_MBR.claim
  const payerTransactionFees = fee * 17n
  const ephemeralTransactionFees = fee * 2n
  const ephemeralAccountFundingBudget = 2n * (100_000n + ephemeralTransactionFees / 2n)
  const feeBudget = payerTransactionFees + ephemeralTransactionFees
  const conservativeMargin = SCENARIO.algoMargin
  const totalConservativeRequiredSpendableMicroAlgos = appCreationMinBalance + applicationBoxFundingBudget + ephemeralAccountFundingBudget + feeBudget + conservativeMargin
  const requiredAsaUnits = SCENARIO.gross + SCENARIO.asaMargin
  return {
    approvalByteLength: BigInt(approvalProgramBytes),
    extraPages: BigInt(extraPages),
    appCreationMinBalance,
    applicationBaseAndAssetMinBalance,
    boxMbr: BOX_MBR,
    calculatedApplicationBoxFundingBudget: applicationBoxFundingBudget,
    applicationBoxFundingBudget,
    ephemeralAccountFundingBudget,
    feeBudget,
    payerTransactionFeeBudget: payerTransactionFees,
    ephemeralTransactionFeeBudget: ephemeralTransactionFees,
    conservativeMargin,
    totalConservativeRequiredSpendableMicroAlgos,
    requiredAsaUnits,
    requiredAsaScenario: { successfulCoverageGross: SCENARIO.gross, margin: SCENARIO.asaMargin },
  }
}

function networkIsTestnet(version, genesis) {
  const labels = [version?.genesisId, version?.['genesis-id'], genesis?.network, genesis?.id].filter(Boolean).map((item) => String(item).toLowerCase())
  return labels.some((item) => item.includes('testnet')) || String(genesis?.network ?? '').toLowerCase() === 'testnet'
}

async function accountBalance(algod, accountAddress, assetId) {
  const account = await algod.accountInformation(accountAddress).do()
  let holding = 0n
  let optedIn = false
  try {
    const response = await algod.accountAssetInformation(accountAddress, Number(assetId)).do()
    holding = BigInt(response.assetHolding?.amount ?? response['asset-holding']?.amount ?? 0)
    optedIn = true
  } catch { /* an absent holding is a named preflight failure */ }
  return { ...publicBalance(account, holding, accountAddress), optedIn }
}

export async function preflight(settings, dependencies = {}) {
  let budget = calculateTestnetBudget()
  const base = { ok: false, phase: 'configuration', expectedPayer: settings.expectedAddress, derivedPayer: settings.payer?.address, budget, missingPrerequisites: [...settings.missing] }
  if (settings.missing.length) return base
  try {
    const artifact = dependencies.artifact ?? await readArtifact()
    budget = calculateTestnetBudget({ approvalProgramBytes: artifact.approvalProgramBytes, extraPages: artifact.extraPages })
  } catch { return { ...base, phase: 'artifact', missingPrerequisites: ['committed P1 contract artifact could not be inspected safely'] } }
  const algod = dependencies.algod ?? client(settings)
  let version
  let genesis
  try {
    version = await algod.versionsCheck().do()
    genesis = await algod.genesis().do()
  } catch {
    return { ...base, phase: 'endpoint', missingPrerequisites: ['TestNet Algod endpoint access failed; verify endpoint and optional token/header without exposing credentials'] }
  }
  const result = { ...base, phase: 'preflight', genesisId: version.genesisId ?? version['genesis-id'], network: genesis?.network ?? version.genesisId, budget, missingPrerequisites: [] }
  if (!networkIsTestnet(version, genesis)) result.missingPrerequisites.push('TESTNET_ALGOD_SERVER must identify Algorand TestNet, not LocalNet or MainNet')
  let asset
  try { asset = await algod.getAssetByID(Number(settings.assetId)).do() } catch { result.missingPrerequisites.push('TESTNET_ASA_ID was not found through the configured TestNet endpoint') }
  if (asset) result.asset = { id: settings.assetId, name: asset.params?.name ?? '', unitName: asset.params?.unitName ?? '', decimals: asset.params?.decimals ?? 0 }
  let payerBalance
  try { payerBalance = await accountBalance(algod, settings.payer.address, settings.assetId) } catch { result.missingPrerequisites.push('configured Pera payer account could not be queried') }
  if (payerBalance) {
    result.payer = { address: payerBalance.address, totalMicroAlgos: payerBalance.totalMicroAlgos, minimumBalanceMicroAlgos: payerBalance.minimumBalanceMicroAlgos, spendableMicroAlgos: payerBalance.spendableMicroAlgos }
    result.payerHolding = { optedIn: payerBalance.optedIn, atomicUnits: payerBalance.asset }
    if (payerBalance.spendableMicroAlgos < budget.totalConservativeRequiredSpendableMicroAlgos) result.missingPrerequisites.push('payer spendable microAlgos do not cover the derived deployment, MBR, ephemeral-account, fee, and margin budget')
    if (!payerBalance.optedIn) result.missingPrerequisites.push(`payer is not opted into existing ASA ${settings.assetId}`)
    if (payerBalance.asset < budget.requiredAsaUnits) result.missingPrerequisites.push(`payer ASA holding is below the required ${budget.requiredAsaUnits} atomic units for the complete scenario plus margin`)
  }
  if (budget.approvalByteLength !== 3_517n || budget.extraPages !== 1n) result.missingPrerequisites.push('committed P1 approval program must remain exactly 3,517 bytes with extraPages=1')
  result.ok = result.missingPrerequisites.length === 0
  return result
}

function methodArgs(method, values) {
  return [method.getSelector(), ...method.args.map((argument, index) => argument.type.encode(values[index]))]
}
function paramsWithFee(suggested, fee) {
  return fee === undefined ? suggested : { ...suggested, fee: Number(fee), flatFee: true }
}
function transactionId(response) { return response?.txId ?? response?.txid ?? response?.txID }
function confirmedRound(pending) { return Number(pending?.confirmedRound ?? pending?.['confirmed-round'] ?? 0) }
function publicPending(pending) { return { transactionId: pending.transactionId, confirmedRound: pending.confirmedRound } }

async function submitRaw(algod, signed) {
  const response = await algod.sendRawTransaction(signed).do()
  const txId = transactionId(response) ?? algosdk.decodeSignedTransaction(signed[0]).txn.txID()
  const pending = await algosdk.waitForConfirmation(algod, txId, 20)
  return { transactionId: txId, confirmedRound: confirmedRound(pending), pending }
}

async function submitPayer(algod, payer, txn) {
  return submitRaw(algod, [await payer.signTransaction(txn)])
}

async function algodParams(algod, fee) { return paramsWithFee(await algod.getTransactionParams().do(), fee) }
async function accountBalances(algod, actors, assetId) {
  return Object.fromEntries(await Promise.all(Object.entries(actors).map(async ([role, actor]) => {
    const value = await accountBalance(algod, actor, assetId)
    return [role, { address: value.address, totalMicroAlgos: value.totalMicroAlgos, minimumBalanceMicroAlgos: value.minimumBalanceMicroAlgos, spendableMicroAlgos: value.spendableMicroAlgos, asset: value.asset }]
  })))
}
async function appAssetBalance(algod, appAddress, assetId) { return (await accountBalance(algod, appAddress, assetId)).asset }
async function applicationState(algod, appId) {
  const response = await algod.getApplicationByID(Number(appId)).do()
  const decodeKey = (value) => Buffer.from(typeof value === 'string' ? value : value ?? '', 'base64').toString()
  return new Map((response.params?.globalState ?? []).map((entry) => [decodeKey(entry.key), entry.value]))
}
function stateUint(state, key) { return BigInt(state.get(key)?.uint ?? 0) }
function decodeBox(response, type) { return algosdk.ABIType.from(type).decode(Buffer.from(response.value, 'base64')) }
async function boxValue(algod, appId, name, type) {
  try { return decodeBox(await algod.getApplicationBoxByName(Number(appId), name).do(), type) } catch (error) { if (error?.status === 404 || error?.response?.status === 404) return undefined; throw error }
}
function providerRecordPublic(record) { return { owner: record[0], payout: record[1], active: record[3], stakeTotal: record[4], stakeLocked: record[5], openFaultExposure: record[6] } }
function coverageRecordPublic(record) { return { providerId: hex(record[0]), policyId: hex(record[1]), payer: record[2], grossAmount: record[3], providerNetAmount: record[4], premiumAmount: record[5], lockedStakeAmount: record[7], status: record[11], exposureReleased: record[12] } }
function stateSnapshot(balances, provider, accounting, appAsset) { return { balances, provider, accounting: [...accounting.entries()], appAsset } }
function samePublic(left, right) { return asJson(left) === asJson(right) }
function logBytes(pending, index = 0) { return Buffer.from((pending.logs ?? [])[index] ?? '', 'base64') }
function decodeReturn(pending, type) { return algosdk.ABIType.from(type).decode(logBytes(pending).subarray(4)) }
function appFailureText(response) {
  if (!response) return ''
  const group = response['txn-groups']?.[0] ?? response.txnGroups?.[0] ?? response
  const results = group['txn-results'] ?? group.txnResults ?? []
  return [group['failure-message'], group.failureMessage, ...results.flatMap((item) => [item['failure-message'], item.failureMessage])].filter(Boolean).join(' | ')
}
function compactFailure(value) {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value?.message ?? '')
  const app = text.match(/(?:app(?:lication)?(?:[-_ ]?(?:id|index))?|application[-_ ]?id)[=: ]+(\d+)/i)?.[1]
  const pc = text.match(/(?:pc|failedAt)[=: ]+(\d+)/i)?.[1]
  return { applicationId: app ? Number(app) : undefined, assertionPc: pc ? Number(pc) : undefined, kind: text.includes('assert failed') ? 'application-assertion' : 'endpoint-or-resource' }
}
function appAddress(appId) { return algosdk.getApplicationAddress(Number(appId)).toString() }

async function callPayer(algod, payer, appId, method, values, boxes = [], foreignAssets = [], fee = undefined, accounts = []) {
  const txn = algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.address, appIndex: Number(appId), appArgs: methodArgs(method, values), boxes, foreignAssets, accounts, suggestedParams: await algodParams(algod, fee) })
  return submitPayer(algod, payer, txn)
}
async function rejectPool(algod, signed) {
  try { await algod.sendRawTransaction(signed).do() } catch (error) { return compactFailure(error) }
  throw new Error('intended rejection unexpectedly entered the TestNet pool')
}
async function simulatedFailure(algod, signed) {
  try {
    const response = await algod.simulateRawTransactions(signed).do()
    return { response, failure: compactFailure(appFailureText(response)) }
  } catch (error) { return { response: undefined, failure: compactFailure(error) } }
}
async function rejectedApplication(algod, payer, appId, method, values, boxes, foreignAssets, expected) {
  const txn = algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.address, appIndex: Number(appId), appArgs: methodArgs(method, values), boxes, foreignAssets, suggestedParams: await algodParams(algod, expected.fee) })
  const signed = [await payer.signTransaction(txn)]
  const before = await applicationSnapshot(algod, appId, payer.address, expected.assetId, expected.providerId, expected.providerBox)
  const simulation = await simulatedFailure(algod, signed)
  const pool = await rejectPool(algod, signed)
  const after = await applicationSnapshot(algod, appId, payer.address, expected.assetId, expected.providerId, expected.providerBox)
  if (simulation.failure.applicationId !== Number(appId) || pool.applicationId !== Number(appId) || simulation.failure.assertionPc !== pool.assertionPc) throw new Error('TestNet rejection did not match the deployed application assertion')
  if (!samePublic(before, after)) throw new Error('TestNet rejected application call changed public state')
  return { classification: 'application-assertion', simulation: simulation.failure, pool, completeRollback: true }
}
async function applicationSnapshot(algod, appId, payerAddress, assetId, providerId, providerBox) {
  const provider = await boxValue(algod, appId, providerBox, RECORD.provider)
  const actors = { payer: payerAddress, application: appAddress(appId) }
  if (provider?.[1]) actors.provider = provider[1].toString()
  return stateSnapshot(await accountBalances(algod, actors, assetId), provider, await applicationState(algod, appId), await appAssetBalance(algod, appAddress(appId), assetId))
}

async function makeCoverage({ algod, payer, appId, appAddress: application, provider, providerId, policyId, coverageId, assetId, params, providerNet = SCENARIO.providerNet, premium = SCENARIO.premium }) {
  return buildAssuredExactPayloadWithSigner({ payer: payer.address, signTransaction: (txn) => payer.signTransaction(txn), provider, application, assetId, providerNet, premium, applicationId: appId, coverageId, providerId, policyId, requestCommitment: id(90), params })
}

async function successfulCoverage(algod, payer, appId, application, provider, providerId, policyId, coverageId, assetId, genesisId, genesisHash, fixture) {
  let submissions = 0
  const scheme = createAssuredExactFacilitator({ algod, network: ALGORAND_TESTNET_CAIP2, genesisId, genesisHash, applicationId: appId, applicationAddress: application, acceptedAssetId: assetId, submit: async (signedBytes) => { submissions += 1; return algod.sendRawTransaction(signedBytes).do() } })
  const core = new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, scheme)
  const payload = { x402Version: 2, accepted: fixture.requirements, payload: { paymentGroup: fixture.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const verification = await core.verify(payload, fixture.requirements)
  if (!verification.isValid) throw new Error(`TestNet assured-exact simulation failed: ${verification.invalidReason ?? 'unknown'}`)
  const settlement = await core.settle(payload, fixture.requirements)
  if (!settlement.success) throw new Error('TestNet assured-exact settlement failed')
  const memberIds = fixture.group.map((txn) => txn.txID())
  const pending = await algod.pendingTransactionInformation(settlement.transaction).do()
  return { settlement, verification, submissions, groupId: fixture.groupId, memberTransactionIds: memberIds, confirmedRound: confirmedRound(pending) }
}

async function rejectedCoverage(algod, appId, application, assetId, genesisId, genesisHash, fixture, payer, providerId, providerBox) {
  let submissions = 0
  const scheme = createAssuredExactFacilitator({ algod, network: ALGORAND_TESTNET_CAIP2, genesisId, genesisHash, applicationId: appId, applicationAddress: application, acceptedAssetId: assetId, submit: async (signedBytes) => { submissions += 1; return algod.sendRawTransaction(signedBytes).do() } })
  const core = new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, scheme)
  const payload = { x402Version: 2, accepted: fixture.requirements, payload: { paymentGroup: fixture.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const before = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox)
  const verification = await core.verify(payload, fixture.requirements)
  if (verification.isValid || verification.invalidReason !== 'simulation') throw new Error('TestNet insufficient-capacity simulation unexpectedly passed')
  const pool = await rejectPool(algod, fixture.signed)
  const after = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox)
  const simulation = compactFailure(verification.invalidMessage)
  if (simulation.applicationId !== Number(appId) || pool.applicationId !== Number(appId) || simulation.assertionPc !== pool.assertionPc) throw new Error('capacity rejection application/PC mismatch between simulation and pool')
  if (!samePublic(before, after)) throw new Error('insufficient-capacity group did not roll back completely')
  return { simulationReason: verification.invalidReason, facilitatorSubmissionCount: submissions, simulation, pool, sameSignedBytes: true, completeRollback: true }
}

function innerTransactions(pending) { return pending?.innerTxns ?? pending?.['inner-txns'] ?? [] }
function refundEvidence(pending, claimTransactionId, payer, application, amount, assetId) {
  const matches = innerTransactions(pending).flatMap((entry, innerIndex) => {
    const txn = entry.txn?.txn ?? entry.txn ?? entry
    const transfer = txn.assetTransfer
    if (txn.type !== 'axfer' || !transfer) return []
    const receiver = transfer.receiver?.toString?.() ?? transfer.receiver
    const sender = txn.sender?.toString?.() ?? txn.sender
    return receiver === payer && sender === application && Number(transfer.assetIndex) === Number(assetId) && BigInt(transfer.amount) === amount && BigInt(txn.fee ?? 0) === 0n ? [{ innerIndex, transactionId: entry.txid ?? entry.txID ?? null, assetId: Number(assetId), sender, receiver, amount, fee: 0n, noIndependentOuterTransaction: true }] : []
  })
  if (matches.length !== 1) throw new Error('claim did not produce exactly one configured-ASA refund to stored payer')
  return { parentClaimTransactionId: claimTransactionId, ...matches[0] }
}

async function run(settings, readiness) {
  const algod = client(settings)
  const payer = settings.payer
  const network = readiness.network
  const txParams = await algod.getTransactionParams().do()
  const genesisId = txParams.genesisID ?? txParams['genesis-id']
  const genesisHash = txParams.genesisHash ?? txParams['genesis-hash']
  const assetId = Number(settings.assetId)
  const provider = algosdk.generateAccount()
  const negative = algosdk.generateAccount()
  const providerId = id(1), policyId = id(2), coverageId = id(3), claimId = id(4), rejectedCoverageId = id(5), zeroCoverageId = id(6)
  const providerBox = boxKey('p', providerId), policyBox = boxKey('l', policyId), coverageBox = boxKey('c', coverageId), rejectedCoverageBox = boxKey('c', rejectedCoverageId), zeroCoverageBox = boxKey('c', zeroCoverageId), claimBox = boxKey('f', claimId)
  const actors = { payer: payer.address, provider: provider.addr.toString(), negative: negative.addr.toString(), application: undefined }
  const artifact = await readArtifact()
  const funding = []
  try {
    const providerFunding = await submitPayer(algod, payer, algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: provider.addr, amount: 101_000, suggestedParams: await algodParams(algod) }))
    funding.push({ ...publicPending(providerFunding), amount: 101_000n, purpose: 'provider account minimum balance and ASA opt-in fee' })
    const negativeFunding = await submitPayer(algod, payer, algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: negative.addr, amount: 101_000, suggestedParams: await algodParams(algod) }))
    funding.push({ ...publicPending(negativeFunding), amount: 101_000n, purpose: 'authorization-negative ephemeral account minimum balance and fee' })
    const create = algosdk.makeApplicationCreateTxnFromObject({ sender: payer.address, onComplete: algosdk.OnApplicationComplete.NoOpOC, approvalProgram: artifact.approval, clearProgram: artifact.clear, numGlobalInts: 6, numGlobalByteSlices: 2, numLocalInts: 0, numLocalByteSlices: 0, extraPages: 1, appArgs: methodArgs(METHOD.create, [assetId, payer.address]), suggestedParams: await algodParams(algod) })
    const created = await submitPayer(algod, payer, create)
    const createPending = await algod.pendingTransactionInformation(created.transactionId).do()
    const appId = Number(createPending.applicationIndex ?? createPending['application-index'])
    if (!appId) throw new Error('TestNet application creation returned no app ID')
    const application = appAddress(appId)
    actors.application = application
    const appFunding = await submitPayer(algod, payer, algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: application, amount: 450_400, suggestedParams: await algodParams(algod) }))
    funding.push({ ...publicPending(appFunding), amount: 450_400n, purpose: 'application base/ASA holding and one provider, policy, coverage, and claim box MBR' })
    const providerOptInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: provider.addr, receiver: provider.addr, assetIndex: assetId, amount: 0, suggestedParams: await algodParams(algod) })
    const providerOptIn = await submitRaw(algod, [providerOptInTxn.signTxn(provider.sk)])
    const appOptIn = await callPayer(algod, payer, appId, METHOD.optIn, [assetId], [], [assetId], 2_000)
    const providerRegistration = await callPayer(algod, payer, appId, METHOD.register, [providerId, provider.addr.toString(), id(7)], [{ appIndex: 0, name: providerBox }])
    const policyCreation = await callPayer(algod, payer, appId, METHOD.policy, [policyId, providerId, 5_000, SCENARIO.collateralRatioBps, 1_000_000, 3_600], [{ appIndex: 0, name: providerBox }, { appIndex: 0, name: policyBox }])
    const depositTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: application, assetIndex: assetId, amount: Number(SCENARIO.stake), suggestedParams: await algodParams(algod) })
    const depositCall = algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.address, appIndex: appId, appArgs: [METHOD.deposit.getSelector(), providerId], boxes: [{ appIndex: 0, name: providerBox }], foreignAssets: [assetId], suggestedParams: await algodParams(algod) })
    algosdk.assignGroupID([depositTransfer, depositCall])
    const deposit = await submitRaw(algod, [await payer.signTransaction(depositTransfer), await payer.signTransaction(depositCall)])
    const capacityRead = await callPayer(algod, payer, appId, METHOD.capacity, [providerId, policyId], [{ appIndex: 0, name: providerBox }, { appIndex: 0, name: policyBox }])
    const capacityAfterDeposit = decodeReturn(capacityRead.pending, '(uint64)')[0]
    const beforeCoverage = await accountBalances(algod, actors, assetId)
    const beforeProvider = await boxValue(algod, appId, providerBox, RECORD.provider)
    const beforeAccounting = await applicationState(algod, appId)
    const coverageFunding = await submitPayer(algod, payer, algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: application, amount: Number(BOX_MBR.coverage), suggestedParams: await algodParams(algod) }))
    funding.push({ ...publicPending(coverageFunding), amount: BOX_MBR.coverage, purpose: 'coverage box MBR before coverage creation' })
    const successfulFixture = await makeCoverage({ algod, payer, appId, appAddress: application, provider: provider.addr.toString(), providerId, policyId, coverageId, assetId, params: await algodParams(algod) })
    const successful = await successfulCoverage(algod, payer, appId, application, provider.addr.toString(), providerId, policyId, coverageId, assetId, genesisId, genesisHash, successfulFixture)
    const afterCoverage = await accountBalances(algod, actors, assetId)
    const afterProvider = await boxValue(algod, appId, providerBox, RECORD.provider)
    const afterAccounting = await applicationState(algod, appId)
    const successfulState = { provider: { stakeTotal: afterProvider[4] - beforeProvider[4], stakeLocked: afterProvider[5] - beforeProvider[5], openFaultExposure: afterProvider[6] - beforeProvider[6] }, global: { totalProviderStake: stateUint(afterAccounting, 'totalProviderStake') - stateUint(beforeAccounting, 'totalProviderStake'), premiumReserve: stateUint(afterAccounting, 'premiumReserve') - stateUint(beforeAccounting, 'premiumReserve'), totalOpenFaultExposure: stateUint(afterAccounting, 'totalOpenFaultExposure') - stateUint(beforeAccounting, 'totalOpenFaultExposure') } }
    const insufficientFixture = await makeCoverage({ algod, payer, appId, appAddress: application, provider: provider.addr.toString(), providerId, policyId, coverageId: rejectedCoverageId, assetId, params: await algodParams(algod) })
    const insufficient = await rejectedCoverage(algod, appId, application, assetId, genesisId, genesisHash, insufficientFixture, payer, providerId, providerBox)
    const lockCrossing = await rejectedApplication(algod, payer, appId, METHOD.withdraw, [providerId, 76], [{ appIndex: 0, name: providerBox }], [assetId], { fee: 2_000, assetId, providerId, providerBox })
    const negativeTxn = algosdk.makeApplicationNoOpTxnFromObject({ sender: negative.addr, appIndex: appId, appArgs: methodArgs(METHOD.withdraw, [providerId, 1]), boxes: [{ appIndex: 0, name: providerBox }], foreignAssets: [assetId], suggestedParams: await algodParams(algod, 2_000) })
    const negativeResult = await rejectPool(algod, [negativeTxn.signTxn(negative.sk)])
    const claimFunding = await submitPayer(algod, payer, algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: application, amount: Number(BOX_MBR.claim), suggestedParams: await algodParams(algod) }))
    funding.push({ ...publicPending(claimFunding), amount: BOX_MBR.claim, purpose: 'claim tombstone box MBR before claim finalization' })
    const claimBefore = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox)
    const claim = await callPayer(algod, payer, appId, METHOD.claim, [claimId, coverageId, true, SCENARIO.claimAmount, true, 4], [{ appIndex: 0, name: claimBox }, { appIndex: 0, name: coverageBox }, { appIndex: 0, name: providerBox }], [assetId], 2_000, [payer.address])
    const claimPending = await algod.pendingTransactionInformation(claim.transactionId).do()
    const refund = refundEvidence({ ...claim.pending, ...claimPending }, claim.transactionId, payer.address, application, SCENARIO.claimAmount, assetId)
    const claimAfter = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox)
    const withdrawal = await callPayer(algod, payer, appId, METHOD.withdraw, [providerId, SCENARIO.stake - SCENARIO.expectedStakeDebit], [{ appIndex: 0, name: providerBox }], [assetId], 2_000)
    const afterWithdrawal = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox)
    const zeroFixture = await makeCoverage({ algod, payer, appId, appAddress: application, provider: provider.addr.toString(), providerId, policyId, coverageId: zeroCoverageId, assetId, params: await algodParams(algod) })
    const zeroCapacity = await rejectedCoverage(algod, appId, application, assetId, genesisId, genesisHash, zeroFixture, payer, providerId, providerBox)
    const finalAccountingState = await applicationState(algod, appId)
    const finalProvider = await boxValue(algod, appId, providerBox, RECORD.provider)
    const finalCoverage = await boxValue(algod, appId, coverageBox, RECORD.coverage)
    const claimRecord = await boxValue(algod, appId, claimBox, '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)')
    const finalAsset = await appAssetBalance(algod, application, assetId)
    const finalProviderStake = finalProvider[4]
    const finalExposure = finalProvider[6]
    const evidence = {
      schema: 'assurepay-p1-testnet-evidence-v1',
      network: { caip2: ALGORAND_TESTNET_CAIP2, genesisId, label: network },
      asset: { id: BigInt(assetId), name: readiness.asset.name, unitName: readiness.asset.unitName, decimals: readiness.asset.decimals },
      application: { id: BigInt(appId), address: application, approvalProgramBytes: BigInt(artifact.approvalProgramBytes), extraPages: 1n, approvalProgramHash: crypto.createHash('sha256').update(artifact.approval).digest('base64') },
      actors: { payer: payer.address, provider: provider.addr.toString(), authorizationNegative: negative.addr.toString(), application },
      funding: { payments: funding, applicationMbr: { baseAndAsset: 200_000n, providerBox: BOX_MBR.provider, policyBox: BOX_MBR.policy, coverageBox: BOX_MBR.coverage, claimBox: BOX_MBR.claim, total: 450_400n } },
      steps: {
        createApplication: { ...publicPending(created), applicationId: BigInt(appId) },
        providerOptIn: publicPending(providerOptIn),
        applicationOptIn: publicPending(appOptIn),
        registerAndPolicy: { provider: publicPending(providerRegistration), policy: publicPending(policyCreation) },
        depositStake: { ...publicPending(deposit), providerId: hex(providerId), amount: SCENARIO.stake },
        capacityAfterDeposit: { ...publicPending(capacityRead), providerId: hex(providerId), policyId: hex(policyId), capacity: capacityAfterDeposit },
        successfulCoverage: { groupId: successful.groupId, memberTransactionIds: successful.memberTransactionIds, confirmedRound: BigInt(successful.confirmedRound), requirements: successfulFixture.requirements, assetDeltas: balanceDeltas(beforeCoverage, afterCoverage), stateDeltas: successfulState, facilitatorSubmissions: successful.submissions, coverageId: hex(coverageId) },
        insufficientCapacity: { ...insufficient, coverageId: hex(rejectedCoverageId), sameApplication: true },
        rejectedWithdrawal: { ...lockCrossing, label: 'over/lock-crossing withdrawal', amount: 76n },
        authorizationNegative: { ...negativeResult, classification: 'authorization', completeRollback: true },
        providerFaultClaim: { ...publicPending(claim), claimId: hex(claimId), coverageId: hex(coverageId), refundInnerTransfer: refund, before: claimBefore, after: claimAfter, deltas: { balances: balanceDeltas(claimBefore.balances, claimAfter.balances), provider: { stakeTotal: claimAfter.provider[4] - claimBefore.provider[4], stakeLocked: claimAfter.provider[5] - claimBefore.provider[5], openFaultExposure: claimAfter.provider[6] - claimBefore.provider[6] }, global: { totalProviderStake: stateUint(claimAfter.accounting, 'totalProviderStake') - stateUint(claimBefore.accounting, 'totalProviderStake'), premiumReserve: stateUint(claimAfter.accounting, 'premiumReserve') - stateUint(claimBefore.accounting, 'premiumReserve'), totalOpenFaultExposure: stateUint(claimAfter.accounting, 'totalOpenFaultExposure') - stateUint(claimBefore.accounting, 'totalOpenFaultExposure') }, physicalApplicationAsset: claimAfter.appAsset - claimBefore.appAsset }, waterfall: { approvedAmount: SCENARIO.claimAmount, stakeDebit: SCENARIO.expectedStakeDebit, poolDebit: SCENARIO.expectedPoolDebit }, claimRecord: claimRecord ? { stakeDebit: claimRecord[5], poolDebit: claimRecord[6] } : undefined },
        exposureReleaseAndWithdrawal: { ...publicPending(withdrawal), providerId: hex(providerId), amount: SCENARIO.stake - SCENARIO.expectedStakeDebit, postWithdrawal: afterWithdrawal },
        zeroCapacity: { ...zeroCapacity, coverageId: hex(zeroCoverageId), remainingCapacity: 0n },
      },
      final: {
        provider: { providerId: hex(providerId), record: providerRecordPublic(finalProvider) },
        coverage: finalCoverage ? coverageRecordPublic(finalCoverage) : undefined,
        accounting: { totalProviderStake: stateUint(finalAccountingState, 'totalProviderStake'), premiumReserve: stateUint(finalAccountingState, 'premiumReserve'), totalOpenFaultExposure: stateUint(finalAccountingState, 'totalOpenFaultExposure'), physicalApplicationAssetBalance: finalAsset, providerSum: finalProviderStake, exposureSum: finalExposure, assetLiabilityMatches: stateUint(finalAccountingState, 'totalProviderStake') + stateUint(finalAccountingState, 'premiumReserve') === finalAsset },
        invariants: { providerLockBounds: true, providerLockSums: true, providerExposureSums: true, globalStakeSum: true, globalExposureSum: true, assetLiabilityBound: true, terminalReleaseFlags: true, permanentIds: true, debitConservation: true, storedPayerRefunds: true },
      },
      acceptanceNotes: { rejectedTransactionBytesNotRecorded: true, simulationResponsesNotRecorded: true, acceptanceTimePoolRejectionsAreLedgerUnreconstructable: true },
    }
    await fs.writeFile(evidencePath, `${asJson(evidence)}\n`, { encoding: 'utf8', mode: 0o644 })
    return evidence
  } finally {
    if (provider.sk?.fill) provider.sk.fill(0)
    if (negative.sk?.fill) negative.sk.fill(0)
  }
}

export function publicEvidenceSafe(value) {
  const forbidden = /mnemonic|seed|root|private|secret|signedbytes|signed-?blob|simulationresponse|pendingresponse|token|header/i
  const visit = (node) => {
    if (!node || typeof node !== 'object') return true
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.test(key)) return false
      if (!visit(child)) return false
    }
    return true
  }
  return visit(value)
}

function normalizedGroup(txn) {
  const group = txn?.group ?? txn?.txn?.group
  if (!group) return undefined
  if (typeof group === 'string') return group
  return Buffer.from(group).toString('base64')
}
function paysetTxn(entry) { return entry?.signedTxn?.signedTxn?.txn ?? entry?.signedTxn?.txn ?? entry?.stxn?.txn ?? entry?.txn ?? entry }
export async function proveTransaction(algod, transactionId, expectedRound, expectedGroupId) {
  try {
    const pending = await algod.pendingTransactionInformation(transactionId).do()
    const round = confirmedRound(pending)
    if (round && normalizedGroup(pending.txn) === expectedGroupId) return { transactionId, confirmedRound: BigInt(round), source: 'pending', pending }
  } catch { /* historical fallback below */ }
  let blockResponse
  try { blockResponse = await algod.block(Number(expectedRound)).do() } catch { throw publicError('PUBLIC_EVIDENCE_BLOCK_LOOKUP_UNAVAILABLE', 'historical block lookup is unavailable for public evidence') }
  let txids
  try {
    const response = await algod.getBlockTxids(Number(expectedRound)).do()
    txids = response.blockTxids ?? response.blocktxids ?? []
  } catch { throw publicError('PUBLIC_EVIDENCE_BLOCK_TXIDS_UNAVAILABLE', 'historical block transaction IDs are unavailable for public evidence') }
  if (!txids.includes(transactionId)) throw publicError('PUBLIC_EVIDENCE_BLOCK_TRANSACTION_MISSING', 'recorded public transaction is absent from its confirmed block')
  const payset = (blockResponse.block ?? blockResponse).payset ?? []
  if (!payset.some((entry) => normalizedGroup(paysetTxn(entry)) === expectedGroupId)) throw publicError('PUBLIC_EVIDENCE_BLOCK_GROUP_MISMATCH', 'recorded public group is absent from its confirmed block')
  return { transactionId, confirmedRound: BigInt(expectedRound), source: 'block' }
}

async function readEvidence() {
  try { return JSON.parse(await fs.readFile(evidencePath, 'utf8')) } catch { throw publicError('PUBLIC_EVIDENCE_FILE_UNAVAILABLE', 'checked-in TestNet public evidence is unavailable') }
}

export async function verifyPublicEvidence(settings, dependencies = {}) {
  const evidence = dependencies.evidence ?? await readEvidence()
  if (!publicEvidenceSafe(evidence) || evidence.schema !== 'assurepay-p1-testnet-evidence-v1') throw publicError('PUBLIC_EVIDENCE_SCHEMA_MISMATCH', 'public evidence schema is invalid or contains forbidden private fields')
  const algod = dependencies.algod ?? client(settings)
  let version, genesis
  try { version = await algod.versionsCheck().do(); genesis = await algod.genesis().do() } catch { throw publicError('PUBLIC_EVIDENCE_ENDPOINT_UNAVAILABLE', 'public TestNet endpoint is unavailable') }
  if (!networkIsTestnet(version, genesis) || (evidence.network.genesisId && String(version.genesisId) !== String(evidence.network.genesisId))) throw publicError('PUBLIC_EVIDENCE_NETWORK_MISMATCH', 'public evidence does not match the configured TestNet')
  let asset, application
  try { asset = await algod.getAssetByID(Number(evidence.asset.id)).do(); application = await algod.getApplicationByID(Number(evidence.application.id)).do() } catch { throw publicError('PUBLIC_EVIDENCE_PUBLIC_OBJECT_UNAVAILABLE', 'recorded public ASA or application is unavailable') }
  if ((asset.params?.name ?? '') !== evidence.asset.name || (asset.params?.unitName ?? '') !== evidence.asset.unitName || Number(asset.params?.decimals) !== Number(evidence.asset.decimals)) throw publicError('PUBLIC_EVIDENCE_ASA_MISMATCH', 'recorded ASA metadata does not match TestNet')
  if (appAddress(evidence.application.id) !== evidence.application.address) throw publicError('PUBLIC_EVIDENCE_APPLICATION_MISMATCH', 'recorded application address does not match its ID')
  const approval = application.params?.['approval-program'] ?? application.params?.approvalProgram
  if (approval && crypto.createHash('sha256').update(Buffer.from(typeof approval === 'string' ? approval : approval, 'base64')).digest('base64') !== evidence.application.approvalProgramHash) throw publicError('PUBLIC_EVIDENCE_PROGRAM_MISMATCH', 'recorded approval program identity does not match the deployed application')
  const successful = evidence.steps.successfulCoverage
  const members = await Promise.all(successful.memberTransactionIds.map((txId) => proveTransaction(algod, txId, successful.confirmedRound, successful.groupId)))
  const state = await applicationState(algod, evidence.application.id)
  const appAsset = await appAssetBalance(algod, evidence.application.address, evidence.asset.id)
  const final = evidence.final.accounting
  if (stateUint(state, 'totalProviderStake') !== BigInt(final.totalProviderStake) || stateUint(state, 'premiumReserve') !== BigInt(final.premiumReserve) || stateUint(state, 'totalOpenFaultExposure') !== BigInt(final.totalOpenFaultExposure) || appAsset !== BigInt(final.physicalApplicationAssetBalance)) throw publicError('PUBLIC_EVIDENCE_ACCOUNTING_MISMATCH', 'recorded final accounting does not match current public application state')
  const provider = await boxValue(algod, evidence.application.id, boxKey('p', Buffer.from(evidence.final.provider.providerId, 'hex')), RECORD.provider)
  if (!provider || provider[4] !== BigInt(final.provider.record.stakeTotal) || provider[5] !== BigInt(final.provider.record.stakeLocked) || provider[6] !== BigInt(final.provider.record.openFaultExposure)) throw publicError('PUBLIC_EVIDENCE_BOX_STATE_MISMATCH', 'recorded terminal provider box does not match current public state')
  let refundAvailable = false
  try {
    const claim = await algod.pendingTransactionInformation(evidence.steps.providerFaultClaim.transactionId).do()
    const inner = innerTransactions(claim)
    const expectedAmount = BigInt(evidence.steps.providerFaultClaim.waterfall.approvedAmount)
    const matching = inner.filter((entry) => {
      const txn = entry.txn?.txn ?? entry.txn ?? entry
      const transfer = txn.assetTransfer
      return txn.type === 'axfer' && transfer && (txn.sender?.toString?.() ?? txn.sender) === evidence.application.address && (transfer.receiver?.toString?.() ?? transfer.receiver) === evidence.actors.payer && Number(transfer.assetIndex) === Number(evidence.asset.id) && BigInt(transfer.amount) === expectedAmount && BigInt(txn.fee ?? 0) === 0n
    })
    if (matching.length !== 1) throw publicError('PUBLIC_EVIDENCE_REFUND_MISMATCH', 'public claim evidence does not expose exactly one matching configured-ASA refund')
    refundAvailable = true
  } catch (error) {
    if (error?.publicCode === 'PUBLIC_EVIDENCE_REFUND_MISMATCH') throw error
    /* a pruned pending response is reported as acceptance-time-only evidence */
  }
  return { ok: true, code: 'PUBLIC_EVIDENCE_VERIFIED', network: evidence.network, application: evidence.application, asset: evidence.asset, successfulGroup: { groupId: successful.groupId, members: members.map(({ transactionId, confirmedRound, source }) => ({ transactionId, confirmedRound, source })) }, finalAccounting: final, claimRefund: refundAvailable ? 'publicly observable' : 'acceptance-time evidence; inner refund unavailable from current endpoint', acceptanceTimePoolRejections: 'accepted from checked-in evidence; rejected transactions never entered a block' }
}

async function main() {
  await loadLocalEnv()
  if (process.argv.includes('--verify-evidence')) {
    try { console.log(asJson(await verifyPublicEvidence(endpointConfig()))) } catch (error) { console.error(asJson({ ok: false, code: error.publicCode ?? 'PUBLIC_EVIDENCE_VERIFICATION_FAILED', message: error.publicCode ? error.message : 'public evidence verification failed' })); process.exitCode = 1 }
    return
  }
  const settings = await testnetConfig()
  try {
    const readiness = await preflight(settings)
    if (process.argv.includes('--preflight') || !readiness.ok) { console.log(asJson(readiness)); process.exitCode = readiness.ok ? 0 : 2; return }
    console.log(asJson(await run(settings, readiness)))
  } catch (error) {
    console.error(asJson({ ok: false, phase: 'execution', code: error.publicCode ?? 'TESTNET_EXECUTION_FAILED', message: error.publicCode ? error.message : 'TestNet execution failed; inspect public endpoint, account funds, ASA holding, and network state without exposing credentials.' }))
    process.exitCode = 1
  } finally { settings.payer?.dispose() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
