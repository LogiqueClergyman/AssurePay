import {
  decodeFunctionData, encodeDeployData, keccak256, parseAbi,
  type Address, type Hex,
} from 'viem';
import { SPIKE_CORE_ABI, prepareCoreCall } from './call.js';
import { compileContracts } from './compiler.js';
import { DEMO_TERMS, demoConfiguration } from './demo.js';
import { hashIntent, type Intent } from './intent.js';
import { NATIVE_USDC } from './preflight.js';
import { verifySettlement, type ReceiptReadClient } from './receipt.js';

const STATE_ABI = parseAbi([
  'function admissionEnabled() view returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
  'function coverages(bytes32 id) view returns (address payer,bytes32 requestHash,uint256 gross)',
  'function coverageCount() view returns (uint256)',
  'function premiumReserve() view returns (uint256)',
]);
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const safe = (value: unknown): string => typeof value === 'bigint' ? value.toString() : String(value);
function integer(value: unknown): bigint { if (typeof value !== 'bigint') throw new Error('M1_PROOF_INTEGER'); return value; }

export interface ProofReader extends ReceiptReadClient {
  getChainId(): Promise<number>;
  getCode(args: {address: Address; blockNumber: bigint}): Promise<Hex | undefined>;
}
export interface PublicProofIdentity {
  transaction: Hex;
  core: Address;
  payer: Address;
  relayer: Address;
  providerPayout: Address;
  calldataHash: Hex;
  minimumConfirmations?: bigint;
}

/** Decode public chain calldata in memory. It is never returned or printed. */
function decodeIntent(data: Hex): Intent {
  const decoded = decodeFunctionData({ abi: SPIKE_CORE_ABI, data });
  if (decoded.functionName !== 'settleAssured') throw new Error('M1_PROOF_CALL');
  const raw = decoded.args[0] as Record<string, unknown>;
  return { chainId: safe(raw.chainId), core: String(raw.core).toLowerCase() as Address, token: String(raw.token).toLowerCase() as Address,
    payer: String(raw.payer).toLowerCase() as Address, providerId: raw.providerId as Hex, policyId: raw.policyId as Hex,
    policyHash: raw.policyHash as Hex, requestHash: raw.requestHash as Hex, gross: safe(raw.gross),
    payerSalt: raw.payerSalt as Hex, validAfter: safe(raw.validAfter), validBefore: safe(raw.validBefore) };
}

async function publicCall(client: ProofReader, expected: PublicProofIdentity) {
  const tx = await client.getTransaction({ hash: expected.transaction });
  if (!tx || !same(tx.hash, expected.transaction) || !same(tx.to, expected.core) ||
      !same(tx.from, expected.relayer) || tx.value !== 0n || tx.chainId !== 84532 ||
      keccak256(tx.input) !== expected.calldataHash) throw new Error('M1_PROOF_TRANSACTION');
  const intent = decodeIntent(tx.input);
  const configuration = demoConfiguration(expected.core, expected.providerPayout);
  if (!same(intent.payer, expected.payer)) throw new Error('M1_PROOF_PAYER');
  return { tx, intent, configuration, call: Object.freeze({ to: expected.core, data: tx.input,
    intentHash: hashIntent(intent), payer: intent.payer }) };
}

export async function verifyPublicSuccess(client: ProofReader, expected: PublicProofIdentity) {
  try {
    const { intent, configuration, call } = await publicCall(client, expected);
    const result = await verifySettlement(client, { call, configuration, intent, relayer: expected.relayer,
      transaction: expected.transaction, minimumConfirmations: expected.minimumConfirmations ?? 1n });
    if (!result.ok || result.blockNumber === undefined || result.blockNumber < 1n) return result;
    const height = result.blockNumber;
    const previous = await client.getBlock({ blockNumber: height - 1n });
    const block = await client.getBlock({ blockNumber: height });
    if (!same(block.parentHash, previous.hash)) throw new Error();
    const read = (address: Address, functionName: string, args: readonly unknown[], blockNumber: bigint) =>
      client.readContract({ address, abi: STATE_ABI, functionName, args, blockNumber });
    const addresses = [intent.payer, expected.core, expected.providerPayout];
    const before = (await Promise.all(addresses.map(address => read(NATIVE_USDC, 'balanceOf', [address], height - 1n)))).map(integer);
    const after = (await Promise.all(addresses.map(address => read(NATIVE_USDC, 'balanceOf', [address], height)))).map(integer);
    if (after[0]! - before[0]! !== -100n || after[1]! - before[1]! !== 7n || after[2]! - before[2]! !== 93n ||
        await read(NATIVE_USDC, 'authorizationState', [intent.payer, call.intentHash], height - 1n) !== false ||
        integer(await read(expected.core, 'coverageCount', [], height)) - integer(await read(expected.core, 'coverageCount', [], height - 1n)) !== 1n ||
        integer(await read(expected.core, 'premiumReserve', [], height)) - integer(await read(expected.core, 'premiumReserve', [], height - 1n)) !== 7n) throw new Error();
    if (!same((await client.getBlock({ blockNumber: height })).hash, result.blockHash!) ||
        !same((await client.getBlock({ blockNumber: height - 1n })).hash, previous.hash)) throw new Error();
    return { ...result, tokenDeltas: ['-100', '7', '93'], confirmationPolicy: 'canonical-inclusion-with-configured-depth' };
  } catch { return { ok: false, code: 'PUBLIC_PROOF_INVALID', transaction: expected.transaction }; }
}

/** Pins creation input including constructor args, rather than immutable-patched runtime bytes. */
export async function verifyPublicDeployment(client: ProofReader, expected: {
  transaction: Hex; relayer: Address; providerPayout: Address; minimumConfirmations?: bigint;
}) {
  try {
    if (await client.getChainId() !== 84532) throw new Error();
    const receipt = await client.getTransactionReceipt({ hash: expected.transaction });
    const tx = await client.getTransaction({ hash: expected.transaction });
    const confirmations = expected.minimumConfirmations ?? 1n;
    if (confirmations < 1n || confirmations > 1000n || receipt.status !== 'success' || !receipt.contractAddress ||
        !same(receipt.transactionHash, expected.transaction) || !same(tx.hash, expected.transaction) ||
        !same(tx.from, expected.relayer) || tx.to !== null || tx.value !== 0n || tx.chainId !== 84532 ||
        !same(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber) throw new Error();
    const artifact = compileContracts().AssuranceCoreSpike!;
    const creation = encodeDeployData({ ...artifact, args: [NATIVE_USDC, expected.providerPayout,
      DEMO_TERMS.providerId, DEMO_TERMS.policyId, DEMO_TERMS.policyHash] });
    if (tx.input !== creation) throw new Error();
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!same(block.hash, receipt.blockHash) || await client.getBlockNumber() < receipt.blockNumber + confirmations - 1n) throw new Error();
    const code = await client.getCode({ address: receipt.contractAddress, blockNumber: receipt.blockNumber });
    if (!code || code === '0x') throw new Error();
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!same(canonical.hash, receipt.blockHash)) throw new Error();
    return { ok: true, code: 'PUBLIC_DEPLOYMENT_VERIFIED', transaction: expected.transaction,
      core: receipt.contractAddress as Address, blockNumber: receipt.blockNumber as bigint,
      blockHash: receipt.blockHash as Hex, gasUsed: receipt.gasUsed as bigint };
  } catch { return { ok: false, code: 'PUBLIC_DEPLOYMENT_INVALID', transaction: expected.transaction }; }
}

/** Intentionally included admission revert; block-level deltas fail closed on concurrent activity. */
export async function verifyPublicAdmissionRevert(client: ProofReader, expected: PublicProofIdentity) {
  try {
    if (await client.getChainId() !== 84532) throw new Error();
    const { tx, intent, configuration, call } = await publicCall(client, expected);
    const receipt = await client.getTransactionReceipt({ hash: expected.transaction });
    const confirmations = expected.minimumConfirmations ?? 1n;
    if (confirmations < 1n || confirmations > 1000n || receipt.status !== 'reverted' ||
        !same(receipt.transactionHash, expected.transaction) || !same(tx.blockHash, receipt.blockHash) ||
        tx.blockNumber !== receipt.blockNumber || receipt.blockNumber < 1n || receipt.logs.length !== 0) throw new Error();
    const blockNumber = receipt.blockNumber as bigint;
    const block = await client.getBlock({ blockNumber });
    const previous = await client.getBlock({ blockNumber: blockNumber - 1n });
    if (!same(block.hash, receipt.blockHash) || !same(block.parentHash, previous.hash) ||
        await client.getBlockNumber() < blockNumber + confirmations - 1n) throw new Error();
    // Establish that this is a valid payer authorization even though admission blocked execution.
    const decoded = decodeFunctionData({ abi: SPIKE_CORE_ABI, data: call.data });
    const args = decoded.args as readonly any[];
    const signature = `0x${args[2].slice(2)}${args[3].slice(2)}${Number(args[1]).toString(16).padStart(2, '0')}` as Hex;
    const { buildRequirements } = await import('./profile.js');
    await prepareCoreCall({ x402Version: 2, accepted: buildRequirements(configuration),
      payload: { intent, intentHash: call.intentHash, signature } }, configuration, block.timestamp);
    const read = (address: Address, functionName: string, args: readonly unknown[], height: bigint) =>
      client.readContract({ address, abi: STATE_ABI, functionName, args, blockNumber: height });
    for (const height of [blockNumber - 1n, blockNumber]) {
      if (await read(expected.core, 'admissionEnabled', [], height) !== false ||
          await read(NATIVE_USDC, 'authorizationState', [intent.payer, call.intentHash], height) !== false) throw new Error();
      const coverage = await read(expected.core, 'coverages', [call.intentHash], height);
      if (!same(coverage[0], ZERO) || coverage[1] !== `0x${'00'.repeat(32)}` || coverage[2] !== 0n) throw new Error();
    }
    const addresses = [intent.payer, expected.core, expected.providerPayout];
    const before = await Promise.all(addresses.map(address => read(NATIVE_USDC, 'balanceOf', [address], blockNumber - 1n)));
    const after = await Promise.all(addresses.map(address => read(NATIVE_USDC, 'balanceOf', [address], blockNumber)));
    if (before.some((value, index) => value !== after[index])) throw new Error();
    for (const name of ['coverageCount', 'premiumReserve']) {
      if (await read(expected.core, name, [], blockNumber - 1n) !== await read(expected.core, name, [], blockNumber)) throw new Error();
    }
    if (!same((await client.getBlock({ blockNumber })).hash, receipt.blockHash) ||
        !same((await client.getBlock({ blockNumber: blockNumber - 1n })).hash, previous.hash)) throw new Error();
    return { ok: true, code: 'PUBLIC_ADMISSION_ROLLBACK_VERIFIED', transaction: expected.transaction,
      blockNumber, blockHash: receipt.blockHash as Hex, gasUsed: receipt.gasUsed as bigint,
      effectiveGasPrice: receipt.effectiveGasPrice as bigint, nonceUnused: true, tokenBalancesUnchanged: true,
      revertCause: 'not-traced; admission-disabled-at-block-boundaries' };
  } catch { return { ok: false, code: 'PUBLIC_ADMISSION_ROLLBACK_INVALID', transaction: expected.transaction }; }
}
