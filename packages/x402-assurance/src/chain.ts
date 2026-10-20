import {
  decodeEventLog, encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex,
} from 'viem';
import { CORE_ABI } from './core-abi.js';
import type { PaymentResult, PreparedCall, Terms, Trust } from './types.js';

const POLICY_TYPEHASH = keccak256(new TextEncoder().encode(
  'AssuredPolicyV1(bytes32 providerId,bytes32 policyId,address providerOwner,address providerPayout,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)',
));
const DOMAIN_TYPEHASH = keccak256(new TextEncoder().encode(
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
));
const USDC_NAME_HASH = keccak256(new TextEncoder().encode('USDC'));
const USDC_VERSION_HASH = keccak256(new TextEncoder().encode('2'));
const COVERAGE_OPENED_TOPIC = keccak256(new TextEncoder().encode('CoverageOpened(bytes32,address,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint64)'));
const TRANSFER_TOPIC = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
const AUTHORIZATION_USED_TOPIC = keccak256(new TextEncoder().encode('AuthorizationUsed(address,bytes32)'));
const fail = () => new Error('CHAIN_TERMS_INVALID');
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uint = (v: unknown) => typeof v === 'bigint' && v >= 0n;
const amount = (v: bigint) => v.toString(10);
const tokenEvents = [
  { type: 'event', name: 'Transfer', inputs: [{ indexed: true, name: 'from', type: 'address' }, { indexed: true, name: 'to', type: 'address' }, { indexed: false, name: 'value', type: 'uint256' }] },
  { type: 'event', name: 'AuthorizationUsed', inputs: [{ indexed: true, name: 'authorizer', type: 'address' }, { indexed: true, name: 'nonce', type: 'bytes32' }] },
] as const;

/** Reads a complete immutable policy quote against one canonical snapshot. */
export async function readTerms(client: any, trust: Trust, gross: bigint | string): Promise<Terms> {
  try {
    const g = typeof gross === 'bigint' ? gross : BigInt(gross);
    if (g < 2n || g.toString() !== String(gross)) throw fail();
    // This package's terms reader is intentionally pinned to Base Sepolia.
    if (trust.chainId !== 84532 || await client.getChainId() !== 84532) throw fail();
    const block = await client.getBlock({ blockTag: 'latest' });
    if (!block?.number || !block?.hash) throw fail();
    const blockNumber = block.number;
    const [coreCode, tokenCode, coreToken, provider, policy, quote, name, version, decimals, domainSeparator] = await Promise.all([
      client.getCode({ address: trust.core, blockNumber }),
      client.getCode({ address: trust.token, blockNumber }),
      client.readContract({ address: trust.core, abi: CORE_ABI, functionName: 'token', blockNumber }),
      client.readContract({ address: trust.core, abi: CORE_ABI, functionName: 'providers', args: [trust.providerId], blockNumber }),
      client.readContract({ address: trust.core, abi: CORE_ABI, functionName: 'policies', args: [trust.policyId], blockNumber }),
      client.readContract({ address: trust.core, abi: CORE_ABI, functionName: 'quoteSettlement', args: [trust.policyId, g], blockNumber }),
      client.readContract({ address: trust.token, abi: [{ type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }], functionName: 'name', blockNumber }),
      client.readContract({ address: trust.token, abi: [{ type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }], functionName: 'version', blockNumber }),
      client.readContract({ address: trust.token, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals', blockNumber }),
      client.readContract({ address: trust.token, abi: [{ type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }], functionName: 'DOMAIN_SEPARATOR', blockNumber }),
    ]);
    if (!coreCode || coreCode === '0x' || !tokenCode || tokenCode === '0x' || !eq(coreToken, trust.token)) throw fail();
    const [owner, payout] = provider as readonly [Address, Address, bigint, bigint];
    const [policyProvider, policyHash, premiumBps, stakeBps, withholdingBps, duration, poolOnlyAllowed] = policy as readonly [Hex, Hex, number, number, number, bigint, boolean];
    if (!owner || !payout || eq(owner, '0x0000000000000000000000000000000000000000') ||
        !eq(policyProvider, trust.providerId) || !uint(duration) || duration === 0n ||
        !Number.isInteger(premiumBps) || premiumBps < 0 || premiumBps > 9999 ||
        !Number.isInteger(stakeBps) || stakeBps < 0 || stakeBps > 10000 ||
        !Number.isInteger(withholdingBps) || withholdingBps < 0 || withholdingBps > 9999 ||
        typeof poolOnlyAllowed !== 'boolean' || name !== 'USDC' || version !== '2' || decimals !== 6) throw fail();
    const expectedDomain = keccak256(encodeAbiParameters(parseAbiParameters(
      'bytes32,bytes32,bytes32,uint256,address',
    ), [DOMAIN_TYPEHASH, USDC_NAME_HASH, USDC_VERSION_HASH, 84532n, trust.token]));
    if (!eq(domainSeparator, expectedDomain)) throw fail();
    const computedPolicyHash = keccak256(encodeAbiParameters(parseAbiParameters(
      'bytes32,bytes32,bytes32,address,address,uint16,uint16,uint16,uint64,bool',
    ), [POLICY_TYPEHASH, trust.providerId, trust.policyId, owner, payout, premiumBps, stakeBps, withholdingBps, duration, poolOnlyAllowed]));
    if (!eq(policyHash, computedPolicyHash)) throw fail();
    const [premium, withheld, net, stakeLock, poolReservation] = quote as readonly [bigint, bigint, bigint, bigint, bigint];
    const expectedPremiumRaw = g * BigInt(premiumBps) / 10_000n;
    const expectedPremium = expectedPremiumRaw === 0n ? 1n : expectedPremiumRaw;
    const expectedWithheld = (g - expectedPremium) * BigInt(withholdingBps) / 10_000n;
    const expectedNet = g - expectedPremium - expectedWithheld;
    const expectedStakeLock = (g * BigInt(stakeBps) + 9_999n) / 10_000n;
    const expectedPoolReservation = poolOnlyAllowed ? g : g - expectedStakeLock;
    if (![premium, withheld, net, stakeLock, poolReservation].every(uint) || expectedPremium >= g || expectedNet === 0n ||
        premium !== expectedPremium || withheld !== expectedWithheld || net !== expectedNet || stakeLock !== expectedStakeLock ||
        poolReservation !== expectedPoolReservation) throw fail();
    const after = await client.getBlock({ blockNumber });
    if (!after?.hash || !eq(after.hash, block.hash)) throw fail();
    return Object.freeze({ ...trust, providerOwner: owner, providerPayout: payout, policyHash,
      premiumBps, stakeBps, withholdingBps, duration: amount(duration), poolOnlyAllowed,
      gross: amount(g), premium: amount(premium), withheld: amount(withheld), net: amount(net),
      stakeLock: amount(stakeLock), poolReservation: amount(poolReservation), tokenName: 'USDC', tokenVersion: '2' });
  } catch (e: any) {
    if (e?.message === 'CHAIN_TERMS_INVALID') throw e;
    throw fail();
  }
}

/** Signer-free, conservative inclusion verification. */
export async function verifySettlement(
  client: any, terms: Terms, call: PreparedCall, hash: Hex, relayer: Address, minimumConfirmations = 1,
  expectedNonce?: bigint,
): Promise<PaymentResult> {
  try {
    if (!Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1 || minimumConfirmations > 1_000) return invalid(hash, call.intentHash);
    const chainId = await client.getChainId();
    const tx = await client.getTransaction({ hash });
    const nonceMatches = expectedNonce === undefined || (typeof tx?.nonce === 'bigint' ? tx.nonce === expectedNonce :
      Number.isSafeInteger(tx?.nonce) && BigInt(tx.nonce) === expectedNonce);
    if (chainId !== terms.chainId || !tx || !eq(tx.hash, hash) || !eq(tx.to ?? '', terms.core) || !eq(tx.from, relayer) ||
        tx.value !== 0n || !eq(tx.input, call.data) || tx.chainId !== terms.chainId ||
        !nonceMatches) return invalid(hash, call.intentHash);
    const receipt = await client.getTransactionReceipt({ hash });
    if (!receipt) return pending(hash, call.intentHash);
    if (!eq(receipt.transactionHash, hash) || typeof receipt.blockNumber !== 'bigint' || !receipt.blockHash ||
        !tx.blockHash || !eq(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber) return pending(hash, call.intentHash);
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!block?.hash || !eq(block.hash, receipt.blockHash)) return pending(hash, call.intentHash);
    const head = await client.getBlockNumber();
    if (head + 1n - receipt.blockNumber < BigInt(minimumConfirmations)) return pending(hash, call.intentHash);
    if (receipt.status === 'reverted') {
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (!canonical?.hash || !eq(canonical.hash, receipt.blockHash)) return pending(hash, call.intentHash);
      return { state: 'reverted', transaction: hash, coverageId: call.intentHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash };
    }
    if (receipt.status !== 'success') return invalid(hash, call.intentHash);
    const rawCoverageEvents = receipt.logs.filter((log: any) => eq(log.address, terms.core) && eq(log.topics?.[0] ?? '', COVERAGE_OPENED_TOPIC));
    if (rawCoverageEvents.length !== 1) return invalid(hash, call.intentHash);
    const coreEvents = rawCoverageEvents.map((log: any) => {
      try { return decodeEventLog({ abi: CORE_ABI, data: log.data, topics: log.topics }); } catch { return undefined; }
    }).filter((event: any) => event?.eventName === 'CoverageOpened');
    const opened = coreEvents.length === 1 && eq(coreEvents[0].args.coverageId, call.intentHash) ? coreEvents[0] : undefined;
    const rawTransfers = receipt.logs.filter((log: any) => eq(log.address, terms.token) && eq(log.topics?.[0] ?? '', TRANSFER_TOPIC));
    const rawAuthorizations = receipt.logs.filter((log: any) => eq(log.address, terms.token) && eq(log.topics?.[0] ?? '', AUTHORIZATION_USED_TOPIC));
    if (rawTransfers.length !== 2 || rawAuthorizations.length !== 1) return invalid(hash, call.intentHash);
    const tokenLogs = [...rawTransfers, ...rawAuthorizations].map((log: any) => {
      try { return decodeEventLog({ abi: tokenEvents, data: log.data, topics: log.topics }); } catch { return undefined; }
    });
    if (tokenLogs.some((event: any) => !event)) return invalid(hash, call.intentHash);
    const transfers = (tokenLogs as any[]).filter(log => log.eventName === 'Transfer');
    const authorizations = (tokenLogs as any[]).filter(log => log.eventName === 'AuthorizationUsed');
    const auth = authorizations.filter(log => eq(log.args.authorizer, call.intent.payer) && eq(log.args.nonce, call.intentHash));
    if (!opened || transfers.length !== 2 || authorizations.length !== 1 || auth.length !== 1) return invalid(hash, call.intentHash);
    const a = opened.args;
    if (!eq(a.payer, call.intent.payer) || !eq(a.providerId, terms.providerId) || !eq(a.policyId, terms.policyId) ||
        !eq(a.requestHash, call.intent.requestHash) || a.gross !== BigInt(terms.gross) || a.premium !== BigInt(terms.premium) ||
        a.withheld !== BigInt(terms.withheld) || a.net !== BigInt(terms.net) || a.stakeLock !== BigInt(terms.stakeLock) ||
        a.poolReservation !== BigInt(terms.poolReservation)) return invalid(hash, call.intentHash);
    const receive = transfers.find(log => eq(log.args.from, call.intent.payer) && eq(log.args.to, terms.core) && log.args.value === BigInt(terms.gross));
    const providerPayment = transfers.find(log => eq(log.args.from, terms.core) && eq(log.args.to, terms.providerPayout) && log.args.value === BigInt(terms.net));
    if (!receive || !providerPayment) return invalid(hash, call.intentHash);
    const stateBlock = receipt.blockNumber;
    const [coverage, used] = await Promise.all([
      client.readContract({ address: terms.core, abi: CORE_ABI, functionName: 'coverages', args: [call.intentHash], blockNumber: stateBlock }),
      client.readContract({ address: terms.token, abi: [{ type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ type: 'bool' }] }], functionName: 'authorizationState', args: [call.intent.payer, call.intentHash], blockNumber: stateBlock }),
    ]);
    if (!used || !eq(coverage[0], call.intent.payer) || !eq(coverage[1], terms.providerId) || !eq(coverage[2], terms.policyId) ||
        !eq(coverage[3], terms.policyHash) || !eq(coverage[4], call.intent.requestHash) || coverage[5] !== BigInt(terms.gross) ||
        coverage[6] !== BigInt(terms.premium) || coverage[7] !== BigInt(terms.withheld) || coverage[8] !== BigInt(terms.stakeLock) ||
        coverage[9] !== BigInt(terms.poolReservation) || coverage[11] !== coverage[10] + BigInt(terms.duration) ||
        a.expiresAt !== coverage[11] || typeof block.timestamp !== 'bigint' || coverage[10] !== block.timestamp ||
        coverage[12] !== terms.poolOnlyAllowed || coverage[13] !== 1) return invalid(hash, call.intentHash);
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!canonical?.hash || !eq(canonical.hash, receipt.blockHash)) return pending(hash, call.intentHash);
    return { state: 'confirmed', transaction: hash, coverageId: call.intentHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash };
  } catch { return pending(hash, call.intentHash); }
}

/** Current-state service gate. Historical payment confirmation alone cannot reopen expired coverage. */
export async function isServiceAdmissible(client: any, terms: Terms, call: PreparedCall): Promise<boolean> {
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    if (!block || block.number === undefined || !block.hash || typeof block.timestamp !== 'bigint') return false;
    const coverage = await client.readContract({ address: terms.core, abi: CORE_ABI, functionName: 'coverages', args: [call.intentHash], blockNumber: block.number });
    const [payer, providerId, policyId, policyHash, requestHash, gross, , , , , , expiresAt, , status] = coverage as readonly [Address, Hex, Hex, Hex, Hex, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, number];
    const fresh = await client.getBlock({ blockNumber: block.number });
    return Boolean(fresh?.hash && eq(fresh.hash, block.hash) && fresh.timestamp === block.timestamp && eq(payer, call.intent.payer) &&
      eq(providerId, terms.providerId) && eq(policyId, terms.policyId) && eq(policyHash, terms.policyHash) &&
      eq(requestHash, call.intent.requestHash) && gross === BigInt(terms.gross) && status === 1 && fresh.timestamp < expiresAt);
  } catch { return false; }
}

const invalid = (transaction: Hex, coverageId: Hex): PaymentResult => ({ state: 'invalid', transaction, coverageId });
const pending = (transaction: Hex, coverageId: Hex): PaymentResult => ({ state: 'pending', transaction, coverageId });
