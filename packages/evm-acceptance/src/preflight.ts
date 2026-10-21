import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { ECONOMICS, NATIVE_USDC, PUBLIC_CHAIN_ID, budgetSummary, validateConfig } from './plan.js';
import type { Actor, RunConfig } from './types.js';

const TOKEN_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const ACTORS = ['relayer', 'payer', 'provider', 'adjudicator'] as const satisfies readonly Actor[];
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const DOMAIN_NAME = 'USDC';
const DOMAIN_VERSION = '2';
const DOMAIN_TYPE = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
export const MANAGED_TEST_VAULT = '0x7a776d8f819b33f50ef85d37effcb5bdd2714756' as Address;

export interface RolePreflight {
  address: Address;
  codeEmpty: boolean | null;
  balanceWei: string | null;
  targetWei: string;
  shortfallWei: string | null;
  excessWei: string | null;
}

export interface PublicPreflightReport {
  ok: boolean;
  code: string;
  chainId: number | null;
  observationBlock: Readonly<{ number: string; hash: Hex }> | null;
  token: Address;
  roles: Readonly<Record<Actor, RolePreflight>>;
  usdc: Readonly<{
    codePresent: boolean | null;
    name: string | null;
    version: string | null;
    decimals: number | null;
    domainMatches: boolean | null;
    payerBalanceAtomic: string | null;
    requiredAtomic: string;
    allocationAtomic: string;
    sufficient: boolean | null;
  }>;
  fees: Readonly<{
    baseFeePerGasWei: string | null;
    priorityFeePerGasWei: string;
    maxFeePerGasWei: string;
    requiredMaxFeePerGasWei: string | null;
    withinCap: boolean | null;
  }>;
  funding: Readonly<{
    campaignAllowanceWei: string;
    fundingAllowanceWei: string;
    maxCampaignAndFundingWei: string;
    vault?: Readonly<{
      address: Address;
      balanceWei: string | null;
      requiredWei: string;
      shortfallWei: string | null;
    }>;
  }>;
}

export interface CheckPublicOptions {
  config: RunConfig;
  client: PreflightReader;
  vaultAddress?: Address;
}

export interface PreflightReader {
  getChainId(): Promise<number>;
  getBlock(args?: any): Promise<{
    number: bigint | null;
    hash: Hex | null;
    baseFeePerGas?: bigint | null;
  }>;
  getCode(args: any): Promise<Hex | undefined>;
  getBalance(args: any): Promise<bigint>;
  readContract(args: any): Promise<unknown>;
}

function domainSeparator(name: string, version: string, chainId: number, token: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [DOMAIN_TYPE, keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), token],
  ));
}

function normalizedAddress(value: unknown): Address | undefined {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value) || ZERO_ADDRESS.test(value)) return undefined;
  return value.toLowerCase() as Address;
}

function blankRoles(config: RunConfig, targets: Record<Actor, string>): Record<Actor, RolePreflight> {
  return Object.fromEntries(ACTORS.map((actor) => [actor, {
    address: config.roles[actor],
    codeEmpty: null,
    balanceWei: null,
    targetWei: targets[actor],
    shortfallWei: null,
    excessWei: null,
  }])) as Record<Actor, RolePreflight>;
}

function makeReport(
  config: RunConfig,
  code: string,
  chainId: number | null,
  roles: Record<Actor, RolePreflight>,
  budget: ReturnType<typeof budgetSummary>,
  extras: {
    usdc?: Partial<PublicPreflightReport['usdc']>;
    fees?: Partial<PublicPreflightReport['fees']>;
    funding?: { vault?: PublicPreflightReport['funding']['vault'] };
    observationBlock?: Readonly<{ number: string; hash: Hex }> | null;
  } = {},
): PublicPreflightReport {
  return Object.freeze({
    ok: code === 'ok',
    code,
    chainId,
    observationBlock: extras.observationBlock ?? null,
    token: NATIVE_USDC,
    roles: Object.freeze(roles),
    usdc: Object.freeze({
      codePresent: null,
      name: null,
      version: null,
      decimals: null,
      domainMatches: null,
      payerBalanceAtomic: null,
      requiredAtomic: ECONOMICS.allocation,
      allocationAtomic: ECONOMICS.allocation,
      sufficient: null,
      ...extras.usdc,
    }),
    fees: Object.freeze({
      baseFeePerGasWei: null,
      priorityFeePerGasWei: config.maxPriorityFeePerGas,
      maxFeePerGasWei: config.maxFeePerGas,
      requiredMaxFeePerGasWei: null,
      withinCap: null,
      ...extras.fees,
    }),
    funding: Object.freeze({
      campaignAllowanceWei: budget.totalWei,
      fundingAllowanceWei: budget.funding.totalWei,
      maxCampaignAndFundingWei: budget.maxCampaignAndFundingWei,
      ...extras.funding,
    }),
  });
}

/** Performs read-only Base Sepolia checks and returns public metadata only. */
export async function checkPublic(options: CheckPublicOptions): Promise<PublicPreflightReport> {
  let config: RunConfig;
  try {
    config = validateConfig(options.config);
  } catch {
    const invalidConfig = {
      version: 1,
      mode: 'public',
      chainId: PUBLIC_CHAIN_ID,
      token: NATIVE_USDC,
      roles: {
        relayer: '0x0000000000000000000000000000000000000001',
        payer: '0x0000000000000000000000000000000000000002',
        provider: '0x0000000000000000000000000000000000000003',
        adjudicator: '0x0000000000000000000000000000000000000004',
      },
      runId: `0x${'1'.repeat(64)}`,
      providerId: `0x${'2'.repeat(64)}`,
      policyId: `0x${'3'.repeat(64)}`,
      serviceId: `0x${'4'.repeat(64)}`,
      resourceUrl: 'http://localhost:1/assured',
      maxFeePerGas: '100000000',
      maxPriorityFeePerGas: '1000000',
    } as RunConfig;
    const budget = budgetSummary(invalidConfig);
    const targets = Object.fromEntries(ACTORS.map((actor) => [actor, budget.roles[actor].targetWei])) as Record<Actor, string>;
    return makeReport(invalidConfig, 'config_invalid', null, blankRoles(invalidConfig, targets), budget);
  }

  const budget = budgetSummary(config);
  const targets = Object.fromEntries(ACTORS.map((actor) => [actor, budget.roles[actor].targetWei])) as Record<Actor, string>;
  const roles = blankRoles(config, targets);
  if (config.mode !== 'public') return makeReport(config, 'local_mode_not_public', null, roles, budget);

  const vault = normalizedAddress(options.vaultAddress ?? MANAGED_TEST_VAULT);
  if (!vault || vault === NATIVE_USDC || Object.values(config.roles).includes(vault)) {
    return makeReport(config, 'vault_address_invalid', null, roles, budget);
  }

  try {
    const chainId = await options.client.getChainId();
    if (chainId !== PUBLIC_CHAIN_ID) return makeReport(config, 'wrong_chain', chainId, roles, budget);
    const block = await options.client.getBlock({ blockTag: 'latest' });
    if (block.number === null || block.hash === null) {
      return makeReport(config, 'block_unavailable', chainId, roles, budget);
    }
    const blockNumber = block.number;
    const observationBlock = Object.freeze({ number: blockNumber.toString(), hash: block.hash });

    const [tokenCode, tokenName, tokenVersion, decimals, actualDomain, payerBalance, ...codeAndBalances] = await Promise.all([
      options.client.getCode({ address: NATIVE_USDC, blockNumber }),
      options.client.readContract({ address: NATIVE_USDC, abi: TOKEN_ABI, functionName: 'name', blockNumber }),
      options.client.readContract({ address: NATIVE_USDC, abi: TOKEN_ABI, functionName: 'version', blockNumber }),
      options.client.readContract({ address: NATIVE_USDC, abi: TOKEN_ABI, functionName: 'decimals', blockNumber }),
      options.client.readContract({ address: NATIVE_USDC, abi: TOKEN_ABI, functionName: 'DOMAIN_SEPARATOR', blockNumber }),
      options.client.readContract({ address: NATIVE_USDC, abi: TOKEN_ABI, functionName: 'balanceOf', args: [config.roles.payer], blockNumber }),
      ...ACTORS.flatMap((actor) => [
        options.client.getCode({ address: config.roles[actor], blockNumber }),
        options.client.getBalance({ address: config.roles[actor], blockNumber }),
      ]),
      options.client.getBalance({ address: vault, blockNumber }),
    ]);

    const baseFee = block.baseFeePerGas;
    const requiredFee = baseFee === null || baseFee === undefined
      ? null
      : baseFee + BigInt(config.maxPriorityFeePerGas);
    ACTORS.forEach((actor, index) => {
      const code = codeAndBalances[index * 2] as Hex | undefined;
      const balance = codeAndBalances[index * 2 + 1] as bigint;
      roles[actor] = {
        address: config.roles[actor],
        codeEmpty: !code || code === '0x',
        balanceWei: balance.toString(),
        targetWei: targets[actor],
        shortfallWei: balance < BigInt(targets[actor]) ? (BigInt(targets[actor]) - balance).toString() : '0',
        excessWei: balance > BigInt(targets[actor]) ? (balance - BigInt(targets[actor])).toString() : '0',
      };
    });

    const payerUsdc = BigInt(payerBalance as bigint);
    const metadataName = typeof tokenName === 'string' ? tokenName : null;
    const metadataVersion = typeof tokenVersion === 'string' ? tokenVersion : null;
    const tokenDecimals = typeof decimals === 'number' ? decimals : null;
    const domainMatches = typeof actualDomain === 'string' &&
      actualDomain.toLowerCase() === domainSeparator(DOMAIN_NAME, DOMAIN_VERSION, PUBLIC_CHAIN_ID, NATIVE_USDC).toLowerCase();
    const checks: string[] = [];
    if (!tokenCode || tokenCode === '0x') checks.push('token_code_missing');
    if (ACTORS.some((actor) => !roles[actor].codeEmpty)) checks.push('role_not_eoa');
    if (metadataName !== DOMAIN_NAME || metadataVersion !== DOMAIN_VERSION || tokenDecimals !== 6) checks.push('token_metadata_mismatch');
    if (!domainMatches) checks.push('domain_mismatch');
    if (payerUsdc < BigInt(ECONOMICS.allocation)) checks.push('insufficient_usdc');
    if (requiredFee === null) checks.push('base_fee_unavailable');
    else if (requiredFee > BigInt(config.maxFeePerGas)) checks.push('fee_cap_insufficient');
    const spendingActors = ['relayer', 'payer', 'adjudicator'] as const;
    if (spendingActors.some((actor) => BigInt(roles[actor].shortfallWei ?? '0') > 0n)) checks.push('native_balance_insufficient');
    if (spendingActors.some((actor) => BigInt(roles[actor].excessWei ?? '0') > 0n)) checks.push('native_balance_excess');

    let fundingVault: PublicPreflightReport['funding']['vault'];
    const vaultBalance = codeAndBalances[ACTORS.length * 2] as bigint;
    const roleTopUps = spendingActors.reduce((sum, actor) => sum + BigInt(roles[actor].shortfallWei ?? '0'), 0n);
    const requiredWei = roleTopUps + BigInt(budget.funding.totalWei);
    fundingVault = Object.freeze({
      address: vault,
      balanceWei: vaultBalance.toString(),
      requiredWei: requiredWei.toString(),
      shortfallWei: vaultBalance < requiredWei ? (requiredWei - vaultBalance).toString() : '0',
    });

    const finalBlock = await options.client.getBlock({ blockNumber });
    if (finalBlock.hash === null || finalBlock.hash.toLowerCase() !== block.hash.toLowerCase()) {
      return makeReport(config, 'block_changed', chainId, roles, budget, {
        observationBlock,
        usdc: {
          codePresent: !!tokenCode && tokenCode !== '0x',
          name: metadataName,
          version: metadataVersion,
          decimals: tokenDecimals,
          domainMatches,
          payerBalanceAtomic: payerUsdc.toString(),
          requiredAtomic: ECONOMICS.allocation,
          allocationAtomic: ECONOMICS.allocation,
          sufficient: payerUsdc >= BigInt(ECONOMICS.allocation),
        },
        fees: {
          baseFeePerGasWei: baseFee?.toString() ?? null,
          priorityFeePerGasWei: config.maxPriorityFeePerGas,
          maxFeePerGasWei: config.maxFeePerGas,
          requiredMaxFeePerGasWei: requiredFee?.toString() ?? null,
          withinCap: requiredFee !== null && requiredFee <= BigInt(config.maxFeePerGas),
        },
        funding: { vault: fundingVault },
      });
    }

    const code = checks[0] ?? 'ok';
    return makeReport(config, code, chainId, roles, budget, {
      usdc: {
        codePresent: !!tokenCode && tokenCode !== '0x',
        name: metadataName,
        version: metadataVersion,
        decimals: tokenDecimals,
        domainMatches,
        payerBalanceAtomic: payerUsdc.toString(),
        requiredAtomic: ECONOMICS.allocation,
        allocationAtomic: ECONOMICS.allocation,
        sufficient: payerUsdc >= BigInt(ECONOMICS.allocation),
      },
      fees: {
        baseFeePerGasWei: baseFee?.toString() ?? null,
        priorityFeePerGasWei: config.maxPriorityFeePerGas,
        maxFeePerGasWei: config.maxFeePerGas,
        requiredMaxFeePerGasWei: requiredFee?.toString() ?? null,
        withinCap: requiredFee !== null && requiredFee <= BigInt(config.maxFeePerGas),
      },
      funding: fundingVault ? { vault: fundingVault } : {},
      observationBlock,
    });
  } catch {
    return makeReport(config, 'rpc_unavailable', null, roles, budget);
  }
}
