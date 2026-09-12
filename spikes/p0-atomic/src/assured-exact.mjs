import algosdk from 'algosdk'
import { ed25519Verifier } from '@algorandfoundation/algokit-utils/crypto'

export const ASSURED_EXACT = 'assured-exact'
export const ASSURED_EXACT_ERRORS = Object.freeze({
  PAYLOAD: 'invalid_assured_exact_payload', GROUP: 'invalid_assured_exact_group',
  ROLE: 'invalid_assured_exact_role', SIGNATURE: 'invalid_assured_exact_signature',
  BINDING: 'invalid_assured_exact_binding', SIMULATION: 'invalid_assured_exact_simulation',
  SUBMISSION: 'invalid_assured_exact_submission', CONFIRMATION: 'invalid_assured_exact_confirmation',
})
export const OPEN_COVERAGE = new algosdk.ABIMethod({ name: 'openCoverage', args: [{ type: 'uint64' }, { type: 'uint64' }, { type: 'byte[]' }, { type: 'bool' }], returns: { type: 'void' } })
const fail = (reason, message, payer) => ({ isValid: false, invalidReason: reason, invalidMessage: message, payer })
const canonical = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
const decode = (encoded) => algosdk.decodeSignedTransaction(new Uint8Array(Buffer.from(encoded, 'base64')))
const copy = (group) => group.map((item) => new Uint8Array(item))

function parse(payload, requirements) {
  try {
    if (payload.x402Version !== 2 || payload.accepted.scheme !== ASSURED_EXACT || requirements.scheme !== ASSURED_EXACT || payload.accepted.network !== requirements.network) return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'scheme or network mismatch')
    const p = payload.payload
    if (!p || !Array.isArray(p.paymentGroup) || p.paymentGroup.length !== 3 || p.providerIndex !== 0 || p.premiumIndex !== 1 || p.applicationIndex !== 2 || !p.paymentGroup.every((x) => typeof x === 'string')) return fail(ASSURED_EXACT_ERRORS.GROUP, 'P0 requires [provider,premium,application] at [0,1,2]')
    const extra = requirements.extra
    if (!extra || !canonical(requirements.asset) || !canonical(requirements.amount) || !canonical(extra.providerNet) || !canonical(extra.premium) || !canonical(extra.applicationId) || typeof extra.provider !== 'string' || typeof extra.applicationAddress !== 'string' || typeof extra.requestCommitment !== 'string') return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'non-canonical requirements')
    const commitment = Buffer.from(extra.requestCommitment, 'base64')
    if (commitment.length !== 32 || Buffer.from(commitment).toString('base64') !== extra.requestCommitment) return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'invalid commitment')
    let members
    try { members = p.paymentGroup.map(decode) } catch { return fail(ASSURED_EXACT_ERRORS.SIGNATURE, 'malformed or missing ed25519 signature') }
    if (members.some((m) => !m.sig || m.msig || m.lsig || m.sig.length !== 64)) return fail(ASSURED_EXACT_ERRORS.SIGNATURE, 'P0 requires one ed25519 signature per role')
    const txns = members.map((m) => m.txn)
    const group = txns[0].group
    if (!group || !txns.every((t) => t.group && Buffer.from(t.group).equals(Buffer.from(group)))) return fail(ASSURED_EXACT_ERRORS.GROUP, 'missing or inconsistent group ID')
    return { txns, members, extra, commitment, prepared: copy(p.paymentGroup.map((x) => new Uint8Array(Buffer.from(x, 'base64')))) }
  } catch { return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'malformed signed transaction') }
}

export class AssuredExactAvmScheme {
  constructor(signer) { this.signer = signer; this.scheme = ASSURED_EXACT; this.caipFamily = 'algorand:*' }
  getExtra() { return undefined }
  getSigners() { return [...this.signer.getAddresses()] }
  async verify(payload, requirements) {
    const parsed = parse(payload, requirements)
    if ('isValid' in parsed) return parsed
    const { txns, members, extra, commitment, prepared } = parsed
    const [provider, premium, app] = txns
    const payer = provider.sender.publicKey
    const payerAddress = provider.sender.toString()
    try {
      if (provider.type !== 'axfer' || premium.type !== 'axfer' || app.type !== 'appl') return fail(ASSURED_EXACT_ERRORS.ROLE, 'unexpected group role', payerAddress)
      if (![premium, app].every((txn) => txn.sender.toString() === payerAddress)) return fail(ASSURED_EXACT_ERRORS.BINDING, 'payer mismatch', payerAddress)
      const signatures = await Promise.all(members.map((member, index) => ed25519Verifier(new Uint8Array(member.sig), txns[index].bytesToSign(), txns[index].sender.publicKey)))
      if (!signatures.every(Boolean)) return fail(ASSURED_EXACT_ERRORS.SIGNATURE, 'invalid payer signature', payerAddress)
      const asset = BigInt(requirements.asset), gross = BigInt(requirements.amount), providerNet = BigInt(extra.providerNet), premiumAmount = BigInt(extra.premium), appId = BigInt(extra.applicationId)
      if (provider.assetTransfer.assetIndex !== asset || premium.assetTransfer.assetIndex !== asset || provider.assetTransfer.receiver.toString() !== extra.provider || premium.assetTransfer.receiver.toString() !== extra.applicationAddress || provider.assetTransfer.amount !== providerNet || premium.assetTransfer.amount !== premiumAmount || providerNet + premiumAmount !== gross) return fail(ASSURED_EXACT_ERRORS.BINDING, 'transfer binding mismatch', payerAddress)
      const args = app.applicationCall.appArgs ?? []
      if (app.applicationCall.appIndex !== appId || args.length !== 5 || !Buffer.from(args[0]).equals(Buffer.from(OPEN_COVERAGE.getSelector()))) return fail(ASSURED_EXACT_ERRORS.BINDING, 'application selector mismatch', payerAddress)
      const decoded = [algosdk.ABIType.from('uint64').decode(new Uint8Array(args[1])), algosdk.ABIType.from('uint64').decode(new Uint8Array(args[2])), algosdk.ABIType.from('byte[]').decode(new Uint8Array(args[3])), algosdk.ABIType.from('bool').decode(new Uint8Array(args[4]))]
      if (decoded[0] !== gross || decoded[1] !== premiumAmount || !Buffer.from(decoded[2]).equals(commitment) || decoded[3] !== false) return fail(ASSURED_EXACT_ERRORS.BINDING, 'application argument mismatch', payerAddress)
      if (txns.some((txn) => txn.rekeyTo) || provider.assetTransfer.closeRemainderTo || premium.assetTransfer.closeRemainderTo) return fail(ASSURED_EXACT_ERRORS.BINDING, 'unsafe rekey or close field', payerAddress)
      const simulation = await this.signer.simulateTransactions(copy(prepared), requirements.network)
      if (simulation.txnGroups?.[0]?.failureMessage) return fail(ASSURED_EXACT_ERRORS.SIMULATION, simulation.txnGroups[0].failureMessage, payerAddress)
      return { isValid: true, payer: payerAddress, prepared }
    } catch { return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'invalid ABI or numeric field', payerAddress) }
  }
  async settle(payload, requirements) {
    const verified = await this.verify(payload, requirements)
    if (!verified.isValid) return { success: false, errorReason: verified.invalidReason, errorMessage: verified.invalidMessage, transaction: '', network: requirements.network, payer: verified.payer }
    const transaction = algosdk.decodeSignedTransaction(verified.prepared[0]).txn.txID()
    try { await this.signer.sendTransactions(copy(verified.prepared), requirements.network) } catch (e) { return { success: false, errorReason: ASSURED_EXACT_ERRORS.SUBMISSION, errorMessage: e instanceof Error ? e.message : 'submission failed', transaction, network: requirements.network, payer: verified.payer } }
    try { await this.signer.waitForConfirmation(transaction, requirements.network, 10) } catch (e) { return { success: false, errorReason: ASSURED_EXACT_ERRORS.CONFIRMATION, errorMessage: e instanceof Error ? e.message : 'confirmation failed', transaction, network: requirements.network, payer: verified.payer } }
    return { success: true, transaction, network: requirements.network, payer: verified.payer }
  }
}

export function buildAssuredExactPayload({ payer, provider, application, assetId, providerNet, premium, applicationId, commitment, params }) {
  const appArgs = [OPEN_COVERAGE.getSelector(), algosdk.ABIType.from('uint64').encode(providerNet + premium), algosdk.ABIType.from('uint64').encode(premium), algosdk.ABIType.from('byte[]').encode(commitment), algosdk.ABIType.from('bool').encode(false)]
  const txns = [algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: provider, assetIndex: assetId, amount: providerNet, suggestedParams: params }), algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer.addr, receiver: application, assetIndex: assetId, amount: premium, suggestedParams: params }), algosdk.makeApplicationNoOpTxnFromObject({ sender: payer.addr, appIndex: applicationId, appArgs, suggestedParams: params })]
  algosdk.assignGroupID(txns)
  const paymentGroup = txns.map((txn) => Buffer.from(txn.signTxn(payer.sk)).toString('base64'))
  return { paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2, requirements: { scheme: ASSURED_EXACT, asset: String(assetId), amount: String(providerNet + premium), extra: { provider: provider.toString(), applicationAddress: application.toString(), applicationId: String(applicationId), providerNet: String(providerNet), premium: String(premium), requestCommitment: Buffer.from(commitment).toString('base64') } } }
}

export async function buildAssuredExactPayloadWithSigner({ payer, signTransaction, provider, application, assetId, providerNet, premium, applicationId, commitment, params }) {
  const appArgs = [OPEN_COVERAGE.getSelector(), algosdk.ABIType.from('uint64').encode(providerNet + premium), algosdk.ABIType.from('uint64').encode(premium), algosdk.ABIType.from('byte[]').encode(commitment), algosdk.ABIType.from('bool').encode(false)]
  const txns = [algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer, receiver: provider, assetIndex: assetId, amount: providerNet, suggestedParams: params }), algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: payer, receiver: application, assetIndex: assetId, amount: premium, suggestedParams: params }), algosdk.makeApplicationNoOpTxnFromObject({ sender: payer, appIndex: applicationId, appArgs, suggestedParams: params })]
  algosdk.assignGroupID(txns)
  const paymentGroup = (await Promise.all(txns.map(signTransaction))).map((signed) => Buffer.from(signed).toString('base64'))
  return { paymentGroup, providerIndex: 0, premiumIndex: 1, applicationIndex: 2, requirements: { scheme: ASSURED_EXACT, asset: String(assetId), amount: String(providerNet + premium), extra: { provider: provider.toString(), applicationAddress: application.toString(), applicationId: String(applicationId), providerNet: String(providerNet), premium: String(premium), requestCommitment: Buffer.from(commitment).toString('base64') } } }
}
