import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeAbiParameters,
  createPublicClient,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { ECONOMICS, NATIVE_USDC } from '../src/plan.js';
import { checkPublic, MANAGED_TEST_VAULT, type PreflightReader } from '../src/preflight.js';
import type { RunConfig } from '../src/types.js';

const addr = (last: string) => `0x${last.padStart(40, '0')}` as Address;
const id = (last: string) => `0x${last.padStart(64, '0')}` as Hex;
const DOMAIN_TYPE = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));

function domainSeparator(name = 'USDC', version = '2', chainId = 84532, token: Address = NATIVE_USDC): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [DOMAIN_TYPE, keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), token],
  ));
}

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    version: 1,
    mode: 'public',
    chainId: 84532,
    token: NATIVE_USDC,
    roles: { relayer: addr('1'), payer: addr('2'), provider: addr('3'), adjudicator: addr('4') },
    runId: id('1'),
    providerId: id('2'),
    policyId: id('3'),
    serviceId: id('4'),
    resourceUrl: 'http://localhost:43127/assured',
    maxFeePerGas: '100000000',
    maxPriorityFeePerGas: '1000000',
    ...overrides,
  };
}

function client(options: {
  chainId?: number;
  code?: Partial<Record<string, Hex>>;
  balances?: Partial<Record<string, bigint>>;
  payerUsdc?: bigint;
  name?: string;
  version?: string;
  decimals?: number;
  domain?: Hex;
  baseFeePerGas?: bigint | null;
  endBlockHash?: Hex;
  failure?: boolean;
} = {}): PreflightReader {
  const defaultBalances: Record<string, bigint> = {
    [addr('1')]: 703_000_000_000_000n,
    [addr('2')]: 108_000_000_000_000n,
    [addr('3')]: 0n,
    [addr('4')]: 94_000_000_000_000n,
    [addr('5')]: 1_000_000_000_000_000n,
  };
  const input = {
    async getChainId() {
      if (options.failure) throw new Error('secret rpc endpoint detail');
      return options.chainId ?? 84532;
    },
    async getCode({ address, blockNumber }: { address: Address; blockNumber: bigint }) {
      if (options.failure) throw new Error('secret rpc endpoint detail');
      assert.equal(blockNumber, 123n);
      return options.code?.[address] ?? (address === NATIVE_USDC ? '0x6000' : '0x');
    },
    async getBalance({ address, blockNumber }: { address: Address; blockNumber: bigint }) {
      if (options.failure) throw new Error('secret rpc endpoint detail');
      assert.equal(blockNumber, 123n);
      return options.balances?.[address] ?? defaultBalances[address] ?? 0n;
    },
    async getBlock(args?: { blockTag?: 'latest'; blockNumber?: bigint }) {
      if (options.failure) throw new Error('secret rpc endpoint detail');
      if (args?.blockNumber !== undefined) {
        return { number: 123n, hash: options.endBlockHash ?? id('123'), baseFeePerGas: options.baseFeePerGas ?? 5_000_000n };
      }
      return { number: 123n, hash: id('123'), baseFeePerGas: options.baseFeePerGas ?? 5_000_000n };
    },
    async readContract({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) {
      if (options.failure) throw new Error('secret rpc endpoint detail');
      assert.equal(blockNumber, 123n);
      switch (functionName) {
        case 'name': return options.name ?? 'USDC';
        case 'version': return options.version ?? '2';
        case 'decimals': return options.decimals ?? 6;
        case 'DOMAIN_SEPARATOR': return options.domain ?? domainSeparator();
        case 'balanceOf': return options.payerUsdc ?? BigInt(ECONOMICS.allocation);
        default: throw new Error('unexpected function');
      }
    },
  };
  return input as unknown as PreflightReader;
}

test('public check confirms chain, native USDC domain, EOA roles, balances, and bounded fees', async () => {
  const report = await checkPublic({ config: config(), client: client(), vaultAddress: addr('5') });
  assert.equal(report.ok, true);
  assert.equal(report.code, 'ok');
  assert.equal(report.chainId, 84532);
  assert.deepEqual(report.observationBlock, { number: '123', hash: id('123') });
  assert.equal(report.token, NATIVE_USDC);
  assert.deepEqual(report.usdc, {
    codePresent: true,
    name: 'USDC',
    version: '2',
    decimals: 6,
    domainMatches: true,
    payerBalanceAtomic: '43514',
    requiredAtomic: '43514',
    allocationAtomic: '43514',
    sufficient: true,
  });
  assert.equal(report.fees.baseFeePerGasWei, '5000000');
  assert.equal(report.fees.requiredMaxFeePerGasWei, '6000000');
  assert.equal(report.fees.withinCap, true);
  assert.deepEqual(report.roles.relayer, {
    address: addr('1'), codeEmpty: true, balanceWei: '703000000000000',
    targetWei: '703000000000000', shortfallWei: '0', excessWei: '0',
  });
  assert.deepEqual(report.funding.vault, {
    address: addr('5'),
    balanceWei: '1000000000000000',
    requiredWei: '9300000000000',
    shortfallWei: '0',
  });
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('pinned Base Sepolia viem client fits the minimal read-only interface', () => {
  const reader: PreflightReader = createPublicClient({ chain: baseSepolia, transport: http() });
  assert.equal(typeof reader.getChainId, 'function');
});

test('public check rejects wrong chain and invalid local campaign without public reads', async () => {
  const wrong = await checkPublic({ config: config(), client: client({ chainId: 84531 }) });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'wrong_chain');
  assert.equal(wrong.chainId, 84531);

  const local = await checkPublic({
    config: config({ mode: 'local', token: addr('9') }),
    client: client({ failure: true }),
  });
  assert.equal(local.ok, false);
  assert.equal(local.code, 'local_mode_not_public');
  assert.equal(local.chainId, null);
});

test('public check reports insufficient native USDC and native fee balances without exposing RPC details', async () => {
  const report = await checkPublic({
    config: config(),
    client: client({
      payerUsdc: 43_513n,
      balances: { [addr('1')]: 1n },
      baseFeePerGas: 100_000_000n,
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.code, 'insufficient_usdc');
  assert.equal(report.usdc.sufficient, false);
  assert.equal(report.roles.relayer.shortfallWei, '702999999999999');
  assert.equal(report.fees.withinCap, false);
  assert.equal(report.fees.requiredMaxFeePerGasWei, '101000000');

  const failed = await checkPublic({ config: config(), client: client({ failure: true }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'rpc_unavailable');
  assert.equal(JSON.stringify(failed).includes('secret rpc endpoint detail'), false);
});

test('public check rejects token code, metadata, EIP712 domain, and contract-code role mismatches', async () => {
  const noCode = await checkPublic({ config: config(), client: client({ code: { [NATIVE_USDC]: '0x' } }) });
  assert.equal(noCode.code, 'token_code_missing');
  assert.equal(noCode.usdc.codePresent, false);

  const wrongMetadata = await checkPublic({ config: config(), client: client({ version: '1' }) });
  assert.equal(wrongMetadata.code, 'token_metadata_mismatch');

  const wrongDomain = await checkPublic({ config: config(), client: client({ domain: domainSeparator('Wrong Coin') }) });
  assert.equal(wrongDomain.code, 'domain_mismatch');
  assert.equal(wrongDomain.usdc.domainMatches, false);

  const roleContract = await checkPublic({ config: config(), client: client({ code: { [addr('3')]: '0x6000' } }) });
  assert.equal(roleContract.code, 'role_not_eoa');
  assert.equal(roleContract.roles.provider.codeEmpty, false);
});

test('public check rejects excess spending-role ETH and an observation-block hash change', async () => {
  const excess = await checkPublic({ config: config(), client: client({ balances: { [addr('1')]: 703_000_000_000_001n } }) });
  assert.equal(excess.ok, false);
  assert.equal(excess.code, 'native_balance_excess');
  assert.equal(excess.roles.relayer.excessWei, '1');

  const changed = await checkPublic({ config: config(), client: client({ endBlockHash: id('456') }) });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'block_changed');
  assert.deepEqual(changed.observationBlock, { number: '123', hash: id('123') });
});

test('public check rejects aliased roles and invalid vault address as fixed config errors', async () => {
  const aliased = config({ roles: { relayer: addr('1'), payer: addr('1'), provider: addr('3'), adjudicator: addr('4') } });
  const collision = await checkPublic({ config: aliased, client: client() });
  assert.equal(collision.ok, false);
  assert.equal(collision.code, 'config_invalid');

  const vaultCollision = await checkPublic({ config: config(), client: client(), vaultAddress: addr('1') });
  assert.equal(vaultCollision.ok, false);
  assert.equal(vaultCollision.code, 'vault_address_invalid');

  const defaultVault = await checkPublic({ config: config(), client: client() });
  assert.equal(defaultVault.funding.vault?.address, MANAGED_TEST_VAULT);
});
