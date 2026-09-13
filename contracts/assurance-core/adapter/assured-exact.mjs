import algosdk from 'algosdk'
import sodium from 'libsodium-wrappers-sumo'

export const ASSURED_EXACT_SCHEME = 'assured-exact'
export const ASSURANCE_CORE_PROFILE = 'assurance-core-v1'
export const OPEN_COVERAGE_SIGNATURE = 'openCoverage(byte[32],byte[32],byte[32],byte[32],uint64)void'
export const OPEN_COVERAGE_METHOD = algosdk.ABIMethod.fromSignature(OPEN_COVERAGE_SIGNATURE)
export const LOCALNET_NETWORK = 'algorand:localnet'

const MAX_UINT64 = 18_446_744_073_709_551_615n
const EXTRA_KEYS = [
  'profile', 'provider', 'applicationAddress', 'applicationId', 'providerNet', 'premium',
  'coverageId', 'providerId', 'policyId', 'requestCommitment',
]

export class AssuredExactError extends Error {
  constructor(category, message, cause = undefined) {
    super(`[${category}] ${message}`, { cause })
    this.name = 'AssuredExactError'
    this.category = category
  }
}

const fail = (category, message, cause = undefined) => {
  throw new AssuredExactError(category, message, cause)
}

const equalBytes = (left, right) => Buffer.from(left ?? []).equals(Buffer.from(right ?? []))
const address = (value) => {
  if (typeof value !== 'string' || !algosdk.isValidAddress(value)) fail('payload', 'invalid address')
  return value
}
const decimal = (value, field, positive = true) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('payload', `${field} is not canonical decimal`)
  let parsed
  try { parsed = BigInt(value) } catch (error) { fail('payload', `${field} is not an integer`, error) }
  if (parsed > MAX_UINT64 || (positive && parsed === 0n)) fail('payload', `${field} is out of range`)
  return parsed
}
const base64 = (value, field) => {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('payload', `${field} is not base64`)
  let bytes
  try { bytes = Buffer.from(value, 'base64') } catch (error) { fail('payload', `${field} is not base64`, error) }
  if (bytes.toString('base64') !== value) fail('payload', `${field} is not canonical base64`)
  if (bytes.length !== 32) fail('payload', `${field} must be byte[32]`)
  return bytes
}
const exactKeys = (object, keys, category = 'payload') => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail(category, 'object expected')
  const actual = Object.keys(object).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(category, 'unexpected or missing fields')
}
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const canonicalBytes = (value, field) => {
  if (typeof value !== 'string') fail('payload', `${field} must be base64`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value) fail('payload', `${field} is not canonical base64`)
  return Buffer.from(bytes)
}
const sender = (txn) => algosdk.encodeAddress(txn.sender.publicKey)
const optionalAddress = (value) => value === undefined || equalBytes(value.publicKey, new Uint8Array(32))
const boxKey = (prefix, id) => Buffer.concat([Buffer.from(prefix), id])
const simulationFailure = (value) => {
  if (!value || typeof value !== 'object') return undefined
  let failure
  let failedAt
  const visit = (node) => {
    if (!node || typeof node !== 'object' || failure && failedAt !== undefined) return
    for (const [key, child] of Object.entries(node)) {
      const lower = key.toLowerCase()
      if ((lower.includes('failure') || lower.includes('poolerror')) && child !== '' && child !== undefined && child !== null && child !== false && child !== 0) {
        if (typeof child === 'string') failure ??= child
        else visit(child)
      } else if (lower.includes('failedat') && child !== '' && child !== undefined && child !== null && child !== false && child !== 0) {
        failedAt ??= child
      } else visit(child)
      if (failure && failedAt !== undefined) return
    }
  }
  visit(value)
  if (failure || failedAt !== undefined) return [failure, failedAt === undefined ? undefined : `failedAt=${String(failedAt)}`].filter(Boolean).join('; ')
  return undefined
}

const validateRequirements = (requirements, configuration) => {
  exactKeys(requirements, ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra'])
  if (requirements.scheme !== ASSURED_EXACT_SCHEME) fail('binding', 'wrong scheme')
  if (requirements.network !== configuration.network) fail('binding', 'wrong network')
  const asset = decimal(requirements.asset, 'asset')
  const amount = decimal(requirements.amount, 'amount')
  const payTo = address(requirements.payTo)
  if (!Number.isSafeInteger(requirements.maxTimeoutSeconds) || requirements.maxTimeoutSeconds <= 0) fail('payload', 'invalid timeout')
  exactKeys(requirements.extra, EXTRA_KEYS)
  const extra = requirements.extra
  if (extra.profile !== ASSURANCE_CORE_PROFILE) fail('binding', 'wrong profile')
  if (address(extra.provider) !== payTo) fail('binding', 'provider/payTo mismatch')
  if (address(extra.applicationAddress) !== algosdk.getApplicationAddress(configuration.applicationId).toString()) fail('binding', 'wrong application address')
  const applicationId = decimal(extra.applicationId, 'applicationId')
  if (applicationId !== BigInt(configuration.applicationId)) fail('binding', 'wrong application id')
  const providerNet = decimal(extra.providerNet, 'providerNet', false)
  const premium = decimal(extra.premium, 'premium', false)
  if (providerNet + premium !== amount) fail('binding', 'providerNet + premium != gross')
  if (asset !== BigInt(configuration.acceptedAssetId)) fail('binding', 'wrong accepted asset')
  return {
    asset, amount, payTo,
    providerNet, premium, applicationId,
    coverageId: base64(extra.coverageId, 'coverageId'),
    providerId: base64(extra.providerId, 'providerId'),
    policyId: base64(extra.policyId, 'policyId'),
    requestCommitment: base64(extra.requestCommitment, 'requestCommitment'),
    provider: payTo,
    applicationAddress: extra.applicationAddress,
  }
}

const validatePayloadShape = (paymentPayload, requirements) => {
  if (!paymentPayload || typeof paymentPayload !== 'object' || Array.isArray(paymentPayload)) fail('payload', 'object expected')
  const allowed = new Set(['x402Version', 'resource', 'accepted', 'payload', 'extensions'])
  if (Object.keys(paymentPayload).some((key) => !allowed.has(key))) fail('payload', 'unexpected or missing fields')
  if (!Object.prototype.hasOwnProperty.call(paymentPayload, 'accepted')) fail('payload', 'accepted requirements missing')
  if (paymentPayload.x402Version !== 2) fail('payload', 'x402Version must be 2')
  if (stable(paymentPayload.accepted) !== stable(requirements)) fail('binding', 'accepted requirements mismatch')
  exactKeys(paymentPayload.payload, ['paymentGroup', 'providerIndex', 'premiumIndex', 'applicationIndex'])
  const payload = paymentPayload.payload
  if (!Array.isArray(payload.paymentGroup) || payload.paymentGroup.length !== 3 || payload.paymentGroup.some((item) => typeof item !== 'string')) fail('group', 'paymentGroup must contain exactly three base64 strings')
  if (payload.providerIndex !== 0 || payload.premiumIndex !== 1 || payload.applicationIndex !== 2) fail('group', 'wrong transaction indices')
  return payload
}

const decodeMembers = (encoded) => encoded.map((item, index) => {
  const bytes = canonicalBytes(item, `paymentGroup[${index}]`)
  let decoded
  try { decoded = algosdk.decodeSignedTransaction(bytes) } catch (error) { fail('payload', `paymentGroup[${index}] cannot be decoded`, error) }
  if (decoded.msig || decoded.lsig || decoded.sgnr || !decoded.sig || decoded.sig.length !== 64) fail('signature', `paymentGroup[${index}] must be single-signed`)
  try {
    if (!sodium.crypto_sign_verify_detached(decoded.sig, decoded.txn.bytesToSign(), decoded.txn.sender.publicKey)) fail('signature', `paymentGroup[${index}] signature is invalid`)
  } catch (error) {
    if (error instanceof AssuredExactError) throw error
    fail('signature', `paymentGroup[${index}] signature cannot be verified`, error)
  }
  return { bytes, decoded, txn: decoded.txn }
})

const validateGroup = (members, requirements, configuration) => {
  const txns = members.map(({ txn }) => txn)
  const first = txns[0]
  if (txns.some((txn) => txn.genesisID !== configuration.genesisId)) fail('group', 'wrong genesis/network')
  if (configuration.genesisHash && txns.some((txn) => !equalBytes(txn.genesisHash, configuration.genesisHash))) fail('group', 'wrong genesis hash/network')
  if (txns.some((txn) => !txn.group || txn.group.length !== 32)) fail('group', 'missing group id')
  if (txns.some((txn) => !equalBytes(txn.group, first.group))) fail('group', 'group ids differ')
  let computed
  const declaredGroups = txns.map((txn) => txn.group)
  try {
    txns.forEach((txn) => { txn.group = undefined })
    computed = algosdk.computeGroupID(txns)
  } catch (error) {
    fail('group', 'group id cannot be computed', error)
  } finally {
    txns.forEach((txn, index) => { txn.group = declaredGroups[index] })
  }
  if (!equalBytes(computed, first.group)) fail('group', 'group id is invalid')
  const commonSender = sender(first)
  if (txns.some((txn) => sender(txn) !== commonSender)) fail('role', 'payer senders differ')
  if (first.type !== 'axfer' || txns[1].type !== 'axfer' || txns[2].type !== 'appl') fail('role', 'wrong group ordering or transaction types')
  if (first.rekeyTo || txns[1].rekeyTo || txns[2].rekeyTo) fail('role', 'rekey is not allowed')
  const providerTransfer = first.assetTransfer
  const premiumTransfer = txns[1].assetTransfer
  const application = txns[2].applicationCall
  if (!providerTransfer || !premiumTransfer || !application) fail('role', 'missing transaction payload')
  const binding = validateRequirements(requirements, configuration)
  if (providerTransfer.assetIndex !== binding.asset || premiumTransfer.assetIndex !== binding.asset) fail('binding', 'wrong transfer asset')
  if (providerTransfer.receiver.toString() !== binding.provider) fail('binding', 'wrong provider payout receiver')
  if (premiumTransfer.receiver.toString() !== binding.applicationAddress) fail('binding', 'wrong premium receiver')
  if (providerTransfer.amount !== binding.providerNet || premiumTransfer.amount !== binding.premium) fail('binding', 'wrong derived transfer amount')
  if (!optionalAddress(providerTransfer.assetSender) || !optionalAddress(providerTransfer.closeRemainderTo) || !optionalAddress(premiumTransfer.assetSender) || !optionalAddress(premiumTransfer.closeRemainderTo)) fail('binding', 'unsafe asset transfer field')
  if (application.appIndex !== binding.applicationId || application.onComplete !== 0) fail('binding', 'wrong application call')
  const expectedArgs = [
    OPEN_COVERAGE_METHOD.getSelector(),
    binding.coverageId,
    binding.providerId,
    binding.policyId,
    binding.requestCommitment,
    algosdk.ABIType.from('uint64').encode(binding.amount),
  ]
  if (application.appArgs.length !== expectedArgs.length || application.appArgs.some((arg, index) => !equalBytes(arg, expectedArgs[index]))) fail('binding', 'openCoverage ABI arguments do not match requirements')
  if (application.foreignAssets.length !== 1 || application.foreignAssets[0] !== binding.asset) fail('binding', 'wrong application asset reference')
  if (application.accounts.length !== 0 || application.foreignApps.length !== 0) fail('binding', 'unexpected application references')
  const expectedBoxes = [boxKey('p', binding.providerId), boxKey('l', binding.policyId), boxKey('c', binding.coverageId)]
  if (application.boxes.length !== expectedBoxes.length || application.boxes.some((box, index) => box.appIndex !== 0n || !equalBytes(box.name, expectedBoxes[index]))) fail('binding', 'coverage box references do not match')
  return { binding, payer: commonSender, groupId: Buffer.from(first.group).toString('base64') }
}

const prepare = async (paymentPayload, requirements, configuration) => {
  await sodium.ready
  const payload = validatePayloadShape(paymentPayload, requirements)
  const members = decodeMembers(payload.paymentGroup)
  const result = validateGroup(members, requirements, configuration)
  const signedBytes = members.map(({ bytes }) => Buffer.from(bytes))
  let simulation
  try {
    simulation = await configuration.simulate(signedBytes.map((bytes) => Buffer.from(bytes)))
  } catch (error) {
    if (error instanceof AssuredExactError) throw error
    fail('simulation', `x402 simulation rejected the group: ${error instanceof Error ? error.message : 'request failed'}`, error)
  }
  const failure = simulationFailure(simulation)
  if (failure) fail('simulation', `x402 simulation rejected the group: ${failure}`)
  return Object.freeze({
    signedBytes: Object.freeze(signedBytes),
    requirementsFingerprint: stable(requirements),
    ...result,
  })
}

export function createAssuredExactFacilitator({
  algod,
  network = LOCALNET_NETWORK,
  genesisId = 'dockernet-v1',
  genesisHash = undefined,
  applicationId,
  applicationAddress: suppliedApplicationAddress = undefined,
  acceptedAssetId,
  simulate = (signedBytes) => algod.simulateRawTransactions(signedBytes).do(),
  submit = (signedBytes) => algod.sendRawTransaction(signedBytes).do(),
  confirm = (txid) => algosdk.waitForConfirmation(algod, txid, 4),
} = {}) {
  if (!algod || applicationId === undefined || acceptedAssetId === undefined) throw new Error('assured-exact facilitator configuration is incomplete')
  const derivedApplicationAddress = algosdk.getApplicationAddress(applicationId).toString()
  if (suppliedApplicationAddress !== undefined && suppliedApplicationAddress !== derivedApplicationAddress) throw new Error('assured-exact facilitator application address does not match application id')
  const applicationAddress = suppliedApplicationAddress ?? derivedApplicationAddress
  const configuration = { network, genesisId, genesisHash, applicationId, applicationAddress, acceptedAssetId, simulate, submit, confirm }
  const snapshots = new WeakMap()
  const failureResponse = (error, payer = '') => ({
    success: false,
    errorReason: error instanceof AssuredExactError ? error.category : 'payload',
    errorMessage: error instanceof Error ? error.message : 'assured-exact settlement failed',
    transaction: '',
    network: configuration.network,
    payer,
  })
  const facilitator = {
    scheme: ASSURED_EXACT_SCHEME,
    caipFamily: 'algorand:*',
    getExtra: () => ({ profile: ASSURANCE_CORE_PROFILE }),
    getSigners: () => [],
    verify: async (paymentPayload, requirements) => {
      snapshots.delete(paymentPayload)
      try {
        const snapshot = await prepare(paymentPayload, requirements, configuration)
        snapshots.set(paymentPayload, snapshot)
        return { isValid: true, payer: snapshot.payer }
      } catch (error) {
        if (error instanceof AssuredExactError) return { isValid: false, invalidReason: error.category, invalidMessage: error.message }
        return { isValid: false, invalidReason: 'payload', invalidMessage: '[payload] malformed payment payload' }
      }
    },
    settle: async (paymentPayload, requirements) => {
      let snapshot = snapshots.get(paymentPayload)
      if (!snapshot || snapshot.requirementsFingerprint !== stable(requirements)) {
        try {
          snapshot = await prepare(paymentPayload, requirements, configuration)
        } catch (error) {
          snapshots.delete(paymentPayload)
          return failureResponse(error)
        }
      }
      let submitted
      try {
        submitted = await configuration.submit(snapshot.signedBytes.map((bytes) => Buffer.from(bytes)))
      } catch (error) {
        return failureResponse(new AssuredExactError('submission', 'transaction pool rejected the group', error), snapshot.payer)
      }
      const transaction = submitted?.txId ?? submitted?.txid
      if (typeof transaction !== 'string' || transaction.length === 0) return failureResponse(new AssuredExactError('submission', 'transaction pool returned no transaction id'), snapshot.payer)
      try {
        await configuration.confirm(transaction)
      } catch (error) {
        return failureResponse(new AssuredExactError('confirmation', 'confirmed transaction failed', error), snapshot.payer)
      }
      return {
        success: true,
        payer: snapshot.payer,
        network: configuration.network,
        transaction,
        groupId: snapshot.groupId,
      }
    },
  }
  return facilitator
}
