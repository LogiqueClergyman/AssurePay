import {
  keccak256, TransactionReceiptNotFoundError,
  type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import type { PreparedCoreCall } from './call.js';
import type { PreparedRelayCall, RelayReceipt } from './relay.js';

export interface PublicTransactionRecord {
  transaction: Hex;
  chainId: '84532';
  nonce: string;
  calldataHash: Hex;
  intentHash: Hex;
  to: Address;
  relayer: Address;
}

/** Single-flight spike signer. Signed bytes never leave the broadcast closure. */
export function createEvmDriver(options: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: LocalAccount;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  beforeBroadcast?: (record: PublicTransactionRecord) => Promise<void>;
}) {
  const { publicClient, walletClient, account, gasLimit, maxFeePerGas, maxPriorityFeePerGas, beforeBroadcast } = options;
  if (gasLimit <= 0n || gasLimit > 2_000_000n ||
      maxFeePerGas <= 0n || maxPriorityFeePerGas < 0n ||
      maxPriorityFeePerGas > maxFeePerGas) throw new Error('M1_DRIVER_BUDGET');
  let occupied = false;
  let activeHash: Hex | undefined;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  async function chain() {
    if (await publicClient.getChainId() !== 84532) throw new Error('M1_DRIVER_CHAIN');
  }
  return {
    address: account.address,
    async now(): Promise<bigint> {
      try { await chain(); return (await publicClient.getBlock()).timestamp; }
      catch { throw new Error('M1_DRIVER_CLOCK'); }
    },
    async simulate(call: PreparedCoreCall): Promise<void> {
      try {
        await chain();
        await publicClient.call({ account: account.address, to: call.to, data: call.data,
          gas: gasLimit, value: 0n });
      } catch { throw new Error('M1_DRIVER_SIMULATION'); }
    },
    async prepareCall(call: PreparedCoreCall): Promise<PreparedRelayCall> {
      if (occupied) throw new Error('M1_DRIVER_BUSY');
      occupied = true;
      try {
        await chain();
        const request = await walletClient.prepareTransactionRequest({
          account, chain: baseSepolia, to: call.to, data: call.data, value: 0n,
          gas: gasLimit, maxFeePerGas: maxFeePerGas,
          maxPriorityFeePerGas: maxPriorityFeePerGas, type: 'eip1559',
        });
        const raw = await walletClient.signTransaction({ ...request, account, chain: baseSepolia });
        const hash = keccak256(raw);
        // Persist only public identity before submission. Failure aborts broadcasting.
        await beforeBroadcast?.({ transaction: hash, chainId: '84532', nonce: String(request.nonce),
          calldataHash: keccak256(call.data), intentHash: call.intentHash,
          to: call.to, relayer: account.address });
        activeHash = hash;
        let attempted = false;
        return { hash, async broadcast() {
          if (attempted) throw new Error('M1_DRIVER_ALREADY_ATTEMPTED');
          attempted = true;
          try {
            const result = await publicClient.sendRawTransaction({ serializedTransaction: raw });
            if (!same(result, hash)) throw new Error();
          } catch { throw new Error('M1_DRIVER_BROADCAST_UNCERTAIN'); }
        } };
      } catch {
        if (!activeHash) occupied = false;
        throw new Error('M1_DRIVER_PREPARATION');
      }
    },
    async getReceipt(hash: Hex): Promise<RelayReceipt | null> {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        if (activeHash && same(hash, activeHash) && same(receipt.transactionHash, hash)) {
          occupied = false;
          activeHash = undefined;
        }
        return { transactionHash: receipt.transactionHash, status: receipt.status };
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw new Error('M1_DRIVER_RECEIPT_UNAVAILABLE');
      }
    },
  };
}
