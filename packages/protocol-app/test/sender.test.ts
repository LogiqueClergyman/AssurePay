import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWalletClient, keccak256, toBytes, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { http } from 'viem';
import { createRoleSender } from '../src/sender.js';
import { transact } from '../../evm-core/test/helpers/evm.js';
import { createProtocolFixture } from './helpers.js';

function proxyClient(client: any, sendRawTransaction?: (raw: Hex) => Promise<Hex>) {
  return new Proxy(client, { get(target, key, receiver) {
    if (key === 'sendRawTransaction' && sendRawTransaction) return ({ serializedTransaction }: { serializedTransaction: Hex }) => sendRawTransaction(serializedTransaction);
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function withDirectory(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-m11-sender-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('preview does not sign; stale state consumes approval before any signature', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  await withDirectory(async directory => {
    const account = f.accounts.admin;
    let signatures = 0;
    const localWallet = createWalletClient({ account, chain: baseSepolia, transport: http(f.config.pilot.rpcUrl) });
    const wallet = { chain: { id: 84532 }, signTransaction: async (args: any) => { signatures++; return localWallet.signTransaction(args); } };
    const sender = await createRoleSender({ config: f.config, role: 'admin', account, directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: proxyClient(f.evm.publicClient), wallet });
    const preview = await sender.preview({ kind: 'setPaused', paused: true });
    assert.equal(signatures, 0);
    await transact(f.evm, f.artifacts.AssuranceCore.abi, f.config.pilot.core, 'setPaused', [true], account);
    await assert.rejects(() => sender.confirm(preview.previewId, { approved: true }), /PROTOCOL_PREVIEW_STALE/);
    assert.equal(signatures, 0);
    await assert.rejects(() => sender.confirm(preview.previewId, { approved: true }), /PROTOCOL_PREVIEW_REQUIRED/);
    const expiring = await sender.preview({ kind: 'setPaused', paused: false });
    await (f.evm.publicClient.request as any)({ method: 'anvil_increaseTime', params: [121] });
    await (f.evm.publicClient.request as any)({ method: 'anvil_mine', params: ['0x1'] });
    await assert.rejects(() => sender.confirm(expiring.previewId, { approved: true }), /PROTOCOL_PREVIEW_EXPIRED/);
    assert.equal(signatures, 0);
    await sender.close();
  });
});

test('unknown send response is recovered by original hash after signer-free restart', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  await withDirectory(async directory => {
    const account = f.accounts.admin;
    const localWallet = createWalletClient({ account, chain: baseSepolia, transport: http(f.config.pilot.rpcUrl) });
    let sends = 0, signatures = 0;
    const wallet = { chain: { id: 84532 }, signTransaction: async (args: any) => { signatures++; return localWallet.signTransaction(args); } };
    const client = proxyClient(f.evm.publicClient, async raw => {
      sends++;
      await f.evm.publicClient.sendRawTransaction({ serializedTransaction: raw });
      throw new Error('simulated response lost');
    });
    const receiptClient = new Proxy(client, { get(target, key, receiver) {
      if (key === 'getTransactionReceipt') return async (args: any) => {
        const receipt = await f.evm.publicClient.getTransactionReceipt(args);
        return { ...receipt, transactionHash: keccak256(toBytes('substituted receipt hash')) };
      };
      return Reflect.get(target, key, receiver);
    } });
    const sender = await createRoleSender({ config: f.config, role: 'admin', account, directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: receiptClient, wallet });
    const providerId = keccak256(toBytes('m11-new-provider'));
    const preview = await sender.preview({ kind: 'registerProvider', providerId,
      owner: f.accounts.provider.address, payout: f.accounts.provider.address });
    assert.equal(signatures, 0);
    const first = await sender.confirm(preview.previewId, { approved: true });
    assert.equal(first.status, 'unknown');
    assert.equal(first.operation, 'registerProvider');
    assert.equal(sends, 1);
    assert.equal(signatures, 1);
    const originalHash = first.transaction;
    await sender.close();

    const readonlySender = await createRoleSender({ config: f.config, role: 'admin', directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: proxyClient(f.evm.publicClient) });
    const reconciled = await readonlySender.reconcile();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].status, 'success');
    assert.equal(reconciled[0].transaction, originalHash);
    assert.equal(sends, 1);
    assert.equal(signatures, 1);
    await readonlySender.close();

    let failReads = true;
    const intermittentClient = new Proxy(f.evm.publicClient, { get(target, key, receiver) {
      if (failReads && (key === 'getTransaction' || key === 'getTransactionReceipt')) return async () => { throw new Error('temporary RPC failure'); };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const guarded = await createRoleSender({ config: f.config, role: 'admin', directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: intermittentClient });
    const temporarilyUnknown = await guarded.reconcile();
    assert.equal(temporarilyUnknown[0].status, 'unknown');
    assert.equal(Object.hasOwn(temporarilyUnknown[0], 'inclusion'), false);
    await guarded.close();
    failReads = false;
    const recoveredAgain = await createRoleSender({ config: f.config, role: 'admin', directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: proxyClient(f.evm.publicClient) });
    const restored = await recoveredAgain.reconcile();
    assert.equal(restored[0].status, 'success');
    assert.equal(restored[0].transaction, originalHash);
    assert.equal(sends, 1);
    assert.equal(signatures, 1);
    await recoveredAgain.close();
  });
});

test('live journal edits fail before signing and an actor marker prevents journal deletion reset', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  await withDirectory(async directory => {
    const account = f.accounts.admin;
    let signatures = 0;
    const localWallet = createWalletClient({ account, chain: baseSepolia, transport: http(f.config.pilot.rpcUrl) });
    const wallet = { chain: { id: 84532 }, signTransaction: async (args: any) => { signatures++; return localWallet.signTransaction(args); } };
    const sender = await createRoleSender({ config: f.config, role: 'admin', account, directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: proxyClient(f.evm.publicClient), wallet });
    const preview = await sender.preview({ kind: 'setPaused', paused: true });
    const path = join(directory, 'journal.json');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    parsed.records.push({});
    await writeFile(path, JSON.stringify(parsed), { mode: 0o600 });
    await assert.rejects(() => sender.confirm(preview.previewId, { approved: true }), /PROTOCOL_JOURNAL_INVALID/);
    assert.equal(signatures, 0);
    await sender.close();
    await unlink(path);
    await assert.rejects(() => createRoleSender({ config: f.config, role: 'admin', account, directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: proxyClient(f.evm.publicClient), wallet }), /PROTOCOL_JOURNAL_MISSING/);
  });
});

test('a pre-broadcast signing interruption stays stranded across a key-free restart', async (t) => {
  const f = await createProtocolFixture(); t.after(() => f.close());
  await withDirectory(async directory => {
    let signatures = 0, sends = 0;
    const limits = { maxActionAmount: '5000', maxActions: 8 };
    const client = proxyClient(f.evm.publicClient, async raw => {
      sends++; return f.evm.publicClient.sendRawTransaction({ serializedTransaction: raw });
    });
    const sender = await createRoleSender({ config: f.config, role: 'admin', account: f.accounts.admin,
      directory, limits, client, wallet: { chain: { id: 84532 }, async signTransaction() { signatures++; throw Error('FIXTURE_SIGN_INTERRUPTED'); } } });
    const preview = await sender.preview({ kind: 'setPaused', paused: true });
    await assert.rejects(sender.confirm(preview.previewId, { approved: true }));
    assert.equal(signatures, 1); assert.equal(sends, 0);
    await sender.close();
    const readonly = await createRoleSender({ config: f.config, role: 'admin', directory, limits, client });
    try {
      const rows = await readonly.reconcile();
      assert.equal(rows.length, 1); assert.equal(rows[0].status, 'reserved');
      assert.equal(Object.hasOwn(rows[0], 'transaction'), false);
      const next = await readonly.preview({ kind: 'setPaused', paused: true });
      await assert.rejects(readonly.confirm(next.previewId, { approved: true }), /PROTOCOL_UNRESOLVED/);
      assert.equal(signatures, 1); assert.equal(sends, 0);
    } finally { await readonly.close(); }
  });
});

test('every operation family rejects the wrong role; absent, false, replayed, concurrent, expired and capped approvals never sign', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  await withDirectory(async directory => {
    let sends = 0;
    const client = proxyClient(f.evm.publicClient, async raw => { sends++; return f.evm.publicClient.sendRawTransaction({ serializedTransaction: raw }); });
    const limits = { maxActionAmount: '5000', maxActions: 10 };
    const senders = {
      admin: await createRoleSender({ config: f.config, role: 'admin', directory: join(directory, 'admin'), limits, client }),
      provider: await createRoleSender({ config: f.config, role: 'provider', directory: join(directory, 'provider'), limits, client }),
      adjudicator: await createRoleSender({ config: f.config, role: 'adjudicator', directory: join(directory, 'adjudicator'), limits, client }),
    };
    try {
      const idOne = keccak256(toBytes('m11-role-denial-one'));
      const idTwo = keccak256(toBytes('m11-role-denial-two'));
      const rejected: Array<[keyof typeof senders, unknown]> = [
        ['provider', { kind: 'registerProvider', providerId: idOne, owner: f.accounts.payer.address, payout: f.accounts.payer.address }],
        ['provider', { kind: 'registerPolicy', policyId: idOne, providerId: f.config.pilot.providerId, premiumBps: 1, stakeBps: 1, withholdingBps: 1, duration: '60', poolOnlyAllowed: true }],
        ['provider', { kind: 'setPaused', paused: true }],
        ['provider', { kind: 'fundPool', amount: '1' }],
        ['adjudicator', { kind: 'approveCore', amount: '1' }],
        ['admin', { kind: 'depositStake', providerId: f.config.pilot.providerId, amount: '1' }],
        ['admin', { kind: 'withdrawStake', providerId: f.config.pilot.providerId, amount: '1' }],
        ['admin', { kind: 'finalizeClaim', coverageId: idTwo, outcome: 1, refundAmount: '1', reason: 'wrong role' }],
      ];
      for (const [role, operation] of rejected) await assert.rejects(() => senders[role].preview(operation), /PROTOCOL_FORBIDDEN/);

      const preview = await senders.admin.preview({ kind: 'setPaused', paused: true });
      await assert.rejects(() => senders.admin.confirm(preview.previewId, undefined as any), /PROTOCOL_ARGUMENT_INVALID/);
      await assert.rejects(() => senders.admin.confirm(preview.previewId, { approved: false } as any), /PROTOCOL_APPROVAL_REQUIRED/);
      const concurrent = await Promise.allSettled([
        senders.admin.confirm(preview.previewId, { approved: true }),
        senders.admin.confirm(preview.previewId, { approved: true }),
      ]);
      assert.equal(concurrent.filter(result => result.status === 'rejected').length, 2);
      const reasons = concurrent.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason));
      assert(reasons.some(reason => reason.includes('PROTOCOL_SIGNER_REQUIRED')));
      assert(reasons.some(reason => reason.includes('PROTOCOL_PREVIEW_REQUIRED')));
      assert.equal(sends, 0);

      for (let index = 0; index < 32; index++) await senders.admin.preview({ kind: 'setPaused', paused: true });
      await assert.rejects(() => senders.admin.preview({ kind: 'setPaused', paused: true }), /PROTOCOL_LIMIT/);
      await (f.evm.publicClient.request as any)({ method: 'anvil_increaseTime', params: [121] });
      await (f.evm.publicClient.request as any)({ method: 'anvil_mine', params: ['0x1'] });
      await senders.admin.preview({ kind: 'setPaused', paused: true });
      assert.equal(sends, 0);
    } finally { await Promise.all(Object.values(senders).map(sender => sender.close())); }
  });
});

test('an included token-transfer revert leaves provider accounting intact and reconciles its original hash', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  await withDirectory(async directory => {
    const account = f.accounts.provider;
    const localWallet = createWalletClient({ account, chain: baseSepolia, transport: http(f.config.pilot.rpcUrl) });
    let signatures = 0, sends = 0;
    const wallet = { chain: { id: 84532 }, signTransaction: async (args: any) => {
      signatures++;
      const raw = await localWallet.signTransaction(args);
      await transact(f.evm, f.artifacts.AuthorizationTokenMock.abi, f.config.pilot.token, 'setFailTransfers', [true], f.accounts.relayer);
      return raw;
    } };
    const sender = await createRoleSender({ config: f.config, role: 'provider', account, directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: proxyClient(f.evm.publicClient, async raw => {
        sends++;
        return f.evm.publicClient.sendRawTransaction({ serializedTransaction: raw });
      }), wallet });
    const coreAbi = (await import('../src/abi.js')).CORE_ABI;
    const tokenAbi = f.artifacts.AuthorizationTokenMock.abi;
    const providerBefore = await f.evm.publicClient.readContract({ address: f.config.pilot.core, abi: coreAbi,
      functionName: 'providers', args: [f.config.pilot.providerId] });
    const providerTokensBefore = await f.evm.publicClient.readContract({ address: f.config.pilot.token, abi: tokenAbi,
      functionName: 'balanceOf', args: [account.address] });
    const coreTokensBefore = await f.evm.publicClient.readContract({ address: f.config.pilot.token, abi: tokenAbi,
      functionName: 'balanceOf', args: [f.config.pilot.core] });
    const preview = await sender.preview({ kind: 'withdrawStake', providerId: f.config.pilot.providerId, amount: '500' });
    const reverted = await sender.confirm(preview.previewId, { approved: true });
    assert.equal(reverted.status, 'reverted');
    assert.equal(signatures, 1);
    assert.equal(sends, 1);
    const providerAfter = await f.evm.publicClient.readContract({ address: f.config.pilot.core, abi: coreAbi,
      functionName: 'providers', args: [f.config.pilot.providerId] });
    assert.equal(providerAfter[2], providerBefore[2]);
    assert.equal(providerAfter[3], providerBefore[3]);
    assert.equal(await f.evm.publicClient.readContract({ address: f.config.pilot.token, abi: tokenAbi,
      functionName: 'balanceOf', args: [account.address] }), providerTokensBefore);
    assert.equal(await f.evm.publicClient.readContract({ address: f.config.pilot.token, abi: tokenAbi,
      functionName: 'balanceOf', args: [f.config.pilot.core] }), coreTokensBefore);
    const originalHash = reverted.transaction;
    await sender.close();
    const readonly = await createRoleSender({ config: f.config, role: 'provider', directory,
      limits: { maxActionAmount: '5000', maxActions: 10 }, client: proxyClient(f.evm.publicClient) });
    const rows = await readonly.reconcile();
    assert.equal(rows[0].status, 'reverted');
    assert.equal(rows[0].transaction, originalHash);
    assert.equal(signatures, 1);
    assert.equal(sends, 1);
    await readonly.close();
  });
});

test('admin and provider senders execute only their fixed registry, pool, allowance, pause and stake actions', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  await withDirectory(async directory => {
    const limits = { maxActionAmount: '20000', maxActions: 6 };
    let sends = 0, adminSignatures = 0;
    const client = proxyClient(f.evm.publicClient, async raw => {
      sends++; return f.evm.publicClient.sendRawTransaction({ serializedTransaction: raw });
    });
    const adminSigningWallet = createWalletClient({ account: f.accounts.admin, chain: baseSepolia, transport: http(f.config.pilot.rpcUrl) });
    const adminWallet = { chain: { id: 84532 }, async signTransaction(args: any) {
      adminSignatures++; return adminSigningWallet.signTransaction(args);
    } };
    const providerWallet = createWalletClient({ account: f.accounts.provider, chain: baseSepolia, transport: http(f.config.pilot.rpcUrl) });
    const admin = await createRoleSender({ config: f.config, role: 'admin', account: f.accounts.admin, directory: join(directory, 'admin'), limits, client, wallet: adminWallet });
    const provider = await createRoleSender({ config: f.config, role: 'provider', account: f.accounts.provider, directory: join(directory, 'provider'), limits, client, wallet: providerWallet });
    const execute = async (sender: Awaited<ReturnType<typeof createRoleSender>>, operation: unknown) => {
      const preview = await sender.preview(operation);
      const result = await sender.confirm(preview.previewId, { approved: true });
      assert.equal(result.status, 'success');
      return result;
    };
    try {
      await assert.rejects(() => provider.preview({ kind: 'fundPool', amount: '1000' }), /PROTOCOL_FORBIDDEN/);
      await execute(admin, { kind: 'approveCore', amount: '2000' });
      await execute(admin, { kind: 'fundPool', amount: '1000' });
      const providerId = keccak256(toBytes('m11-registered-provider'));
      const policyId = keccak256(toBytes('m11-registered-policy'));
      await execute(admin, { kind: 'registerProvider', providerId, owner: f.accounts.payer.address, payout: f.accounts.provider.address });
      await execute(admin, { kind: 'registerPolicy', policyId, providerId, premiumBps: 200, stakeBps: 1000,
        withholdingBps: 100, duration: '3600', poolOnlyAllowed: false });
      await execute(admin, { kind: 'setPaused', paused: true });
      await execute(admin, { kind: 'setPaused', paused: false });
      const capped = await admin.preview({ kind: 'setPaused', paused: true });
      const beforeCap = { sends, adminSignatures };
      await assert.rejects(() => admin.confirm(capped.previewId, { approved: true }), /PROTOCOL_LIMIT/);
      assert.deepEqual({ sends, adminSignatures }, beforeCap);
      await assert.rejects(() => provider.preview({ kind: 'withdrawStake', providerId: f.config.pilot.providerId, amount: '11001' }), /PROTOCOL_PREVIEW_STALE/);

      await execute(provider, { kind: 'approveCore', amount: '2000' });
      await execute(provider, { kind: 'depositStake', providerId: f.config.pilot.providerId, amount: '1500' });
      await execute(provider, { kind: 'withdrawStake', providerId: f.config.pilot.providerId, amount: '500' });
      const abi = (await import('../src/abi.js')).CORE_ABI;
      assert.equal(await f.evm.publicClient.readContract({ address: f.config.pilot.core, abi, functionName: 'paused' }), false);
      const registered = await f.evm.publicClient.readContract({ address: f.config.pilot.core, abi, functionName: 'providers', args: [providerId] });
      assert.equal(registered[0].toLowerCase(), f.accounts.payer.address.toLowerCase());
      const policy = await f.evm.publicClient.readContract({ address: f.config.pilot.core, abi, functionName: 'policies', args: [policyId] });
      assert.equal(policy[0], providerId);
      const stake = await f.evm.publicClient.readContract({ address: f.config.pilot.core, abi, functionName: 'providers', args: [f.config.pilot.providerId] });
      assert.equal(stake[2], 11000n);
      assert.equal(stake[3], 0n);
      assert.equal(await f.evm.publicClient.readContract({ address: f.config.pilot.core, abi, functionName: 'poolAssets' }), 51000n);
    } finally { await Promise.all([admin.close(), provider.close()]); }
  });
});
