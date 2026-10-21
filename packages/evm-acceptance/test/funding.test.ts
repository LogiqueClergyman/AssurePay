import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { startEvm } from '../../evm-core/test/helpers/evm.js';
import { budgetSummary, NATIVE_USDC } from '../src/plan.js';
import { buildFundingPlan, fundCampaign, PUBLIC_FUNDING_SCOPE, reconcileFunding } from '../src/funding.js';
import type { RunConfig } from '../src/types.js';
import { pad, toHex, type Hex } from 'viem';

const id = (n: number): Hex => pad(toHex(n), { size: 32 });
test('funds three exact role shortfalls on Anvil and reconciles a lost response by its recorded hash', async () => {
  const evm = await startEvm(); const dir = await mkdtemp(join(tmpdir(), 'm5-funding-'));
  try {
    const vault = privateKeyToAccount(generatePrivateKey());
    const config: RunConfig = { version: 1, mode: 'local', chainId: 84532, token: '0x1111111111111111111111111111111111111111',
      roles: { relayer: evm.owner.address, payer: evm.payer.address, provider: evm.provider.address, adjudicator: evm.outsider.address },
      runId: id(701), providerId: id(702), policyId: id(703), serviceId: id(704), resourceUrl: 'http://127.0.0.1:43129/assured',
      maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' };
    await evm.publicClient.request({ method: 'anvil_setBalance', params: [vault.address, '0x1000000000000000'] });
    for (const actor of ['relayer', 'payer', 'adjudicator'] as const) await evm.publicClient.request({
      method: 'anvil_setBalance', params: [config.roles[actor], '0x0'],
    });
    await evm.publicClient.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: ['0x1'] });
    await evm.publicClient.request({ method: 'evm_mine', params: [] });
    const plan = await buildFundingPlan({ config, client: evm.publicClient, vault: vault.address });
    assert.equal(plan.transfers.length, 3); assert.equal(plan.ready, true);
    for (const malformed of [
      { ...plan, privateKey: 'hidden' },
      { ...plan, roles: { ...plan.roles, relayer: { ...plan.roles.relayer, extra: true } } },
      { ...plan, transfers: [{ ...plan.transfers[0], extra: true }, ...plan.transfers.slice(1)] },
      { ...plan, totalFeeAllowanceWei: '0' },
      { ...plan, ready: false },
    ]) await assert.rejects(fundCampaign({ config, client: evm.publicClient, account: vault, plan: malformed as any,
      journalPath: join(dir, `invalid-${Math.random()}.json`), execute: true, estimateAuxFee: async () => 0n }), /M5_FUNDING_PLAN_INVALID/);
    let sends = 0; const rawTransactions: string[] = []; const client = { ...evm.publicClient, async sendRawTransaction(args: any) {
      sends++; rawTransactions.push(args.serializedTransaction); const hash = await evm.publicClient.sendRawTransaction(args); if (sends === 1) throw Error(`lost ${hash}`); return hash;
    } };
    const path = join(dir, 'funding.json');
    const report = await fundCampaign({ config, client, account: vault, plan, journalPath: path, execute: true,
      estimateAuxFee: async () => 0n, polls: 3, delay: 0 });
    assert.equal(report.state, 'complete'); assert.equal(report.transactions.length, 3); assert.equal(sends, 3);
    const journal = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(journal.transactions.every((row: any) => row.feeSource === 'vault_balance_delta' &&
      row.operatorFeeWei === 'unavailable' && typeof row.actualAuxiliaryFeeWei === 'string'));
    for (const actor of ['relayer', 'payer', 'adjudicator'] as const) assert.equal(
      await evm.publicClient.getBalance({ address: config.roles[actor] }), BigInt(budgetSummary(config).roles[actor].targetWei));
    const saved = await readFile(path, 'utf8'); for (const raw of rawTransactions) assert.equal(saved.includes(raw), false);
    assert.equal((await reconcileFunding({ config, client, journalPath: path, vault: vault.address })).state, 'complete');
    const alteredFee = JSON.parse(saved);
    alteredFee.transactions[0].actualAuxiliaryFeeWei = (BigInt(alteredFee.transactions[0].actualAuxiliaryFeeWei) + 1n).toString();
    await writeFile(path, JSON.stringify(alteredFee));
    await assert.rejects(reconcileFunding({ config, client, journalPath: path, vault: vault.address }), /M5_FUNDING_JOURNAL_FEE_CONFLICT/);
    await writeFile(path, saved);
    const tampered = JSON.parse(saved); tampered.extra = true; await writeFile(path, JSON.stringify(tampered));
    await assert.rejects(fundCampaign({ config, client, account: vault, plan, journalPath: path, execute: true,
      estimateAuxFee: async () => 0n }), /M5_FUNDING_JOURNAL_INVALID/);
  } finally { await rm(dir, { recursive: true, force: true }); await evm.close(); }
});

test('public funding scope is distinct and tampered journals are rejected before signer or broadcast', async () => {
  const evm = await startEvm(); const dir = await mkdtemp(join(tmpdir(), 'm5-funding-'));
  try {
    const vault = evm.owner; const config: RunConfig = { version: 1, mode: 'public', chainId: 84532,
      token: NATIVE_USDC, roles: { relayer: '0x0000000000000000000000000000000000000001',
      payer: '0x0000000000000000000000000000000000000002', provider: '0x0000000000000000000000000000000000000003',
      adjudicator: '0x0000000000000000000000000000000000000004' }, runId: id(711), providerId: id(712), policyId: id(713), serviceId: id(714),
      resourceUrl: 'http://localhost:43129/assured', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' };
    assert.equal(PUBLIC_FUNDING_SCOPE, 'm5-fund-campaign-roles-once');
    const plan = await buildFundingPlan({ config, client: evm.publicClient, vault: vault.address });
    const wrong = await fundCampaign({ config, client: evm.publicClient, plan, journalPath: join(dir, 'wrong.json'), execute: true,
      publicScope: 'm5-public-run-once' });
    assert.equal(wrong.state, 'blocked'); assert.equal(wrong.code, 'public_scope_required');
  } finally { await rm(dir, { recursive: true, force: true }); await evm.close(); }
});

test('keeps a pre-broadcast crash stranded and signer-free reconciliation never sends', async () => {
  const evm = await startEvm(); const dir = await mkdtemp(join(tmpdir(), 'm5-funding-'));
  try {
    const vault = evm.owner; const config: RunConfig = { version: 1, mode: 'local', chainId: 84532, token: '0x1111111111111111111111111111111111111111',
      roles: { relayer: evm.payer.address, payer: evm.provider.address, provider: evm.outsider.address, adjudicator: '0x0000000000000000000000000000000000000005' },
      runId: id(721), providerId: id(722), policyId: id(723), serviceId: id(724), resourceUrl: 'http://127.0.0.1:43129/assured',
      maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' };
    await evm.publicClient.request({ method: 'anvil_setBalance', params: [vault.address, '0x1000000000000000'] });
    for (const actor of ['relayer', 'payer', 'adjudicator'] as const) await evm.publicClient.request({ method: 'anvil_setBalance', params: [config.roles[actor], '0x0'] });
    await evm.publicClient.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: ['0x1'] });
    await evm.publicClient.request({ method: 'evm_mine', params: [] });
    const plan = await buildFundingPlan({ config, client: evm.publicClient, vault: vault.address });
    let sends = 0; let signs = 0;
    const client = { ...evm.publicClient, async sendRawTransaction() { sends++; throw Error('offline before admission'); } };
    const account = { ...vault, async signTransaction(args: any) { signs++; return vault.signTransaction(args); } } as any;
    const path = join(dir, 'stranded.json');
    const report = await fundCampaign({ config, client, account, plan, journalPath: path, execute: true,
      estimateAuxFee: async () => 0n, polls: 1, delay: 0 });
    assert.equal(report.state, 'pending'); assert.equal(sends, 1); assert.equal(signs, 1);
    const recovered = await reconcileFunding({ config, client, journalPath: path, vault: vault.address });
    assert.equal(recovered.state, 'pending');
    const resumed = await fundCampaign({ config, client, account, plan, journalPath: path, execute: true,
      estimateAuxFee: async () => 0n, polls: 1, delay: 0 });
    assert.equal(resumed.state, 'pending'); assert.equal(sends, 1); assert.equal(signs, 1);
  } finally { await rm(dir, { recursive: true, force: true }); await evm.close(); }
});
