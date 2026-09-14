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
export const SCENARIO = Object.freeze({
  gross: 100n,
  providerNet: 50n,
  premium: 50n,
  stake: 123n,
  unrelatedStake: 10n,
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

function failureText(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (!value || typeof value !== 'object') return String(value ?? '')
  return [value.message, value['failure-message'], value.failureMessage, value.invalidMessage, value.error].filter(Boolean).join(' | ')
}

export function compactFailure(value) {
  const text = failureText(value)
  const app = text.match(/(?:app(?:lication)?(?:[-_ ]?(?:id|index))?|application[-_ ]?id)[=: ]+(\d+)/i)?.[1]
  const pc = text.match(/(?:pc|failed(?:[-_ ]?at)?)[=: ]+(\d+)/i)?.[1]
  return {
    applicationId: app ? Number(app) : undefined,
    assertionPc: pc ? Number(pc) : undefined,
    kind: /assert(?:ion)?\s+failed|logic\s+eval\s+error/i.test(text) && app && pc ? 'application-assertion' : 'endpoint-or-resource',
  }
}

export function isIntendedApplicationAssertionFailure(value, appId, expectedPc) {
  const failure = value?.kind ? value : compactFailure(value)
  return failure.kind === 'application-assertion' && failure.applicationId === Number(appId) && Number.isInteger(failure.assertionPc) && (expectedPc === undefined || failure.assertionPc === Number(expectedPc))
}

export function matchApplicationAssertionFailures(simulation, pool, appId) {
  const left = simulation?.kind ? simulation : compactFailure(simulation)
  const right = pool?.kind ? pool : compactFailure(pool)
  if (!isIntendedApplicationAssertionFailure(left, appId) || !isIntendedApplicationAssertionFailure(right, appId)) return false
  return left.assertionPc === right.assertionPc
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

export function plannedTransactionTable() {
  const payment = (name, purpose, fee = MIN_TX_FEE, charged = true) => ({ name, purpose, payer: 'payer', fee: BigInt(fee), charged })
  const appCall = (name, purpose, fee = MIN_TX_FEE, charged = true) => ({ name, purpose, payer: 'payer', fee: BigInt(fee), charged })
  return [
    payment('fund-primary-provider', 'primary provider retained balance, ASA opt-in, and opt-in fee'),
    payment('fund-authorization-negative', 'authorization-negative retained minimum balance and exact 2,000 fee'),
    appCall('create-application', 'application creation minimum balance'),
    payment('fund-application-base-and-asset', 'application base plus accepted-ASA holding'),
    payment('fund-primary-provider-box', 'primary provider record box MBR'),
    payment('fund-unrelated-provider-box', 'unrelated provider record box MBR'),
    payment('fund-policy-box', 'primary policy record box MBR'),
    payment('fund-coverage-box', 'successful coverage tombstone box MBR'),
    payment('fund-claim-box', 'claim tombstone box MBR'),
    appCall('application-asset-opt-in', 'application accepted-ASA opt-in', 2_000),
    appCall('register-primary-provider', 'primary provider registration'),
    appCall('register-unrelated-provider', 'unrelated provider registration'),
    appCall('create-policy', 'primary policy creation'),
    payment('deposit-primary-asset', 'primary provider stake transfer'),
    appCall('deposit-primary', 'primary provider stake accounting call'),
    payment('deposit-unrelated-asset', 'unrelated provider stake transfer'),
    appCall('deposit-unrelated', 'unrelated provider stake accounting call'),
    appCall('read-capacity', 'capacity read application call'),
    payment('successful-provider-transfer', 'successful coverage provider-net transfer'),
    payment('successful-premium-transfer', 'successful coverage premium transfer'),
    appCall('successful-coverage', 'successful coverage application call'),
    appCall('provider-fault-claim', 'provider-fault claim application call', 2_000),
    appCall('released-provider-withdrawal', 'released primary provider withdrawal', 2_000),
    appCall('rejected-lock-crossing-withdrawal', 'rejected lock-crossing application call', 2_000, false),
  ]
}

function sumFees(table, predicate = () => true) { return table.filter(predicate).reduce((sum, item) => sum + item.fee, 0n) }

export function calculateTestnetBudget({ minTxnFee = MIN_TX_FEE, approvalProgramBytes = 3_517, extraPages = 1, scenario = SCENARIO, providerCount = 2 } = {}) {
  const fee = BigInt(minTxnFee)
  const appCreationMinBalance = 100_000n + 28_500n * 6n + 50_000n * 2n + 100_000n * BigInt(extraPages)
  const applicationBaseAndAssetMinBalance = 100_000n + 100_000n
  const applicationFundingLines = Object.freeze({
    baseAndAsset: applicationBaseAndAssetMinBalance,
    providerBox: BOX_MBR.provider,
    ...(Number(providerCount) >= 2 ? { unrelatedProviderBox: BOX_MBR.provider } : {}),
    policyBox: BOX_MBR.policy,
    coverageBox: BOX_MBR.coverage,
    claimBox: BOX_MBR.claim,
  })
  const applicationFundingTotal = Object.values(applicationFundingLines).reduce((sum, amount) => sum + amount, 0n)
  const ephemeralFundingLines = Object.freeze({
    primaryProvider: 100_000n + 100_000n + fee,
    authorizationNegative: 100_000n + 2_000n,
  })
  const ephemeralAccountFundingBudget = Object.values(ephemeralFundingLines).reduce((sum, amount) => sum + amount, 0n)
  const plannedTransactions = plannedTransactionTable().map((item) => ({ ...item, fee: item.fee === MIN_TX_FEE ? fee : item.fee }))
  const payerPaidTransactionFees = sumFees(plannedTransactions, (item) => item.payer === 'payer' && item.charged)
  const plannedPayerTransactionFees = sumFees(plannedTransactions, (item) => item.payer === 'payer')
  const ephemeralTransactionFees = fee + 2_000n
  const conservativeMargin = BigInt(scenario.algoMargin)
  const totalConservativeRequiredSpendableMicroAlgos = appCreationMinBalance + applicationFundingTotal + ephemeralAccountFundingBudget + payerPaidTransactionFees + conservativeMargin
  const unrelatedStake = Number(providerCount) >= 2 ? BigInt(scenario.unrelatedStake) : 0n
  const requiredAsaUnits = BigInt(scenario.stake) + unrelatedStake + BigInt(scenario.gross) + BigInt(scenario.asaMargin)
  return {
    approvalByteLength: BigInt(approvalProgramBytes),
    extraPages: BigInt(extraPages),
    appCreationMinBalance,
    applicationBaseAndAssetMinBalance,
    boxMbr: BOX_MBR,
    applicationFundingLines,
    calculatedApplicationBoxFundingBudget: applicationFundingTotal,
    applicationBoxFundingBudget: applicationFundingTotal,
    applicationFundingTotal,
    ephemeralFundingLines,
    ephemeralAccountFundingBudget,
    feeBudget: payerPaidTransactionFees,
    payerTransactionFeeBudget: payerPaidTransactionFees,
    payerPaidTransactionFees,
    plannedPayerTransactionFees,
    ephemeralTransactionFeeBudget: ephemeralTransactionFees,
    ephemeralFundingIncludesFees: true,
    conservativeMargin,
    totalConservativeRequiredSpendableMicroAlgos,
    requiredAsaUnits,
    requiredAsaScenario: { primaryStake: scenario.stake, unrelatedProviderStake: unrelatedStake, successfulCoverageGross: scenario.gross, margin: scenario.asaMargin, equation: `${scenario.stake} + ${unrelatedStake} + ${scenario.gross} + ${scenario.asaMargin} = ${requiredAsaUnits}` },
    spendableEquation: `${appCreationMinBalance} + ${applicationFundingTotal} + ${ephemeralAccountFundingBudget} + ${payerPaidTransactionFees} + ${conservativeMargin} = ${totalConservativeRequiredSpendableMicroAlgos}`,
    feeEquation: `payer-paid ${payerPaidTransactionFees}; planned including uncharged rejection ${plannedPayerTransactionFees}; ephemeral funding includes ${ephemeralTransactionFees}`,
    plannedTransactions,
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
  } catch (error) {
    if (error?.status !== 404 && error?.response?.status !== 404) throw publicError('PUBLIC_PREFLIGHT_ASA_HOLDING_UNAVAILABLE', 'configured ASA holding could not be read from the public endpoint')
  }
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
    return { ...base, phase: 'endpoint', code: 'PUBLIC_PREFLIGHT_ENDPOINT_UNAVAILABLE', missingPrerequisites: ['TestNet Algod endpoint access failed; verify endpoint and optional token/header without exposing credentials'] }
  }
  const result = { ...base, phase: 'preflight', genesisId: version.genesisId ?? version['genesis-id'], network: genesis?.network ?? version.genesisId, budget, missingPrerequisites: [] }
  if (!networkIsTestnet(version, genesis)) result.missingPrerequisites.push('TESTNET_ALGOD_SERVER must identify Algorand TestNet, not LocalNet or MainNet')
  let asset
  try { asset = await algod.getAssetByID(Number(settings.assetId)).do() } catch (error) {
    if (error?.status === 404 || error?.response?.status === 404) result.missingPrerequisites.push('TESTNET_ASA_ID was not found through the configured TestNet endpoint')
    else { result.code = 'PUBLIC_PREFLIGHT_ASA_UNAVAILABLE'; result.missingPrerequisites.push('configured ASA could not be read from the public endpoint') }
  }
  if (asset) result.asset = { id: settings.assetId, name: asset.params?.name ?? '', unitName: asset.params?.unitName ?? '', decimals: asset.params?.decimals ?? 0 }
  let payerBalance
  try { payerBalance = await accountBalance(algod, settings.payer.address, settings.assetId) } catch (error) {
    result.code = error?.publicCode ?? 'PUBLIC_PREFLIGHT_ACCOUNT_UNAVAILABLE'
    result.missingPrerequisites.push('configured Pera payer account or ASA holding could not be queried from the public endpoint')
  }
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
function signedGroupId(signed) {
  const txn = algosdk.decodeSignedTransaction(signed[0]).txn
  return txn.group ? Buffer.from(txn.group).toString('base64') : undefined
}
function publicPending(pending) { return { transactionId: pending.transactionId, confirmedRound: pending.confirmedRound, ...(pending.groupId ? { groupId: pending.groupId } : {}) } }

async function submitRaw(algod, signed) {
  const response = await algod.sendRawTransaction(signed).do()
  const txId = transactionId(response) ?? algosdk.decodeSignedTransaction(signed[0]).txn.txID()
  const pending = await algosdk.waitForConfirmation(algod, txId, 20)
  return { transactionId: txId, confirmedRound: confirmedRound(pending), groupId: signedGroupId(signed), pending }
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
function appAddress(appId) { return algosdk.getApplicationAddress(Number(appId)).toString() }

async function callPayer(algod, payer, appId, method, values, boxes = [], foreignAssets = [], fee = undefined, accounts = []) {
  const txn = algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.address, appIndex: Number(appId), appArgs: methodArgs(method, values), boxes, foreignAssets, accounts, suggestedParams: await algodParams(algod, fee) })
  return submitPayer(algod, payer, txn)
}
async function rejectPool(algod, signed) {
  try { await algod.sendRawTransaction(signed).do() } catch (error) {
    const failure = compactFailure(error)
    if (failure.kind === 'application-assertion') return failure
    throw publicError('TESTNET_REJECTION_ENDPOINT_OR_RESOURCE', 'the rejected transaction returned a non-application public failure')
  }
  throw publicError('TESTNET_REJECTION_ACCEPTED', 'an intended rejected transaction entered the TestNet pool')
}
async function simulatedFailure(algod, signed) {
  try {
    const response = await algod.simulateRawTransactions(signed).do()
    return compactFailure(appFailureText(response))
  } catch (error) {
    throw publicError('TESTNET_SIMULATION_ENDPOINT_OR_RESOURCE', 'simulation returned a non-application public failure')
  }
}
export function sameSignedByteArrays(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Buffer.from(value).equals(Buffer.from(right[index])))
}

export async function rejectedApplication(algod, signer, appId, method, values, boxes, foreignAssets, expected) {
  const txn = algosdk.makeApplicationNoOpTxnFromObject({ sender: signer.address, appIndex: Number(appId), appArgs: methodArgs(method, values), boxes, foreignAssets, accounts: expected.accounts ?? [], suggestedParams: await algodParams(algod, expected.fee) })
  const signed = [await signer.signTransaction(txn)]
  const before = await applicationSnapshot(algod, appId, signer.address, expected.assetId, expected.providerId, expected.providerBox, expected.snapshot)
  const simulation = await simulatedFailure(algod, signed)
  const pool = await rejectPool(algod, signed)
  const after = await applicationSnapshot(algod, appId, signer.address, expected.assetId, expected.providerId, expected.providerBox, expected.snapshot)
  if (!matchApplicationAssertionFailures(simulation, pool, appId)) throw publicError('TESTNET_REJECTION_ASSERTION_MISMATCH', 'simulation and pool rejection did not match the deployed application assertion')
  if (!samePublic(before, after)) throw publicError('TESTNET_REJECTION_ROLLBACK_MISMATCH', 'rejected application state was not fully rolled back')
  return { classification: 'application-assertion', simulation, pool, sameSignedBytes: true, completeRollback: true, before, after }
}

async function applicationSnapshot(algod, appId, payerAddress, assetId, providerId, providerBox, options = {}) {
  const actors = { payer: payerAddress, application: appAddress(appId), ...(options.actors ?? {}) }
  const provider = await boxValue(algod, appId, providerBox, RECORD.provider)
  if (provider?.[1] && !actors.provider) actors.provider = provider[1].toString()
  const boxes = [{ name: providerBox, type: RECORD.provider }, ...(options.boxes ?? [])]
  const boxState = Object.fromEntries(await Promise.all(boxes.map(async ({ name, type }) => [hex(name), await boxValue(algod, appId, name, type)])))
  const balances = await accountBalances(algod, actors, assetId)
  const application = balances.application
  return { balances, boxes: boxState, provider, accounting: [...(await applicationState(algod, appId)).entries()], appAsset: application.asset, applicationMbr: application.minimumBalanceMicroAlgos }
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

async function rejectedCoverage(algod, appId, application, assetId, genesisId, genesisHash, fixture, payer, providerId, providerBox, snapshot = {}) {
  let submissions = 0
  const scheme = createAssuredExactFacilitator({ algod, network: ALGORAND_TESTNET_CAIP2, genesisId, genesisHash, applicationId: appId, applicationAddress: application, acceptedAssetId: assetId, submit: async (signedBytes) => { submissions += 1; return algod.sendRawTransaction(signedBytes).do() } })
  const core = new x402Facilitator().register(ALGORAND_TESTNET_CAIP2, scheme)
  const payload = { x402Version: 2, accepted: fixture.requirements, payload: { paymentGroup: fixture.paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2 } }
  const before = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox, snapshot)
  const verification = await core.verify(payload, fixture.requirements)
  if (verification.isValid || verification.invalidReason !== 'simulation') throw new Error('TestNet insufficient-capacity simulation unexpectedly passed')
  if (!sameSignedByteArrays(fixture.signed, fixture.paymentGroup.map((encoded) => Buffer.from(encoded, 'base64')))) throw publicError('TESTNET_SIGNED_BYTES_MISMATCH', 'simulation and pool paths did not receive identical signed transaction bytes')
  const pool = await rejectPool(algod, fixture.signed)
  const after = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox, snapshot)
  const simulation = compactFailure(verification.invalidMessage)
  if (!matchApplicationAssertionFailures(simulation, pool, appId)) throw publicError('TESTNET_REJECTION_ASSERTION_MISMATCH', 'capacity rejection application and PC did not match between simulation and pool')
  if (!samePublic(before, after)) throw publicError('TESTNET_REJECTION_ROLLBACK_MISMATCH', 'insufficient-capacity group did not roll back completely')
  return { simulationReason: verification.invalidReason, facilitatorSubmissionCount: submissions, simulation, pool, sameSignedBytes: true, completeRollback: true }
}

function innerTransactions(pending) { return pending?.innerTxns ?? pending?.['inner-txns'] ?? pending?.txn?.innerTxns ?? pending?.txn?.['inner-txns'] ?? [] }
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

export function computeLifecycleInvariants({ providers, coverages, claims, accounting, physicalApplicationAsset, rejectedBoxes = [], claimDelta, refund }) {
  const providerRecords = providers.map((item) => item.record ?? item)
  const coverageRecords = coverages.map((item) => item.record ?? item)
  const providerStakeSum = providerRecords.reduce((sum, record) => sum + BigInt(record.stakeTotal ?? record[4] ?? 0), 0n)
  const providerLockSum = providerRecords.reduce((sum, record) => sum + BigInt(record.stakeLocked ?? record[5] ?? 0), 0n)
  const providerExposureSum = providerRecords.reduce((sum, record) => sum + BigInt(record.openFaultExposure ?? record[6] ?? 0), 0n)
  const open = coverageRecords.filter((record) => Number(record.status ?? record[11]) === 1 && !(record.exposureReleased ?? record[12]))
  const openLockSum = open.reduce((sum, record) => sum + BigInt(record.lockedStakeAmount ?? record[7] ?? 0), 0n)
  const openExposureSum = open.reduce((sum, record) => sum + BigInt(record.grossAmount ?? record[3] ?? 0), 0n)
  const claimRecord = claims?.[0]?.record ?? claims?.[0]
  const approved = BigInt(claimDelta?.approvedAmount ?? claimRecord?.approvedAmount ?? claimRecord?.[2] ?? 0)
  const stakeDebit = BigInt(claimDelta?.stakeDebit ?? claimRecord?.stakeDebit ?? claimRecord?.[5] ?? 0)
  const poolDebit = BigInt(claimDelta?.poolDebit ?? claimRecord?.poolDebit ?? claimRecord?.[6] ?? 0)
  const physicalDelta = BigInt(claimDelta?.physicalApplicationAsset ?? 0)
  const flags = {
    providerLockBounds: providerRecords.every((record) => BigInt(record.stakeLocked ?? record[5] ?? 0) <= BigInt(record.stakeTotal ?? record[4] ?? 0)),
    providerLockSums: providerLockSum === openLockSum,
    providerExposureSums: providerExposureSum === openExposureSum,
    globalStakeSum: providerStakeSum === BigInt(accounting.totalProviderStake),
    globalExposureSum: providerExposureSum === BigInt(accounting.totalOpenFaultExposure),
    assetLiabilityBound: BigInt(accounting.totalProviderStake) + BigInt(accounting.premiumReserve) === BigInt(physicalApplicationAsset),
    terminalReleaseFlags: coverageRecords.every((record) => Number(record.status ?? record[11]) !== 1 || Boolean(record.exposureReleased ?? record[12]) === false) && (claimRecord ? Boolean(claimRecord.finalized ?? claimRecord[1]) : false),
    permanentIds: coverageRecords.length > 0 && (claims?.length ?? 0) > 0 && rejectedBoxes.every((box) => box === undefined),
    debitConservation: approved === stakeDebit + poolDebit && physicalDelta === -approved,
    storedPayerRefunds: Boolean(refund?.receiver) && refund.receiver === (claimDelta?.storedPayer ?? refund.receiver) && BigInt(refund.amount) === approved,
  }
  return { flags, observed: { providerStakeSum, providerLockSum, providerExposureSum, openLockSum, openExposureSum, approved, stakeDebit, poolDebit, physicalDelta } }
}

export function assertComputedInvariants(observed) {
  const result = computeLifecycleInvariants(observed)
  if (Object.values(result.flags).some((flag) => flag !== true)) throw publicError('TESTNET_INVARIANT_MISMATCH', 'observed TestNet lifecycle accounting did not satisfy every required invariant')
  return result
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
  const providerSigner = { address: provider.addr.toString(), signTransaction: async (txn) => txn.signTxn(provider.sk) }
  const negativeSigner = { address: negative.addr.toString(), signTransaction: async (txn) => txn.signTxn(negative.sk) }
  const providerId = id(1), unrelatedProviderId = id(7), policyId = id(2), coverageId = id(3), claimId = id(4), rejectedCoverageId = id(5), zeroCoverageId = id(6)
  const providerBox = boxKey('p', providerId), unrelatedProviderBox = boxKey('p', unrelatedProviderId), policyBox = boxKey('l', policyId), coverageBox = boxKey('c', coverageId), rejectedCoverageBox = boxKey('c', rejectedCoverageId), zeroCoverageBox = boxKey('c', zeroCoverageId), claimBox = boxKey('f', claimId)
  const actors = { payer: payer.address, provider: provider.addr.toString(), unrelatedProvider: payer.address, negative: negative.addr.toString(), application: undefined }
  const artifact = await readArtifact()
  const budget = calculateTestnetBudget({ approvalProgramBytes: artifact.approvalProgramBytes, extraPages: artifact.extraPages })
  const funding = []
  const ephemeralFunding = []
  const applicationPayment = async (amount, purpose) => {
    const result = await submitPayer(algod, payer, algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: actors.application, amount: Number(amount), suggestedParams: await algodParams(algod) }))
    const item = { ...publicPending(result), amount: BigInt(amount), purpose }
    funding.push(item)
    return result
  }
  try {
    const create = algosdk.makeApplicationCreateTxnFromObject({ sender: payer.address, onComplete: algosdk.OnApplicationComplete.NoOpOC, approvalProgram: artifact.approval, clearProgram: artifact.clear, numGlobalInts: 6, numGlobalByteSlices: 2, numLocalInts: 0, numLocalByteSlices: 0, extraPages: 1, appArgs: methodArgs(METHOD.create, [assetId, payer.address]), suggestedParams: await algodParams(algod) })
    const created = await submitPayer(algod, payer, create)
    const createPending = await algod.pendingTransactionInformation(created.transactionId).do()
    const appId = Number(createPending.applicationIndex ?? createPending['application-index'])
    if (!appId) throw new Error('TestNet application creation returned no app ID')
    const application = appAddress(appId)
    actors.application = application
    const appFunding = await applicationPayment(200_000n, 'application base plus accepted-ASA holding')
    const providerFunding = await submitPayer(algod, payer, algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: provider.addr, amount: Number(budget.ephemeralFundingLines.primaryProvider), suggestedParams: await algodParams(algod) }))
    ephemeralFunding.push({ ...publicPending(providerFunding), amount: budget.ephemeralFundingLines.primaryProvider, purpose: 'primary provider retained minimum, ASA opt-in, and exact opt-in fee' })
    const providerOptInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: provider.addr, receiver: provider.addr, assetIndex: assetId, amount: 0, suggestedParams: await algodParams(algod) })
    const providerOptIn = await submitRaw(algod, [providerOptInTxn.signTxn(provider.sk)])
    const negativeFunding = await submitPayer(algod, payer, algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: negative.addr, amount: Number(budget.ephemeralFundingLines.authorizationNegative), suggestedParams: await algodParams(algod) }))
    ephemeralFunding.push({ ...publicPending(negativeFunding), amount: budget.ephemeralFundingLines.authorizationNegative, purpose: 'authorization-negative retained 100,000 minimum plus exact 2,000 application fee' })
    const appOptIn = await callPayer(algod, payer, appId, METHOD.optIn, [assetId], [], [assetId], 2_000)
    await applicationPayment(BOX_MBR.provider, 'primary provider record box MBR before registration')
    const providerRegistration = await callPayer(algod, payer, appId, METHOD.register, [providerId, provider.addr.toString(), id(8)], [{ appIndex: 0, name: providerBox }])
    await applicationPayment(BOX_MBR.provider, 'unrelated provider record box MBR before registration')
    const unrelatedRegistration = await callPayer(algod, payer, appId, METHOD.register, [unrelatedProviderId, payer.address, id(9)], [{ appIndex: 0, name: unrelatedProviderBox }])
    await applicationPayment(BOX_MBR.policy, 'primary policy record box MBR before policy creation')
    const policyCreation = await callPayer(algod, payer, appId, METHOD.policy, [policyId, providerId, 5_000, SCENARIO.collateralRatioBps, 1_000_000, 3_600], [{ appIndex: 0, name: providerBox }, { appIndex: 0, name: policyBox }])
    const depositTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: application, assetIndex: assetId, amount: Number(SCENARIO.stake), suggestedParams: await algodParams(algod) })
    const depositCall = algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.address, appIndex: appId, appArgs: [METHOD.deposit.getSelector(), providerId], boxes: [{ appIndex: 0, name: providerBox }], foreignAssets: [assetId], suggestedParams: await algodParams(algod) })
    algosdk.assignGroupID([depositTransfer, depositCall])
    const deposit = await submitRaw(algod, [await payer.signTransaction(depositTransfer), await payer.signTransaction(depositCall)])
    const unrelatedDepositTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.address, receiver: application, assetIndex: assetId, amount: Number(SCENARIO.unrelatedStake), suggestedParams: await algodParams(algod) })
    const unrelatedDepositCall = algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.address, appIndex: appId, appArgs: [METHOD.deposit.getSelector(), unrelatedProviderId], boxes: [{ appIndex: 0, name: unrelatedProviderBox }], foreignAssets: [assetId], suggestedParams: await algodParams(algod) })
    algosdk.assignGroupID([unrelatedDepositTransfer, unrelatedDepositCall])
    const unrelatedDeposit = await submitRaw(algod, [await payer.signTransaction(unrelatedDepositTransfer), await payer.signTransaction(unrelatedDepositCall)])
    const capacityRead = await callPayer(algod, payer, appId, METHOD.capacity, [providerId, policyId], [{ appIndex: 0, name: providerBox }, { appIndex: 0, name: policyBox }])
    const capacityAfterDeposit = decodeReturn(capacityRead.pending, '(uint64)')[0]
    await applicationPayment(BOX_MBR.coverage, 'successful coverage tombstone box MBR before coverage creation')
    const beforeCoverage = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox, { actors, boxes: [{ name: unrelatedProviderBox, type: RECORD.provider }, { name: policyBox, type: '(byte[32],bool,uint64,uint64,uint64,uint64,uint64)' }, { name: coverageBox, type: RECORD.coverage }, { name: rejectedCoverageBox, type: RECORD.coverage }, { name: zeroCoverageBox, type: RECORD.coverage }, { name: claimBox, type: '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)' }] })
    const beforeProvider = beforeCoverage.provider
    const beforeAccounting = new Map(beforeCoverage.accounting)
    const successfulFixture = await makeCoverage({ algod, payer, appId, appAddress: application, provider: provider.addr.toString(), providerId, policyId, coverageId, assetId, params: await algodParams(algod) })
    const successful = await successfulCoverage(algod, payer, appId, application, provider.addr.toString(), providerId, policyId, coverageId, assetId, genesisId, genesisHash, successfulFixture)
    const afterCoverage = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox, { actors, boxes: [{ name: unrelatedProviderBox, type: RECORD.provider }, { name: policyBox, type: '(byte[32],bool,uint64,uint64,uint64,uint64,uint64)' }, { name: coverageBox, type: RECORD.coverage }, { name: rejectedCoverageBox, type: RECORD.coverage }, { name: zeroCoverageBox, type: RECORD.coverage }, { name: claimBox, type: '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)' }] })
    const afterProvider = afterCoverage.provider
    const afterAccounting = new Map(afterCoverage.accounting)
    const successfulState = { provider: { stakeTotal: afterProvider[4] - beforeProvider[4], stakeLocked: afterProvider[5] - beforeProvider[5], openFaultExposure: afterProvider[6] - beforeProvider[6] }, global: { totalProviderStake: stateUint(afterAccounting, 'totalProviderStake') - stateUint(beforeAccounting, 'totalProviderStake'), premiumReserve: stateUint(afterAccounting, 'premiumReserve') - stateUint(beforeAccounting, 'premiumReserve'), totalOpenFaultExposure: stateUint(afterAccounting, 'totalOpenFaultExposure') - stateUint(beforeAccounting, 'totalOpenFaultExposure') } }
    const insufficientFixture = await makeCoverage({ algod, payer, appId, appAddress: application, provider: provider.addr.toString(), providerId, policyId, coverageId: rejectedCoverageId, assetId, params: await algodParams(algod) })
    const rejectionSnapshot = { actors, boxes: [{ name: unrelatedProviderBox, type: RECORD.provider }, { name: policyBox, type: '(byte[32],bool,uint64,uint64,uint64,uint64,uint64)' }, { name: coverageBox, type: RECORD.coverage }, { name: rejectedCoverageBox, type: RECORD.coverage }, { name: zeroCoverageBox, type: RECORD.coverage }, { name: claimBox, type: '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)' }] }
    const insufficient = await rejectedCoverage(algod, appId, application, assetId, genesisId, genesisHash, insufficientFixture, payer, providerId, providerBox, rejectionSnapshot)
    const lockCrossing = await rejectedApplication(algod, payer, appId, METHOD.withdraw, [providerId, 76], [{ appIndex: 0, name: providerBox }], [assetId], { fee: 2_000, assetId, providerId, providerBox, snapshot: rejectionSnapshot })
    const negativeResult = await rejectedApplication(algod, negativeSigner, appId, METHOD.withdraw, [providerId, 1], [{ appIndex: 0, name: providerBox }], [assetId], { fee: 2_000, assetId, providerId, providerBox, snapshot: rejectionSnapshot })
    await applicationPayment(BOX_MBR.claim, 'claim tombstone box MBR before claim finalization')
    const claimBefore = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox, rejectionSnapshot)
    const claim = await callPayer(algod, payer, appId, METHOD.claim, [claimId, coverageId, true, SCENARIO.claimAmount, true, 4], [{ appIndex: 0, name: claimBox }, { appIndex: 0, name: coverageBox }, { appIndex: 0, name: providerBox }], [assetId], 2_000, [payer.address])
    const claimPending = await algod.pendingTransactionInformation(claim.transactionId).do()
    const refund = refundEvidence({ ...claim.pending, ...claimPending }, claim.transactionId, payer.address, application, SCENARIO.claimAmount, assetId)
    const claimAfter = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox, rejectionSnapshot)
    const claimAfterProvider = claimAfter.provider
    const claimAfterAccounting = new Map(claimAfter.accounting)
    const claimDeltas = { provider: { stakeTotal: claimAfterProvider[4] - claimBefore.provider[4], stakeLocked: claimAfterProvider[5] - claimBefore.provider[5], openFaultExposure: claimAfterProvider[6] - claimBefore.provider[6] }, global: { totalProviderStake: stateUint(claimAfterAccounting, 'totalProviderStake') - stateUint(new Map(claimBefore.accounting), 'totalProviderStake'), premiumReserve: stateUint(claimAfterAccounting, 'premiumReserve') - stateUint(new Map(claimBefore.accounting), 'premiumReserve'), totalOpenFaultExposure: stateUint(claimAfterAccounting, 'totalOpenFaultExposure') - stateUint(new Map(claimBefore.accounting), 'totalOpenFaultExposure') }, physicalApplicationAsset: claimAfter.appAsset - claimBefore.appAsset }
    const unrelatedAfterClaim = claimAfter.boxes[hex(unrelatedProviderBox)]
    if (!samePublic(claimBefore.boxes[hex(unrelatedProviderBox)], unrelatedAfterClaim)) throw publicError('TESTNET_UNRELATED_COLLATERAL_CHANGED', 'unrelated provider collateral changed during the primary provider-fault claim')
    if (claimDeltas.provider.stakeTotal !== -SCENARIO.expectedStakeDebit || claimDeltas.provider.stakeLocked !== -SCENARIO.expectedStakeDebit || claimDeltas.provider.openFaultExposure !== -SCENARIO.claimAmount || claimDeltas.global.totalProviderStake !== -SCENARIO.expectedStakeDebit || claimDeltas.global.premiumReserve !== -SCENARIO.expectedPoolDebit || claimDeltas.global.totalOpenFaultExposure !== -SCENARIO.claimAmount || claimDeltas.physicalApplicationAsset !== -SCENARIO.claimAmount) throw publicError('TESTNET_CLAIM_WATERFALL_MISMATCH', 'observed provider-fault claim waterfall did not match the configured-ASA deltas')
    const withdrawal = await callPayer(algod, payer, appId, METHOD.withdraw, [providerId, SCENARIO.stake - SCENARIO.expectedStakeDebit], [{ appIndex: 0, name: providerBox }], [assetId], 2_000)
    const afterWithdrawal = await applicationSnapshot(algod, appId, payer.address, assetId, providerId, providerBox, rejectionSnapshot)
    const zeroFixture = await makeCoverage({ algod, payer, appId, appAddress: application, provider: provider.addr.toString(), providerId, policyId, coverageId: zeroCoverageId, assetId, params: await algodParams(algod) })
    const zeroCapacity = await rejectedCoverage(algod, appId, application, assetId, genesisId, genesisHash, zeroFixture, payer, providerId, providerBox, rejectionSnapshot)
    const finalAccountingState = await applicationState(algod, appId)
    const finalProvider = await boxValue(algod, appId, providerBox, RECORD.provider)
    const finalUnrelatedProvider = await boxValue(algod, appId, unrelatedProviderBox, RECORD.provider)
    const finalCoverage = await boxValue(algod, appId, coverageBox, RECORD.coverage)
    const claimRecord = await boxValue(algod, appId, claimBox, '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)')
    const finalAsset = await appAssetBalance(algod, application, assetId)
    const finalApplicationAccount = await accountBalance(algod, application, assetId)
    const finalProviders = [{ providerId: hex(providerId), record: providerRecordPublic(finalProvider) }, { providerId: hex(unrelatedProviderId), record: providerRecordPublic(finalUnrelatedProvider) }]
    const finalCoveragePublic = coverageRecordPublic(finalCoverage)
    const finalClaimPublic = { claimId: hex(claimId), finalized: claimRecord[1], approvedAmount: claimRecord[2], providerFault: claimRecord[3], stakeDebit: claimRecord[5], poolDebit: claimRecord[6] }
    const invariants = assertComputedInvariants({ providers: finalProviders, coverages: [finalCoveragePublic], claims: [finalClaimPublic], accounting: { totalProviderStake: stateUint(finalAccountingState, 'totalProviderStake'), premiumReserve: stateUint(finalAccountingState, 'premiumReserve'), totalOpenFaultExposure: stateUint(finalAccountingState, 'totalOpenFaultExposure') }, physicalApplicationAsset: finalAsset, rejectedBoxes: [await boxValue(algod, appId, rejectedCoverageBox, RECORD.coverage), await boxValue(algod, appId, zeroCoverageBox, RECORD.coverage)], claimDelta: { ...claimDeltas, approvedAmount: claimRecord[2], stakeDebit: claimRecord[5], poolDebit: claimRecord[6], storedPayer: payer.address }, refund })
    const fundingTotal = funding.reduce((sum, item) => sum + BigInt(item.amount), 0n)
    if (fundingTotal !== budget.applicationFundingTotal) throw publicError('TESTNET_FUNDING_RECONCILIATION_MISMATCH', 'actual application funding payments do not equal the planned MBR schedule')
    const evidence = {
      schema: 'assurepay-p1-testnet-evidence-v1',
      network: { caip2: ALGORAND_TESTNET_CAIP2, genesisId, label: network },
      asset: { id: BigInt(assetId), name: readiness.asset.name, unitName: readiness.asset.unitName, decimals: readiness.asset.decimals },
      application: { id: BigInt(appId), address: application, approvalProgramBytes: BigInt(artifact.approvalProgramBytes), extraPages: 1n, approvalProgramHash: crypto.createHash('sha256').update(artifact.approval).digest('base64'), globalStateSchema: { numUint: 6, numByteSlice: 2 } },
      actors: { payer: payer.address, provider: provider.addr.toString(), unrelatedProviderOwner: payer.address, authorizationNegative: negative.addr.toString(), application },
      funding: { payments: funding, ephemeralPayments: ephemeralFunding, applicationMbr: { baseAndAsset: budget.applicationFundingLines.baseAndAsset, providerBox: budget.applicationFundingLines.providerBox, unrelatedProviderBox: budget.applicationFundingLines.unrelatedProviderBox, policyBox: budget.applicationFundingLines.policyBox, coverageBox: budget.applicationFundingLines.coverageBox, claimBox: budget.applicationFundingLines.claimBox, total: budget.applicationFundingTotal }, reconciliation: { actualApplicationFunding: fundingTotal, plannedApplicationFunding: budget.applicationFundingTotal, payerPaidTransactionFees: budget.payerPaidTransactionFees, ephemeralAccountFunding: budget.ephemeralAccountFundingBudget, margin: budget.conservativeMargin, conservativeSpendableRequirement: budget.totalConservativeRequiredSpendableMicroAlgos } },
      steps: {
        createApplication: { ...publicPending(created), applicationId: BigInt(appId) },
        providerOptIn: publicPending(providerOptIn),
        applicationOptIn: publicPending(appOptIn),
        registerAndPolicy: { provider: publicPending(providerRegistration), unrelatedProvider: publicPending(unrelatedRegistration), policy: publicPending(policyCreation) },
        depositStake: { primary: { ...publicPending(deposit), providerId: hex(providerId), amount: SCENARIO.stake }, unrelated: { ...publicPending(unrelatedDeposit), providerId: hex(unrelatedProviderId), amount: SCENARIO.unrelatedStake } },
        capacityAfterDeposit: { ...publicPending(capacityRead), providerId: hex(providerId), policyId: hex(policyId), capacity: capacityAfterDeposit },
        successfulCoverage: { groupId: successful.groupId, memberTransactionIds: successful.memberTransactionIds, confirmedRound: BigInt(successful.confirmedRound), requirements: successfulFixture.requirements, assetDeltas: balanceDeltas(beforeCoverage, afterCoverage), stateDeltas: successfulState, facilitatorSubmissions: successful.submissions, coverageId: hex(coverageId) },
        insufficientCapacity: { ...insufficient, coverageId: hex(rejectedCoverageId), sameApplication: true },
        rejectedWithdrawal: { ...lockCrossing, label: 'over/lock-crossing withdrawal', amount: 76n, before: undefined, after: undefined },
        authorizationNegative: { classification: 'authorization', simulation: negativeResult.simulation, pool: negativeResult.pool, sameSignedBytes: negativeResult.sameSignedBytes, completeRollback: negativeResult.completeRollback },
        providerFaultClaim: { ...publicPending(claim), claimId: hex(claimId), coverageId: hex(coverageId), refundInnerTransfer: refund, deltas: { balances: balanceDeltas(claimBefore.balances, claimAfter.balances), ...claimDeltas }, waterfall: { approvedAmount: claimRecord[2], stakeDebit: claimRecord[5], poolDebit: claimRecord[6] }, claimRecord: finalClaimPublic, unrelatedCollateralUnchanged: true },
        exposureReleaseAndWithdrawal: { ...publicPending(withdrawal), providerId: hex(providerId), amount: SCENARIO.stake - SCENARIO.expectedStakeDebit, postWithdrawal: { provider: providerRecordPublic(afterWithdrawal.provider) } },
        zeroCapacity: { ...zeroCapacity, coverageId: hex(zeroCoverageId), remainingCapacity: 0n },
      },
      final: {
        providers: finalProviders,
        tombstones: [{ prefix: 'c', id: hex(coverageId), type: RECORD.coverage, statusIndex: 11, status: finalCoverage[11] }, { prefix: 'f', id: hex(claimId), type: '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)', statusIndex: 1, status: claimRecord[1] }, { prefix: 'c', id: hex(rejectedCoverageId), type: RECORD.coverage, absent: true }, { prefix: 'c', id: hex(zeroCoverageId), type: RECORD.coverage, absent: true }],
        accounting: { totalProviderStake: stateUint(finalAccountingState, 'totalProviderStake'), premiumReserve: stateUint(finalAccountingState, 'premiumReserve'), totalOpenFaultExposure: stateUint(finalAccountingState, 'totalOpenFaultExposure'), physicalApplicationAssetBalance: finalAsset, providerSum: invariants.observed.providerStakeSum, exposureSum: invariants.observed.providerExposureSum, assetLiabilityMatches: invariants.flags.assetLiabilityBound },
        applicationMinimumBalance: finalApplicationAccount.minimumBalanceMicroAlgos,
        reconciliation: invariants.observed,
        invariants: invariants.flags,
      },
      acceptanceNotes: { rejectedTransactionBytesNotRecorded: true, simulationResponsesNotRecorded: true, acceptanceTimePoolRejectionsAreLedgerUnreconstructable: true },
    }
    if (!publicEvidenceSafe(evidence)) throw publicError('PUBLIC_EVIDENCE_UNSAFE', 'public evidence failed secret and signed-material safety validation')
    await fs.writeFile(evidencePath, `${asJson(evidence)}\n`, { encoding: 'utf8', mode: 0o644 })
    return evidence
  } finally {
    if (provider.sk?.fill) provider.sk.fill(0)
    if (negative.sk?.fill) negative.sk.fill(0)
  }
}

export function publicEvidenceSafe(value) {
  const forbiddenKey = /mnemonic|seed|root|private|secret|signature|\bsig\b|signed|rawbytes|signed-?blob|simulation|pending|token|header|environment|secret/i
  const phrase = /^(?:\S+\s+){23}\S+$/
  const longBase64 = /^[A-Za-z0-9+/]+={0,2}$/
  const seen = new Set()
  const visit = (node, key = '') => {
    const sanitizedFailure = (key === 'simulation' || key === 'pool') && node && typeof node === 'object' && !Array.isArray(node) && Object.keys(node).every((field) => ['applicationId', 'assertionPc', 'kind'].includes(field)) && Object.prototype.hasOwnProperty.call(node, 'kind')
    if (forbiddenKey.test(key) && !sanitizedFailure) return false
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'number' || typeof node === 'bigint') return true
    if (typeof node === 'string') return !phrase.test(node.trim()) && !(longBase64.test(node) && node.length >= 128)
    if (node instanceof Uint8Array || Buffer.isBuffer(node)) return false
    if (typeof node !== 'object') return false
    if (seen.has(node)) return false
    seen.add(node)
    if (Array.isArray(node) && node.length > 64 && node.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return false
    return Object.entries(node).every(([childKey, child]) => visit(child, childKey))
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
function paysetTransactionId(entry) {
  const txn = paysetTxn(entry)
  const recorded = entry?.txid ?? entry?.txID ?? entry?.id ?? txn?.txid ?? txn?.txID ?? txn?.id
  if (recorded) return recorded
  try { return algosdk.Transaction.from_obj(txn).txID() } catch { return undefined }
}
function blockPayset(blockResponse) { return (blockResponse.block ?? blockResponse).payset ?? [] }
async function historicalTransactionEntry(algod, transactionId, expectedRound, expectedGroupId) {
  let blockResponse
  try { blockResponse = await algod.block(Number(expectedRound)).do() } catch { throw publicError('PUBLIC_EVIDENCE_BLOCK_LOOKUP_UNAVAILABLE', 'historical block lookup is unavailable for public evidence') }
  let txids
  try {
    const response = await algod.getBlockTxids(Number(expectedRound)).do()
    txids = response.blockTxids ?? response.blockTxIds ?? response.blocktxids ?? []
  } catch { throw publicError('PUBLIC_EVIDENCE_BLOCK_TXIDS_UNAVAILABLE', 'historical block transaction IDs are unavailable for public evidence') }
  if (!txids.includes(transactionId)) throw publicError('PUBLIC_EVIDENCE_BLOCK_TRANSACTION_MISSING', 'recorded public transaction is absent from its confirmed block')
  const entry = blockPayset(blockResponse).find((candidate) => paysetTransactionId(candidate) === transactionId)
  if (!entry) throw publicError('PUBLIC_EVIDENCE_BLOCK_TRANSACTION_MISSING', 'recorded public transaction cannot be associated with its confirmed block entry')
  if (expectedGroupId !== undefined && normalizedGroup(paysetTxn(entry)) !== expectedGroupId) throw publicError('PUBLIC_EVIDENCE_BLOCK_GROUP_MISMATCH', 'recorded transaction is associated with the wrong public group')
  return entry
}
export async function proveTransaction(algod, transactionId, expectedRound, expectedGroupId) {
  try {
    const pending = await algod.pendingTransactionInformation(transactionId).do()
    const round = confirmedRound(pending)
    if (!round) throw publicError('PUBLIC_EVIDENCE_PENDING_UNAVAILABLE', 'pending data does not contain a confirmation round')
    if (round !== Number(expectedRound)) throw publicError('PUBLIC_EVIDENCE_ROUND_MISMATCH', 'recorded transaction confirmation round does not match pending public data')
    if (expectedGroupId !== undefined && normalizedGroup(pending.txn) !== expectedGroupId) throw publicError('PUBLIC_EVIDENCE_GROUP_MISMATCH', 'recorded transaction group does not match pending public data')
    return { transactionId, confirmedRound: BigInt(round), source: 'pending' }
  } catch (error) {
    if (error?.publicCode && !['PUBLIC_EVIDENCE_PENDING_UNAVAILABLE'].includes(error.publicCode)) throw error
  }
  await historicalTransactionEntry(algod, transactionId, expectedRound, expectedGroupId)
  return { transactionId, confirmedRound: BigInt(expectedRound), source: 'block' }
}

async function readEvidence() {
  try { return JSON.parse(await fs.readFile(evidencePath, 'utf8')) } catch { throw publicError('PUBLIC_EVIDENCE_FILE_UNAVAILABLE', 'checked-in TestNet public evidence is unavailable') }
}

function applicationSchemaMatches(application, expected) {
  const schema = application.params?.['global-state-schema'] ?? application.params?.globalStateSchema
  return schema && Number(schema.numUint ?? schema['num-uint'] ?? 0) === Number(expected.numUint) && Number(schema.numByteSlice ?? schema['num-byte-slice'] ?? 0) === Number(expected.numByteSlice)
}

function publicTxnSteps(evidence) {
  const steps = evidence.steps ?? {}
  return [
    steps.createApplication,
    steps.providerOptIn,
    steps.applicationOptIn,
    steps.registerAndPolicy?.provider,
    steps.registerAndPolicy?.unrelatedProvider,
    steps.registerAndPolicy?.policy,
    steps.depositStake?.primary,
    steps.depositStake?.unrelated,
    steps.capacityAfterDeposit,
    steps.providerFaultClaim,
    steps.exposureReleaseAndWithdrawal,
  ].filter((step) => step?.transactionId && step?.confirmedRound !== undefined)
}

async function verifyRecordedSteps(algod, evidence) {
  const proofs = []
  for (const step of publicTxnSteps(evidence)) proofs.push(await proveTransaction(algod, step.transactionId, step.confirmedRound, step.groupId))
  const successful = evidence.steps.successfulCoverage
  if (!Array.isArray(successful.memberTransactionIds) || successful.memberTransactionIds.length !== 3) throw publicError('PUBLIC_EVIDENCE_GROUP_MISMATCH', 'successful coverage must record exactly three group members')
  const memberProofs = await Promise.all(successful.memberTransactionIds.map((txId) => proveTransaction(algod, txId, successful.confirmedRound, successful.groupId)))
  return { proofs, memberProofs }
}

function refundMatches(entries, evidence) {
  const expectedAmount = BigInt(evidence.steps.providerFaultClaim.waterfall.approvedAmount)
  const expectedAsset = Number(evidence.asset.id)
  const expectedPayer = evidence.actors.payer
  const application = evidence.application.address
  return entries.flatMap((entry, innerIndex) => {
    const txn = entry.txn?.txn ?? entry.txn ?? entry
    const transfer = txn.assetTransfer
    const receiver = transfer?.receiver?.toString?.() ?? transfer?.receiver
    const sender = txn.sender?.toString?.() ?? txn.sender
    return txn.type === 'axfer' && transfer && sender === application && receiver === expectedPayer && Number(transfer.assetIndex) === expectedAsset && BigInt(transfer.amount) === expectedAmount && BigInt(txn.fee ?? 0) === 0n ? [innerIndex] : []
  })
}

async function verifyClaimRefund(algod, evidence) {
  const claim = evidence.steps.providerFaultClaim
  try {
    const pending = await algod.pendingTransactionInformation(claim.transactionId).do()
    const matches = refundMatches(innerTransactions(pending), evidence)
    if (matches.length !== 1) throw publicError('PUBLIC_EVIDENCE_REFUND_MISMATCH', 'public claim data does not expose exactly one configured-ASA refund')
    return 'publicly observable'
  } catch (error) {
    if (error?.publicCode === 'PUBLIC_EVIDENCE_REFUND_MISMATCH') throw error
  }
  let entry
  try { entry = await historicalTransactionEntry(algod, claim.transactionId, claim.confirmedRound, claim.groupId) } catch {
    throw publicError('PUBLIC_EVIDENCE_REFUND_UNAVAILABLE', 'neither pending data nor the confirmed block can prove the claim refund')
  }
  const matches = refundMatches(innerTransactions(entry), evidence)
  if (matches.length !== 1) throw publicError('PUBLIC_EVIDENCE_REFUND_MISMATCH', 'historical claim data does not expose exactly one configured-ASA refund')
  return 'historically observable'
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
  if (!approval) throw publicError('PUBLIC_EVIDENCE_PROGRAM_UNAVAILABLE', 'deployed approval program identity is unavailable')
  const approvalBytes = Buffer.from(typeof approval === 'string' ? approval : approval, 'base64')
  if (approvalBytes.length !== Number(evidence.application.approvalProgramBytes) || crypto.createHash('sha256').update(approvalBytes).digest('base64') !== evidence.application.approvalProgramHash || Number(evidence.application.extraPages) !== 1) throw publicError('PUBLIC_EVIDENCE_PROGRAM_MISMATCH', 'recorded approval program identity or page allocation does not match the deployed application')
  if (!applicationSchemaMatches(application, evidence.application.globalStateSchema)) throw publicError('PUBLIC_EVIDENCE_SCHEMA_MISMATCH', 'deployed application global schema does not match public evidence')
  const { proofs, memberProofs: members } = await verifyRecordedSteps(algod, evidence)
  const state = await applicationState(algod, evidence.application.id)
  const appAsset = await appAssetBalance(algod, evidence.application.address, evidence.asset.id)
  const final = evidence.final.accounting
  if (stateUint(state, 'totalProviderStake') !== BigInt(final.totalProviderStake) || stateUint(state, 'premiumReserve') !== BigInt(final.premiumReserve) || stateUint(state, 'totalOpenFaultExposure') !== BigInt(final.totalOpenFaultExposure) || appAsset !== BigInt(final.physicalApplicationAssetBalance)) throw publicError('PUBLIC_EVIDENCE_ACCOUNTING_MISMATCH', 'recorded final accounting does not match current public application state')
  let applicationAccount
  try { applicationAccount = await accountBalance(algod, evidence.application.address, evidence.asset.id) } catch { throw publicError('PUBLIC_EVIDENCE_ACCOUNT_UNAVAILABLE', 'deployed application account state is unavailable') }
  if (applicationAccount.minimumBalanceMicroAlgos !== BigInt(evidence.final.applicationMinimumBalance)) throw publicError('PUBLIC_EVIDENCE_MBR_MISMATCH', 'recorded application minimum balance does not match current public state')
  const fundingTotal = (evidence.funding?.payments ?? []).reduce((sum, item) => sum + BigInt(item.amount), 0n)
  if (fundingTotal !== BigInt(evidence.funding.applicationMbr.total) || BigInt(evidence.funding.reconciliation.actualApplicationFunding) !== fundingTotal || BigInt(evidence.funding.reconciliation.plannedApplicationFunding) !== fundingTotal) throw publicError('PUBLIC_EVIDENCE_FUNDING_MISMATCH', 'recorded application funding reconciliation is inconsistent')
  if (BigInt(final.providerSum) !== BigInt(final.totalProviderStake) || BigInt(final.exposureSum) !== BigInt(final.totalOpenFaultExposure) || BigInt(final.totalProviderStake) + BigInt(final.premiumReserve) !== appAsset || final.assetLiabilityMatches !== true) throw publicError('PUBLIC_EVIDENCE_RECONCILIATION_MISMATCH', 'recorded provider, reserve, exposure, and physical-ASA reconciliation is inconsistent')
  for (const provider of evidence.final.providers) {
    const record = await boxValue(algod, evidence.application.id, boxKey('p', Buffer.from(provider.providerId, 'hex')), RECORD.provider)
    if (!record || record[0].toString() !== provider.record.owner || record[1].toString() !== provider.record.payout || record[3] !== provider.record.active || record[4] !== BigInt(provider.record.stakeTotal) || record[5] !== BigInt(provider.record.stakeLocked) || record[6] !== BigInt(provider.record.openFaultExposure)) throw publicError('PUBLIC_EVIDENCE_BOX_STATE_MISMATCH', 'recorded terminal provider box does not match current public state')
  }
  for (const tombstone of evidence.final.tombstones) {
    if (tombstone.absent) {
      const absent = await boxValue(algod, evidence.application.id, boxKey(tombstone.prefix, Buffer.from(tombstone.id, 'hex')), tombstone.type)
      if (absent !== undefined) throw publicError('PUBLIC_EVIDENCE_TOMBSTONE_MISMATCH', 'a recorded rejected box is present on public chain')
      continue
    }
    const record = await boxValue(algod, evidence.application.id, boxKey(tombstone.prefix, Buffer.from(tombstone.id, 'hex')), tombstone.type)
    if (!record || tombstone.status !== undefined && Number(record[tombstone.statusIndex]) !== Number(tombstone.status)) throw publicError('PUBLIC_EVIDENCE_TOMBSTONE_MISMATCH', 'recorded terminal box tombstone does not match current public state')
  }
  const claimRefund = await verifyClaimRefund(algod, evidence)
  return { ok: true, code: 'PUBLIC_EVIDENCE_VERIFIED', network: evidence.network, application: evidence.application, asset: evidence.asset, successfulGroup: { groupId: evidence.steps.successfulCoverage.groupId, members: members.map(({ transactionId, confirmedRound, source }) => ({ transactionId, confirmedRound, source })) }, verifiedTransactions: proofs.map(({ transactionId, confirmedRound, source }) => ({ transactionId, confirmedRound, source })), finalAccounting: final, claimRefund, acceptanceTimePoolRejections: 'acceptance-time-only: rejected transactions never entered a block' }
}

export function runnerMode(argv = []) {
  if (argv.includes('--verify-evidence')) return 'verify-evidence'
  if (argv.includes('--preflight')) return 'preflight'
  return 'mutating-acceptance'
}

async function main() {
  await loadLocalEnv()
  if (runnerMode(process.argv) === 'verify-evidence') {
    try { console.log(asJson(await verifyPublicEvidence(endpointConfig()))) } catch (error) { console.error(asJson({ ok: false, code: error.publicCode ?? 'PUBLIC_EVIDENCE_VERIFICATION_FAILED', message: error.publicCode ? error.message : 'public evidence verification failed' })); process.exitCode = 1 }
    return
  }
  const settings = await testnetConfig()
  try {
    const readiness = await preflight(settings)
    if (runnerMode(process.argv) === 'preflight' || !readiness.ok) { console.log(asJson(readiness)); process.exitCode = readiness.ok ? 0 : 2; return }
    console.log(asJson(await run(settings, readiness)))
  } catch (error) {
    console.error(asJson({ ok: false, phase: 'execution', code: error.publicCode ?? 'TESTNET_EXECUTION_FAILED', message: error.publicCode ? error.message : 'TestNet execution failed; inspect public endpoint, account funds, ASA holding, and network state without exposing credentials.' }))
    process.exitCode = 1
  } finally { settings.payer?.dispose() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
