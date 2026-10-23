import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProvider, providerErrorCode, readProviderConfig, validateProviderConfig } from '../src/index.js';

const address = (digit: string) => `0x${digit.repeat(40)}`;
const id = (digit: string) => `0x${digit.repeat(64)}`;
const input = () => ({
  version: 1, mode: 'local', chainId: 84532,
  rpcUrl: 'http://127.0.0.1:12345', core: address('5'), token: address('6'),
  providerId: id('1'), policyId: id('2'), serviceId: id('3'),
  roles: { relayer: address('1'), payer: address('2'), provider: address('3'), adjudicator: address('4') },
  resourceUrl: 'http://127.0.0.1:12346/service', claimsUrl: 'http://127.0.0.1:12347',
  deploymentBlock: '1', gross: '10003',
});

test('public config validation captures and freezes identity and rejects unsupported context', () => {
  const source = input();
  const config = validateProviderConfig(source);
  source.roles.provider = address('9'); source.gross = '999';
  assert.equal(config.roles.provider, address('3'));
  assert.equal(config.gross, '10003');
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.roles));
  for (const bad of [
    { ...input(), mode: 'public' }, { ...input(), chainId: 1 },
    { ...input(), rpcUrl: 'https://example.org' },
    { ...input(), token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' },
    { ...input(), gross: 10003.5 }, { ...input(), extra: true },
    { ...input(), roles: { ...input().roles, payer: address('1') } },
  ]) assert.throws(() => validateProviderConfig(bad), error => providerErrorCode(error) !== 'PROVIDER_OPERATION_FAILED');
});

test('public config reader rejects symlinks, malformed and oversized fresh files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-sdk-config-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(input()), { mode: 0o600 });
    assert.equal((await readProviderConfig(path)).gross, '10003');
    const linked = join(directory, 'linked.json'); await symlink(path, linked);
    await assert.rejects(readProviderConfig(linked), { message: 'PILOT_CONFIG_INVALID' });
    await writeFile(path, '{');
    await assert.rejects(readProviderConfig(path), { message: 'PILOT_CONFIG_INVALID' });
    await writeFile(path, ' '.repeat(16_385));
    await assert.rejects(readProviderConfig(path), { message: 'PILOT_CONFIG_INVALID' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid provider capabilities fail before RPC or storage startup with fixed errors', async () => {
  const config = validateProviderConfig(input());
  const options = {
    config, storage: { directory: '/unused-by-invalid-config', key: new Uint8Array(32) },
    receiptSigner: { address: config.roles.provider, async signTypedData(): Promise<`0x${string}`> { throw Error('MUST_NOT_SIGN'); } },
    handler: (body: Uint8Array) => body,
  };
  await assert.rejects(createProvider({ ...options, storage: { ...options.storage, key: new Uint8Array(31) } }), { message: 'PROVIDER_OPTIONS_INVALID' });
  await assert.rejects(createProvider({ ...options, receiptSigner: { ...options.receiptSigner, address: config.roles.payer } }), { message: 'PILOT_PROVIDER_CONFIG_INVALID' });
  await assert.rejects(createProvider({ ...options, relayerAccount: { address: config.roles.payer } as never }), { message: 'PILOT_RELAYER_MISMATCH' });
  const hostile = { ...options, get storage(): never { throw Error('/private/key/content'); } };
  await assert.rejects(createProvider(hostile), { message: 'PROVIDER_OPERATION_FAILED' });
});
