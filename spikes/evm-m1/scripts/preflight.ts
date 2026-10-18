import { createPublicClient, http, type Hex } from "viem";
import { BASE_SEPOLIA_RPC, runPreflight, validateRpcUrl, type ReadOnlyRpcClient } from "../src/preflight.js";

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? BASE_SEPOLIA_RPC;
if (!validateRpcUrl(rpcUrl)) {
  process.stdout.write('{"ok":false,"code":"rpc_url_rejected"}\n');
  process.exitCode = 2;
} else {
  const rpc = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
  const client: ReadOnlyRpcClient = {
    getChainId: () => rpc.getChainId(),
    getBlock: async ({ blockNumber } = {}) => {
      const block = await rpc.getBlock(blockNumber === undefined ? {} : { blockNumber });
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    getCode: ({ address, blockNumber }) => rpc.getCode({ address, blockNumber }),
    call: async ({ from, to, data, blockNumber, gas }) => {
      const response = await rpc.call({ ...(from ? { account: from } : {}), to, data, blockNumber, gas });
      if (!response.data) throw new Error("empty eth_call result");
      return response.data as Hex;
    },
  };

  try {
    const result = await runPreflight(client);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stdout.write('{"ok":false,"code":"rpc_unavailable"}\n');
    process.exitCode = 1;
  }
}
