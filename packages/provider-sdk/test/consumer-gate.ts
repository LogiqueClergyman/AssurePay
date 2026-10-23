import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { privateKeyToAccount } from 'viem/accounts';
import { createBuyer } from '../../developer-pilot/src/buyer.js';
import { createClients, trustFor } from '../../developer-pilot/src/config.js';
import { createPilotFixture } from '../../developer-pilot/test/helpers.js';
import { verifyProfileSettlement } from './financial-proof.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const exampleDir = fileURLToPath(new URL('../../../examples/data-profile-service/', import.meta.url));
const utf8 = (value: string) => new TextEncoder().encode(value);

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('GATE_LISTEN_FAILED'));
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function waitLine(child: ReturnType<typeof spawn>, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('GATE_PROVIDER_START_TIMEOUT')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); child.stdout?.off('data', onData); child.off('exit', onExit); };
    const onData = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const end = text.indexOf('\n');
      if (end >= 0) { const line = text.slice(0, end); cleanup(); resolve(line); }
    };
    const onExit = () => { cleanup(); reject(new Error('GATE_PROVIDER_EXITED_EARLY')); };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('GATE_PROVIDER_STOP_TIMEOUT')); }, 10_000);
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('GATE_PROVIDER_STOP_FAILED')); });
  });
}

async function installConsumer(root: string): Promise<{ project: string; tarball: string }> {
  const packDirectory = join(root, 'pack');
  const project = join(root, 'consumer');
  await mkdir(packDirectory, { recursive: true });
  await mkdir(project, { recursive: true });
  const packed = execFileSync('npm', ['pack', '--pack-destination', packDirectory, '--ignore-scripts'], {
    cwd: packageDir, encoding: 'utf8', env: { PATH: process.env.PATH },
  }).trim().split(/\r?\n/).at(-1)!;
  const tarball = join(packDirectory, packed);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'provider-sdk-consumer-gate', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball,
    'typescript@5.9.3', '@types/node@24.10.1'], {
    cwd: project, encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  await cp(join(exampleDir, 'src'), join(project, 'src'), { recursive: true });
  await cp(join(exampleDir, 'test'), join(project, 'test'), { recursive: true });
  await cp(join(exampleDir, 'tsconfig.json'), join(project, 'tsconfig.json'));
  return { project, tarball };
}

function launchExample(project: string, env: NodeJS.ProcessEnv) {
  const safeEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const key of ['ASSUREPAY_CONFIG', 'ASSUREPAY_STORAGE_DIRECTORY', 'ASSUREPAY_STORAGE_KEY',
    'ASSUREPAY_PROVIDER_PRIVATE_KEY', 'ASSUREPAY_RELAYER_PRIVATE_KEY', 'ASSUREPAY_MODE']) {
    if (env[key] !== undefined) safeEnv[key] = env[key];
  }
  return spawn(process.execPath, ['src/index.js'], {
    cwd: project, env: safeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buyerOptions(f: Awaited<ReturnType<typeof createPilotFixture>>, buyerDir: string, relayer: string,
  payerSigner?: { address: `0x${string}`; signTypedData(data: any): Promise<`0x${string}`> }, fetch?: typeof globalThis.fetch) {
  const directConfig = { ...f.config, rpcUrl: f.evm.url };
  return {
    binding: { url: f.config.resourceUrl, trust: trustFor(f.config), maxGross: f.config.gross, payer: f.config.roles.payer },
    directory: buyerDir, key: f.keys.buyer, client: createClients(directConfig).client,
    relayer: relayer as `0x${string}`, ...(payerSigner ? { payerSigner } : {}), ...(fetch ? { fetch } : {}),
  };
}

/** Runs the built artifact outside the workspace and returns only safe counters. */
export async function runProviderConsumerGate(): Promise<Record<string, unknown>> {
  const fixture = await createPilotFixture();
  const root = await mkdtemp(join(tmpdir(), 'assurepay-m9-consumer-'));
  let rpcProxy: Server | undefined;
  let provider: ReturnType<typeof spawn> | undefined;
  let buyer: Awaited<ReturnType<typeof createBuyer>> | undefined;
  try {
    const { project } = await installConsumer(root);
    const consumerSdk = await import(join(project, 'node_modules/@assurepay/provider-sdk/dist/index.js'));
    assert.equal(typeof consumerSdk.createProvider, 'function');
    await importPackageDeepPath(project);
    const typeFile = join(project, 'consumer.ts');
    await writeFile(typeFile, `import { createProvider, type ProviderOptions } from '@assurepay/provider-sdk';\n` +
      `declare const good: ProviderOptions; void createProvider(good);\n` +
      `// @ts-expect-error raw key strings are not accepted\nvoid createProvider({ ...good, storage: { directory: 'x', key: 'secret' } });\n` +
      `// @ts-expect-error generic wallet/client injection is outside the facade\nvoid createProvider({ ...good, client: {} });\n`);
    execFileSync(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', typeFile], { cwd: project, stdio: 'pipe' });
    execFileSync(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '--noEmit', '--project', join(project, 'tsconfig.json')], { cwd: project, stdio: 'pipe' });

    const broadcastHashes: string[] = [];
    let failRpcReads = false;
    rpcProxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      let method = '';
      try { method = JSON.parse(Buffer.concat(chunks).toString('utf8')).method; } catch { /* upstream returns error */ }
      if (failRpcReads && ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method)) {
        response.writeHead(503); response.end(); return;
      }
      if (method === 'eth_sendRawTransaction') {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const { keccak256: hash } = await import('viem');
          broadcastHashes.push(hash(payload.params[0]));
        } catch { /* upstream response remains authoritative */ }
      }
      try {
        const upstream = await fetch(fixture.evm.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end(); }
    });
    const rpcPort = await listen(rpcProxy);
    const config = { ...fixture.config, rpcUrl: `http://127.0.0.1:${rpcPort}` };
    const configFile = join(project, 'pilot-config.json');
    await writeFile(configFile, JSON.stringify(config));
    const serviceDir = join(root, 'provider-storage');
    const storageKey = Buffer.from(fixture.keys.provider).toString('hex');
    const providerEnv = {
      ASSUREPAY_CONFIG: configFile, ASSUREPAY_STORAGE_DIRECTORY: serviceDir, ASSUREPAY_STORAGE_KEY: storageKey,
      ASSUREPAY_PROVIDER_PRIVATE_KEY: fixture.roleKeys.provider, ASSUREPAY_RELAYER_PRIVATE_KEY: fixture.roleKeys.relayer,
      ASSUREPAY_MODE: 'profile',
    };
    provider = launchExample(project, providerEnv);
    const ready = JSON.parse(await waitLine(provider));
    assert.equal(ready.mode, 'settlement-enabled');
    assert.equal(ready.resourceUrl, fixture.config.resourceUrl);
    const contender = launchExample(project, providerEnv);
    const contenderExit = new Promise<number | null>(resolve => contender.once('exit', code => resolve(code)));
    await assert.rejects(waitLine(contender));
    assert.equal(await contenderExit, 1);
    await assert.rejects(consumerSdk.createProvider({
      config, storage: { directory: serviceDir, key: fixture.keys.provider },
      receiptSigner: privateKeyToAccount(fixture.roleKeys.provider),
      relayerAccount: privateKeyToAccount(fixture.roleKeys.relayer), handler: async (body: Uint8Array) => body,
    }), /M5_RUN_LOCK_UNAVAILABLE|ACTION_LOCK_UNAVAILABLE/);
    const binding = { url: fixture.config.resourceUrl, trust: trustFor(fixture.config), maxGross: fixture.config.gross, payer: fixture.config.roles.payer };
    let payerSignatures = 0;
    const payerSigner = { address: fixture.accounts.payer.address, async signTypedData(data: any) { payerSignatures++; return fixture.accounts.payer.signTypedData(data); } };
    let lostPaidProof: { transaction?: string; status?: number; bodyHash?: string; receiptFingerprint?: string } = {};
    const lostResponseFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).origin === new URL(fixture.config.resourceUrl).origin && response.status >= 200 && response.status !== 402) {
        if (response.status !== 202) {
          const paymentHeader = response.headers.get('payment-response');
          if (paymentHeader) {
            const proof = decodePaymentResponseHeader(paymentHeader);
            const receiptHeader = response.headers.get('assurepay-receipt');
            if (!receiptHeader) throw new Error('PAID_RECEIPT_HEADER_MISSING');
            const signedReceipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8'));
            const message = signedReceipt.message;
            const fingerprint = keccak256(toBytes(JSON.stringify([message.chainId, message.core, message.coverageId,
              message.requestHash, message.responseHash, message.status, message.completedAt, signedReceipt.signature])));
            lostPaidProof = { transaction: proof.transaction, status: response.status,
              bodyHash: keccak256(new Uint8Array(await response.clone().arrayBuffer())), receiptFingerprint: fingerprint };
          }
        }
        throw new Error('SIMULATED_RESPONSE_LOSS');
      }
      return response;
    };
    buyer = await createBuyer(buyerOptions(fixture, join(root, 'buyer'), fixture.config.roles.relayer, payerSigner, lostResponseFetch));
    const csv = utf8('name,age\nAda,37\nLin,\n');
    const prepared = await buyer.prepare(csv);
    await assert.rejects(buyer.send(prepared.requestId));
    const coverageCount = await fixture.evm.publicClient.readContract({ address: fixture.config.core, abi: fixture.artifacts.AssuranceCore.abi, functionName: 'coverageCount' });
    assert.equal(coverageCount, 1n);
    assert.equal(broadcastHashes.length, 1);
    assert.equal(payerSignatures, 1);
    await assert.rejects(buyer.send(prepared.requestId), /BUYER_SEND_UNAVAILABLE/);
    await buyer.close(); buyer = undefined;
    await stop(provider); provider = undefined;

    const nonceBefore = await fixture.evm.publicClient.getTransactionCount({ address: fixture.config.roles.relayer });
    provider = launchExample(project, { ...providerEnv, ASSUREPAY_MODE: 'retrieve-only', ASSUREPAY_PROVIDER_PRIVATE_KEY: undefined, ASSUREPAY_RELAYER_PRIVATE_KEY: undefined });
    const readonly = JSON.parse(await waitLine(provider));
    assert.equal(readonly.mode, 'retrieval-only');
    buyer = await createBuyer(buyerOptions(fixture, join(root, 'buyer'), fixture.config.roles.relayer));
    const signaturesBeforeRetrieve = payerSignatures;
    const recovered = await buyer.retrieve(prepared.requestId);
    const retrievalPayerSignatures = payerSignatures - signaturesBeforeRetrieve;
    assert.equal(retrievalPayerSignatures, 0);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.paid, true);
    assert.equal(keccak256(recovered.body), keccak256(utf8('{"schemaVersion":1,"rows":2,"columns":2,"fields":[{"name":"name","present":2,"missing":0},{"name":"age","present":1,"missing":1}]}')));
    assert.deepEqual({ chainId: recovered.receipt?.message.chainId, core: recovered.receipt?.message.core.toLowerCase(),
      coverageId: recovered.receipt?.message.coverageId, requestHash: recovered.receipt?.message.requestHash,
      status: recovered.receipt?.message.status, responseHash: recovered.receipt?.message.responseHash },
    { chainId: '84532', core: fixture.config.core.toLowerCase(), coverageId: prepared.coverageId,
      requestHash: prepared.requestHash, status: 200, responseHash: lostPaidProof.bodyHash });
    assert.equal(recovered.receipt?.message.responseHash, lostPaidProof.bodyHash);
    const recoveredFingerprint = keccak256(toBytes(JSON.stringify([recovered.receipt?.message.chainId, recovered.receipt?.message.core,
      recovered.receipt?.message.coverageId, recovered.receipt?.message.requestHash, recovered.receipt?.message.responseHash,
      recovered.receipt?.message.status, recovered.receipt?.message.completedAt, recovered.receipt?.signature])));
    assert.equal(recoveredFingerprint, lostPaidProof.receiptFingerprint);
    assert.equal((recovered.paymentResponse as any)?.transaction, lostPaidProof.transaction);
    assert.equal(recovered.status, lostPaidProof.status);
    const txHash = (recovered.paymentResponse as any).transaction as `0x${string}`;
    const profileProof = await verifyProfileSettlement(fixture, prepared, txHash, csv);
    assert.equal(await fixture.evm.publicClient.getTransactionCount({ address: fixture.config.roles.relayer }), nonceBefore);
    assert.equal(broadcastHashes.length, 1);
    assert.equal(payerSignatures, 1);
    await assert.rejects(buyer.retrieve(`0x${'1'.repeat(64)}` as `0x${string}`));
    await buyer.close(); buyer = undefined;
    buyer = await createBuyer(buyerOptions(fixture, join(root, 'buyer'), fixture.config.roles.relayer));
    const alteredFetch: typeof fetch = async (input, init) => {
      if (new URL(String(input)).origin === new URL(fixture.config.resourceUrl).origin &&
          new Headers(init?.headers).has('assurepay-retrieve-only')) {
        const bytes = Buffer.from(init?.body as Uint8Array);
        return fetch(input, { ...init, body: Buffer.concat([bytes, Buffer.from('tampered')]) });
      }
      return fetch(input, init);
    };
    await buyer.close(); buyer = undefined;
    buyer = await createBuyer(buyerOptions(fixture, join(root, 'buyer'), fixture.config.roles.relayer, undefined, alteredFetch));
    await assert.rejects(buyer.retrieve(prepared.requestId));
    await buyer.close(); buyer = undefined;
    failRpcReads = true;
    buyer = await createBuyer(buyerOptions(fixture, join(root, 'buyer'), fixture.config.roles.relayer));
    await assert.rejects(buyer.retrieve(prepared.requestId));
    failRpcReads = false;
    assert.equal(broadcastHashes.length, 1);
    await buyer.close(); buyer = undefined;

    buyer = await createBuyer(buyerOptions(fixture, join(root, 'buyer'), fixture.config.roles.relayer, payerSigner));
    const newPrepared = await buyer.prepare(utf8('fresh valid identity must be refused in retrieval-only mode'));
    await assert.rejects(buyer.send(newPrepared.requestId));
    const afterRefusal = await fixture.evm.publicClient.readContract({ address: fixture.config.core, abi: fixture.artifacts.AssuranceCore.abi, functionName: 'coverageCount' });
    assert.equal(afterRefusal, 1n);
    assert.equal(broadcastHashes.length, 1);
    assert.equal(payerSignatures, 2);
    await buyer.close(); buyer = undefined;
    const changedBinding = { ...binding, maxGross: '10002' };
    const wrongBindingDirectory = join(root, 'wrong-binding-buyer');
    await cp(join(root, 'buyer'), wrongBindingDirectory, { recursive: true });
    buyer = await createBuyer({ ...buyerOptions(fixture, wrongBindingDirectory, fixture.config.roles.relayer), binding: changedBinding });
    await assert.rejects(buyer.retrieve(prepared.requestId));
    await buyer.close(); buyer = undefined;

    await stop(provider); provider = undefined;
    async function retrievalClone(label: string, change: (directory: string) => Promise<void>) {
      const directory = join(root, `clone-${label}`);
      await cp(serviceDir, directory, { recursive: true });
      await change(directory);
      provider = launchExample(project, { ...providerEnv, ASSUREPAY_MODE: 'retrieve-only', ASSUREPAY_STORAGE_DIRECTORY: directory,
        ASSUREPAY_PROVIDER_PRIVATE_KEY: undefined, ASSUREPAY_RELAYER_PRIVATE_KEY: undefined });
      await waitLine(provider);
      const buyerDir = join(root, `buyer-${label}`);
      await cp(join(root, 'buyer'), buyerDir, { recursive: true });
      buyer = await createBuyer(buyerOptions(fixture, buyerDir, fixture.config.roles.relayer));
      await assert.rejects(buyer.retrieve(prepared.requestId));
      await buyer.close(); buyer = undefined;
      await stop(provider); provider = undefined;
      assert.equal(broadcastHashes.length, 1);
    }
    const archivePath = (directory: string) => join(directory, 'objects', `result-${prepared.coverageId.slice(2)}.json`);
    await retrievalClone('archive-missing', directory => rm(archivePath(directory)));
    await retrievalClone('archive-corrupt', directory => writeFile(archivePath(directory), '{corrupt}\n'));
    await retrievalClone('payment-journal-missing', directory => rm(join(directory, 'payments.json')));

    provider = launchExample(project, { ...providerEnv, ASSUREPAY_MODE: 'fail' });
    assert.equal(JSON.parse(await waitLine(provider)).mode, 'settlement-enabled');
    buyer = await createBuyer(buyerOptions(fixture, join(root, 'buyer-fail-mode'), fixture.config.roles.relayer, payerSigner));
    const failedRequest = await buyer.prepare(utf8('controlled signed failure'));
    const failedResponse = await buyer.send(failedRequest.requestId);
    assert.equal(failedResponse.paid, true); assert.equal(failedResponse.status, 500);
    assert.equal(payerSignatures, 3);
    assert.equal(broadcastHashes.length, 2);
    const finalCoverageCount = await fixture.evm.publicClient.readContract({ address: fixture.config.core, abi: fixture.artifacts.AssuranceCore.abi, functionName: 'coverageCount' });
    assert.equal(finalCoverageCount, 2n);
    await buyer.close(); buyer = undefined;
    await stop(provider); provider = undefined;

    const financial = profileProof;
    return { ok: true, code: 'LOCAL_PROVIDER_SDK_VERIFIED', package: '@assurepay/provider-sdk@0.1.0', runtime: 'plain-node-outside-repository', mode: 'profile->retrieve-only+fail',
      profilePayerSignatures: 1, negativeRequestSignatures: 1, relayerBroadcastsIncludingControlledFailure: broadcastHashes.length,
      originalRelayerNonceUnchangedOnRetrieve: true, retrievalOnlyNewRequestRefused: true, alteredBodyRefused: true,
      sameOriginalReceiptAfterRestart: recoveredFingerprint === lostPaidProof.receiptFingerprint,
      missingAndCorruptArchiveRefused: true, missingPaymentJournalRefused: true, rpcFailureFailsClosed: true, signed500Verified: true,
      providerProcessRestart: true, buyerProcessRestart: false, retrievalPayerSignatures,
      firstProfileSnapshot: financial, totalCoverageCountAfterIntentionalFailMode: String(finalCoverageCount),
      limits: { publicNativeUsdcProof: false, mainnetFinality: false, multiHostStorage: false } };
  } finally {
    await buyer?.close().catch(() => undefined);
    if (provider && provider.exitCode === null) await stop(provider).catch(() => provider?.kill('SIGKILL'));
    if (rpcProxy) await closeServer(rpcProxy).catch(() => undefined);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function importPackageDeepPath(project: string): Promise<void> {
  let output = '';
  try {
    output = execFileSync(process.execPath, ['--input-type=module', '-e', "import('@assurepay/provider-sdk/dist/index.js')"], {
      cwd: project, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    output = String((error as { stderr?: Buffer }).stderr ?? '');
  }
  assert.match(output, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
}
