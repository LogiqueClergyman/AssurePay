import assert from 'node:assert/strict'
import test from 'node:test'
import algosdk from 'algosdk'
import { ed25519Verifier } from '@algorandfoundation/algokit-utils/crypto'
import { BIP32DerivationType, KeyContext, XHDWalletAPI, fromSeed } from '@algorandfoundation/xhd-wallet-api'
import { mnemonicToSeed } from 'bip39'
import { buildAssuredExactPayloadWithSigner } from '../src/assured-exact.mjs'
import { createPeraHdSigner, validatePeraHdMnemonic } from '../src/pera-hd-signer.mjs'
import { testnetConfig } from '../scripts/run-testnet.mjs'

const mnemonic = 'salon zoo engage submit smile frost later decide wing sight chaos renew lizard rely canal coral scene hobby scare step bus leaf tobacco slice'
const params = { fee: 1000, firstValid: 1, lastValid: 1000, genesisHash: new Uint8Array(32), genesisID: 'testnet-v1.0', flatFee: true }

test('Pera HD signer accepts only a valid 24-word BIP-39 phrase', () => {
  assert.equal(validatePeraHdMnemonic(mnemonic), true)
  assert.equal(validatePeraHdMnemonic(mnemonic.split(' ').slice(0, 23).join(' ')), false)
  assert.equal(validatePeraHdMnemonic(`${mnemonic.slice(0, -5)} abort`), false)
})

test('ARC-52 official public vector derives the documented Khovratovich address', async () => {
  const seed = Buffer.from(await mnemonicToSeed(mnemonic))
  const rootKey = fromSeed(seed)
  seed.fill(0)
  try {
    const publicKey = await new XHDWalletAPI().keyGen(rootKey, KeyContext.Address, 0, 0, BIP32DerivationType.Khovratovich)
    assert.equal(algosdk.encodeAddress(publicKey), 'ML7IGK322ECUJPUDG6THAQ26KBSK4STG4555PCIJOZNUNNLWU3Z3ZFXITA')
  } finally {
    rootKey.fill(0)
  }
})

test('Pera Peikert derivation honors account and address indices', async () => {
  const first = await createPeraHdSigner({ mnemonic, accountIndex: 0, addressIndex: 0 })
  const nextAddress = await createPeraHdSigner({ mnemonic, accountIndex: 0, addressIndex: 1 })
  const nextAccount = await createPeraHdSigner({ mnemonic, accountIndex: 1, addressIndex: 0 })
  try {
    assert.equal(first.address, 'PPNHVQJGE6ZMEWPR35UHLUYMCCZV6VNTHLJMZDVCONXKUPV47K4WGQJWGI')
    assert.notEqual(first.address, nextAddress.address)
    assert.notEqual(first.address, nextAccount.address)
  } finally {
    first.dispose(); nextAddress.dispose(); nextAccount.dispose()
  }
})

test('Pera address mismatch is rejected during configuration before any network mutation', async () => {
  const settings = await testnetConfig({ TESTNET_PAYER_HD_MNEMONIC: mnemonic, TESTNET_PAYER_ADDRESS: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ', TESTNET_PAYER_ACCOUNT_INDEX: '0', TESTNET_PAYER_ADDRESS_INDEX: '0', TESTNET_ASA_ID: '77', TESTNET_ALGOD_SERVER: 'https://testnet.example' })
  try {
    assert.ok(settings.missing.includes('TESTNET_PAYER_ADDRESS: derived Pera address does not match the required public safety assertion'))
    assert.equal(settings.payer.address, 'PPNHVQJGE6ZMEWPR35UHLUYMCCZV6VNTHLJMZDVCONXKUPV47K4WGQJWGI')
  } finally {
    settings.payer?.dispose()
  }
})

test('Pera signer signs every immutable assured-exact member with independently verifiable signatures', async () => {
  const payer = await createPeraHdSigner({ mnemonic, accountIndex: 0, addressIndex: 0 })
  const provider = algosdk.generateAccount().addr
  const application = algosdk.getApplicationAddress(42)
  try {
    const built = await buildAssuredExactPayloadWithSigner({ payer: payer.addr, signTransaction: (txn) => payer.signTransaction(txn), provider, application, assetId: 77n, providerNet: 93n, premium: 7n, applicationId: 42n, commitment: new Uint8Array(32).fill(7), params })
    const members = built.paymentGroup.map((encoded) => algosdk.decodeSignedTransaction(Buffer.from(encoded, 'base64')))
    assert.equal(members.length, 3)
    assert.deepEqual(members.map((member) => member.txn.type), ['axfer', 'axfer', 'appl'])
    assert.ok(members.every((member) => Buffer.from(member.txn.group).equals(Buffer.from(members[0].txn.group))))
    assert.deepEqual(await Promise.all(members.map((member) => ed25519Verifier(new Uint8Array(member.sig), member.txn.bytesToSign(), payer.addr.publicKey))), [true, true, true])
  } finally {
    payer.dispose()
  }
})

test('Pera HD errors and configuration records never interpolate the mnemonic', async () => {
  const invalid = `${mnemonic} extra`
  await assert.rejects(createPeraHdSigner({ mnemonic: invalid, accountIndex: 0, addressIndex: 0 }), (error) => !String(error.message).includes(invalid))
  const settings = await testnetConfig({ TESTNET_PAYER_HD_MNEMONIC: invalid })
  assert.equal(JSON.stringify(settings).includes(invalid), false)
})
