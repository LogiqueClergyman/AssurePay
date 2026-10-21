import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, pad, parseTransaction, toHex, type Address, type Hex } from 'viem';
import { startEvm } from '../../evm-core/test/helpers/evm.js';
import { createCampaignSender } from '../src/sender.js';
import { CampaignStore } from '../src/store.js';
import { budgetSummary } from '../src/plan.js';
import type { RunConfig, StepSpec } from '../src/types.js';

const id = (n: number): Hex => pad(toHex(n), { size: 32 });
const configFor = (evm: Awaited<ReturnType<typeof startEvm>>): RunConfig => ({
  version: 1, mode: 'local', chainId: 84532, token: '0x1111111111111111111111111111111111111111',
  roles: { relayer: evm.owner.address, payer: evm.payer.address, provider: evm.provider.address, adjudicator: evm.outsider.address },
  runId: id(101), providerId: id(102), policyId: id(103), serviceId: id(104),
  resourceUrl: 'http://127.0.0.1:43129/assured', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000',
});
const deploySpec = (): StepSpec => ({ kind: 'deploy', actor: 'relayer', to: null, data: '0x60006000f3' });
const providerSpec = (core: Address): StepSpec => ({ kind: 'provider', actor: 'relayer', to: core, data: '0x12345678' });
async function temp() { return mkdtemp(join(tmpdir(), 'assurepay-m5-sender-')); }
async function setLowBaseFee(evm: Awaited<ReturnType<typeof startEvm>>) {
  await (evm.publicClient.request as any)({ method: 'anvil_setNextBlockBaseFeePerGas', params: ['0x1'] });
}
async function fundRoleTargets(evm: Awaited<ReturnType<typeof startEvm>>, config: RunConfig) {
  const targets = budgetSummary(config).roles;
  for (const actor of ['relayer', 'payer', 'provider', 'adjudicator'] as const) {
    await (evm.publicClient.request as any)({ method: 'anvil_setBalance',
      params: [config.roles[actor], `0x${BigInt(targets[actor].targetWei).toString(16)}`] });
  }
}

test('journals a locally derived deployment identity before one broadcast and canonical observation', async () => {
    const evm = await startEvm(); const directory = await temp();
    try {
      const config = configFor(evm); const path = join(directory, 'campaign.json');
      await fundRoleTargets(evm, config);
      const sender = await createCampaignSender({ config, client: evm.publicClient, wallet: evm.walletClient,
        accounts: { relayer: evm.owner, payer: evm.payer, provider: evm.provider, adjudicator: evm.outsider }, journalPath: path, polls: 2, delay: 0 });
      assert.throws(() => sender.prepare({ ...deploySpec(), extra: 'rejected' } as any), /CAMPAIGN_STEP_INVALID/);
      const mutable = deploySpec();
      const pendingRaw = sender.prepare(mutable);
      (mutable as any).data = '0xdeadbeef';
      (mutable as any).actor = 'payer';
      const raw = await pendingRaw;
      const prepared = sender.read().transactions[0]!;
      assert.equal(prepared.attempted, false);
      assert.equal(prepared.calldataHash, keccak256(deploySpec().data));
      assert.equal((parseTransaction(raw as any) as any).data, deploySpec().data);
      const contents = await readFile(path, 'utf8');
      assert.equal(contents.includes(raw), false);
      await setLowBaseFee(evm);
      await sender.broadcast('deploy', raw);
      let observed = await sender.observe('deploy');
      for (let attempt = 0; attempt < 20 && !observed.status; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observed = await sender.observe('deploy');
      }
      assert.equal(observed.status, 'success');
      assert.equal(sender.read().core, await (async () => (await evm.publicClient.getTransactionReceipt({ hash: prepared.transaction })).contractAddress)());
      await assert.rejects(sender.prepare(deploySpec()), /CAMPAIGN_STEP_ORDER|CAMPAIGN_UNRESOLVED_TRANSACTION/);
    } finally { await rm(directory, { recursive: true, force: true }); await evm.close(); }
});

test('rejects a malicious signer before writing an identity', async () => {
    const evm = await startEvm(); const directory = await temp();
    try {
      const config = configFor(evm); const path = join(directory, 'campaign.json');
      await fundRoleTargets(evm, config);
      const alterations: Array<(args: any) => any> = [
        (args) => ({ ...args, to: config.token }),
        (args) => ({ ...args, data: '0x00' }),
        (args) => ({ ...args, nonce: args.nonce + 1 }),
        (args) => ({ ...args, value: 1n }),
        (args) => ({ ...args, gas: args.gas - 1n }),
        (args) => ({ ...args, maxFeePerGas: args.maxFeePerGas - 1n }),
        (args) => ({ ...args, maxPriorityFeePerGas: args.maxPriorityFeePerGas + 1n }),
        (args) => ({ ...args, account: evm.payer }),
      ];
      for (let index = 0; index < alterations.length; index++) {
        const scoped = { ...config, runId: id(300 + index) };
        const malicious = { ...evm.walletClient, async signTransaction(args: any) {
          return evm.walletClient.signTransaction(alterations[index]!(args));
        } };
        const sender = await createCampaignSender({ config: scoped, client: evm.publicClient, wallet: malicious,
          accounts: { relayer: evm.owner, payer: evm.payer, provider: evm.provider, adjudicator: evm.outsider }, journalPath: join(directory, `campaign-${index}.json`) });
        await assert.rejects(sender.prepare(deploySpec()), /CAMPAIGN_TRANSACTION_INVALID/);
        assert.equal(sender.read().transactions.length, 0);
      }
    } finally { await rm(directory, { recursive: true, force: true }); await evm.close(); }
});

test('treats a lost broadcast response as uncertain and retries only by observing the known hash', async () => {
    const evm = await startEvm(); const directory = await temp();
    try {
      const config = configFor(evm); const path = join(directory, 'campaign.json');
      await fundRoleTargets(evm, config);
      let broadcasts = 0; let signatures = 0;
      const client = { ...evm.publicClient, async sendRawTransaction(args: any) {
        broadcasts++;
        const hash = await evm.publicClient.sendRawTransaction(args);
        throw new Error(`response lost ${hash}`);
      } };
      const wallet = { ...evm.walletClient, async signTransaction(args: any) { signatures++; return evm.walletClient.signTransaction(args); } };
      const sender = await createCampaignSender({ config, client, wallet,
        accounts: { relayer: evm.owner, payer: evm.payer, provider: evm.provider, adjudicator: evm.outsider }, journalPath: path, polls: 2, delay: 0 });
      await setLowBaseFee(evm);
      const first = await sender.submit(deploySpec());
      assert.equal(first.status, 'success');
      const second = await sender.submit(deploySpec());
      assert.equal(second.transaction, first.transaction);
      assert.equal(signatures, 1);
      assert.equal(broadcasts, 1);
    } finally { await rm(directory, { recursive: true, force: true }); await evm.close(); }
});

test('leaves a prepared-no-broadcast crash stranded and restart recovery signer-free', async () => {
    const evm = await startEvm(); const directory = await temp();
    try {
      const config = configFor(evm); const path = join(directory, 'campaign.json');
      await fundRoleTargets(evm, config);
      let signs = 0; let sends = 0;
      const wallet = { ...evm.walletClient, async signTransaction(args: any) { signs++; return evm.walletClient.signTransaction(args); } };
      const client = { ...evm.publicClient, async sendRawTransaction(args: any) { sends++; return evm.publicClient.sendRawTransaction(args); } };
      const sender = await createCampaignSender({ config, client, wallet,
        accounts: { relayer: evm.owner, payer: evm.payer, provider: evm.provider, adjudicator: evm.outsider }, journalPath: path });
      await sender.prepare(deploySpec());
      const restarted = await createCampaignSender({ config, client, journalPath: path });
      const record = await restarted.submit(deploySpec());
      assert.equal(record.attempted, false);
      assert.equal(record.status, undefined);
      await assert.rejects(restarted.prepare(providerSpec(restarted.read().core!)), /CAMPAIGN_UNRESOLVED_TRANSACTION/);
      assert.equal(signs, 1);
      assert.equal(sends, 0);
    } finally { await rm(directory, { recursive: true, force: true }); await evm.close(); }
});

test('rejects a symlink journal, context substitution, and unknown manifest keys', async () => {
    const evm = await startEvm(); const directory = await temp();
    try {
      const config = configFor(evm); const path = join(directory, 'campaign.json');
      await CampaignStore.create(path, config);
      const alias = join(directory, 'alias.json'); await symlink(path, alias);
      await assert.rejects(CampaignStore.open(alias, config), /CAMPAIGN_JOURNAL_UNAVAILABLE/);
      await assert.rejects(CampaignStore.open(path, { ...config, runId: id(999) }), /CAMPAIGN_JOURNAL_CONTEXT/);
      const content = JSON.parse(await readFile(path, 'utf8')); content.extra = true;
      await (await import('node:fs/promises')).writeFile(path, JSON.stringify(content));
      await assert.rejects(CampaignStore.open(path, config), /CAMPAIGN_JOURNAL_INVALID/);
    } finally { await rm(directory, { recursive: true, force: true }); await evm.close(); }
});
