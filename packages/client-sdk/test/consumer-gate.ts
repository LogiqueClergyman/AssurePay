import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, keccak256, parseTransaction, toBytes, toFunctionSelector, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPilotFixture } from '../../developer-pilot/test/helpers.js';
import { CORE_ABI } from '../../x402-assurance/src/core-abi.js';
import { transact } from '../../evm-core/test/helpers/evm.js';
import { verifyFirstClientSettlement, verifyClientAccounting } from './financial-proof.js';
import { verifyPayerClaim } from './claim-proof.js';
import { CORE_ABI as CLAIMS_CORE_ABI } from '../../claims-backend/src/abi.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const exampleDir = fileURLToPath(new URL('../../../examples/assured-client/', import.meta.url));
const workerSource = fileURLToPath(new URL('./consumer-worker.mjs', import.meta.url));
const providerPackageDir = fileURLToPath(new URL('../../provider-sdk/', import.meta.url));
const providerExampleDir = fileURLToPath(new URL('../../../examples/data-profile-service/', import.meta.url));
const utf8 = (value: string) => new TextEncoder().encode(value);

async function seedModuleTree(project: string, names: string[]): Promise<void> {
  const seen = new Set<string>();
  const copyModule = async (name: string): Promise<void> => {
    if (seen.has(name)) return;
    seen.add(name);
    const source = join(packageDir, 'node_modules', name), destination = join(project, 'node_modules', name);
    await mkdir(join(destination, '..'), { recursive: true });
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    await cp(source, destination, { recursive: true, dereference: true });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyModule(dependency);
  };
  for (const name of names) await copyModule(name);
}

async function installOutside(root: string): Promise<string> {
  const packedDir = join(root, 'packed'), project = join(root, 'consumer');
  const npmEnv = { PATH: process.env.PATH!, NPM_CONFIG_CACHE: join(root, 'npm-cache') };
  await mkdir(packedDir, { recursive: true }); await mkdir(project, { recursive: true });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', packedDir, '--ignore-scripts'], {
    cwd: packageDir, encoding: 'utf8', env: npmEnv,
  })) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const expected = ['README.md', 'dist/index.d.ts', 'dist/index.js', 'dist/types.d.ts', 'package.json', 'skill/assurepay-client/SKILL.md'].sort();
  assert.deepEqual(packed[0]?.files.map(file => file.path).sort(), expected);
  const tarball = join(packedDir, packed[0]!.filename);
  const providerPacked = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', packedDir, '--ignore-scripts'], {
    cwd: providerPackageDir, encoding: 'utf8', env: npmEnv,
  })) as Array<{ filename: string }>;
  const providerTarball = join(packedDir, providerPacked[0]!.filename);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'assurepay-client-consumer-gate', private: true, type: 'module' }));
  await seedModuleTree(project, ['viem', '@x402/core']);
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball, providerTarball], {
    cwd: project, encoding: 'utf8', env: npmEnv,
  });
  await seedModuleTree(project, ['@types/node', 'typescript']);
  await cp(join(exampleDir, 'src'), join(project, 'client-example'), { recursive: true });
  await cp(join(providerExampleDir, 'src'), join(project, 'provider-example'), { recursive: true });
  await cp(workerSource, join(project, 'consumer-worker.mjs'));
  return project;
}

function run(project: string, mode: string, env: Record<string, string>, args: string[] = []): Promise<any> {
  const safeEnv = { PATH: process.env.PATH!, ...env };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['consumer-worker.mjs', mode, ...args], { cwd: project, env: safeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLIENT_CONSUMER_${mode.toUpperCase()}_TIMEOUT`)); }, 120_000);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; }); child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`CLIENT_CONSUMER_${mode.toUpperCase()}_FAILED:${stderr.slice(-1000)}`));
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)); }
      catch { reject(new Error(`CLIENT_CONSUMER_${mode.toUpperCase()}_OUTPUT_INVALID:${stderr.slice(-500)}`)); }
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('CLIENT_GATE_LISTEN_FAILED'));
      server.off('error', reject); resolve(address.port);
    });
  });
}

function waitReady(child: ReturnType<typeof spawn>, expectedMode = 'settlement-enabled'): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLIENT_GATE_PROVIDER_START_TIMEOUT')); }, 20_000);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline >= 0) {
        try { const ready = JSON.parse(stdout.slice(0, newline)); if (ready.mode !== expectedMode) throw new Error(); clearTimeout(timer); resolve(); }
        catch { clearTimeout(timer); reject(new Error('CLIENT_GATE_PROVIDER_READY_INVALID')); }
      }
    });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => { clearTimeout(timer); if (code !== null && code !== 0) reject(new Error(`CLIENT_GATE_PROVIDER_EXIT_${code}:${stderr.slice(-500)}`)); });
  });
}

async function stopProvider(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLIENT_GATE_PROVIDER_STOP_TIMEOUT')); }, 10_000);
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('CLIENT_GATE_PROVIDER_STOP_FAILED')); });
  });
}

async function assertRootOnly(project: string): Promise<void> {
  const sdk = await import(join(project, 'node_modules/@assurepay/client-sdk/dist/index.js'));
  for (const name of ['validateClientConfig', 'readClientConfig', 'createClient', 'clientErrorCode', 'createAgentTools']) assert.equal(typeof sdk[name], 'function');
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', "await import('@assurepay/client-sdk/dist/client.js')"], { cwd: project, stdio: 'pipe' }),
    (error: any) => String(error.stderr).includes('ERR_PACKAGE_PATH_NOT_EXPORTED'));
  const types = join(project, 'consumer.ts');
  await writeFile(types, `import { createClient, createAgentTools, type ClientOptions, type ClientPreview } from '@assurepay/client-sdk';\n` +
    `declare const options: ClientOptions; declare const preview: ClientPreview; void createClient(options); void preview.requestId;\n` +
    `// @ts-expect-error signing is tied to LocalAccount, never a caller generic wallet\nvoid createClient({ ...options, payerAccount: { address: options.config.roles.payer, signTypedData() { return '0x'; } } });\n` +
    `// @ts-expect-error no arbitrary provider/RPC client injection\nvoid createClient({ ...options, client: {} });\n` +
    `// @ts-expect-error approval must be literal true\nvoid (null as any as import('@assurepay/client-sdk').Client).authorize(preview.requestId, { approved: false });\n` +
    `void createAgentTools;\n`);
  execFileSync(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', types], { cwd: project, stdio: 'inherit' });
  const example = join(project, 'client-example/index.mjs');
  execFileSync(process.execPath, ['--check', example], { cwd: project, stdio: 'pipe' });
  execFileSync(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '--allowJs', '--checkJs', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', example], { cwd: project, stdio: 'inherit' });
}

/** Outside-repository tarball consumer with fresh process recovery and local EVM/claims proof. */
export async function runClientConsumerGate(): Promise<Record<string, unknown>> {
  const fixture = await createPilotFixture();
  const root = await mkdtemp(join(tmpdir(), 'assurepay-m10-consumer-'));
  let provider: ReturnType<typeof spawn> | undefined;
  let rpcProxy: Server | undefined;
  try {
    const project = await installOutside(root);
    await assertRootOnly(project);
    const counters = { relayerSettleBroadcasts: 0, claimBroadcasts: 0 };
    rpcProxy = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      try {
        const payload = JSON.parse(bytes.toString('utf8')) as { method?: string; params?: string[] };
        if (payload.method === 'eth_sendRawTransaction' && typeof payload.params?.[0] === 'string') {
          const transaction = parseTransaction(payload.params[0] as Hex);
          if (transaction.to?.toLowerCase() === fixture.config.core && transaction.data) {
            if (transaction.data.startsWith(toFunctionSelector('fileClaim(bytes32,bytes32)'))) counters.claimBroadcasts++;
            try {
              const decoded = decodeFunctionData({ abi: CORE_ABI, data: transaction.data });
              if (decoded.functionName === 'settleAssured') counters.relayerSettleBroadcasts++;
            } catch { /* Ignore unrelated Core calls. */ }
          }
        }
      } catch { /* The upstream node remains authoritative for malformed requests. */ }
      try {
        const upstream = await fetch(fixture.evm.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes });
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end(); }
    });
    const rpcPort = await listen(rpcProxy);
    const config = { ...fixture.config, rpcUrl: `http://127.0.0.1:${rpcPort}` };
    const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    const storage = join(root, 'client');
    const base = { ASSUREPAY_CONFIG: configPath, ASSUREPAY_STORAGE_DIRECTORY: storage,
      ASSUREPAY_STORAGE_KEY: Buffer.from(fixture.keys.buyer).toString('hex'),
      ASSUREPAY_MAX_GROSS: fixture.config.gross, ASSUREPAY_MAX_TOTAL_GROSS: '30009', ASSUREPAY_MAX_PAYMENTS: '3' };
    const payer = { ...base, ASSUREPAY_PAYER_PRIVATE_KEY: fixture.roleKeys.payer };
    const providerConfigPath = join(root, 'provider-config.json'); await writeFile(providerConfigPath, JSON.stringify(config));
    const providerEnv = { PATH: process.env.PATH!, ASSUREPAY_CONFIG: providerConfigPath, ASSUREPAY_STORAGE_DIRECTORY: join(root, 'provider'),
      ASSUREPAY_STORAGE_KEY: Buffer.from(fixture.keys.provider).toString('hex'), ASSUREPAY_PROVIDER_PRIVATE_KEY: fixture.roleKeys.provider,
      ASSUREPAY_RELAYER_PRIVATE_KEY: fixture.roleKeys.relayer, ASSUREPAY_MODE: 'profile' };
    const launchProvider = (mode: string) => {
      const env = { ...providerEnv, ASSUREPAY_MODE: mode };
      if (mode === 'retrieve-only') {
        delete (env as Record<string, string | undefined>).ASSUREPAY_PROVIDER_PRIVATE_KEY;
        delete (env as Record<string, string | undefined>).ASSUREPAY_RELAYER_PRIVATE_KEY;
      }
      const child = spawn(process.execPath, ['provider-example/index.js'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
      provider = child;
      return waitReady(child, mode === 'retrieve-only' ? 'retrieval-only' : 'settlement-enabled');
    };
    const stopCurrentProvider = async () => { const child = provider; if (child) { await stopProvider(child); if (provider === child) provider = undefined; } };
    await launchProvider('profile');
    await assert.rejects(run(project, 'deny', { ...base, ASSUREPAY_PAYER_PRIVATE_KEY: fixture.roleKeys.provider }));
    const denied = await run(project, 'agent-deny', base);
    assert.equal(denied.denied?.state, 'denied'); assert.equal(denied.denied?.code, 'CLIENT_APPROVAL_DENIED'); assert.equal(denied.signatures, 0);
    const bodyPath = join(root, 'first.bin'), lostProofPath = join(root, 'lost-proof.json');
    await writeFile(bodyPath, Buffer.from('M10_NORMAL'));
    const lost = await run(project, 'concurrent', { ...payer, ASSUREPAY_REQUEST_BODY: bodyPath,
      ASSUREPAY_TEST_DROP_PAID: '1', ASSUREPAY_TEST_LOST_PROOF: lostProofPath });
    assert.equal(lost.signatures, 1); assert.equal(lost.result.state, 'retrieval-required');
    const lostProof = JSON.parse(await readFile(lostProofPath, 'utf8')) as { transaction: `0x${string}`; status: number; bodyHash: string; receiptFingerprint: string };
    const firstCoverage = lost.result.coverageId;
    const afterFirst = await fixture.evm.publicClient.readContract({ address: fixture.config.core, abi: fixture.artifacts.AssuranceCore.abi, functionName: 'coverageCount' });
    assert.equal(afterFirst, 1n); assert.equal(counters.relayerSettleBroadcasts, 1);

    const recovered = await run(project, 'retrieve', base, [lost.result.requestId]);
    assert.equal(recovered.signatures, 0); assert.equal(recovered.result.state, 'confirmed');
    assert.equal(recovered.result.transaction, lostProof.transaction); assert.equal(recovered.result.receiptFingerprint, lostProof.receiptFingerprint);
    assert.equal(recovered.result.status, lostProof.status); assert.equal(keccak256(Buffer.from(recovered.result.body, 'base64')), lostProof.bodyHash);
    assert.equal(counters.relayerSettleBroadcasts, 1);
    const firstProof = await verifyFirstClientSettlement(fixture, lost.result, lostProof.transaction, utf8('M10_NORMAL'));
    await stopCurrentProvider();

    const relayerNonceBeforeReadOnlyRestart = await fixture.evm.publicClient.getTransactionCount({ address: fixture.config.roles.relayer, blockTag: 'latest' });
    await launchProvider('retrieve-only');
    const providerRecovered = await run(project, 'retrieve', base, [lost.result.requestId]);
    assert.equal(providerRecovered.signatures, 0);
    assert.equal(providerRecovered.result.state, 'confirmed');
    assert.equal(providerRecovered.result.transaction, lostProof.transaction);
    assert.equal(providerRecovered.result.receiptFingerprint, lostProof.receiptFingerprint);
    assert.equal(providerRecovered.result.status, lostProof.status);
    assert.equal(keccak256(Buffer.from(providerRecovered.result.body, 'base64')), lostProof.bodyHash);
    assert.equal(counters.relayerSettleBroadcasts, 1);
    assert.equal(await fixture.evm.publicClient.getTransactionCount({ address: fixture.config.roles.relayer, blockTag: 'latest' }), relayerNonceBeforeReadOnlyRestart);
    await stopCurrentProvider();

    await launchProvider('fail');
    const second = await run(project, 'pay500', payer);
    assert.equal(second.signatures, 1); assert.equal(second.result.state, 'confirmed'); assert.equal(second.result.status, 500);
    const secondCoverage = second.result.coverageId;
    await stopCurrentProvider();
    await launchProvider('profile');
    const third = await run(project, 'pay', payer);
    assert.equal(third.result.state, 'confirmed'); assert.equal(third.result.status, 200);
    const thirdCoverage = third.result.coverageId;
    assert.equal(counters.relayerSettleBroadcasts, 3);
    const preRefundAccounting = await verifyClientAccounting(fixture, false);

    const claim = await run(project, 'claim', payer, [secondCoverage]);
    assert.equal(claim.evidenceMatches, true); assert.equal(claim.claim.status, 'success');
    assert.equal(counters.claimBroadcasts, 1);
    const claimProof = await verifyPayerClaim(fixture, secondCoverage, claim.evidenceHash, claim.claim.transaction);
    const sameClaim = await run(project, 'claim-same', base, [secondCoverage, claim.evidenceHash]);
    assert.equal(sameClaim.signatures, 0); assert.equal(sameClaim.claim.transaction, claim.claim.transaction);
    const reconciledClaims = await run(project, 'claim-reconcile', base);
    assert.equal(reconciledClaims.signatures, 0);
    assert.equal(reconciledClaims.claims.some((row: any) => row.transaction === claim.claim.transaction), true);
    assert.equal(counters.claimBroadcasts, 1);
    const duplicateClaim = await run(project, 'claim-duplicate', payer, [secondCoverage]);
    assert.equal(duplicateClaim.rejected, true); assert.equal(duplicateClaim.signatures, 0);
    const prematureClaim = await run(project, 'claim-premature', payer, [`0x${'55'.repeat(32)}`]);
    assert.equal(prematureClaim.rejected, true); assert.equal(prematureClaim.signatures, 0);
    const coreBeforeRefund = await fixture.evm.publicClient.readContract({ address: fixture.config.core, abi: fixture.artifacts.AssuranceCore.abi, functionName: 'coverages', args: [secondCoverage] });
    assert.equal(coreBeforeRefund[13], 2);
    const decisionHash = keccak256(toBytes('M10 external test adjudication; client has no decision API'));
    await transact(fixture.evm, CLAIMS_CORE_ABI, fixture.config.core, 'finalizeClaim', [secondCoverage, 2, coreBeforeRefund[5], decisionHash], fixture.accounts.adjudicator);
    const refunded = await run(project, 'state', base, [secondCoverage]);
    assert.equal(refunded.state.coverage.status, 3); assert.equal(refunded.state.coverage.outcome, 2);
    assert.equal(refunded.state.coverage.refundAmount, fixture.config.gross);
    const firstState = (await run(project, 'state', base, [firstCoverage])).state;
    const thirdState = (await run(project, 'state', base, [thirdCoverage])).state;
    assert.equal(firstState.coverage.status, 1); assert.equal(thirdState.coverage.status, 1);
    assert.equal(BigInt(firstState.coverage.stakeLock) + BigInt(thirdState.coverage.stakeLock), 7004n);
    assert.equal(BigInt(firstState.coverage.poolReservation) + BigInt(thirdState.coverage.poolReservation), 20006n);

    const postRefundAccounting = await verifyClientAccounting(fixture, true);
    assert.equal(refunded.state.tokenBalanceAtomic, postRefundAccounting.payerAssetsAtomic);
    const fourth = await run(project, 'budget', payer);
    assert.equal(fourth.accepted, false); assert.equal(fourth.error, 'CLIENT_BUDGET_EXCEEDED'); assert.equal(fourth.signatures, 0);
    await assert.rejects(run(project, 'deny', { ...base, ASSUREPAY_MAX_TOTAL_GROSS: '30010' }));
    const totalCoverage = await fixture.evm.publicClient.readContract({ address: fixture.config.core, abi: fixture.artifacts.AssuranceCore.abi, functionName: 'coverageCount' });
    assert.equal(totalCoverage, 3n);
    return { ok: true, code: 'LOCAL_CLIENT_SDK_VERIFIED', runtime: 'plain-node-outside-repository', chainId: 84532,
      clientPackageVersion: '0.1.0', providerPackageVersion: '0.1.0',
      limits: { localOnly: true, tokenKind: 'LOCAL_ERC3009_FIXTURE', publicNativeUsdcProof: false, finality: false, hostedAvailability: false },
      previewAndAgentDenialSignatures: denied.signatures, concurrentAuthorizationSignatures: lost.signatures,
      firstPaymentResponseLost: true, clientProcessRestart: true, signerFreeRetrieval: recovered.signatures === 0,
      sameOriginalTransactionAndReceipt: true, signed500Verified: second.result.status === 500,
      payerEvidenceAndClaimIncluded: claim.claim.status === 'success', sameEvidenceIdempotentWithoutSigner: sameClaim.signatures === 0,
      claimReconcileWithoutSigner: reconciledClaims.signatures === 0, retrievalOnlyProviderWithoutKeys: true, refundOnlyViaTestAdjudicator: true,
      otherCoverageLocksPreserved: true, capDeniedBeforeSignature: fourth.signatures === 0,
      changedBudgetContextRejected: true, coverageCount: String(totalCoverage), counters, firstProof, claimProof,
      preRefundAccounting, postRefundAccounting };
  } finally {
    if (provider) await stopProvider(provider).catch(() => undefined);
    if (rpcProxy) await new Promise<void>(resolve => rpcProxy!.close(() => resolve()));
    await fixture.close(); await rm(root, { recursive: true, force: true });
  }
}
