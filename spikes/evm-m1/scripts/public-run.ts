import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { parsePublicConfig, publicConfigSummary, PublicConfigError } from '../src/public-config.js';
import { BASE_SEPOLIA_RPC, validateRpcUrl } from '../src/preflight.js';
import { publicJournalExists, recoverPublicRun, runPublicExecution } from '../src/public-runner.js';
import { withBaseReceiptFees } from '../src/base-receipt-fees.js';

const args = process.argv.slice(2);
const execute = args.length === 1 && args[0] === '--execute';
const validArgs = args.length === 0 || execute;
const journalPath = process.env.M1_PUBLIC_JOURNAL_DIR;
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (!validArgs) {
  out({ ok: false, code: 'INVALID_ARGUMENTS' });
  process.exitCode = 2;
} else if (!execute) {
  try {
    const config = parsePublicConfig(process.env);
    out({ ok: true, code: 'CHECK_ONLY', ...publicConfigSummary(config) });
  } catch (error) {
    if (error instanceof PublicConfigError) out({ ok: false, code: error.code, missing: error.missing });
    else out({ ok: false, code: 'CONFIGURATION_UNAVAILABLE' });
    process.exitCode = 1;
  }
} else if (!journalPath) {
  out({ ok: false, code: 'JOURNAL_PATH_REQUIRED' });
  process.exitCode = 1;
} else {
  try {
    if (await publicJournalExists(journalPath)) {
      const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? BASE_SEPOLIA_RPC;
      if (!validateRpcUrl(rpcUrl)) throw new Error('M1_INVALID_RPC');
      const client = withBaseReceiptFees(createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0 }), cacheTime: 0,
        batch: { multicall: false } }));
      const result = await recoverPublicRun(client as never, journalPath, 1n);
      out(result);
      if (!result.ok) process.exitCode = 1;
    } else {
      const config = parsePublicConfig(process.env, { execute: true });
      const payer = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`);
      const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as `0x${string}`);
      if (payer.address.toLowerCase() !== config.payer.toLowerCase() || relayer.address.toLowerCase() !== config.relayer.toLowerCase()) {
        out({ ok: false, code: 'SIGNER_ADDRESS_MISMATCH' });
        process.exitCode = 1;
      } else {
        const client = withBaseReceiptFees(createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl, { retryCount: 0 }), cacheTime: 0,
          batch: { multicall: false } }));
        const wallet = createWalletClient({ account: relayer, chain: baseSepolia,
          transport: http(config.rpcUrl, { retryCount: 0 }) });
        const result = await runPublicExecution({ config, payer, relayer, client: client as never,
          wallet, journalPath, receiptPolls: 5, pollDelayMs: 1_000 });
        out(result);
        if (!result.ok) process.exitCode = 1;
      }
    }
  } catch (error) {
    if (error instanceof PublicConfigError) out({ ok: false, code: error.code, missing: error.missing });
    else out({ ok: false, code: 'PUBLIC_RUN_UNAVAILABLE' });
    process.exitCode = 1;
  }
}
