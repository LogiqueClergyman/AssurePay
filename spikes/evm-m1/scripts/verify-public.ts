import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { BASE_SEPOLIA_RPC, validateRpcUrl } from '../src/preflight.js';
import { recoverPublicRun } from '../src/public-runner.js';
import { withBaseReceiptFees } from '../src/base-receipt-fees.js';

const args = process.argv.slice(2);
const path = args.length === 2 && args[0] === '--journal' ? args[1] : undefined;
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? BASE_SEPOLIA_RPC;
if (!path || !validateRpcUrl(rpcUrl)) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: path ? 'INVALID_RPC_URL' : 'INVALID_ARGUMENTS' })}\n`);
  process.exitCode = 2;
} else {
  try {
    const client = withBaseReceiptFees(createPublicClient({ chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0 }), cacheTime: 0,
      batch: { multicall: false } }));
    const result = await recoverPublicRun(client as never, path, 1n);
    process.stdout.write(`${JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'PUBLIC_PROOF_UNAVAILABLE' })}\n`);
    process.exitCode = 1;
  }
}
