import { CORE_ABI } from '../../claims-backend/src/abi.js';
import type { Address, Hex } from 'viem';
import type { ClientConfig, ClientCoverage, ClientState } from './types.js';

const ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO32 = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const err = (code: string): never => { throw new Error(code); };
function uint(value: unknown): string {
  if (typeof value === 'bigint' && value >= 0n && value < (1n << 256n)) return value.toString();
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) < (1n << 256n)) return value;
  return err('CLIENT_RPC_INVALID');
}
function address(value: unknown): Address {
  if (typeof value !== 'string' || !ADDRESS.test(value)) return err('CLIENT_RPC_INVALID');
  return value.toLowerCase() as Address;
}
function id(value: unknown, allowZero = false): Hex {
  if (typeof value !== 'string' || !ID.test(value) || (!allowZero && value === ZERO32)) return err('CLIENT_RPC_INVALID');
  return value.toLowerCase() as Hex;
}

/** Read only the configured payer's token balance and, optionally, its own coverage. */
export function createStateReader(config: ClientConfig, client: any): (coverageId?: Hex) => Promise<ClientState> {
  const c = structuredClone(config);
  const getChainId = client.getChainId?.bind(client);
  const getBlock = client.getBlock?.bind(client);
  const readContract = client.readContract?.bind(client);
  if (!getChainId || !getBlock || !readContract) return () => Promise.reject(new Error('CLIENT_RPC_UNAVAILABLE'));
  return async (coverageId?: Hex): Promise<ClientState> => {
    if (coverageId !== undefined && (typeof coverageId !== 'string' || !ID.test(coverageId) || coverageId === ZERO32)) err('CLIENT_COVERAGE_INVALID');
    try {
      const chainId = await getChainId();
      if (chainId !== 84532) err('CLIENT_CHAIN_MISMATCH');
      const head = await getBlock({ blockTag: 'latest' });
      const number = uint(head?.number);
      const hash = id(head?.hash);
      const timestamp = uint(head?.timestamp);
      const blockNumber = BigInt(number);
      const [coreToken, adjudicator, tokenBalance, rawCoverage] = await Promise.all([
        readContract({ address: c.core, abi: CORE_ABI, functionName: 'token', blockNumber }),
        readContract({ address: c.core, abi: CORE_ABI, functionName: 'adjudicator', blockNumber }),
        readContract({ address: c.token, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [c.roles.payer], blockNumber }),
        coverageId === undefined ? Promise.resolve(undefined) : readContract({ address: c.core, abi: CORE_ABI, functionName: 'coverages', args: [coverageId], blockNumber }),
      ]);
      if (!same(address(coreToken), c.token) || !same(address(adjudicator), c.roles.adjudicator)) err('CLIENT_CONTEXT_MISMATCH');
      let coverage: ClientCoverage | undefined;
      if (coverageId !== undefined) {
        if (!Array.isArray(rawCoverage) || rawCoverage.length < 18) err('CLIENT_RPC_INVALID');
        const [payer, providerId, policyId, , requestHash, gross, premium, withheld, stakeLock, poolReservation,
          openedAt, expiresAt, poolOnlyAllowed, status, , , refundAmount, outcome] = rawCoverage;
        if (typeof payer === 'string' && same(payer, ZERO_ADDRESS)) err('CLIENT_COVERAGE_NOT_FOUND');
        const normalizedPayer = address(payer);
        const normalizedProviderId = id(providerId);
        const normalizedPolicyId = id(policyId);
        if (!same(normalizedPayer, c.roles.payer) || !same(normalizedProviderId, c.providerId) || !same(normalizedPolicyId, c.policyId)) err('CLIENT_COVERAGE_FOREIGN');
        if (!Number.isInteger(status) || status < 0 || status > 5 || !Number.isInteger(outcome) || outcome < 0 || outcome > 2 || typeof poolOnlyAllowed !== 'boolean') err('CLIENT_RPC_INVALID');
        coverage = {
          coverageId: coverageId.toLowerCase() as Hex, payer: normalizedPayer, providerId: normalizedProviderId, policyId: normalizedPolicyId,
          requestHash: id(requestHash), status, outcome, gross: uint(gross), premium: uint(premium), withheld: uint(withheld),
          stakeLock: uint(stakeLock), poolReservation: uint(poolReservation), openedAt: uint(openedAt), expiresAt: uint(expiresAt),
          poolOnlyAllowed, refundAmount: uint(refundAmount),
        };
      }
      const canonical = await getBlock({ blockNumber });
      if (!same(id(canonical?.hash), hash)) err('CLIENT_HEAD_REORGED');
      return { chainId: 84532, core: c.core, token: c.token, payer: c.roles.payer,
        tokenBalanceAtomic: uint(tokenBalance), observedBlock: { number, hash, timestamp }, ...(coverage ? { coverage } : {}) };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CLIENT_')) throw error;
      throw new Error('CLIENT_RPC_UNAVAILABLE');
    }
  };
}
