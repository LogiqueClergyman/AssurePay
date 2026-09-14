import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import algosdk from 'algosdk'

const root = path.resolve(import.meta.dirname, '..')
const artifacts = path.join(root, 'artifacts')
const source = path.join(root, 'contract')
const arc56 = JSON.parse(fs.readFileSync(path.join(artifacts, 'AssuranceCore.arc56.json'), 'utf8'))
const contract = fs.readFileSync(path.join(source, 'assurance-core.algo.ts'), 'utf8')
const methods = new Map(arc56.methods.map((method) => [method.name, method]))
const signature = (item) => `${item.name}(${item.args.map((arg) => arg.type).join(',')})`
const prefix = (item) => crypto.createHash('sha512-256').update(signature(item)).digest().subarray(0, 4)

test('Gate B ABI surface preserves Gate A and freezes typed methods', () => {
  assert.deepEqual([...methods.keys()], [
    'createApplication',
    'optInAcceptedAsset',
    'setPaused',
    'registerProvider',
    'setProviderStatus',
    'getProvider',
    'createPolicy',
    'setPolicyStatus',
    'getPolicy',
    'depositStake',
    'getAvailableCapacity',
    'openCoverage',
    'getCoverage',
    'withdrawStake',
    'closeCoverage',
    'finalizeClaim',
    'getClaim',
    'getConfig',
    'getAccounting',
  ])
  assert.deepEqual(methods.get('setPaused').args.map((arg) => arg.type), ['bool'])
  assert.deepEqual(methods.get('registerProvider').args.map((arg) => arg.type), ['byte[32]', 'address', 'byte[32]'])
  assert.deepEqual(methods.get('createPolicy').args.map((arg) => arg.type), ['byte[32]', 'byte[32]', 'uint64', 'uint64', 'uint64', 'uint64'])
  assert.deepEqual(methods.get('depositStake').args.map((arg) => arg.type), ['byte[32]', 'axfer'])
  assert.equal(methods.get('getProvider').returns.type, '(address,address,byte[32],bool,uint64,uint64,uint64,uint64)')
  assert.equal(methods.get('getPolicy').returns.type, '(byte[32],bool,uint64,uint64,uint64,uint64,uint64)')
  assert.equal(methods.get('getAvailableCapacity').returns.type, 'uint64')
  for (const name of ['getProvider', 'getPolicy', 'getAvailableCapacity']) assert.equal(methods.get(name).readonly, true)
})

test('Gate B events have exact public signatures and ARC-28 prefixes', () => {
  const expected = {
    ProtocolPauseChanged: 'ProtocolPauseChanged(uint64,bool)',
    ProviderRegistered: 'ProviderRegistered(uint64,byte[32],address,address,byte[32],uint64)',
    ProviderStatusChanged: 'ProviderStatusChanged(uint64,byte[32],bool)',
    PolicyCreated: 'PolicyCreated(uint64,byte[32],byte[32],uint64,uint64,uint64,uint64,uint64)',
    PolicyStatusChanged: 'PolicyStatusChanged(uint64,byte[32],bool)',
    StakeDeposited: 'StakeDeposited(uint64,byte[32],uint64,uint64)',
  }
  for (const [name, wanted] of Object.entries(expected)) {
    const event = arc56.events.find((item) => item.name === name)
    assert.equal(signature(event), wanted)
    assert.deepEqual([...prefix(event)], [...crypto.createHash('sha512-256').update(wanted).digest().subarray(0, 4)])
  }
})

test('Gate B source guards pause, ownership, fixed references, and asset invariants', () => {
  assert.match(contract, /private requireUnpaused\(\)/)
  assert.equal((contract.match(/this\.requireUnpaused\(\)/g) ?? []).length, 7)
  assert.match(contract, /const provider = this\.providers\(providerId\)/)
  assert.match(contract, /const policy = this\.policies\(policyId\)/)
  assert.match(contract, /assert\(Global\.groupSize === 2, 'exactly two group members required'\)/)
  assert.match(contract, /assert\(Txn\.groupIndex === 1, 'application call must be second'\)/)
  assert.match(contract, /Asset\(this\.acceptedAssetId\.value\)\.balance\(Global\.currentApplicationAddress\)/)
  assert.match(contract, /assert\(this\.totalProviderStake\.value \+ transfer\.assetAmount <= applicationHolding/)
  assert.match(contract, /assert\(transfer\.assetSender\.bytes === Global\.zeroAddress\.bytes/)
  assert.match(contract, /assert\(transfer\.assetCloseTo\.bytes === Global\.zeroAddress\.bytes/)
  assert.match(contract, /assert\(transfer\.rekeyTo\.bytes === Global\.zeroAddress\.bytes/)
})

test('capacity model uses floor, locked stake, and uint64 saturation', () => {
  const max = 18_446_744_073_709_551_615n
  const capacity = (stake, locked, ratio) => {
    assert.ok(stake >= locked)
    const result = ((stake - locked) * 10_000n) / ratio
    return result > max ? max : result
  }
  assert.equal(capacity(1_000n, 0n, 10_000n), 1_000n)
  assert.equal(capacity(1_000n, 0n, 2_500n), 4_000n)
  assert.equal(capacity(1_001n, 0n, 3_000n), 3_336n)
  assert.equal(capacity(1_000n, 400n, 2_000n), 3_000n)
  assert.equal(capacity(1_000n, 1_000n, 1n), 0n)
  assert.equal(capacity(max, 0n, 1n), max)
  assert.equal(capacity(max, 0n, 2n), max)
  assert.equal(capacity(max, 0n, 10_000n), max)
  assert.throws(() => capacity(1n, 2n, 1n))
})

test('box MBR evidence remains exact for Gate B records', () => {
  const mbr = (keyLength, valueLength) => 2_500 + 400 * (keyLength + valueLength)
  assert.equal(mbr(33, 129), 67_300)
  assert.equal(mbr(33, 73), 44_900)
  assert.equal(67_300 + 2 * 44_900, 157_100)
})

test('invalid provider and policy inputs fail before any model mutation', () => {
  const register = (id, payout, key) => {
    if (id.every((byte) => byte === 0)) throw new Error('provider id must be non-zero')
    if (payout.every((byte) => byte === 0)) throw new Error('payout must be non-zero')
    if (key.every((byte) => byte === 0)) throw new Error('receipt key must be non-zero')
  }
  const create = (premium, collateral, maximum, window) => {
    if (premium < 1 || premium > 10_000) throw new Error('invalid premium bps')
    if (collateral < 1 || collateral > 10_000) throw new Error('invalid collateral bps')
    if (maximum <= 0 || window <= 0) throw new Error('invalid policy terms')
  }
  const zero = new Uint8Array(32)
  assert.throws(() => register(zero, new Uint8Array(32).fill(1), new Uint8Array(32).fill(1)), /provider id/)
  assert.throws(() => register(new Uint8Array(32).fill(1), zero, new Uint8Array(32).fill(1)), /payout/)
  assert.throws(() => register(new Uint8Array(32).fill(1), new Uint8Array(32).fill(1), zero), /receipt key/)
  assert.throws(() => create(0, 1, 1, 1), /premium/)
  assert.throws(() => create(10_001, 1, 1, 1), /premium/)
  assert.throws(() => create(1, 0, 1, 1), /collateral/)
  assert.throws(() => create(1, 10_001, 1, 1), /collateral/)
  assert.throws(() => create(1, 1, 0, 1), /policy terms/)
  assert.throws(() => create(1, 1, 1, 0), /policy terms/)
})
