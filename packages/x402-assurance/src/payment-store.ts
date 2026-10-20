import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Hex } from 'viem';
import type { Terms } from './types.js';

/** Public, signature-free identity for one attempted Core call. */
export interface PaymentRecord {
  version: 1;
  chainId: number;
  core: string;
  token: string;
  relayer: string;
  intentHash: Hex;
  calldataHash: Hex;
  nonce: string;
  transaction: Hex;
  termsHash: string;
  terms: Terms;
  status: 'prepared' | 'pending' | 'confirmed' | 'reverted';
  coverageId: Hex;
  blockNumber?: string;
  blockHash?: Hex;
}

export interface PaymentNamespace {
  chainId: number;
  core: string;
  token: string;
  relayer: string;
  termsHash: string;
}

interface Journal { version: 1; namespace: PaymentNamespace; records: Record<string, PaymentRecord> }

const fixed = () => new Error('PAYMENT_JOURNAL_UNAVAILABLE');
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const uintString = /^(0|[1-9][0-9]*)$/;
const termsKeys = ['chainId', 'core', 'token', 'providerId', 'policyId', 'providerOwner', 'providerPayout', 'policyHash',
  'premiumBps', 'stakeBps', 'withholdingBps', 'duration', 'poolOnlyAllowed', 'gross', 'premium', 'withheld', 'net',
  'stakeLock', 'poolReservation', 'tokenName', 'tokenVersion'];
const recordKeys = ['version', 'chainId', 'core', 'token', 'relayer', 'intentHash', 'calldataHash', 'nonce', 'transaction',
  'termsHash', 'terms', 'status', 'coverageId'];
const optionalRecordKeys = ['blockNumber', 'blockHash'];
const namespaceKeys = ['chainId', 'core', 'token', 'relayer', 'termsHash'];

const exactKeys = (value: any, required: string[], optional: string[] = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
};
const jsonHash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function validTerms(terms: any): terms is Terms {
  if (!(exactKeys(terms, termsKeys) && terms.chainId === 84532 && address.test(terms.core) && address.test(terms.token) &&
    hex32.test(terms.providerId) && hex32.test(terms.policyId) && address.test(terms.providerOwner) && address.test(terms.providerPayout) &&
    hex32.test(terms.policyHash) && Number.isSafeInteger(terms.premiumBps) && terms.premiumBps >= 0 && terms.premiumBps <= 9999 &&
    Number.isSafeInteger(terms.stakeBps) && terms.stakeBps >= 0 && terms.stakeBps <= 10000 &&
    Number.isSafeInteger(terms.withholdingBps) && terms.withholdingBps >= 0 && terms.withholdingBps <= 9999 &&
    ['duration', 'gross', 'premium', 'withheld', 'net', 'stakeLock', 'poolReservation'].every(k => typeof terms[k] === 'string' && uintString.test(terms[k])) &&
    typeof terms.poolOnlyAllowed === 'boolean' && terms.tokenName === 'USDC' && terms.tokenVersion === '2')) return false;
  const gross = BigInt(terms.gross), premium = BigInt(terms.premium), withheld = BigInt(terms.withheld), net = BigInt(terms.net);
  const stakeLock = BigInt(terms.stakeLock), poolReservation = BigInt(terms.poolReservation), duration = BigInt(terms.duration);
  if (gross < 2n || duration === 0n) return false;
  const expectedPremiumRaw = gross * BigInt(terms.premiumBps) / 10_000n;
  const expectedPremium = expectedPremiumRaw === 0n ? 1n : expectedPremiumRaw;
  const expectedWithheld = (gross - expectedPremium) * BigInt(terms.withholdingBps) / 10_000n;
  const expectedStakeLock = (gross * BigInt(terms.stakeBps) + 9_999n) / 10_000n;
  return expectedPremium < gross && premium === expectedPremium && withheld === expectedWithheld &&
    net === gross - premium - withheld && net > 0n && stakeLock === expectedStakeLock &&
    poolReservation === (terms.poolOnlyAllowed ? gross : gross - stakeLock);
}

function validNamespace(namespace: any): namespace is PaymentNamespace {
  return exactKeys(namespace, namespaceKeys) && namespace.chainId === 84532 && address.test(namespace.core) && address.test(namespace.token) &&
    address.test(namespace.relayer) && /^[0-9a-f]{64}$/.test(namespace.termsHash);
}

function validateRecord(record: any, key: string, namespace: PaymentNamespace): record is PaymentRecord {
  if (!exactKeys(record, recordKeys, optionalRecordKeys) || record.version !== 1 || record.chainId !== namespace.chainId ||
      !address.test(record.core) || !address.test(record.token) || !address.test(record.relayer) ||
      !hex32.test(record.intentHash) || key !== record.intentHash.toLowerCase() || !hex32.test(record.calldataHash) ||
      !hex32.test(record.transaction) || !hex32.test(record.coverageId) || !uintString.test(record.nonce) ||
      !/^[0-9a-f]{64}$/.test(record.termsHash) || !['prepared', 'pending', 'confirmed', 'reverted'].includes(record.status) ||
      (record.blockNumber !== undefined && (typeof record.blockNumber !== 'string' || !uintString.test(record.blockNumber))) ||
      (record.blockHash !== undefined && !hex32.test(record.blockHash)) || !validTerms(record.terms)) return false;
  if ((record.blockNumber === undefined) !== (record.blockHash === undefined) ||
      (['confirmed', 'reverted'].includes(record.status) !== (record.blockNumber !== undefined))) return false;
  return same(record.core, namespace.core) && same(record.token, namespace.token) && same(record.relayer, namespace.relayer) &&
    record.termsHash === namespace.termsHash && record.termsHash === safeTermsHash(record.terms) && record.coverageId.toLowerCase() === record.intentHash.toLowerCase() &&
    same(record.terms.core, record.core) && same(record.terms.token, record.token) && record.terms.chainId === record.chainId;
}

function identity(record: PaymentRecord): string {
  return stableJson({ version: record.version, chainId: record.chainId, core: record.core, token: record.token, relayer: record.relayer,
    intentHash: record.intentHash, calldataHash: record.calldataHash, nonce: record.nonce, transaction: record.transaction,
    termsHash: record.termsHash, terms: record.terms, coverageId: record.coverageId });
}

/** A tiny durable, namespaced, schema-checked single-file journal. */
export class PaymentStore {
  readonly path: string;
  readonly namespace: PaymentNamespace;
  constructor(path: string, namespace: PaymentNamespace) {
    if (!validNamespace(namespace)) throw fixed();
    this.path = path;
    this.namespace = Object.freeze(structuredClone(namespace));
  }

  async get(intentHash: Hex): Promise<PaymentRecord | undefined> {
    return this.locked(async () => (await this.load()).records[intentHash.toLowerCase()]);
  }

  async list(): Promise<PaymentRecord[]> {
    return this.locked(async () => Object.values((await this.load()).records));
  }

  async create(record: PaymentRecord): Promise<PaymentRecord> {
    return this.locked(async () => {
      const state = await this.load();
      const key = record.intentHash.toLowerCase();
      if (!validateRecord(record, key, this.namespace)) throw fixed();
      if (state.records[key]) throw new Error('PAYMENT_ALREADY_RECORDED');
      state.records[key] = structuredClone(record);
      await this.save(state);
      return structuredClone(record);
    });
  }

  async update(record: PaymentRecord): Promise<void> {
    await this.locked(async () => {
      const state = await this.load();
      const key = record.intentHash.toLowerCase();
      const prior = state.records[key];
      if (!validateRecord(record, key, this.namespace) || !prior || identity(prior) !== identity(record)) {
        throw new Error('PAYMENT_JOURNAL_MISMATCH');
      }
      const allowed = prior.status === record.status || (prior.status === 'prepared' && ['pending', 'confirmed', 'reverted'].includes(record.status)) ||
        (prior.status === 'pending' && (record.status === 'confirmed' || record.status === 'reverted'));
      if (!allowed || (prior.blockNumber !== undefined && prior.blockNumber !== record.blockNumber) ||
          (prior.blockHash !== undefined && prior.blockHash !== record.blockHash)) throw new Error('PAYMENT_JOURNAL_MISMATCH');
      state.records[key] = structuredClone(record);
      await this.save(state);
    });
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let lock;
    for (let i = 0; i < 100; i++) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (e: any) { if (e?.code !== 'EEXIST') throw fixed(); await new Promise(r => setTimeout(r, 10)); }
    }
    if (!lock) throw fixed();
    try { return await fn(); }
    catch (e: any) {
      if (e?.message?.startsWith('PAYMENT_')) throw e;
      throw fixed();
    } finally {
      await lock.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async load(): Promise<Journal> {
    let handle;
    try {
      try {
        const info = await lstat(this.path);
        if (!info.isFile() || info.isSymbolicLink()) throw fixed();
      } catch (e: any) { if (e?.code === 'ENOENT') return { version: 1, namespace: this.namespace, records: {} }; throw e; }
      handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile()) throw fixed();
      const parsed = JSON.parse(await handle.readFile('utf8'));
      if (!exactKeys(parsed, ['version', 'namespace', 'records']) || parsed.version !== 1 || !validNamespace(parsed.namespace) ||
          stableJson(parsed.namespace) !== stableJson(this.namespace) || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) throw fixed();
      for (const [key, rec] of Object.entries(parsed.records) as [string, any][]) {
        if (!validateRecord(rec, key, this.namespace)) throw fixed();
      }
      return parsed;
    } catch (e: any) {
      if (e?.message === 'PAYMENT_JOURNAL_UNAVAILABLE') throw e;
      throw fixed();
    } finally { await handle?.close().catch(() => undefined); }
  }

  private async save(state: Journal): Promise<void> {
    try {
      if (!exactKeys(state, ['version', 'namespace', 'records']) || state.version !== 1 ||
          stableJson(state.namespace) !== stableJson(this.namespace)) throw fixed();
      for (const [key, record] of Object.entries(state.records)) if (!validateRecord(record, key, this.namespace)) throw fixed();
      try { const info = await lstat(this.path); if (!info.isFile() || info.isSymbolicLink()) throw fixed(); }
      catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(tmp, this.path);
      const dir = await open(dirname(this.path), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (e: any) {
      if (e?.message === 'PAYMENT_JOURNAL_UNAVAILABLE') throw e;
      throw fixed();
    }
  }
}

export function safeTermsHash(terms: Terms): string { return jsonHash(terms); }
