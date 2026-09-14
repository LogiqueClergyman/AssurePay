import algosdk from 'algosdk'
import { mnemonicToSeed, validateMnemonic } from 'bip39'
import { BIP32DerivationType, KeyContext, XHDWalletAPI, fromSeed } from '@algorandfoundation/xhd-wallet-api'

export const PERA_DERIVATION = Object.freeze({
  path: "m/44'/283'/account'/0/addressIndex",
  variant: 'Peikert',
  change: 0,
})

const MAX_INDEX = 0x7fffffff
const isBoundedIndex = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INDEX
const isValidWordPhrase = (value) => typeof value === 'string' && value.trim().split(/\s+/).length === 24 && validateMnemonic(value.trim())

export function validatePeraHdMnemonic(mnemonic) {
  return isValidWordPhrase(mnemonic)
}

const invalid = () => new Error('invalid Pera HD signer configuration')

/**
 * The returned object is intentionally opaque. Private key material stays in
 * this closure and is erased by dispose() when the wallet library permits it.
 */
export async function createPeraHdSigner({ mnemonic, accountIndex, addressIndex }) {
  if (!isValidWordPhrase(mnemonic) || !isBoundedIndex(accountIndex) || !isBoundedIndex(addressIndex)) throw invalid()

  let seed
  let rootKey
  let publicKey
  let addressObject
  let disposed = false
  const api = new XHDWalletAPI()
  try {
    seed = Buffer.from(await mnemonicToSeed(mnemonic.trim()))
    rootKey = fromSeed(seed)
    publicKey = await api.keyGen(rootKey, KeyContext.Address, accountIndex, addressIndex, BIP32DerivationType.Peikert)
    addressObject = new algosdk.Address(publicKey)
  } catch {
    if (seed?.fill) seed.fill(0)
    if (rootKey?.fill) rootKey.fill(0)
    throw invalid()
  } finally {
    if (seed?.fill) seed.fill(0)
    seed = undefined
  }

  const address = algosdk.encodeAddress(publicKey)
  const signer = {
    address,
    async signTransaction(transaction) {
      if (disposed || !rootKey) throw new Error('Pera HD signer has been disposed')
      if (!transaction || typeof transaction.bytesToSign !== 'function' || typeof transaction.attachSignature !== 'function') throw new Error('Pera HD signer received an invalid transaction')
      try {
        const signature = await api.signAlgoTransaction(rootKey, KeyContext.Address, accountIndex, addressIndex, transaction.bytesToSign(), BIP32DerivationType.Peikert)
        return transaction.attachSignature(addressObject, signature)
      } catch {
        throw new Error('Pera HD transaction signing failed')
      }
    },
    dispose() {
      if (disposed) return
      if (rootKey?.fill) rootKey.fill(0)
      rootKey = undefined
      publicKey = undefined
      addressObject = undefined
      disposed = true
    },
    toJSON() {
      return { address }
    },
  }
  return Object.freeze(signer)
}
