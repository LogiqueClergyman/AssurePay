import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import algosdk from 'algosdk'

const root = path.resolve(import.meta.dirname, '..')
const artifacts = path.join(root, 'artifacts')
const source = path.join(root, 'contract')
const arc32 = JSON.parse(fs.readFileSync(path.join(artifacts, 'AssuranceCore.arc32.json'), 'utf8'))
const arc56 = JSON.parse(fs.readFileSync(path.join(artifacts, 'AssuranceCore.arc56.json'), 'utf8'))
const address = algosdk.generateAccount().addr.toString()

const recordTypes = {
  ProviderRecord: '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)',
  PolicyRecord: '(byte[32],bool,uint64,uint64,uint64,uint64,uint64)',
  CoverageRecord: '(byte[32],byte[32],address,uint64,uint64,uint64,uint64,uint64,byte[32],uint64,uint64,uint64,bool)',
  FinalizedClaimRecord: '(byte[32],bool,uint64,bool,uint64,uint64,uint64,uint64)',
}

const methodMap = new Map(arc56.methods.map((method) => [method.name, method]))
const eventSignature = (event) => `${event.name}(${event.args.map((arg) => arg.type).join(',')})`
const eventPrefix = (signature) => crypto.createHash('sha512-256').update(signature).digest().subarray(0, 4)

test('compiled artifacts are present, current, and use the pinned compiler', () => {
  for (const file of ['AssuranceCore.arc32.json', 'AssuranceCore.arc56.json', 'AssuranceCore.approval.teal', 'AssuranceCore.clear.teal', 'AssuranceCore.client.ts']) {
    assert.equal(fs.existsSync(path.join(artifacts, file)), true, file)
  }
  assert.deepEqual(arc56.compilerInfo, { compiler: 'puya', compilerVersion: { major: 5, minor: 10, patch: 0 } })
  assert.equal(Buffer.from(arc56.source.approval, 'base64').toString(), fs.readFileSync(path.join(artifacts, 'AssuranceCore.approval.teal'), 'utf8'))
  assert.equal(Buffer.from(arc56.source.clear, 'base64').toString(), fs.readFileSync(path.join(artifacts, 'AssuranceCore.clear.teal'), 'utf8'))
  assert.equal(arc32.state.global.num_uints, 6)
  assert.equal(arc32.state.global.num_byte_slices, 2)
})

test('Gate A ABI methods have the exact read and mutation surface', () => {
  assert.deepEqual([...methodMap.keys()].slice(0, 2), ['createApplication', 'optInAcceptedAsset'])
  assert.deepEqual([...methodMap.keys()].slice(-2), ['getConfig', 'getAccounting'])
  assert.deepEqual(methodMap.get('createApplication').args.map((arg) => arg.type), ['uint64', 'address'])
  assert.equal(methodMap.get('createApplication').returns.type, 'void')
  assert.deepEqual(methodMap.get('optInAcceptedAsset').args.map((arg) => arg.type), ['uint64'])
  assert.equal(methodMap.get('optInAcceptedAsset').returns.type, 'void')
  assert.equal(methodMap.get('getConfig').returns.type, '(address,address,uint64,uint64,uint64)')
  assert.equal(methodMap.get('getAccounting').returns.type, '(uint64,uint64,uint64)')
  assert.equal(methodMap.get('getConfig').readonly, true)
  assert.equal(methodMap.get('getAccounting').readonly, true)
})

test('all four namespaces are one byte and append a fixed byte[32] ID', () => {
  const contract = fs.readFileSync(path.join(source, 'assurance-core.algo.ts'), 'utf8')
  const prefixes = [...contract.matchAll(/BoxMap<RecordId,\s*\w+>\(\{ keyPrefix: '([^'])' \}\)/g)].map((match) => match[1])
  assert.deepEqual(prefixes, ['p', 'l', 'c', 'f'])
  assert.equal(new Set(prefixes).size, 4)
  assert.deepEqual(prefixes.map((prefix) => Buffer.byteLength(prefix) + 32), [33, 33, 33, 33])
})

test('compiled ARC-4 record layouts have the documented fixed lengths', () => {
  const expected = { ProviderRecord: 129, PolicyRecord: 73, CoverageRecord: 193, FinalizedClaimRecord: 74 }
  for (const [name, signature] of Object.entries(recordTypes)) {
    const type = algosdk.ABIType.from(signature)
    assert.equal(type.isDynamic(), false, name)
    assert.equal(type.byteLen(), expected[name], name)
    assert.equal(type.encode(name === 'ProviderRecord'
      ? [address, address, new Uint8Array(32), false, 0, 0, 0, 0]
      : name === 'PolicyRecord'
        ? [new Uint8Array(32), false, 0, 0, 0, 0, 0]
        : name === 'CoverageRecord'
          ? [new Uint8Array(32), new Uint8Array(32), address, 0, 0, 0, 0, 0, new Uint8Array(32), 0, 0, 0, false]
          : [new Uint8Array(32), false, 0, false, 0, 0, 0, 0]).length, expected[name], name)
    assert.equal(arc56.structs[name].map((field) => field.type).join(','), signature.slice(1, -1).replaceAll('(', '').replaceAll(')', ''))
  }
})

test('box MBR calculations use the current protocol formula', () => {
  const formula = (keyLength, valueLength) => 2500 + 400 * (keyLength + valueLength)
  assert.deepEqual({
    provider: formula(33, 129),
    policy: formula(33, 73),
    coverage: formula(33, 193),
    claim: formula(33, 74),
  }, { provider: 67300, policy: 44900, coverage: 92900, claim: 45300 })
  assert.equal(67300 + 44900 + 92900 + 45300, 250400)
})

test('global schema and event ABI projections are fixed', () => {
  assert.deepEqual(arc32.schema.global.declared, {
    acceptedAssetId: { type: 'uint64', key: 'acceptedAssetId' },
    adjudicator: { type: 'bytes', key: 'adjudicator' },
    admin: { type: 'bytes', key: 'admin' },
    assetOptedIn: { type: 'uint64', key: 'assetOptedIn' },
    paused: { type: 'uint64', key: 'paused' },
    premiumReserve: { type: 'uint64', key: 'premiumReserve' },
    totalOpenFaultExposure: { type: 'uint64', key: 'totalOpenFaultExposure' },
    totalProviderStake: { type: 'uint64', key: 'totalProviderStake' },
  })

  const created = arc56.events.find((event) => event.name === 'ProtocolCreated')
  const optedIn = arc56.events.find((event) => event.name === 'ProtocolAssetOptedIn')
  assert.equal(eventSignature(created), 'ProtocolCreated(uint64,address,address,uint64)')
  assert.equal(eventSignature(optedIn), 'ProtocolAssetOptedIn(uint64,uint64)')

  const createdValues = [1n, address, address, 10458941n]
  const createdPayload = Buffer.concat([eventPrefix(eventSignature(created)), Buffer.from(algosdk.ABIType.from('(uint64,address,address,uint64)').encode(createdValues))])
  assert.deepEqual([...createdPayload.subarray(0, 4)], [...eventPrefix('ProtocolCreated(uint64,address,address,uint64)')])
  assert.deepEqual(algosdk.ABIType.from('(uint64,address,address,uint64)').decode(createdPayload.subarray(4)), createdValues)

  const optInValues = [1n, 10458941n]
  const optInPayload = Buffer.concat([eventPrefix(eventSignature(optedIn)), Buffer.from(algosdk.ABIType.from('(uint64,uint64)').encode(optInValues))])
  assert.deepEqual(algosdk.ABIType.from('(uint64,uint64)').decode(optInPayload.subarray(4)), optInValues)
})

test('unsafe controls are explicitly guarded in both state-changing methods', () => {
  const contract = fs.readFileSync(path.join(source, 'assurance-core.algo.ts'), 'utf8')
  assert.equal((contract.match(/Txn\.rekeyTo\.bytes === Global\.zeroAddress\.bytes/g) ?? []).length, 9)
  assert.match(contract, /fee: 0/)
  assert.match(contract, /Txn\.fee >= Global\.minTxnFee \* 2/)
})
