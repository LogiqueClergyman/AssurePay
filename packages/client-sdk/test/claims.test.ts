import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPayerClaims } from '../src/claims.js';
import type { ClientConfig } from '../src/types.js';

const id = (n: string): Hex => `0x${n.repeat(64)}`;
const addr = (n: string): Address => `0x${n.repeat(40)}`;
const config: ClientConfig = { version: 1, mode: 'local', chainId: 84532, rpcUrl: 'http://127.0.0.1:8545', core: addr('1'), token: addr('2'),
  providerId: id('1'), policyId: id('2'), serviceId: id('3'), roles: { payer: addr('3'), relayer: addr('4'), provider: addr('5'), adjudicator: addr('6') },
  resourceUrl: 'http://127.0.0.1:8081/', claimsUrl: 'http://127.0.0.1:8082', deploymentBlock: '1', gross: '100' };
const ownState = { observedBlock: { timestamp: '1000' }, coverage: { status: 1, expiresAt: '2000' } };

describe('payer claims facade', () => {
  it('fails closed before auth when signer or explicit literal approval is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'client-claims-'));
    try {
      let reads = 0;
      const api = createPayerClaims({ config, client: {}, directory: dir, readState: async () => { reads++; return ownState; } });
      await assert.rejects(api.uploadEvidence(id('7'), new Uint8Array([1])), { message: 'CLIENT_SIGNER_REQUIRED' });
      await assert.rejects(api.fileClaim(id('7'), id('8'), { approved: false } as any), { message: 'CLIENT_APPROVAL_REQUIRED' });
      await assert.rejects(api.fileClaim(id('7'), id('8'), { approved: true, extra: true } as any), { message: 'CLIENT_APPROVAL_REQUIRED' });
      assert.equal(reads, 1);
      assert.deepEqual(await api.reconcileClaims(), []);
      await api.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('checks own active unexpired coverage and evidence size before attempting authorization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'client-claims-'));
    try {
      const account: any = { address: config.roles.payer, signTypedData: async () => { throw new Error('must not sign'); } };
      let state: any = { observedBlock: { timestamp: '2000' }, coverage: { status: 1, expiresAt: '2000' } };
      const api = createPayerClaims({ config, client: {}, account, directory: dir, readState: async () => state });
      await assert.rejects(api.uploadEvidence(id('7'), new Uint8Array(65_537)), { message: 'CLIENT_EVIDENCE_SIZE' });
      await assert.rejects(api.uploadEvidence(id('7'), new Uint8Array([1])), { message: 'CLIENT_CLAIM_STATE' });
      state = { observedBlock: { timestamp: '1000' }, coverage: { status: 2, expiresAt: '2000' } };
      await assert.rejects(api.fileClaim(id('7'), id('8'), { approved: true }), { message: 'CLIENT_CLAIM_STATE' });
      await api.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
