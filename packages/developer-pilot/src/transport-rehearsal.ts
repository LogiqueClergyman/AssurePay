import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect as connectTls } from 'node:tls';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, keccak256 } from 'viem';
import { createPilotFixture, freePort } from '../test/helpers.js';
import { contextFor, trustFor } from './config.js';
import { createBuyer, type Buyer } from './buyer.js';
import { createLocalTls, createTrustedFetch, startLocalIngress } from './local-https.js';
import { EncryptedVault, createResultStore, contextNamespace } from '../../claims-backend/src/index.js';
import { readTerms, isServiceAdmissible } from '../../x402-assurance/src/chain.js';
import { startProvider } from '../../x402-assurance/src/http-provider.js';
import { createSettlementEngine } from '../../x402-assurance/src/engine.js';
import { prepareCall, hashRequest } from '../../x402-assurance/src/protocol.js';
import { CORE_ABI } from '../../x402-assurance/src/core-abi.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Isolated local transport proof; it never loads an existing deployment or wallet. */
export async function runTransportRehearsal() {
  const f = await createPilotFixture();
  let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  let ingress: Awaited<ReturnType<typeof startLocalIngress>> | undefined;
  let buyer: Buyer | undefined;
  const counts = {relayerSignatures: 0, broadcasts: 0, handlers: 0, receiptSignatures: 0};
  let rpcUnavailable = false;
  const client = new Proxy(f.evm.publicClient, {get(target, property) {
    if (property === 'sendRawTransaction') return async (args: any) => { counts.broadcasts++; return target.sendRawTransaction(args); };
    if (property === 'getTransaction') return async (args: any) => { if (rpcUnavailable) throw Error('LOCAL_REHEARSAL_RPC_UNAVAILABLE'); return target.getTransaction(args); };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  }});
  async function command(mode: 'purchase' | 'retrieve', configPath: string, finalArg: string) {
    const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, PILOT_DATA_KEY: f.keys.buyer.toString('hex')};
    if (mode === 'purchase') env.PILOT_PAYER_PRIVATE_KEY = f.roleKeys.payer;
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/transport-buyer.ts', mode, configPath, join(f.directory, 'buyer'), finalArg],
      {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderrBytes = 0;
    child.stdout!.on('data', chunk => { stdout += chunk; if (stdout.length > 32_768) child.kill('SIGKILL'); });
    child.stderr!.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 32_768) child.kill('SIGKILL'); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
    let code;
    try { [code] = await once(child, 'exit'); } finally { clearTimeout(timeout); }
    let rows: any[];
    try { rows = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { throw Error('TRANSPORT_BUYER_OUTPUT'); }
    if (code !== 0) {
      const fixed = rows.at(-1)?.code;
      if (typeof fixed === 'string' && /^[A-Z][A-Z0-9_]{0,90}$/.test(fixed)) throw Error(fixed);
      throw Error('TRANSPORT_BUYER_PROCESS_FAILED');
    }
    if (stderrBytes || !rows.length) throw Error('TRANSPORT_BUYER_PROCESS_FAILED');
    return rows;
  }
  try {
    const tlsDirectory = join(f.directory, 'tls');
    await mkdir(tlsDirectory, {mode: 0o700});
    const tls = await createLocalTls(tlsDirectory);
    const listen = new URL(f.config.resourceUrl);
    let port = await freePort(); while (port === Number(listen.port)) port = await freePort();
    const resourceUrl = `https://127.0.0.1:${port}/service`;
    const listenUrl = listen.origin + '/';
    const terms = await readTerms(client, trustFor(f.config), f.config.gross);
    const paymentPath = join(f.directory, 'transport-payments.json');
    const providerPath = join(f.directory, 'transport-service.jsonl');
    const resultStore = (missing = false) => createResultStore(new EncryptedVault({directory: join(f.directory, missing ? 'missing-objects' : 'objects'),
      namespace: contextNamespace(contextFor(f.config)), keyId: 'transport-v1', key: f.keys.provider}));
    async function start(readOnly: boolean, missingArchive = false) {
      const engine = createSettlementEngine({client, terms, relayer: f.config.roles.relayer, journalPath: paymentPath,
        ...(readOnly ? {} : {wallet: {...f.evm.walletClient, async signTransaction(args: any) { counts.relayerSignatures++; return f.evm.walletClient.signTransaction(args); }}, account: f.accounts.relayer}),
        gasLimit: 800_000n, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n, polls: 5, delay: 0});
      return startProvider({terms, engine, resourceUrl, listenUrl, journalPath: providerPath, resultStore: resultStore(missingArchive),
        signer: {address: f.accounts.provider.address, async signTypedData(data) {
          counts.receiptSignatures++; if (readOnly) throw Error('RETRIEVAL_CANNOT_SIGN_RECEIPT'); return f.accounts.provider.signTypedData(data);
        }}, handler: body => { counts.handlers++; if (readOnly) throw Error('RETRIEVAL_CANNOT_EXECUTE'); return body; },
        canServe: call => isServiceAdmissible(client, terms, call), prepareCall: (payment, requestHash) => prepareCall(payment, terms, requestHash, 0n, {allowExpired: true})});
    }
    provider = await start(false);
    ingress = await startLocalIngress({certPath: tls.certPath, keyPath: tls.keyPath, port, upstream: listenUrl});
    assert.equal(ingress.url, `https://127.0.0.1:${port}`);
    const configPath = join(f.directory, 'transport-config.json'), bodyPath = join(f.directory, 'request.bin');
    const body = new Uint8Array([0, 255, 1, 128, 0, 65, 10]);
    await writeFile(configPath, JSON.stringify({config: f.config, resourceUrl, certPath: tls.certPath}), {flag: 'wx', mode: 0o600});
    await writeFile(bodyPath, body, {flag: 'wx', mode: 0o600});
    const purchased = await command('purchase', configPath, bodyPath);
    const prepared = purchased.find(row => row.code === 'TRANSPORT_BUYER_PREPARED');
    const paid = purchased.find(row => row.code === 'TRANSPORT_BUYER_RESULT');
    assert.ok(prepared && paid); assert.equal(paid.status, 200); assert.equal(paid.signatures, 1); assert.equal(paid.bodyHash, keccak256(body));
    const expectedRequest = hashRequest('POST', resourceUrl, 'application/octet-stream', body, prepared.requestId);
    assert.equal(prepared.requestHash, expectedRequest);
    assert.deepEqual(counts, {relayerSignatures: 1, broadcasts: 1, handlers: 1, receiptSignatures: 1});
    const paidCounts = {...counts};
    const nonce = await client.getTransactionCount({address: f.config.roles.relayer});
    await provider.close(); provider = await start(true);
    const restored = (await command('retrieve', configPath, prepared.requestId)).at(-1);
    assert.equal(restored.status, 200); assert.equal(restored.signatures, 0); assert.equal(restored.bodyHash, paid.bodyHash); assert.equal(restored.transaction, paid.transaction);
    assert.deepEqual(counts, paidCounts); assert.equal(await client.getTransactionCount({address: f.config.roles.relayer}), nonce);

    const trusted = createTrustedFetch(tls.cert, new URL(resourceUrl).origin);
    let original: RequestInit | undefined;
    const buyerOptions = {binding: {url: resourceUrl, trust: trustFor(f.config), maxGross: f.config.gross, payer: f.config.roles.payer},
      directory: join(f.directory, 'buyer'), key: f.keys.buyer, client, relayer: f.config.roles.relayer};
    buyer = await createBuyer({...buyerOptions, fetch: async (input, init) => {
      original = {...init, headers: new Headers(init?.headers)};
      const headers = new Headers(init?.headers); headers.set('forwarded', 'host=other.invalid;proto=http'); headers.set('x-forwarded-host', 'other.invalid'); headers.set('x-forwarded-proto', 'http');
      return trusted(input, {...init, headers});
    }});
    assert.deepEqual((await buyer.retrieve(prepared.requestId)).body, body);
    assert.ok(original);
    const originalHeaders = new Headers(original.headers);
    const invalidHost = new Headers(originalHeaders); invalidHost.set('host', 'other.invalid');
    const wrongHostStatus = await new Promise<number>((resolve, reject) => {
      // TLS authenticates the pinned IP; raw HTTP independently tests a false Host.
      const socket = connectTls({host: '127.0.0.1', port, ca: tls.cert, rejectUnauthorized: true});
      let response = '';
      socket.setTimeout(10_000, () => socket.destroy(Error('TRANSPORT_HOST_TEST_TIMEOUT')));
      socket.once('secureConnect', () => {
        const fields = [...invalidHost].map(([name, value]) => `${name}: ${value}`).join('\r\n');
        socket.write(`POST /service HTTP/1.1\r\n${fields}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
        socket.write(body);
      });
      socket.on('data', bytes => { response += bytes.toString('latin1'); if (response.length > 32_768) socket.destroy(); });
      socket.once('error', () => reject(Error('TRANSPORT_HOST_TEST_FAILED')));
      socket.once('end', () => { const match = /^HTTP\/1\.1 ([0-9]{3}) /.exec(response); if (match) resolve(Number(match[1])); else reject(Error('TRANSPORT_HOST_TEST_FAILED')); });
    });
    assert.equal(wrongHostStatus, 400);
    assert.equal((await trusted(`${new URL(resourceUrl).origin}/wrong`, original)).status, 404);
    assert.equal((await trusted(resourceUrl, {...original, body: Buffer.from([9, 8, 7])})).status, 402);
    const badFinancial = new Headers(originalHeaders); badFinancial.set('payment-signature', 'invalid');
    assert.equal((await trusted(resourceUrl, {...original, headers: badFinancial})).status, 400);
    rpcUnavailable = true;
    await assert.rejects(() => buyer!.retrieve(prepared.requestId), /MISSING_PAID_RESPONSE_PROOF/);
    rpcUnavailable = false;
    await provider.close(); provider = await start(true, true);
    await assert.rejects(() => buyer!.retrieve(prepared.requestId), /MISSING_PAID_RESPONSE_PROOF/);
    await provider.close(); provider = undefined;
    await rename(paymentPath, paymentPath + '.saved');
    try {
      provider = await start(true);
      await assert.rejects(() => buyer!.retrieve(prepared.requestId), /MISSING_PAID_RESPONSE_PROOF/);
      await provider.close(); provider = undefined;
    } finally { await rename(paymentPath + '.saved', paymentPath); }
    provider = await start(true);
    assert.deepEqual((await buyer.retrieve(prepared.requestId)).body, body);
    assert.deepEqual(counts, paidCounts); assert.equal(await client.getTransactionCount({address: f.config.roles.relayer}), nonce);

    const receipt = await client.getTransactionReceipt({hash: paid.transaction});
    const tx = await client.getTransaction({hash: paid.transaction});
    assert.equal(receipt.status, 'success'); assert.equal((await client.getBlock({blockNumber: receipt.blockNumber})).hash, receipt.blockHash);
    assert.equal(tx.from.toLowerCase(), f.config.roles.relayer); assert.equal(tx.to.toLowerCase(), f.config.core);
    const decoded = decodeFunctionData({abi: CORE_ABI, data: tx.input});
    assert.equal(decoded.functionName, 'settleAssured'); assert.equal((decoded.args![0] as any).requestHash, expectedRequest);
    const coverage = await client.readContract({address: f.config.core, abi: f.artifacts.AssuranceCore.abi, functionName: 'coverages', args: [prepared.coverageId]});
    assert.equal(coverage[0].toLowerCase(), f.config.roles.payer); assert.equal(coverage[4], expectedRequest); assert.equal(coverage[5], BigInt(f.config.gross)); assert.equal(Number(coverage[13]), 1);
    const state: Record<string, string> = {};
    for (const name of ['totalProviderStake', 'poolAssets', 'totalLockedStake', 'totalPoolReserved', 'activeCoverageCount', 'coverageCount'])
      state[name] = String(await client.readContract({address: f.config.core, abi: f.artifacts.AssuranceCore.abi, functionName: name}));
    const coreAssets = await client.readContract({address: f.config.token, abi: f.artifacts.AuthorizationTokenMock.abi, functionName: 'balanceOf', args: [f.config.core]});
    assert.equal(coreAssets, BigInt(state.totalProviderStake!) + BigInt(state.poolAssets!));
    assert.equal(state.totalLockedStake, terms.stakeLock); assert.equal(state.totalPoolReserved, terms.poolReservation); assert.equal(state.activeCoverageCount, '1'); assert.equal(state.coverageCount, '1');
    return {ok: true, code: 'LOCAL_HTTPS_TRANSPORT_VERIFIED', chainId: 84532, tokenKind: 'LOCAL_ERC3009_FIXTURE',
      core: f.config.core, requestId: prepared.requestId, coverageId: prepared.coverageId, requestHash: expectedRequest, bodyHash: paid.bodyHash,
      transaction: paid.transaction, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
      paidStatus: 200, retrievedStatus: 200, providerRestart: true, providerProcessRestart: false, buyerProcessRestart: true, tlsVerified: true,
      payerSignatures: paid.signatures, retrievalPayerSignatures: restored.signatures, counts: {...counts}, retrievalCountsUnchanged: true,
      forwardedIdentityUnchanged: true, negativeRetrievalsDidNotSettle: true, solvencyEquality: true, coreAssetsAtomic: String(coreAssets), state,
      limits: {localOnly: true, publicNativeUsdcProof: false, hostedAvailability: false, finality: false}};
  } finally {
    await buyer?.close().catch(() => undefined);
    await ingress?.close().catch(() => undefined);
    await provider?.close().catch(() => undefined);
    await f.close();
  }
}
