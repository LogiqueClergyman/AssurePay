import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { CORE_ABI } from './core-abi.js';
import { verifySettlement } from './chain.js';
import { PaymentStore, safeTermsHash, type PaymentNamespace, type PaymentRecord } from './payment-store.js';
import type { PaymentResult, PreparedCall, SettlementEngine, Terms } from './types.js';

export interface SettlementEngineOptions {
  client: any;
  wallet?: any;
  account?: any;
  /** Required for read-only restart recovery; otherwise taken from wallet/account. */
  relayer?: Address;
  terms: Terms;
  journalPath: string;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  polls?: number;
  delay?: number;
}

const err = (code: string) => new Error(code);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const noResult = (transaction: Hex | '', coverageId: Hex, state: PaymentResult['state'] = 'invalid'): PaymentResult => ({ state, transaction, coverageId });
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};
const snapshot = <T>(value: T): T => deepFreeze(structuredClone(value));
const stableJson = (value: any): string => Array.isArray(value) ? `[${value.map(stableJson).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}` : JSON.stringify(value);
const stableCall = (call: PreparedCall) => stableJson(call);

/** Restricted journaled sender and signer-free recovery engine. */
export function createSettlementEngine(options: SettlementEngineOptions): SettlementEngine {
  const { client, wallet } = options;
  const terms = snapshot(options.terms);
  const account = options.account ?? wallet?.account;
  const relayer: Address | undefined = options.relayer ?? (typeof account === 'string' ? account : account?.address);
  if (!relayer) throw err('SETTLEMENT_RELAYER_REQUIRED');
  const gasLimit = options.gasLimit ?? 650_000n;
  const maxFeePerGas = options.maxFeePerGas ?? 2_000_000_000n;
  const maxPriorityFeePerGas = options.maxPriorityFeePerGas ?? 100_000_000n;
  const polls = options.polls ?? 4;
  const delay = options.delay ?? 250;
  if (gasLimit < 21_000n || gasLimit > 2_000_000n || maxFeePerGas <= 0n || maxFeePerGas > 100_000_000_000n ||
      maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > 10_000_000_000n || maxPriorityFeePerGas > maxFeePerGas ||
      !Number.isSafeInteger(polls) || polls < 1 || polls > 20 || !Number.isSafeInteger(delay) || delay < 0 || delay > 5_000) {
    throw err('SETTLEMENT_BOUNDS_INVALID');
  }
  const termsHash = safeTermsHash(terms);
  const namespace: PaymentNamespace = { chainId: terms.chainId, core: terms.core, token: terms.token,
    relayer, termsHash };
  const store = new PaymentStore(options.journalPath, namespace);
  let tail: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, { callIdentity: string; promise: Promise<PaymentResult> }>();

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };

  async function reconcile(record: PaymentRecord, call: PreparedCall): Promise<PaymentResult> {
    const result = await verifySettlement(client, terms, call, record.transaction, relayer!, 1, BigInt(record.nonce));
    const status = result.state === 'confirmed' ? 'confirmed' : result.state === 'reverted' ? 'reverted' : 'pending';
    if ((record.status === 'confirmed' || record.status === 'reverted') && result.state !== record.status) {
      // A transient read failure or reorg observation must not downgrade a durable
      // terminal record. Admission remains closed until canonical proof returns.
      return noResult(record.transaction, call.intentHash, 'pending');
    }
    if (record.status !== status || result.blockNumber || result.blockHash) {
      await store.update({ ...record, status, ...(result.blockNumber ? { blockNumber: result.blockNumber } : {}), ...(result.blockHash ? { blockHash: result.blockHash } : {}) });
    }
    return result;
  }

  return {
    async settle(input: PreparedCall): Promise<PaymentResult> {
      let call: PreparedCall;
      try { call = snapshot(input); } catch { return noResult('', '0x' as Hex); }
      const key = call?.intentHash?.toLowerCase();
      if (typeof key !== 'string') return noResult('', '0x' as Hex);
      const active = inflight.get(key);
      const identity = stableCall(call);
      if (active) return active.callIdentity === identity ? active.promise : noResult('', call.intentHash);
      const operation = enqueue(() => run(call));
      inflight.set(key, { callIdentity: identity, promise: operation });
      try { return await operation; } finally { if (inflight.get(key)?.promise === operation) inflight.delete(key); }
    },
  };

  async function run(input: PreparedCall): Promise<PaymentResult> {
    let call: PreparedCall;
    try {
      const { validateCall } = await import('./protocol.js');
      const observed = await client.getBlock({ blockTag: 'latest' });
      if (!observed?.number || !observed?.hash || typeof observed.timestamp !== 'bigint') return noResult('', input?.intentHash ?? ('0x' as Hex));
      call = await validateCall(input, terms, observed.timestamp, { allowExpired: true });
      if (!same(call.to, terms.core)) return noResult('', call.intentHash);
      const decoded = decodeFunctionData({ abi: CORE_ABI, data: call.data });
      if (decoded.functionName !== 'settleAssured') return noResult('', call.intentHash);
    } catch { return noResult('', input?.intentHash ?? ('0x' as Hex)); }

    let calldataHash: Hex;
    try { calldataHash = keccak256(call.data); } catch { return noResult('', call.intentHash); }
    let prior: PaymentRecord | undefined;
    try { prior = await store.get(call.intentHash); } catch { return noResult('', call.intentHash); }
    if (prior) {
      if (prior.chainId !== terms.chainId || !same(prior.core, terms.core) || !same(prior.token, terms.token) ||
          !same(prior.relayer, relayer!) || prior.intentHash.toLowerCase() !== call.intentHash.toLowerCase() ||
          prior.calldataHash.toLowerCase() !== calldataHash.toLowerCase() || prior.termsHash !== termsHash) return noResult(prior.transaction, call.intentHash);
      return reconcile(prior, call);
    }

    // A new authorization must still be valid now; an expired known transaction is recovery-only.
    let observed;
    try {
      observed = await client.getBlock({ blockTag: 'latest' });
      if (!observed?.number || !observed?.hash || typeof observed.timestamp !== 'bigint') return noResult('', call.intentHash);
      const { validateCall } = await import('./protocol.js');
      call = await validateCall(input, terms, observed.timestamp);
    } catch { return noResult('', call.intentHash); }
    if (!wallet || !account || typeof wallet.signTransaction !== 'function' || typeof client.sendRawTransaction !== 'function') return noResult('', call.intentHash);
    try {
      const currentChain = await client.getChainId();
      if (currentChain !== terms.chainId || terms.chainId !== 84532 || wallet.chain?.id !== terms.chainId ||
          typeof account === 'string' || !account?.address || !same(account.address, relayer!)) return noResult('', call.intentHash);
      await client.simulateContract({ account, address: terms.core, abi: CORE_ABI, functionName: 'settleAssured',
        args: decodeFunctionData({ abi: CORE_ABI, data: call.data }).args, value: 0n, blockNumber: observed.number });
      const stillCanonical = await client.getBlock({ blockNumber: observed.number });
      if (!stillCanonical?.hash || !same(stillCanonical.hash, observed.hash)) return noResult('', call.intentHash, 'pending');
      // A different intent cannot consume a nonce while an earlier prepared/pending
      // hash is ambiguous. Its own call can be reconciled through the prior branch.
      const unresolved = (await store.list()).find(record => record.status === 'prepared' || record.status === 'pending');
      if (unresolved) return noResult(unresolved.transaction, unresolved.coverageId, 'pending');
      const nonce = await client.getTransactionCount({ address: relayer!, blockTag: 'latest' });
      const pendingNonce = await client.getTransactionCount({ address: relayer!, blockTag: 'pending' });
      if (nonce !== pendingNonce) return noResult('', call.intentHash, 'pending');
      const request = { account, chain: wallet.chain, to: terms.core, data: call.data, value: 0n,
        nonce, gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas, type: 'eip1559' as const, accessList: [] as const };
      const raw = await wallet.signTransaction(request);
      const parsed = parseTransaction(raw);
      const signedFrom = await recoverTransactionAddress({ serializedTransaction: raw });
      const expectedNonce = BigInt(nonce);
      const signedNonceMatches = typeof parsed.nonce === 'bigint' ? parsed.nonce === expectedNonce :
        typeof parsed.nonce === 'number' && Number.isSafeInteger(parsed.nonce) && BigInt(parsed.nonce) === expectedNonce;
      // viem omits a zero-value field when decoding its canonical RLP encoding.
      if (!same(parsed.to ?? '', terms.core) || parsed.data?.toLowerCase() !== call.data.toLowerCase() || (parsed.value ?? 0n) !== 0n ||
          !signedNonceMatches || parsed.chainId !== terms.chainId || parsed.gas !== gasLimit ||
          parsed.maxFeePerGas !== maxFeePerGas || parsed.maxPriorityFeePerGas !== maxPriorityFeePerGas ||
          !same(signedFrom, relayer!) || (parsed.accessList?.length ?? 0) !== 0 || parsed.type !== 'eip1559') return noResult('', call.intentHash);
      const transaction = keccak256(raw);
      const record: PaymentRecord = { version: 1, chainId: terms.chainId, core: terms.core, token: terms.token,
        relayer: relayer!, intentHash: call.intentHash, calldataHash, nonce: String(nonce), transaction,
        termsHash, terms, status: 'prepared', coverageId: call.intentHash };
      await store.create(record); // durable identity precedes the one broadcast attempt
      try {
        const returned = await client.sendRawTransaction({ serializedTransaction: raw });
        if (!same(returned, transaction)) return noResult(transaction, call.intentHash, 'pending');
      } catch { return noResult(transaction, call.intentHash, 'pending'); }
      let current = { ...record, status: 'pending' as const };
      await store.update(current);
      for (let i = 0; i < polls; i++) {
        const result = await reconcile(current, call);
        if (result.state === 'confirmed' || result.state === 'reverted' || result.state === 'invalid') return result;
        current = { ...current, status: 'pending' };
        if (i + 1 < polls) await new Promise(resolve => setTimeout(resolve, delay));
      }
      return noResult(transaction, call.intentHash, 'pending');
    } catch {
      // Any error after signing is ambiguous. The persisted hash, if present, is the only recovery handle.
      const record = await store.get(call.intentHash).catch(() => undefined);
      return noResult(record?.transaction ?? '', call.intentHash, 'pending');
    }
  }
}
