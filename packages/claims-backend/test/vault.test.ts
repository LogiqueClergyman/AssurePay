import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { keccak256, type Hex } from 'viem';
import { EncryptedVault } from '../src/vault.js';
import { createResultStore } from '../src/results.js';
import type { DurableServiceResult } from '../../x402-assurance/src/types.js';

const namespace = 'ab'.repeat(32);
const context = 'cd'.repeat(32);
const id = `0x${'11'.repeat(32)}` as Hex;
const requestHash = `0x${'22'.repeat(32)}` as Hex;
const transaction = `0x${'33'.repeat(32)}` as Hex;
const blockHash = `0x${'44'.repeat(32)}` as Hex;
const core = `0x${'55'.repeat(20)}` as const;
const address = `0x${'66'.repeat(20)}` as const;
const signature = `0x${randomBytes(65).toString('hex')}` as Hex;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assurepay-vault-'));
  const directory = join(root, 'objects');
  const key = randomBytes(32);
  const vault = new EncryptedVault({ directory, namespace, keyId: 'local-v1', key });
  return { root, directory, vault, key, close: () => rm(root, { recursive: true, force: true }) };
}
const rawFile = async (directory: string) => {
  const names = await readdir(directory);
  return readFile(join(directory, names.find(name => name.endsWith('.json'))!));
};
const result = (body: Uint8Array): DurableServiceResult => ({
  coverageId: id, requestHash, transaction, blockNumber: '17', blockHash, status: 201, body,
  receipt: { message: { chainId: '84532', core, coverageId: id, requestHash, responseHash: keccak256(body), status: 201, completedAt: '1800000000' }, signature },
});

test('vault encrypts immutable JSON and snapshots mutable input before async storage', async () => {
  const f = await fixture();
  try {
    const value = { body: 'private response', nested: { value: 1 } };
    const write = f.vault.put('evidence', id, value);
    value.nested.value = 2;
    await write;
    assert.deepEqual(await f.vault.get('evidence', id), { body: 'private response', nested: { value: 1 } });
    const bytes = await rawFile(f.directory);
    assert.equal(bytes.includes(Buffer.from('private response')), false);
    assert.equal(bytes.includes(Buffer.from(signature)), false);
    await f.vault.put('evidence', id, { nested: { value: 1 }, body: 'private response' });
    await assert.rejects(f.vault.put('evidence', id, { body: 'different' }), /VAULT_CONFLICT/);
  } finally { await f.close(); }
});

test('vault rejects wrong key, tampering, namespace mismatch and object identity mismatch', async () => {
  const f = await fixture();
  try {
    await f.vault.put('decision', id, { reason: 'private reason' });
    const wrongKey = new EncryptedVault({ directory: f.directory, namespace, keyId: 'local-v1', key: randomBytes(32) });
    await assert.rejects(wrongKey.get('decision', id), /VAULT_CORRUPT/);
    const wrongNamespace = new EncryptedVault({ directory: f.directory, namespace: 'ef'.repeat(32), keyId: 'local-v1', key: f.key });
    await assert.rejects(wrongNamespace.get('decision', id), /VAULT_CORRUPT/);
    const bytes = await rawFile(f.directory);
    const envelope = JSON.parse(bytes.toString('utf8')) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}${envelope.ciphertext.endsWith('00') ? '01' : '00'}`;
    const file = join(f.directory, `decision-${id.slice(2)}.json`);
    await writeFile(file, `${JSON.stringify(envelope)}\n`);
    await assert.rejects(f.vault.get('decision', id), /VAULT_CORRUPT/);
    await rename(file, join(f.directory, `decision-${'99'.repeat(32)}.json`));
    await assert.rejects(f.vault.get('decision', `0x${'99'.repeat(32)}` as Hex), /VAULT_CORRUPT/);
  } finally { await f.close(); }
});

test('vault rejects symlinks, truncated files, and oversized plaintext', async () => {
  const f = await fixture();
  try {
    await mkdir(f.directory, { recursive: true });
    const file = join(f.directory, `evidence-${id.slice(2)}.json`);
    await symlink(join(f.root, 'absent-target'), file);
    await assert.rejects(f.vault.get('evidence', id), /VAULT_UNSAFE_PATH/);
    await rm(file);
    await writeFile(file, '{');
    await chmod(file, 0o600);
    await assert.rejects(f.vault.get('evidence', id), /VAULT_CORRUPT/);
    await assert.rejects(f.vault.put('evidence', id, { data: 'x'.repeat(262_145) }), /VAULT_SIZE/);
  } finally { await f.close(); }
});

test('result store round-trips the exact body and encrypted receipt, and binds context and identity', async () => {
  const f = await fixture();
  try {
    const store = createResultStore(f.vault);
    const body = new TextEncoder().encode('durable response bytes');
    const saved = result(body);
    await store.put(context, saved);
    saved.body.fill(0);
    const restored = await store.get(context, id, requestHash);
    assert.deepEqual(restored?.body, new TextEncoder().encode('durable response bytes'));
    assert.deepEqual(restored?.receipt, result(new TextEncoder().encode('durable response bytes')).receipt);
    await assert.rejects(store.get('00'.repeat(32), id, requestHash), /RESULT_INVALID/);
    await assert.rejects(store.get(context, id, `0x${'88'.repeat(32)}` as Hex), /RESULT_INVALID/);
    const bytes = await rawFile(f.directory);
    assert.equal(bytes.includes(Buffer.from('durable response bytes')), false);
    assert.equal(bytes.includes(Buffer.from(signature)), false);
  } finally { await f.close(); }
});

test('result store rejects oversized or hash-inconsistent result objects', async () => {
  const f = await fixture();
  try {
    const store = createResultStore(f.vault);
    const body = new Uint8Array([1, 2, 3]);
    const bad = result(body);
    bad.receipt.message.responseHash = `0x${'00'.repeat(32)}`;
    await assert.rejects(store.put(context, bad), /RESULT_INVALID/);
    await assert.rejects(store.put(context, result(new Uint8Array(65_537))), /RESULT_INVALID/);
  } finally { await f.close(); }
});
