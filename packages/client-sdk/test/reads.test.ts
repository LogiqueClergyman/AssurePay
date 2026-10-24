import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { createStateReader } from '../src/reads.js';
import type { ClientConfig } from '../src/types.js';

const id = (n: string): Hex => `0x${n.repeat(64)}`;
const addr = (n: string): Address => `0x${n.repeat(40)}`;
const checksum = (value: Address): Address => `0x${value.slice(2).toUpperCase()}`;
const config: ClientConfig = { version: 1, mode: 'local', chainId: 84532, rpcUrl: 'http://127.0.0.1:8545', core: addr('a'), token: addr('b'),
  providerId: id('1'), policyId: id('2'), serviceId: id('3'), roles: { payer: addr('3'), relayer: addr('4'), provider: addr('5'), adjudicator: addr('6') },
  resourceUrl: 'http://127.0.0.1:8081/', claimsUrl: 'http://127.0.0.1:8082', deploymentBlock: '1', gross: '100' };
const block = { number: 99n, hash: id('a'), timestamp: 1000n };
function rpc(overrides: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const client = {
    getChainId: async () => 84532,
    getBlock: async (args: any) => args.blockTag === 'latest' ? block : ({ ...block, ...(overrides.canonicalHash ? { hash: overrides.canonicalHash } : {}) }),
    readContract: async (args: any) => {
      calls.push(args);
      if (args.functionName === 'token') return overrides.token ?? checksum(config.token);
      if (args.functionName === 'adjudicator') return overrides.adjudicator ?? checksum(config.roles.adjudicator);
      if (args.functionName === 'balanceOf') return 123456n;
      return [checksum(config.roles.payer), config.providerId, config.policyId, id('4'), id('5'), 100n, 10n, 2n, 30n, 58n, 900n, 2000n, true, 1, id('0'), id('0'), 0n, 0];
    },
  };
  return { client: Object.assign(client, overrides.client as object), calls };
}

describe('canonical payer state reads', () => {
  it('pins configured context, balance and own coverage to one numbered head', async () => {
    const { client, calls } = rpc();
    const result = await createStateReader(config, client)(id('7'));
    assert.equal(result.tokenBalanceAtomic, '123456');
    assert.equal(result.observedBlock.number, '99');
    assert.equal(result.coverage?.gross, '100');
    assert.equal(result.coverage?.refundAmount, '0');
    assert.ok(calls.filter((c) => c.functionName !== 'balanceOf').every((c) => c.blockNumber === 99n));
    assert.equal('evidenceHash' in (result.coverage as object), false);
    assert.equal('decisionHash' in (result.coverage as object), false);
  });
  it('rejects foreign coverage, configured context drift, wrong chain, reorg and RPC failure', async () => {
    const foreign = rpc();
    foreign.client.readContract = async (args: any) => args.functionName === 'coverages'
      ? [addr('8'), config.providerId, config.policyId, id('4'), id('5'), 100n, 10n, 2n, 30n, 58n, 900n, 2000n, true, 1, id('0'), id('0'), 0n, 0]
      : args.functionName === 'token' ? config.token : args.functionName === 'adjudicator' ? config.roles.adjudicator : 1n;
    await assert.rejects(createStateReader(config, foreign.client)(id('7')), { message: 'CLIENT_COVERAGE_FOREIGN' });
    await assert.rejects(createStateReader(config, rpc({ token: addr('9') }).client)(), { message: 'CLIENT_CONTEXT_MISMATCH' });
    const wrongChain = rpc(); wrongChain.client.getChainId = async () => 1;
    await assert.rejects(createStateReader(config, wrongChain.client)(), { message: 'CLIENT_CHAIN_MISMATCH' });
    await assert.rejects(createStateReader(config, rpc({ canonicalHash: id('b') }).client)(), { message: 'CLIENT_HEAD_REORGED' });
    const failed = rpc(); failed.client.readContract = async () => { throw new Error('private rpc detail'); };
    await assert.rejects(createStateReader(config, failed.client)(), { message: 'CLIENT_RPC_UNAVAILABLE' });
    const unknownStatus = rpc(); unknownStatus.client.readContract = async (args: any) => args.functionName === 'coverages'
      ? [config.roles.payer, config.providerId, config.policyId, id('4'), id('5'), 100n, 10n, 2n, 30n, 58n, 900n, 2000n, true, 6, id('0'), id('0'), 0n, 0]
      : args.functionName === 'token' ? config.token : args.functionName === 'adjudicator' ? config.roles.adjudicator : 1n;
    await assert.rejects(createStateReader(config, unknownStatus.client)(id('7')), { message: 'CLIENT_RPC_INVALID' });
    const noCoverage = rpc(); noCoverage.client.readContract = async (args: any) => args.functionName === 'coverages'
      ? [addr('0'), id('0'), id('0'), id('0'), id('0'), 0n, 0n, 0n, 0n, 0n, 0n, 0n, false, 0, id('0'), id('0'), 0n, 0]
      : args.functionName === 'token' ? config.token : args.functionName === 'adjudicator' ? config.roles.adjudicator : 1n;
    await assert.rejects(createStateReader(config, noCoverage.client)(id('7')), { message: 'CLIENT_COVERAGE_NOT_FOUND' });
    const oversized = rpc(); oversized.client.readContract = async (args: any) => args.functionName === 'balanceOf'
      ? 1n << 256n : args.functionName === 'token' ? config.token : args.functionName === 'adjudicator' ? config.roles.adjudicator : 1n;
    await assert.rejects(createStateReader(config, oversized.client)(), { message: 'CLIENT_RPC_INVALID' });
  });
});
