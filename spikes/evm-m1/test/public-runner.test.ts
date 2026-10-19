import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, LocalAccount } from 'viem';
import { createSession, recordPrepared } from '../src/journal.js';
import { parsePublicConfig, PUBLIC_EXECUTION_SCOPE } from '../src/public-config.js';
import { createPublicPreflightAdapter, publicJournalExists, runPublicExecution } from '../src/public-runner.js';

const env = {
  EXPECTED_PAYER: '0x1111111111111111111111111111111111111111',
  RELAYER_ADDRESS: '0x2222222222222222222222222222222222222222',
  PROVIDER_PAYOUT: '0x3333333333333333333333333333333333333333',
  MAX_FEE_PER_GAS_ATOMIC: '1000000000',
  MAX_PRIORITY_FEE_PER_GAS_ATOMIC: '100000000',
  MAX_TOTAL_GAS: '3100000',
  MAX_L1_FEE_WEI: '100000000000000',
  M1_PUBLIC_SCOPE: PUBLIC_EXECUTION_SCOPE,
  PAYER_PRIVATE_KEY: 'opaque-not-used', RELAYER_PRIVATE_KEY: 'opaque-not-used',
} as const;
const config = () => parsePublicConfig(env, { execute: true });

function account(address: string, signCalls: { count: number }): LocalAccount {
  return { address: address as Address, type: 'local', source: 'custom', publicKey: '0x',
    signTransaction: async () => { signCalls.count++; throw new Error('SIGN_FORBIDDEN'); },
    signMessage: async () => { signCalls.count++; throw new Error('SIGN_FORBIDDEN'); },
    signTypedData: async () => { signCalls.count++; throw new Error('SIGN_FORBIDDEN'); },
  } as unknown as LocalAccount;
}

test('existing journal is recovered read-only before signer validation or any network access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm1-public-runner-'));
  const journal = join(root, 'run');
  try {
    await createSession(journal, config());
    const signs = { count: 0 };
    const calls = { count: 0 };
    const client = new Proxy({}, { get() { return async () => { calls.count++; throw new Error('RPC_FORBIDDEN'); }; } });
    const result = await runPublicExecution({ config: config(), payer: account('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', signs),
      relayer: account('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', signs), client: client as never,
      wallet: {} as never, journalPath: journal });
    assert.deepEqual(result, { ok: false, code: 'RUN_INCOMPLETE_OR_PENDING', transactions: [] });
    assert.equal(signs.count, 0);
    assert.equal(calls.count, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recorded partial journal only queries its known hash and never reads signer or broadcasts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm1-public-runner-'));
  const journal = join(root, 'run');
  const signs = { count: 0 };
  const calls: string[] = [];
  try {
    await createSession(journal, config());
    const knownHash = `0x${'ab'.repeat(32)}` as const;
    await recordPrepared(journal, { kind: 'deploy', chainId: 84532, transactionHash: knownHash,
      from: env.RELAYER_ADDRESS, to: null, nonce: '7', calldataHash: `0x${'cd'.repeat(32)}` });
    const client = new Proxy({}, { get(_target, property) {
      if (property === 'getTransaction' || property === 'getTransactionReceipt') {
        return async ({ hash }: { hash: string }) => { calls.push(`${String(property)}:${hash}`); throw new Error('PENDING'); };
      }
      if (property === 'sendRawTransaction') return async () => { calls.push('broadcast'); throw new Error('BROADCAST_FORBIDDEN'); };
      return async () => { calls.push(String(property)); throw new Error('UNEXPECTED_RPC'); };
    } });
    const result = await runPublicExecution({ config: config(), payer: account(env.EXPECTED_PAYER, signs),
      relayer: account(env.RELAYER_ADDRESS, signs), client: client as never, wallet: {} as never, journalPath: journal });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RUN_INCOMPLETE_OR_PENDING');
    assert.equal(result.transactions[0]?.transaction, knownHash);
    assert.ok(calls.includes(`getTransaction:${knownHash}`));
    assert.ok(calls.includes(`getTransactionReceipt:${knownHash}`));
    assert.ok(!calls.includes('broadcast'));
    assert.equal(signs.count, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('signer address mismatch stops before preflight, journal creation, or signing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm1-public-runner-'));
  const journal = join(root, 'run');
  const signs = { count: 0 };
  let preflightCalls = 0;
  const client = new Proxy({}, { get() { return async () => { throw new Error('RPC_FORBIDDEN'); }; } });
  try {
    const result = await runPublicExecution({ config: config(), payer: account('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', signs),
      relayer: account(env.RELAYER_ADDRESS, signs), client: client as never, wallet: {} as never, journalPath: journal,
      preflight: async () => { preflightCalls++; return { ok: true }; } });
    assert.equal(result.code, 'SIGNER_ADDRESS_MISMATCH');
    assert.equal(signs.count, 0);
    assert.equal(preflightCalls, 0);
    assert.equal(await publicJournalExists(journal), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('insufficient payer balance stops before journal creation or signer access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm1-public-runner-'));
  const journal = join(root, 'run');
  const signs = { count: 0 };
  const ceiling = config().budget.maxTotalGas * config().budget.maxFeePerGasAtomic + config().budget.maxL1FeeWei;
  const client = {
    async getChainId() { return 84532; },
    async getBlock({ blockNumber }: { blockNumber?: bigint } = {}) {
      return { number: blockNumber ?? 10n, hash: `0x${'aa'.repeat(32)}`, parentHash: `0x${'bb'.repeat(32)}`, timestamp: 1_700_000_000n };
    },
    async readContract() { return 199n; },
    async getBalance() { return ceiling; },
    async getTransactionCount() { return 7; },
  };
  try {
    const result = await runPublicExecution({ config: config(), payer: account(env.EXPECTED_PAYER, signs),
      relayer: account(env.RELAYER_ADDRESS, signs), client: client as never, wallet: {} as never,
      journalPath: journal, preflight: async () => ({ ok: true }) });
    assert.equal(result.code, 'PAYER_BALANCE_LOW');
    assert.equal(signs.count, 0);
    assert.equal(await publicJournalExists(journal), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preflight adapter maps the synthetic from address to viem account and returns hex data', async () => {
  const calls: Record<string, unknown>[] = [];
  const adapter = createPublicPreflightAdapter({
    async call(args: Record<string, unknown>) { calls.push(args); return { data: '0x1234' }; },
  } as never);
  const result = await adapter.call({ from: '0x2222222222222222222222222222222222222222' as Address,
    to: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as Address,
    data: '0xabcd', blockNumber: 99n, gas: 300_000n });
  assert.equal(result, '0x1234');
  assert.deepEqual(calls, [{ account: '0x2222222222222222222222222222222222222222',
    to: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', data: '0xabcd', blockNumber: 99n, gas: 300_000n }]);
  assert.equal(Object.hasOwn(calls[0]!, 'from'), false);
});

test('confirmed snapshot and pending nonce mismatch stops before session creation or signing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm1-public-runner-'));
  const journal = join(root, 'run');
  const signs = { count: 0 };
  const ceiling = config().budget.maxTotalGas * config().budget.maxFeePerGasAtomic + config().budget.maxL1FeeWei;
  const nonceReads: Array<{ blockNumber?: bigint; blockTag?: string }> = [];
  const client = {
    async getChainId() { return 84532; },
    async getBlock({ blockNumber }: { blockNumber?: bigint } = {}) {
      return { number: blockNumber ?? 10n, hash: `0x${'aa'.repeat(32)}`, parentHash: `0x${'bb'.repeat(32)}`, timestamp: 1_700_000_000n };
    },
    async readContract() { return 200n; },
    async getBalance() { return ceiling; },
    async getTransactionCount(args: { blockNumber?: bigint; blockTag?: string }) {
      nonceReads.push(args);
      return args.blockNumber === undefined ? 8 : 7;
    },
  };
  try {
    const result = await runPublicExecution({ config: config(), payer: account(env.EXPECTED_PAYER, signs),
      relayer: account(env.RELAYER_ADDRESS, signs), client: client as never, wallet: {} as never,
      journalPath: journal, preflight: async () => ({ ok: true }) });
    assert.equal(result.code, 'RELAYER_NONCE_UNAVAILABLE');
    assert.equal(signs.count, 0);
    assert.ok(nonceReads.some(read => read.blockNumber === 10n));
    assert.ok(nonceReads.some(read => read.blockTag === 'pending'));
    assert.equal(await publicJournalExists(journal), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects excess native balance against the exact approved ceiling before session creation or signing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm1-public-runner-'));
  const journal = join(root, 'new-run');
  const signs = { count: 0 };
  const calls: string[] = [];
  const ceiling = config().budget.maxTotalGas * config().budget.maxFeePerGasAtomic + config().budget.maxL1FeeWei;
  const client = {
    async getChainId() { calls.push('chain'); return 84532; },
    async getBlock({ blockNumber }: { blockNumber?: bigint } = {}) {
      calls.push('block'); return { number: blockNumber ?? 10n, hash: `0x${'aa'.repeat(32)}`, parentHash: `0x${'bb'.repeat(32)}`, timestamp: 1_700_000_000n };
    },
    async readContract() { calls.push('token-balance'); return 200n; },
    async getBalance() { calls.push('native-balance'); return ceiling + 1n; },
    async getTransactionCount() { return 7; },
  };
  try {
    const result = await runPublicExecution({ config: config(), payer: account(env.EXPECTED_PAYER, signs),
      relayer: account(env.RELAYER_ADDRESS, signs), client: client as never, wallet: {} as never,
      journalPath: journal, preflight: async () => ({ ok: true }) });
    assert.equal(result.code, 'RELAYER_BALANCE_EXCESS');
    assert.equal(signs.count, 0);
    assert.equal(await publicJournalExists(journal), false);
    assert.ok(calls.includes('chain'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stops before transaction preparation when the relayer pending nonce changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm1-public-runner-'));
  const journal = join(root, 'run');
  const signs = { count: 0 };
  const ceiling = config().budget.maxTotalGas * config().budget.maxFeePerGasAtomic + config().budget.maxL1FeeWei;
  let pendingReads = 0;
  let preparations = 0;
  const client = {
    async getChainId() { return 84532; },
    async getBlock({ blockNumber }: { blockNumber?: bigint } = {}) {
      return { number: blockNumber ?? 10n, hash: `0x${'aa'.repeat(32)}`, parentHash: `0x${'bb'.repeat(32)}`, timestamp: 1_700_000_000n };
    },
    async readContract() { return 200n; },
    async getBalance() { return ceiling; },
    async getTransactionCount(args: { blockNumber?: bigint; blockTag?: string }) {
      if (args.blockNumber !== undefined) return 7;
      if (args.blockTag === 'pending') return ++pendingReads === 1 ? 7 : 8;
      return 7;
    },
  };
  const wallet = { async prepareTransactionRequest() { preparations++; throw new Error('MUST_NOT_PREPARE'); } };
  try {
    const result = await runPublicExecution({ config: config(), payer: account(env.EXPECTED_PAYER, signs),
      relayer: account(env.RELAYER_ADDRESS, signs), client: client as never, wallet: wallet as never,
      journalPath: journal, preflight: async () => ({ ok: true }), pollDelayMs: 0 });
    assert.equal(result.code, 'RUN_STOPPED_RECONCILE');
    assert.equal(signs.count, 0);
    assert.equal(preparations, 0);
    assert.equal(await publicJournalExists(journal), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
