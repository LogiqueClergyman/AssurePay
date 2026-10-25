import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createClient, type Client } from '../../client-sdk/src/index.js';
import { keccak256, toBytes, type Hex, type LocalAccount } from 'viem';
import { createProtocolRuntime } from '../src/runtime.js';
import { startProtocolProvider } from '../src/provider.js';
import { validateProtocolConfig } from '../src/config.js';
import { TOKEN_ABI } from '../src/abi.js';
import type { ProtocolRuntime, ProtocolServer, ProtocolConfig, Role, ReadSnapshot } from '../src/types.js';
import { createProtocolFixture } from './helpers.js';

export const CONSOLE_ROLES: readonly Role[] = ['admin', 'provider', 'adjudicator', 'operator'];

/** Parse the exact host CLI grammar without touching Anvil or fixture storage. */
export function parseConsoleArgs(args: readonly string[]): Role {
  if (args.length === 0) return 'operator';
  if (args.length !== 2 || args[0] !== '--role' || !CONSOLE_ROLES.includes(args[1] as Role))
    throw Error('CONSOLE_ARGUMENT_INVALID');
  return args[1] as Role;
}

type Counts = { broadcasts: number; payerAuthorizations: number; providerReceipts: number; relayerTransactions: number;
  adminTransactions: number; providerTransactions: number; adjudicatorTransactions: number; serviceRequests: number; claimsFiled: number };
type RpcFault = { enabled: boolean; loseNext: boolean; hiddenHash?: Hex; hideOriginal: boolean };
type FixtureOptions = { role?: Role; startServer?: boolean };

/** Fresh actual M11 Core, M10 payer/provider and one-use original-hash RPC fault proxy. */
export async function createConsoleFixture(options: FixtureOptions = {}) {
  const f = await createProtocolFixture();
  let proxy: Server | undefined;
  let provider: Awaited<ReturnType<typeof startProtocolProvider>> | undefined;
  let client: Client | undefined;
  let runtime: ProtocolRuntime | undefined;
  let server: ProtocolServer | undefined;
  let closed = false;
  const counts: Counts = { broadcasts: 0, payerAuthorizations: 0, providerReceipts: 0, relayerTransactions: 0,
    adminTransactions: 0, providerTransactions: 0, adjudicatorTransactions: 0, serviceRequests: 0, claimsFiled: 0 };
  const fault: RpcFault = { enabled: true, loseNext: false, hideOriginal: true };
  let role: Role = options.role ?? 'operator';

  const proxyHandler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    let request: any;
    try { request = JSON.parse(bytes.toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
    const requests = Array.isArray(request) ? request : [request];
    const blocked = requests.some((rpc: any) => fault.hideOriginal && fault.hiddenHash &&
      ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(rpc.method) && rpc.params?.[0] === fault.hiddenHash);
    if (!fault.enabled || blocked) { res.writeHead(503); res.end(); return; }
    let lose = false;
    for (const rpc of requests) if (rpc.method === 'eth_sendRawTransaction') {
      counts.broadcasts++;
      if (fault.loseNext) {
        fault.loseNext = false;
        const raw = rpc.params?.[0];
        if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) { res.writeHead(502); res.end(); return; }
        fault.hiddenHash = keccak256(raw as Hex);
        lose = true;
      }
    }
    try {
      const upstream = await fetch(f.evm.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes });
      const result = Buffer.from(await upstream.arrayBuffer());
      if (lose) { res.writeHead(503); res.end(); }
      else { res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(result); }
    } catch { res.writeHead(502); res.end(); }
  };

  const wrap = (account: LocalAccount, kind: keyof Omit<Counts, 'broadcasts'>): LocalAccount => ({ ...account,
    async signTransaction(...args: any[]) {
      if (kind.endsWith('Transactions')) counts[kind]++;
      return (account.signTransaction as any)(...args);
    },
    async signTypedData(data: any) {
      if (kind === 'payerAuthorizations' && data?.primaryType === 'ReceiveWithAuthorization') counts.payerAuthorizations++;
      if (kind === 'providerReceipts' && data?.primaryType) counts.providerReceipts++;
      return account.signTypedData(data);
    },
  } as LocalAccount);

  try {
    const rpcServer = createServer(proxyHandler);
    proxy = rpcServer;
    await new Promise<void>((resolve, reject) => {
      rpcServer.once('error', reject); rpcServer.listen(0, '127.0.0.1', resolve);
    });
    const address = rpcServer.address(); assert.ok(address && typeof address !== 'string');
    const rpcUrl = `http://127.0.0.1:${address.port}`;
    const config: ProtocolConfig = validateProtocolConfig({ ...f.config,
      pilot: { ...f.pilotConfig, rpcUrl } });
    const wrapped = {
      admin: wrap(f.accounts.admin, 'adminTransactions'),
      provider: wrap(f.accounts.provider, 'providerTransactions'),
      adjudicator: wrap(f.accounts.adjudicator, 'adjudicatorTransactions'),
      relayer: wrap(f.accounts.relayer, 'relayerTransactions'),
      payer: wrap(f.accounts.payer, 'payerAuthorizations'),
      providerReceipt: wrap(f.accounts.provider, 'providerReceipts'),
    };
    provider = await startProtocolProvider({ config,
      storage: { directory: join(f.directory, 'console-provider'), key: f.keys.provider },
      receiptSigner: wrapped.providerReceipt, relayerAccount: wrapped.relayer,
      handler(body) {
        counts.serviceRequests++;
        if (new TextDecoder().decode(body).startsWith('FAIL')) throw Error('CONTROLLED_LOCAL_SERVICE_FAILURE');
        return Uint8Array.from(body);
      },
    });
    runtime = await createProtocolRuntime({ config, storage: { directory: join(f.directory, 'console-protocol'), key: f.keys.buyer },
      limits: { maxActionAmount: '1000000', maxActions: 64 },
      accounts: { admin: wrapped.admin, provider: wrapped.provider, adjudicator: wrapped.adjudicator } });
    client = await createClient({ config: config.pilot, maxGross: config.pilot.gross,
      budget: { maxTotalGross: (BigInt(config.pilot.gross) * 2n).toString(), maxPayments: 2 },
      storage: { directory: join(f.directory, 'console-client'), key: f.keys.buyer }, payerAccount: wrapped.payer });

    const purchase = async (body: string) => {
      const preview = await client!.preview(toBytes(body));
      const authorized = await client!.authorize(preview.requestId, { approved: true });
      const result = await client!.send(authorized.requestId);
      if (result.state !== 'confirmed') throw Error('CONSOLE_SEED_PAYMENT_UNCONFIRMED');
      return result;
    };
    const active = await purchase('NORMAL');
    const failed = await purchase('FAIL_CONSOLE_CLAIM');
    if (active.status !== 200 || failed.status !== 500) throw Error('CONSOLE_SEED_SERVICE_STATE_INVALID');
    const evidenceBytes = toBytes('Disposable local fixture evidence for the controlled 500 response.');
    const evidenceHash = await client.uploadEvidence(failed.coverageId, evidenceBytes);
    const recoveredEvidence = await client.readEvidence(failed.coverageId, evidenceHash);
    if (Buffer.compare(Buffer.from(evidenceBytes), Buffer.from(recoveredEvidence)) !== 0) throw Error('CONSOLE_SEED_EVIDENCE_INVALID');
    const filed = await client.fileClaim(failed.coverageId, evidenceHash, { approved: true });
    if (filed.status !== 'success') throw Error('CONSOLE_SEED_CLAIM_INVALID');
    counts.claimsFiled++;

    if (options.startServer !== false) await restartServer(role);
    return Object.freeze({
      get role() { return role; },
      get url() { return server?.url; },
      get runtime() { return runtime!; },
      get ids() { return Object.freeze({ active: active.coverageId, claim: failed.coverageId }); },
      get faultState() { return Object.freeze({ hidden: fault.hiddenHash !== undefined && fault.hideOriginal, armed: fault.loseNext }); },
      counters(): Readonly<Counts> { return Object.freeze({ ...counts }); },
      async snapshot(): Promise<ReadSnapshot> { return runtime!.snapshot(); },
      async payerBalance(anchor?: bigint): Promise<bigint> {
        const blockNumber = anchor ?? await f.evm.publicClient.getBlockNumber();
        return f.evm.publicClient.readContract({ address: config.pilot.token, abi: TOKEN_ABI, functionName: 'balanceOf',
          args: [config.pilot.roles.payer], blockNumber });
      },
      async startRole(next: Role): Promise<string> {
        if (!CONSOLE_ROLES.includes(next)) throw Error('CONSOLE_ROLE_INVALID');
        await restartServer(next); return server!.url;
      },
      rpcOff() { fault.enabled = false; },
      rpcOn() { fault.enabled = true; },
      loseNextSend() {
        if (fault.loseNext || (fault.hiddenHash !== undefined && fault.hideOriginal)) throw Error('CONSOLE_FAULT_BUSY');
        fault.hiddenHash = undefined; fault.loseNext = true; fault.hideOriginal = true;
      },
      reveal() { fault.hideOriginal = false; },
      async expirePreview(): Promise<void> {
        await f.evm.publicClient.request({ method: 'evm_increaseTime', params: [121] });
        await f.evm.publicClient.request({ method: 'evm_mine', params: [] });
      },
      async close(): Promise<void> {
        if (closed) return; closed = true;
        await server?.close().catch(() => undefined); server = undefined;
        await runtime?.close().catch(() => undefined); runtime = undefined;
        await client?.close().catch(() => undefined); client = undefined;
        await provider?.close().catch(() => undefined); provider = undefined;
        if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve())); proxy = undefined;
        await f.close();
      },
    });
  } catch (error) {
    await server?.close().catch(() => undefined); await runtime?.close().catch(() => undefined);
    await client?.close().catch(() => undefined); await provider?.close().catch(() => undefined);
    if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
    await f.close(); throw error;
  }

  async function restartServer(nextRole: Role): Promise<void> {
    await server?.close(); server = undefined; role = nextRole;
    // Local console source loads the three fixed application assets; do not pass arbitrary paths.
    const { startProtocolConsole } = await import('../src/console.js');
    server = await startProtocolConsole({ runtime: runtime!, role: nextRole });
  }
}
