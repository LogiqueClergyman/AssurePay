import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { compileContracts } from '../../evm-core/src/compiler.js';
import { acquireRunLock } from '../src/run-lock.js';
import { runCampaign } from '../src/campaign.js';
import { CampaignStore } from '../src/store.js';
import { createCampaignSender } from '../src/sender.js';
import { checkPublic, MANAGED_TEST_VAULT } from '../src/preflight.js';
import { buildFundingPlan, fundCampaign, reconcileFunding, PUBLIC_FUNDING_SCOPE } from '../src/funding.js';
import { validateConfig, ECONOMICS } from '../src/plan.js';
import { verifyCampaign } from '../src/verify.js';
import {
  assertFundingPlanMatchesProposal,
  assertOriginalRuntimeMatches,
  assertProposalAnchor,
  assertSpendingRoleNonces,
  SECOND_ATTEMPT_SCOPE,
  validateSecondAttemptProposal,
} from '../src/second-attempt.js';
import { runtimeAccounts, runtimeConfig, runtimeDataKey, runtimeRpc, safeCode, PUBLIC_SCOPE } from '../src/runtime.js';
import { withBaseReceiptFees } from '../../../spikes/evm-m1/src/base-receipt-fees.js';
import { withReadQueue } from '../src/read-queue.js';
import { withLogChunks } from '../src/log-chunks.js';

const SCOPE_ENV = 'M5_SECOND_ATTEMPT_SCOPE';
const directory = fileURLToPath(new URL('../.local-m5-r2/', import.meta.url));
const campaignPath = join(directory, 'campaign.json');
const fundingPath = join(directory, 'funding.json');
const dataDirectory = join(directory, 'data');
const proposalPath = fileURLToPath(new URL('../evidence/second-attempt-proposal.json', import.meta.url));
const originalPublicEvidencePath = fileURLToPath(new URL('../evidence/public-reconciliation.json', import.meta.url));
let release: (() => Promise<void>) | undefined;

function parseMode(args: string[]): 'check' | 'fund' | 'reconcile-funding' | 'execute' | 'continue' | 'reconcile' | 'verify' {
  if (args.length === 0) return 'check';
  if (args.length === 1 && args[0] === '--reconcile-funding') return 'reconcile-funding';
  if (args.length === 1 && args[0] === '--reconcile') return 'reconcile';
  if (args.length === 1 && args[0] === '--verify') return 'verify';
  if (args.length === 3 && args[0] === '--fund' && args[1] === '--scope' && args[2] === SECOND_ATTEMPT_SCOPE) return 'fund';
  if (args.length === 3 && args[0] === '--continue' && args[1] === '--scope' && args[2] === SECOND_ATTEMPT_SCOPE) return 'continue';
  if (args.length === 3 && args[0] === '--execute' && args[1] === '--scope' && args[2] === SECOND_ATTEMPT_SCOPE) return 'execute';
  throw new Error('M5_SECOND_ARGUMENTS_INVALID');
}

async function readPublicJson(path: string, errorCode: string): Promise<any> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error(errorCode);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return JSON.parse(await handle.readFile('utf8')); }
  catch { throw new Error(errorCode); }
  finally { await handle.close(); }
}

async function loadOriginalPublicConfig() {
  const evidence = await readPublicJson(originalPublicEvidencePath, 'M5_SECOND_BASELINE_INVALID');
  try {
    if (evidence?.manifest?.version !== 1) throw new Error();
    return validateConfig(evidence.manifest.config);
  } catch { throw new Error('M5_SECOND_BASELINE_INVALID'); }
}

async function loadProposal(original: ReturnType<typeof validateConfig>) {
  const info = await lstat(proposalPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error('M5_SECOND_PROPOSAL_INVALID');
  const handle = await open(proposalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
    return validateSecondAttemptProposal(parsed, original);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('M5_SECOND_')) throw error;
    throw new Error('M5_SECOND_PROPOSAL_INVALID');
  } finally { await handle.close(); }
}

async function existingRegularFile(path: string, code: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error(code);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

async function acquireMutationLock(): Promise<void> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('M5_SECOND_DIRECTORY_INVALID');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error instanceof Error && error.message === 'M5_SECOND_DIRECTORY_INVALID'
      ? error : new Error('M5_SECOND_DIRECTORY_INVALID');
    await mkdir(directory, { recursive: false, mode: 0o700 });
  }
  release = await acquireRunLock(join(directory, 'run.lock'));
}

function requireNewApproval(): void {
  if (process.env[SCOPE_ENV] !== SECOND_ATTEMPT_SCOPE || process.env.M5_PUBLIC_SCOPE !== PUBLIC_SCOPE) {
    throw new Error('M5_SECOND_EXPLICIT_SCOPE_REQUIRED');
  }
}

async function ensureFundingComplete(config: ReturnType<typeof runtimeConfig>, client: any, plan: Parameters<typeof assertFundingPlanMatchesProposal>[0]) {
  if (!await existingRegularFile(fundingPath, 'M5_SECOND_FUNDING_JOURNAL_INVALID')) throw new Error('M5_SECOND_FUNDING_JOURNAL_MISSING');
  const result = await reconcileFunding({ config, client, journalPath: fundingPath, vault: MANAGED_TEST_VAULT });
  assertFundingPlanMatchesProposal(plan, result.plan);
  if (result.state !== 'complete' || !result.ok) throw new Error('M5_SECOND_FUNDING_INCOMPLETE');
  return result;
}

try {
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'fund' || mode === 'execute' || mode === 'continue') requireNewApproval();
  const original = await loadOriginalPublicConfig();
  const proposal = await loadProposal(original);
  assertOriginalRuntimeMatches(proposal, original);
  if (mode === 'fund' || mode === 'execute' || mode === 'continue') {
    const runtimeOriginal = runtimeConfig(process.env);
    if (JSON.stringify(runtimeOriginal) !== JSON.stringify(original)) throw new Error('M5_SECOND_ORIGINAL_RUNTIME_MISMATCH');
  }
  const rpc = runtimeRpc(process.env);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 0, timeout: 15_000 }), cacheTime: 0 });
  const client = withLogChunks(withReadQueue(withBaseReceiptFees(publicClient)));

  if (mode === 'check') {
    const [preflight, observedPlan] = await Promise.all([
      checkPublic({ config: proposal.config, client }),
      buildFundingPlan({ config: proposal.config, client, vault: MANAGED_TEST_VAULT }),
    ]);
    await assertProposalAnchor(client, proposal.fundingPlan);
    assertFundingPlanMatchesProposal(proposal.fundingPlan, observedPlan);
    const readyForFunding = ['ok', 'native_balance_insufficient'].includes(preflight.code) &&
      preflight.funding.vault?.shortfallWei === '0';
    process.stdout.write(JSON.stringify({ ok: readyForFunding, code: readyForFunding ? 'M5_SECOND_PROPOSAL_CURRENT' : 'M5_SECOND_PREFLIGHT_BLOCKED',
      scope: proposal.scope, preflight, fundingPlan: observedPlan, publicMutation: false }) + '\n');
    if (!readyForFunding) process.exitCode = 1;
  } else if (mode === 'fund') {
    await acquireMutationLock();
    const exists = await existingRegularFile(fundingPath, 'M5_SECOND_FUNDING_JOURNAL_INVALID');
    if (exists) {
      const reconciled = await reconcileFunding({ config: proposal.config, client, journalPath: fundingPath, vault: MANAGED_TEST_VAULT });
      assertFundingPlanMatchesProposal(proposal.fundingPlan, reconciled.plan);
      if (reconciled.transactions.some((row) => row.status !== 'success' || row.actualGasUsed === undefined ||
          row.effectiveGasPriceWei === undefined || row.actualAuxiliaryFeeWei === undefined)) {
        throw new Error('M5_SECOND_FUNDING_UNRESOLVED');
      }
      if (reconciled.state === 'complete') {
        process.stdout.write(JSON.stringify({ ...reconciled, code: 'M5_SECOND_FUNDING_ALREADY_COMPLETE' }) + '\n');
        process.exitCode = reconciled.ok ? 0 : 1;
      } else {
        await assertProposalAnchor(client, proposal.fundingPlan);
        const check = await checkPublic({ config: proposal.config, client });
        if (!['ok', 'native_balance_insufficient'].includes(check.code) || check.funding.vault?.shortfallWei !== '0') {
          throw new Error('M5_SECOND_FUNDING_PREFLIGHT_BLOCKED');
        }
        const key = process.env.VAULT_PRIVATE_KEY;
        if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('M5_VAULT_SIGNER_REQUIRED');
        const account = privateKeyToAccount(key as Hex);
        if (account.address.toLowerCase() !== MANAGED_TEST_VAULT) throw new Error('M5_VAULT_SIGNER_MISMATCH');
        const wallet = createWalletClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 0, timeout: 15_000 }) });
        const result = await fundCampaign({ config: proposal.config, client, wallet, account, plan: proposal.fundingPlan,
          journalPath: fundingPath, execute: true, publicScope: PUBLIC_FUNDING_SCOPE, polls: 20, delay: 1_000 });
        process.stdout.write(JSON.stringify(result) + '\n');
        if (!result.ok) process.exitCode = 1;
      }
    } else {
      const [preflight, currentPlan] = await Promise.all([
        checkPublic({ config: proposal.config, client }),
        buildFundingPlan({ config: proposal.config, client, vault: MANAGED_TEST_VAULT }),
      ]);
      await assertProposalAnchor(client, proposal.fundingPlan);
      assertFundingPlanMatchesProposal(proposal.fundingPlan, currentPlan);
      if (!['ok', 'native_balance_insufficient'].includes(preflight.code) || preflight.funding.vault?.shortfallWei !== '0') {
        throw new Error('M5_SECOND_FUNDING_PREFLIGHT_BLOCKED');
      }
      const key = process.env.VAULT_PRIVATE_KEY;
      if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('M5_VAULT_SIGNER_REQUIRED');
      const account = privateKeyToAccount(key as Hex);
      if (account.address.toLowerCase() !== MANAGED_TEST_VAULT) throw new Error('M5_VAULT_SIGNER_MISMATCH');
      const wallet = createWalletClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 0, timeout: 15_000 }) });
      const result = await fundCampaign({ config: proposal.config, client, wallet, account, plan: proposal.fundingPlan,
        journalPath: fundingPath, execute: true, publicScope: PUBLIC_FUNDING_SCOPE, polls: 20, delay: 1_000 });
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.ok) process.exitCode = 1;
    }
  } else if (mode === 'reconcile-funding') {
    await acquireMutationLock();
    const result = await reconcileFunding({ config: proposal.config, client, journalPath: fundingPath, vault: MANAGED_TEST_VAULT });
    assertFundingPlanMatchesProposal(proposal.fundingPlan, result.plan);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } else if (mode === 'execute') {
    await acquireMutationLock();
    await assertProposalAnchor(client, proposal.fundingPlan);
    await ensureFundingComplete(proposal.config, client, proposal.fundingPlan);
    await assertSpendingRoleNonces(client, proposal.config, proposal.fundingPlan);
    const preflight = await checkPublic({ config: proposal.config, client });
    if (!preflight.ok || preflight.code !== 'ok') throw new Error('M5_SECOND_PUBLIC_PREFLIGHT_BLOCKED');
    if (await existingRegularFile(campaignPath, 'M5_SECOND_CAMPAIGN_JOURNAL_INVALID') ||
        await existingRegularFile(dataDirectory, 'M5_SECOND_DATA_DIRECTORY_INVALID')) throw new Error('M5_SECOND_CAMPAIGN_ALREADY_EXISTS');
    const accounts = runtimeAccounts(process.env, proposal.config);
    const dataKey = runtimeDataKey(process.env);
    const wallet = createWalletClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 0, timeout: 15_000 }) });
    const result = await runCampaign({ config: proposal.config, client, wallet, accounts, dataKey, journalPath: campaignPath,
      dataDirectory, artifact: compileContracts().AssuranceCore, executePublic: true, polls: 20, delay: 1_000 });
    process.stdout.write(JSON.stringify({ ok: result.verification.ok, code: 'M5_SECOND_CAMPAIGN_RESULT',
      transport: result.transport, verification: result.verification }) + '\n');
    if (!result.verification.ok) process.exitCode = 1;
  } else if (mode === 'continue') {
    await acquireMutationLock();
    await assertProposalAnchor(client, proposal.fundingPlan);
    if (!await existingRegularFile(campaignPath, 'M5_SECOND_CAMPAIGN_JOURNAL_INVALID')) throw new Error('M5_SECOND_CAMPAIGN_JOURNAL_MISSING');
    const dataInfo = await lstat(dataDirectory).catch(() => { throw new Error('M5_SECOND_DATA_DIRECTORY_INVALID'); });
    if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()) throw new Error('M5_SECOND_DATA_DIRECTORY_INVALID');
    const sender = await createCampaignSender({ config: proposal.config, client, journalPath: campaignPath });
    const prefix = sender.read();
    if (prefix.transactions.length !== 7 || prefix.transactions[6]?.kind !== 'purchaseA' ||
        prefix.transactions.some(row => row.status !== 'success')) throw new Error('M5_CONTINUATION_PREFIX_INVALID');
    for (const row of prefix.transactions) await sender.observe(row.kind);
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.baseFeePerGas === null || block.baseFeePerGas + 1_000_000n > BigInt(proposal.config.maxFeePerGas)) throw new Error('M5_CONTINUATION_FEE_PREFLIGHT_FAILED');
    const payerUsdc = await client.readContract({ address: proposal.config.token,
      abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'balanceOf', args: [proposal.config.roles.payer] });
    if (typeof payerUsdc !== 'bigint' || payerUsdc < BigInt(ECONOMICS.gross)) throw new Error('M5_CONTINUATION_USDC_INSUFFICIENT');
    const accounts = runtimeAccounts(process.env, proposal.config);
    const dataKey = runtimeDataKey(process.env);
    const wallet = createWalletClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 0, timeout: 15_000 }) });
    const result = await runCampaign({ config: proposal.config, client, wallet, accounts, dataKey, journalPath: campaignPath,
      dataDirectory, artifact: compileContracts().AssuranceCore, executePublic: true, continueAfterPurchaseA: true, polls: 20, delay: 1_000 });
    process.stdout.write(JSON.stringify({ ok: result.verification.ok, code: 'M5_SECOND_CONTINUATION_RESULT',
      transport: result.transport, verification: result.verification }) + '\n');
    if (!result.verification.ok) process.exitCode = 1;
  } else if (mode === 'reconcile') {
    await acquireMutationLock();
    if (!await existingRegularFile(campaignPath, 'M5_SECOND_CAMPAIGN_JOURNAL_INVALID')) throw new Error('M5_SECOND_CAMPAIGN_JOURNAL_MISSING');
    const sender = await createCampaignSender({ config: proposal.config, client, journalPath: campaignPath });
    for (const row of sender.read().transactions) await sender.observe(row.kind);
    const manifest = sender.read();
    process.stdout.write(JSON.stringify({ ok: manifest.transactions.every((row) => row.status !== undefined),
      code: 'M5_SECOND_READ_ONLY_RECONCILED', manifest }) + '\n');
    if (manifest.transactions.some((row) => row.status === undefined)) process.exitCode = 1;
  } else {
    if (!await existingRegularFile(campaignPath, 'M5_SECOND_CAMPAIGN_JOURNAL_INVALID')) throw new Error('M5_SECOND_CAMPAIGN_JOURNAL_MISSING');
    const manifest = await CampaignStore.open(campaignPath, proposal.config).then((store) => store.read());
    const report = await verifyCampaign({ client, manifest, artifact: compileContracts().AssuranceCore });
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: safeCode(error) }) + '\n');
  process.exitCode = 1;
} finally {
  if (release) try { await release(); } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: safeCode(error) }) + '\n');
    process.exitCode = 1;
  }
}
