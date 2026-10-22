import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { EncryptedVault } from '../../claims-backend/src/vault.js';
import { readTerms, verifySettlement } from '../../x402-assurance/src/chain.js';
import { createPurchase, restorePurchase, type PurchaseSession, type PurchaseSnapshot } from '../../x402-assurance/src/http-client.js';
import type { Trust } from '../../x402-assurance/src/types.js';

export interface BuyerBinding { url: string; trust: Trust; maxGross: string; payer: Address }
export interface BuyerOptions {
  binding: BuyerBinding; directory: string; key: Uint8Array; client: any; relayer: Address;
  payerSigner?: { address: Address; signTypedData(data: any): Promise<Hex> }; fetch?: typeof globalThis.fetch;
}
export interface BuyerPrepared { requestId: Hex; requestHash: Hex; coverageId: Hex }
export interface Buyer {
  prepare(body: Uint8Array): Promise<BuyerPrepared>;
  send(requestId: Hex): ReturnType<PurchaseSession['send']>;
  retrieve(requestId: Hex): ReturnType<PurchaseSession['send']>;
  close(): Promise<void>;
}

function exactSnapshot(value: unknown): PurchaseSnapshot {
  const keys = ['version','url','bodyHex','trust','maxGross','payer','terms','requestId','payment'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) throw new Error('BUYER_SNAPSHOT_INVALID');
  const row = value as PurchaseSnapshot;
  if (row.version !== 1 || typeof row.url !== 'string' || typeof row.bodyHex !== 'string' || typeof row.maxGross !== 'string' ||
      typeof row.payer !== 'string' || typeof row.requestId !== 'string' || !row.payment || !row.terms || !row.trust) throw new Error('BUYER_SNAPSHOT_INVALID');
  return row;
}

/** Durable local buyer. The encrypted vault is binding-specific; only retrieval survives process restart. */
export async function createBuyer(options: BuyerOptions): Promise<Buyer> {
  const key = Uint8Array.from(options.key);
  const sourceClient = options.client;
  const client = Object.fromEntries(['getChainId','getBlock','getCode','readContract','getTransaction','getTransactionReceipt','getBlockNumber']
    .map(name => [name, typeof sourceClient?.[name] === 'function' ? sourceClient[name].bind(sourceClient) : undefined])) as any;
  const relayer = options.relayer.toLowerCase() as Address;
  const payerSigner = options.payerSigner && Object.freeze({ address: options.payerSigner.address.toLowerCase() as Address,
    signTypedData: options.payerSigner.signTypedData.bind(options.payerSigner) });
  const fetcher = options.fetch ?? globalThis.fetch;
  const binding = Object.freeze({ url: options.binding.url, trust: Object.freeze({ ...options.binding.trust }),
    maxGross: options.binding.maxGross, payer: options.binding.payer.toLowerCase() as Address });
  const directory = resolve(options.directory);
  if (!options.directory || parse(directory).root === directory || !(key instanceof Uint8Array) || key.byteLength !== 32 ||
      !client || typeof client.getBlock !== 'function' || !/^0x[0-9a-fA-F]{40}$/.test(binding.payer) ||
      !/^(0|[1-9][0-9]*)$/.test(binding.maxGross)) throw new Error('BUYER_CONFIG_INVALID');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dirInfo = await lstat(directory);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('BUYER_DIRECTORY_INVALID');
  const lockPath = join(directory, '.buyer.lock');
  let lock: FileHandle | undefined;
  let lockStat: Stats | undefined;
  try {
    lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await lock.writeFile('assurepay-buyer-lock-v1\n'); await lock.sync();
    const stat = await lock.stat();
    lockStat = stat;
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error();
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch {
    if (lock) {
      try {
        const ownStat = lockStat ?? await lock.stat();
        const pathStat = await lstat(lockPath);
        if (!pathStat.isSymbolicLink() && pathStat.isFile() && pathStat.dev === ownStat.dev && pathStat.ino === ownStat.ino) {
          await unlink(lockPath);
          const dir = await open(directory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
        }
      } catch { /* fail closed */ }
    }
    await lock?.close().catch(() => {});
    throw new Error('BUYER_DIRECTORY_LOCKED');
  }
  const namespace = keccak256(toBytes(JSON.stringify({ url: binding.url, trust: binding.trust, maxGross: binding.maxGross, payer: binding.payer })));
  const vault = new EncryptedVault({ directory: join(directory, 'vault'), namespace: namespace.slice(2), keyId: 'buyer-v1', key });
  const fresh = new Map<string, PurchaseSession>();
  let closed = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  function operation<T>(action: () => Promise<T>): Promise<T> {
    if (closed || closing) return Promise.reject(new Error('BUYER_CLOSED'));
    const task = action(); active.add(task);
    void task.finally(() => active.delete(task)).catch(() => undefined);
    return task;
  }
  async function time(): Promise<bigint> {
    const block = await client.getBlock({ blockTag: 'latest' });
    if (!block || typeof block.timestamp !== 'bigint') throw new Error('BUYER_CLOCK_UNAVAILABLE');
    return block.timestamp;
  }
  async function read(gross: string) { return readTerms(client, binding.trust, gross); }
  async function readSnapshotTerms(gross: string) {
    const terms = await read(gross);
    return Object.freeze({ ...terms, core: terms.core.toLowerCase() as typeof terms.core,
      token: terms.token.toLowerCase() as typeof terms.token,
      providerOwner: terms.providerOwner.toLowerCase() as typeof terms.providerOwner,
      providerPayout: terms.providerPayout.toLowerCase() as typeof terms.providerPayout });
  }
  async function verify(input: Parameters<NonNullable<Parameters<typeof createPurchase>[0]['verifyPayment']>>[0]) {
    return verifySettlement(client, input.call && (await read(input.call.intent.gross)), input.call, (input.paymentResponse as any).transaction, relayer);
  }
  return {
    prepare(bodyInput) { return operation(async () => {
      if (!(bodyInput instanceof Uint8Array)) throw new Error('BUYER_BODY_INVALID');
      if (!payerSigner || payerSigner.address.toLowerCase() !== binding.payer.toLowerCase()) throw new Error('BUYER_SIGNER_REQUIRED');
      const body = Uint8Array.from(bodyInput);
      let termsForRequest: Awaited<ReturnType<typeof readSnapshotTerms>> | undefined;
      const session = await createPurchase({ url: binding.url, body, payer: payerSigner, trust: binding.trust, maxGross: binding.maxGross,
        readTerms: async (_trust, gross) => { termsForRequest = await readSnapshotTerms(gross); return termsForRequest; }, now: time, verifyPayment: verify, fetch: fetcher });
      if (!termsForRequest) throw new Error('BUYER_TERMS_UNAVAILABLE');
      const snapshot: PurchaseSnapshot = { version: 1, url: binding.url, bodyHex: Buffer.from(body).toString('hex'), trust: binding.trust,
        maxGross: binding.maxGross, payer: binding.payer, terms: termsForRequest, requestId: session.requestId, payment: session.payment };
      await vault.put('result', session.requestId, snapshot);
      fresh.set(session.requestId, session);
      return { requestId: session.requestId, requestHash: session.requestHash, coverageId: session.call.intentHash };
    }); },
    send(requestId) { return operation(async () => {
      const session = fresh.get(requestId);
      if (!session) throw new Error('BUYER_SEND_UNAVAILABLE');
      fresh.delete(requestId);
      const markerPath = join(directory, `.attempt-${requestId.slice(2)}.json`);
      let marker;
      try {
        marker = await open(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await marker.writeFile(JSON.stringify({ version: 1, requestId, requestHash: session.requestHash, coverageId: session.call.intentHash, attempted: true }) + '\n');
        await marker.sync();
      } catch { await marker?.close().catch(() => {}); throw new Error('BUYER_ALREADY_ATTEMPTED'); }
      await marker.close();
      const directoryHandle = await open(directory, constants.O_RDONLY); await directoryHandle.sync(); await directoryHandle.close();
      return session.send();
    }); },
    retrieve(requestId) { return operation(async () => {
      const raw = await vault.get('result', requestId);
      if (!raw) throw new Error('BUYER_SNAPSHOT_MISSING');
      const snapshot = exactSnapshot(raw);
      if (snapshot.requestId !== requestId) throw new Error('BUYER_SNAPSHOT_BINDING_MISMATCH');
      const session = await restorePurchase({ snapshot, url: binding.url, trust: binding.trust, maxGross: binding.maxGross, payer: binding.payer,
        readTerms: (_trust, gross) => read(gross), now: time, verifyPayment: verify, fetch: fetcher });
      return session.send();
    }); },
    close() {
      if (closePromise) return closePromise;
      if (closed) return Promise.resolve();
      closing = true;
      closePromise = (async () => {
        await Promise.allSettled([...active]);
        fresh.clear();
        try {
          const expectedLock = lockStat;
          if (!expectedLock) throw new Error();
          const pathStat = await lstat(lockPath);
          if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.dev !== expectedLock.dev || pathStat.ino !== expectedLock.ino || (pathStat.mode & 0o777) !== 0o600) throw new Error();
          await unlink(lockPath);
          const dir = await open(dirname(lockPath), constants.O_RDONLY); await dir.sync(); await dir.close();
        } catch { await lock.close().catch(() => {}); closed = true; throw new Error('BUYER_LOCK_RELEASE_FAILED'); }
        await lock.close(); closed = true;
      })();
      return closePromise;
    },
  };
}
