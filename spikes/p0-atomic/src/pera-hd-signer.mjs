import algosdk from 'algosdk'
import { mnemonicToSeed, validateMnemonic } from 'bip39'
import { BIP32DerivationType, KeyContext, XHDWalletAPI, fromSeed } from '@algorandfoundation/xhd-wallet-api'

export const PERA_DERIVATION = Object.freeze({
  path: "m/44'/283'/account'/0/addressIndex",
  variant: 'Peikert',
  change: 0,
})

const index = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff

export function validatePeraHdMnemonic(mnemonic) {
  return typeof mnemonic === 'string' && mnemonic.trim().split(/\s+/).length === 24 && validateMnemonic(mnemonic)
}

export async function createPeraHdSigner({ mnemonic, accountIndex, addressIndex }) {
  if (!validatePeraHdMnemonic(mnemonic)) throw new Error('provide a valid 24-word BIP-39 mnemonic')
  if (!index(accountIndex) || !index(addressIndex)) throw new Error('provide non-negative safe account and address indices')
  let seed = Buffer.from(await mnemonicToSeed(mnemonic))
  let rootKey
  try {
    rootKey = fromSeed(seed)
  } finally {
    seed.fill(0)
    seed = undefined
  }
  const api = new XHDWalletAPI()
  const publicKey = await api.keyGen(rootKey, KeyContext.Address, accountIndex, addressIndex, BIP32DerivationType.Peikert)
  const address = algosdk.encodeAddress(publicKey)
  const addr = new algosdk.Address(publicKey)
  let disposed = false
  return Object.freeze({
    addr,
    address,
    accountIndex,
    addressIndex,
    async signTransaction(transaction) {
      if (disposed) throw new Error('HD signer has been disposed')
      const signature = await api.signAlgoTransaction(rootKey, KeyContext.Address, accountIndex, addressIndex, transaction.bytesToSign(), BIP32DerivationType.Peikert)
      return transaction.attachSignature(addr, signature)
    },
    dispose() {
      if (rootKey) rootKey.fill(0)
      rootKey = undefined
      disposed = true
    },
  })
}
