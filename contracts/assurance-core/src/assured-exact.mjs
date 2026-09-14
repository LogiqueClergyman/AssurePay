import algosdk from 'algosdk'
import { ALGORAND_TESTNET_CAIP2 } from '@x402/avm'

export const ASSURED_EXACT_SCHEME = 'assured-exact'
export const ASSURANCE_CORE_PROFILE = 'assurance-core-v1'
export const TESTNET_NETWORK = ALGORAND_TESTNET_CAIP2
export const OPEN_COVERAGE_SIGNATURE = 'openCoverage(byte[32],byte[32],byte[32],byte[32],uint64)void'

const OPEN_COVERAGE = algosdk.ABIMethod.fromSignature(OPEN_COVERAGE_SIGNATURE)
const uint64 = algosdk.ABIType.from('uint64')
const box = (prefix, id) => new Uint8Array(Buffer.concat([Buffer.from(prefix), Buffer.from(id)]))
const b64 = (value) => Buffer.from(value).toString('base64')

const requireAddress = (value, field) => {
  if (typeof value !== 'string' || !algosdk.isValidAddress(value)) throw new Error(`invalid ${field}`)
  return value
}
const requireBytes32 = (value, field) => {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error(`invalid ${field}`)
  return value
}

export async function buildAssuredExactPayloadWithSigner({
  payer,
  signTransaction,
  provider,
  application,
  assetId,
  providerNet,
  premium,
  applicationId,
  coverageId,
  providerId,
  policyId,
  requestCommitment,
  params,
  maxTimeoutSeconds = 120,
}) {
  requireAddress(payer, 'payer')
  requireAddress(provider, 'provider')
  requireAddress(application, 'application')
  for (const [field, value] of Object.entries({ coverageId, providerId, policyId, requestCommitment })) requireBytes32(value, field)
  if (typeof signTransaction !== 'function') throw new Error('missing transaction signer')
  const gross = BigInt(providerNet) + BigInt(premium)
  if (gross <= 0n || BigInt(assetId) <= 0n || BigInt(applicationId) <= 0n) throw new Error('invalid assured-exact amount or identifier')
  const providerTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer,
    receiver: provider,
    assetIndex: Number(assetId),
    amount: Number(providerNet),
    suggestedParams: params,
  })
  const premiumTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer,
    receiver: application,
    assetIndex: Number(assetId),
    amount: Number(premium),
    suggestedParams: params,
  })
  const applicationCall = algosdk.makeApplicationNoOpTxnFromObject({
    sender: payer,
    appIndex: Number(applicationId),
    appArgs: [OPEN_COVERAGE.getSelector(), coverageId, providerId, policyId, requestCommitment, uint64.encode(gross)],
    boxes: [
      { appIndex: 0, name: box('p', providerId) },
      { appIndex: 0, name: box('l', policyId) },
      { appIndex: 0, name: box('c', coverageId) },
    ],
    foreignAssets: [Number(assetId)],
    suggestedParams: params,
  })
  const group = algosdk.assignGroupID([providerTransfer, premiumTransfer, applicationCall])
  const signed = []
  for (const transaction of group) signed.push(await signTransaction(transaction))
  const requirements = {
    scheme: ASSURED_EXACT_SCHEME,
    network: TESTNET_NETWORK,
    asset: String(assetId),
    amount: String(gross),
    payTo: provider,
    maxTimeoutSeconds,
    extra: {
      profile: ASSURANCE_CORE_PROFILE,
      provider,
      applicationAddress: application,
      applicationId: String(applicationId),
      providerNet: String(providerNet),
      premium: String(premium),
      coverageId: b64(coverageId),
      providerId: b64(providerId),
      policyId: b64(policyId),
      requestCommitment: b64(requestCommitment),
    },
  }
  return {
    group,
    signed,
    paymentGroup: signed.map((transaction) => Buffer.from(transaction).toString('base64')),
    requirements,
    groupId: Buffer.from(group[0].group).toString('base64'),
    gross,
  }
}
