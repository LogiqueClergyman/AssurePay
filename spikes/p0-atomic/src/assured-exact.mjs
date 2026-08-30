import { ed25519Verifier } from '@algorandfoundation/algokit-utils/crypto'
import { bytesForSigning, decodeSignedTransaction } from '@algorandfoundation/algokit-utils/transact'
import { Address } from '@algorandfoundation/algokit-utils/common'
import { decode, encode } from 'algorand-msgpack'

export const ASSURED_EXACT = 'assured-exact'
export const ASSURED_EXACT_ERRORS = Object.freeze({
  PAYLOAD: 'invalid_assured_exact_payload', GROUP: 'invalid_assured_exact_group',
  ROLE: 'invalid_assured_exact_role', SIGNATURE: 'invalid_assured_exact_signature',
  BINDING: 'invalid_assured_exact_binding', SIMULATION: 'invalid_assured_exact_simulation',
})

const fail = (reason, message) => ({ isValid: false, invalidReason: reason, invalidMessage: message })
const bytes = (value) => new Uint8Array(Buffer.from(value, 'base64'))
const address = (value) => value?.toString()
const zero = (value) => !value || address(value) === 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'
const key = (map, name) => [...map.entries()].find(([k]) => Buffer.from(k).toString() === name)?.[1]
function decodeMember(encoded) {
  const value = bytes(encoded)
  try { const signed = decodeSignedTransaction(value); return { signed, txn: signed.txn, signature: signed.sig, signingBytes: bytesForSigning.transaction(signed.txn) } } catch {
    const outer = decode(value, { useMap: true, rawBinaryStringKeys: true, rawBinaryStringValues: true }); const raw = key(outer, 'txn'); const snd = key(raw, 'snd')
    if (!(raw instanceof Map) || !snd) throw new Error('invalid signed transaction')
    const type = key(raw, 'apid') !== undefined ? 'appl' : undefined
    if (type !== 'appl') throw new Error('unknown transaction')
    const sender = new Address(snd); const txn = { type, sender, group: key(raw, 'grp'), rekeyTo: key(raw, 'rekey'), appCall: { appId: BigInt(key(raw, 'apid')), args: key(raw, 'apaa') ?? [] } }
    return { signed: null, txn, signature: key(outer, 'sig'), signingBytes: new Uint8Array(Buffer.concat([Buffer.from('TX'), Buffer.from(encode(raw, { ignoreUndefined: true }))])) }
  }
}

export function isAssuredExactPayload(value) {
  return value && Array.isArray(value.paymentGroup) && Number.isInteger(value.providerIndex) && Number.isInteger(value.premiumIndex) && Number.isInteger(value.applicationIndex) && !('feePayerIndex' in value)
}

/** Local P0 implementation of the @x402/core scheme-network facilitator interface. */
export class AssuredExactAvmScheme {
  constructor(signer) { this.signer = signer; this.scheme = ASSURED_EXACT; this.caipFamily = 'algorand:*' }
  getExtra() { return undefined }
  getSigners() { return [...this.signer.getAddresses()] }

  async verify(payload, requirements) {
    if (payload.x402Version !== 2 || payload.accepted.scheme !== ASSURED_EXACT || requirements.scheme !== ASSURED_EXACT || payload.accepted.network !== requirements.network) return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'scheme or network mismatch')
    if (!isAssuredExactPayload(payload.payload)) return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'invalid assured-exact payload')
    const p = payload.payload
    if (p.paymentGroup.length !== 3 || p.providerIndex !== 0 || p.premiumIndex !== 1 || p.applicationIndex !== 2) return fail(ASSURED_EXACT_ERRORS.GROUP, 'P0 requires [provider,premium,application] at [0,1,2]')
    let members
    try { members = p.paymentGroup.map(decodeMember) } catch { return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'each P0 group member must be a signed transaction') }
    const group = members.map((s) => s.txn)
    if (!group[0].group || !group.every((t) => t.group && Buffer.from(t.group).equals(Buffer.from(group[0].group)))) return fail(ASSURED_EXACT_ERRORS.GROUP, 'missing or inconsistent group ID')
    const [providerTxn, premiumTxn, appTxn] = group
    if (providerTxn.type !== 'axfer' || premiumTxn.type !== 'axfer' || appTxn.type !== 'appl') return fail(ASSURED_EXACT_ERRORS.ROLE, 'unexpected group role')
    const payer = address(providerTxn.sender)
    if (address(premiumTxn.sender) !== payer || address(appTxn.sender) !== payer) return fail(ASSURED_EXACT_ERRORS.BINDING, 'payer mismatch')
    for (const [i, member] of members.entries()) {
      // AlgoKit 10 cannot decode a signed appl transaction into Transaction;
      // its raw fallback still requires a canonical 64-byte signature. Axfer
      // signatures are cryptographically verified through the public helper.
      const valid = member.signed ? await ed25519Verifier(member.signature, member.signingBytes, group[i].sender.publicKey) : member.signature?.length === 64
      if (!valid) return fail(ASSURED_EXACT_ERRORS.SIGNATURE, `invalid payer signature at ${i}`)
    }
    const extra = requirements.extra ?? {}
    const providerNet = BigInt(extra.providerNet)
    const premium = BigInt(extra.premium)
    const gross = BigInt(requirements.amount)
    const commitment = extra.requestCommitment
    if (!/^[0-9]+$/.test(requirements.asset) || !/^[0-9]+$/.test(requirements.amount) || !/^[0-9]+$/.test(String(extra.providerNet)) || !/^[0-9]+$/.test(String(extra.premium)) || typeof commitment !== 'string' || Buffer.from(commitment, 'base64').length !== 32) return fail(ASSURED_EXACT_ERRORS.PAYLOAD, 'non-canonical requirements')
    if (providerTxn.assetTransfer?.assetId !== BigInt(requirements.asset) || premiumTxn.assetTransfer?.assetId !== BigInt(requirements.asset) || address(providerTxn.assetTransfer?.receiver) !== extra.provider || address(premiumTxn.assetTransfer?.receiver) !== extra.applicationAddress || providerTxn.assetTransfer?.amount !== providerNet || premiumTxn.assetTransfer?.amount !== premium || providerNet + premium !== gross) return fail(ASSURED_EXACT_ERRORS.BINDING, 'transfer binding mismatch')
    if (appTxn.appCall?.appId !== BigInt(extra.applicationId) || Buffer.from(appTxn.appCall?.args?.[0] ?? []).toString() !== 'openCoverage' || BigInt(Buffer.from(appTxn.appCall?.args?.[1] ?? []).toString()) !== gross || BigInt(Buffer.from(appTxn.appCall?.args?.[2] ?? []).toString()) !== premium || !Buffer.from(appTxn.appCall?.args?.[3] ?? []).equals(Buffer.from(commitment, 'base64'))) return fail(ASSURED_EXACT_ERRORS.BINDING, 'application binding mismatch')
    for (const txn of group) if (!zero(txn.rekeyTo) || (txn.assetTransfer && !zero(txn.assetTransfer.closeRemainderTo))) return fail(ASSURED_EXACT_ERRORS.BINDING, 'unsafe rekey or close field')
    try {
      const prepared = p.paymentGroup.map(bytes)
      const simulation = await this.signer.simulateTransactions(prepared, requirements.network)
      if (simulation.txnGroups?.[0]?.failureMessage) return fail(ASSURED_EXACT_ERRORS.SIMULATION, simulation.txnGroups[0].failureMessage)
      return { isValid: true, payer }
    } catch (error) { return fail(ASSURED_EXACT_ERRORS.SIMULATION, error instanceof Error ? error.message : 'simulation failed') }
  }

  async settle(payload, requirements) {
    const verification = await this.verify(payload, requirements)
    if (!verification.isValid) return { success: false, errorReason: verification.invalidReason, errorMessage: verification.invalidMessage, transaction: '', network: requirements.network }
    const prepared = payload.payload.paymentGroup.map(bytes)
    const transaction = Buffer.from(prepared[0]).toString('base64')
    try { await this.signer.sendTransactions(prepared, requirements.network); await this.signer.waitForConfirmation(transaction, requirements.network, 10) } catch (error) { return { success: false, errorReason: ASSURED_EXACT_ERRORS.SIMULATION, errorMessage: error instanceof Error ? error.message : 'submission failed', transaction, network: requirements.network } }
    return { success: true, transaction, network: requirements.network, payer: verification.payer }
  }
}

export async function buildAssuredExactPayload({ payer, provider, application, assetId, providerNet, premium, applicationId, commitment, transactions }) {
  const signed = await payer.signer(transactions, [0, 1, 2])
  return { paymentGroup: signed.map((value) => Buffer.from(value).toString('base64')), providerIndex: 0, premiumIndex: 1, applicationIndex: 2,
    requirements: { scheme: ASSURED_EXACT, asset: String(assetId), amount: String(providerNet + premium), extra: { provider: address(provider), applicationAddress: address(application), applicationId: String(applicationId), providerNet: String(providerNet), premium: String(premium), requestCommitment: Buffer.from(commitment).toString('base64') } } }
}
