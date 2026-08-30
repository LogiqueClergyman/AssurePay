/**
 * Off-chain mirror used to construct negative cases before LocalNet deployment.
 * The authoritative validation is the compiled AlgoTS contract.
 */
export function validateAssuranceGroup({ group, assetId, provider, appAddress, gross, premium, commitment, reject }) {
  if (group.length !== 3) throw new Error('GROUP_SIZE')
  const [providerPayment, premiumPayment, appCall] = group
  if (providerPayment.type !== 'axfer' || premiumPayment.type !== 'axfer' || appCall.type !== 'appl') throw new Error('GROUP_SHAPE')
  if (providerPayment.sender !== premiumPayment.sender || appCall.sender !== providerPayment.sender) throw new Error('PAYER_MISMATCH')
  if (providerPayment.assetId !== assetId || premiumPayment.assetId !== assetId) throw new Error('ASSET_MISMATCH')
  if (providerPayment.receiver !== provider) throw new Error('PROVIDER_RECEIVER')
  if (premiumPayment.receiver !== appAddress) throw new Error('PREMIUM_RECEIVER')
  if (providerPayment.amount + premiumPayment.amount !== gross || premiumPayment.amount !== premium) throw new Error('AMOUNT_MISMATCH')
  if (!(commitment instanceof Uint8Array) || commitment.length === 0) throw new Error('COMMITMENT')
  for (const txn of [providerPayment, premiumPayment]) {
    if (txn.rekeyTo || txn.closeTo) throw new Error('UNSAFE_TRANSACTION_CONTROL')
  }
  if (reject) throw new Error('FORCED_REJECTION')
  return { marker: 'coverage-opened' }
}
