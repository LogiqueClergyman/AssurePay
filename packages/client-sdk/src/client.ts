import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { keccak256, toBytes, type Hex, type LocalAccount } from 'viem';
import { createBuyer } from '../../developer-pilot/src/buyer.js';
import { createClients, ensureDirectory, trustFor, validateConfig } from '../../developer-pilot/src/config.js';
import { acquireRunLock } from '../../evm-acceptance/src/run-lock.js';
import { Budget, amount, requestId, type BudgetRequest } from './budget.js';
import { createPayerClaims } from './claims.js';
import { createStateReader } from './reads.js';
import { clientErrorCode } from './errors.js';
import type { AuthorizedRequest, Client, ClientOptions, ClientPreview, ClientResult, ConfirmedResult } from './types.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function captureAccount(account: LocalAccount | undefined, expected: string): LocalAccount | undefined {
  if (account === undefined) return undefined;
  if (!account || account.type !== 'local' || account.address?.toLowerCase() !== expected ||
      typeof account.signTypedData !== 'function' || typeof account.signTransaction !== 'function' || typeof account.signMessage !== 'function')
    throw Error('CLIENT_SIGNER_MISMATCH');
  return Object.freeze({ address: account.address, publicKey: account.publicKey, source: account.source, type: 'local',
    signTypedData: account.signTypedData.bind(account), signTransaction: account.signTransaction.bind(account),
    signMessage: account.signMessage.bind(account),
    ...(account.sign ? { sign: account.sign.bind(account) } : {}),
    ...(account.signAuthorization ? { signAuthorization: account.signAuthorization.bind(account) } : {}) });
}
function explicitApproval(input: unknown): boolean {
  return !!input && typeof input === 'object' && !Array.isArray(input) && Object.getPrototypeOf(input) === Object.prototype &&
    Reflect.ownKeys(input).length === 1 && Object.getOwnPropertyDescriptor(input, 'approved')?.value === true;
}
const metadata = (row: BudgetRequest): AuthorizedRequest => ({ requestId: row.requestId, requestHash: row.requestHash, coverageId: row.coverageId });

/** Fixed local payer runtime; private capabilities never leave this closure. */
export async function createClientRuntime(options: ClientOptions): Promise<Client> {
  let release: (() => Promise<void>) | undefined;
  let buyer: Awaited<ReturnType<typeof createBuyer>> | undefined;
  let claims: ReturnType<typeof createPayerClaims> | undefined;
  try {
    const config = validateConfig(options?.config);
    const maxGross = amount(options.maxGross), maxTotalGross = amount(options.budget?.maxTotalGross);
    const maxPayments = options.budget?.maxPayments;
    if (BigInt(maxGross) < 2n || BigInt(maxTotalGross) < BigInt(maxGross) || !Number.isSafeInteger(maxPayments) || maxPayments < 1 || maxPayments > 64)
      throw Error('CLIENT_LIMIT_INVALID');
    if (!options.storage || typeof options.storage.directory !== 'string' || !options.storage.directory ||
        !(options.storage.key instanceof Uint8Array) || options.storage.key.length !== 32) throw Error('CLIENT_OPTIONS_INVALID');
    const directoryInput = options.storage.directory, key = Uint8Array.from(options.storage.key);
    const account = captureAccount(options.payerAccount, config.roles.payer);
    const namespace = keccak256(toBytes(stable({ config, maxGross, maxTotalGross, maxPayments })));
    const directory = await ensureDirectory(directoryInput);
    if (((await lstat(directory)).mode & 0o077) !== 0) throw Error('CLIENT_STORAGE_INVALID');
    try { release = await acquireRunLock(join(directory, 'client.lock')); }
    catch { throw Error('CLIENT_STORAGE_LOCKED'); }
    const budget = await Budget.open(directory, namespace, maxGross, maxTotalGross, maxPayments);
    const { client, wallet } = createClients(config);
    const previews = new Map<Hex, ClientPreview>(), fresh = new Set<Hex>();
    let activeApproval: ClientPreview | undefined;
    async function now(): Promise<bigint> {
      const head = await client.getBlock({ blockTag: 'latest' });
      if (typeof head.timestamp !== 'bigint') throw Error('CLIENT_STATE_UNAVAILABLE');
      return head.timestamp;
    }
    const paymentSigner = account && { address: config.roles.payer, async signTypedData(data: any): Promise<Hex> {
      const preview = activeApproval;
      if (!preview || data?.primaryType !== 'ReceiveWithAuthorization' || data?.domain?.name !== 'USDC' || data?.domain?.version !== '2' ||
          data?.domain?.chainId !== 84532 || data?.domain?.verifyingContract?.toLowerCase() !== config.token ||
          data?.message?.from?.toLowerCase() !== config.roles.payer || data?.message?.to?.toLowerCase() !== config.core ||
          BigInt(data?.message?.value) !== BigInt(preview.terms.gross)) throw Error('CLIENT_SIGNING_CONTEXT_INVALID');
      if (await now() >= BigInt(preview.expiresAt)) throw Error('CLIENT_PREVIEW_EXPIRED');
      const coverageId = requestId(data.message.nonce);
      await budget.reserve({ requestId: preview.requestId, requestHash: preview.requestHash, coverageId, gross: preview.terms.gross });
      return account.signTypedData(data);
    } };
    buyer = await createBuyer({ binding: { url: config.resourceUrl, trust: trustFor(config), maxGross, payer: config.roles.payer },
      directory: join(directory, 'buyer'), key, client, relayer: config.roles.relayer,
      ...(paymentSigner ? { payerSigner: paymentSigner } : {}) });
    const localBuyer = buyer;
    const readState = createStateReader(config, client);
    claims = createPayerClaims({ config, client, ...(account ? { wallet, account } : {}), directory, readState });
    const localClaims = claims;
    let closing = false, closed = false, closePromise: Promise<void> | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    function operation<T>(task: () => Promise<T>): Promise<T> {
      if (closing || closed) return Promise.reject(Error('CLIENT_CLOSED'));
      const pending = tail.then(task); tail = pending.then(() => undefined, () => undefined);
      return pending.catch(error => { throw Error(clientErrorCode(error)); });
    }
    function bodyOperation<T>(input: Uint8Array, task: (body: Uint8Array) => Promise<T>): Promise<T> {
      try {
        if (!(input instanceof Uint8Array) || input.byteLength > 65_536) throw Error('CLIENT_OPTIONS_INVALID');
        const body = Uint8Array.from(input);
        return operation(() => task(body));
      } catch (error) { return Promise.reject(Error(clientErrorCode(error))); }
    }
    async function confirmed(row: BudgetRequest, result: Awaited<ReturnType<typeof localBuyer.retrieve>>): Promise<ConfirmedResult> {
      if (!result.paid || !result.receipt || !result.paymentResponse) throw Error('CLIENT_PAYMENT_UNCONFIRMED');
      const transaction = requestId((result.paymentResponse as { transaction?: unknown }).transaction);
      const message = result.receipt.message;
      if (message.coverageId !== row.coverageId || message.requestHash !== row.requestHash) throw Error('CLIENT_REQUEST_BINDING_MISMATCH');
      const receipt = await client.getTransactionReceipt({ hash: transaction });
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== transaction || block.hash !== receipt.blockHash)
        throw Error('CLIENT_PAYMENT_UNCONFIRMED');
      const fingerprint = keccak256(toBytes(JSON.stringify([message.chainId, message.core, message.coverageId, message.requestHash,
        message.responseHash, message.status, message.completedAt, result.receipt.signature])));
      const output: ConfirmedResult = Object.freeze({ ...metadata(row), state: 'confirmed', status: result.status,
        body: Uint8Array.from(result.body), transaction, paymentBlock: Object.freeze({ number: String(receipt.blockNumber), hash: receipt.blockHash }),
        receipt: Object.freeze({ chainId: message.chainId, core: message.core, coverageId: message.coverageId,
          requestHash: message.requestHash, responseHash: message.responseHash, status: message.status, completedAt: message.completedAt }),
        receiptFingerprint: fingerprint });
      await budget.mark(row.requestId, 'confirmed');
      return output;
    }
    async function getResult(id: Hex, send: boolean): Promise<ClientResult> {
      const row = budget.get(requestId(id));
      if (send) {
        if (!fresh.delete(id) || row.state !== 'authorized') throw Error('CLIENT_SEND_UNAVAILABLE');
        await budget.mark(id, 'attempted');
      } else if (row.state === 'confirmed') {
        // Close admission durably before rechecking an earlier proof. If the
        // read or verification becomes uncertain, the guard already survives.
        await budget.mark(id, 'attempted');
      }
      try {
        return await confirmed(row, await (send ? localBuyer.send(id) : localBuyer.retrieve(id)));
      } catch {
        // Preserve identity even when canonical proof or local persistence is unavailable.
        return { ...metadata(row), state: 'retrieval-required', code: 'CLIENT_RETRIEVAL_REQUIRED' };
      }
    }
    const service: Client = Object.freeze({
      preview(bodyInput: Uint8Array) { return bodyOperation(bodyInput, async body => {
        if (previews.size >= 32) throw Error('CLIENT_PREVIEW_LIMIT');
        const expiresAt = String(await now() + 120n);
        const unsigned = await localBuyer.preview(body);
        const preview: ClientPreview = Object.freeze({ requestId: unsigned.requestId, requestHash: unsigned.requestHash,
          bodyHash: keccak256(body), url: unsigned.url, payer: config.roles.payer, serviceId: config.serviceId,
          maxGross, expiresAt, terms: Object.freeze({ ...unsigned.terms }) });
        previews.set(preview.requestId, preview); return preview;
      }); },
      authorize(id: Hex, approval: Readonly<{ approved: true }>) {
        let approved = false; try { approved = explicitApproval(approval); } catch { /* fixed denial */ }
        return operation(async () => {
          if (!approved) throw Error('CLIENT_APPROVAL_REQUIRED');
          if (!account) throw Error('CLIENT_SIGNER_REQUIRED');
          requestId(id); const preview = previews.get(id); previews.delete(id);
          if (!preview) throw Error('CLIENT_PREVIEW_REQUIRED');
          budget.assertAdmission();
          if (await now() >= BigInt(preview.expiresAt)) throw Error('CLIENT_PREVIEW_EXPIRED');
          activeApproval = preview;
          try {
            const authorized = await localBuyer.authorize(id), row = budget.get(id);
            if (authorized.requestHash !== row.requestHash || authorized.coverageId !== row.coverageId) throw Error('CLIENT_REQUEST_BINDING_MISMATCH');
            await budget.mark(id, 'authorized'); fresh.add(id);
            return Object.freeze({ ...authorized });
          } finally { activeApproval = undefined; }
        });
      },
      send(id: Hex) { return operation(() => getResult(id, true)); },
      retrieve(id: Hex) { return operation(() => getResult(id, false)); },
      readState(id?: Hex) { return operation(() => readState(id)); },
      uploadEvidence(id: Hex, body: Uint8Array) { return bodyOperation(body, captured => localClaims.uploadEvidence(id, captured)); },
      readEvidence(id: Hex, hash: Hex) { return operation(() => localClaims.readEvidence(id, hash)); },
      fileClaim(id: Hex, hash: Hex, approval: Readonly<{ approved: true }>) {
        let approved = false; try { approved = explicitApproval(approval); } catch { /* fixed denial */ }
        return operation(async () => { if (!approved) throw Error('CLIENT_APPROVAL_REQUIRED'); return localClaims.fileClaim(id, hash, { approved: true }); });
      },
      reconcileClaims() { return operation(() => localClaims.reconcileClaims()); },
      close(): Promise<void> {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          await tail; previews.clear(); fresh.clear();
          const stopped = await Promise.allSettled([localBuyer.close(), localClaims.close()]);
          if (stopped.some(row => row.status === 'rejected')) throw Error('CLIENT_CLOSE_FAILED');
          try { await release!(); } catch { throw Error('CLIENT_CLOSE_FAILED'); }
          closed = true;
        })(); return closePromise;
      },
    });
    return service;
  } catch (error) {
    const stopped = await Promise.allSettled([buyer?.close(), claims?.close()]);
    if (stopped.every(row => row.status === 'fulfilled')) await release?.().catch(() => undefined);
    throw Error(clientErrorCode(error));
  }
}
