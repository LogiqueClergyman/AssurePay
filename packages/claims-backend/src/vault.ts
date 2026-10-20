import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import { canonicalJson, exact, requireId } from './common.js';
import type { ObjectKind, Vault } from './types.js';

const MAX_PLAINTEXT = 262_144;
const MAX_FILE = MAX_PLAINTEXT * 2 + 2048;
const HEX = /^(?:[0-9a-f]{2})*$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const KINDS = new Set<ObjectKind>(['result', 'evidence', 'decision']);
type Envelope = { version: 1; namespace: string; keyId: string; kind: ObjectKind; id: Hex; iv: string; tag: string; ciphertext: string };

function fail(code: string): never { throw new Error(code); }
function aadFor(namespace: string, keyId: string, kind: ObjectKind, id: Hex): Buffer {
  return Buffer.from(canonicalJson({ version: 1, namespace, keyId, kind, id }), 'utf8');
}
function objectPath(directory: string, kind: ObjectKind, id: Hex): string { return join(directory, `${kind}-${id.slice(2)}.json`); }
function validKind(kind: unknown): kind is ObjectKind { return typeof kind === 'string' && KINDS.has(kind as ObjectKind); }
function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && HEX.test(value);
}
function parseEnvelope(raw: unknown, expected: { namespace: string; keyId: string; kind: ObjectKind; id: Hex }): Envelope {
  const row = exact(raw, ['version', 'namespace', 'keyId', 'kind', 'id', 'iv', 'tag', 'ciphertext']);
  if (row.version !== 1 || row.namespace !== expected.namespace || row.keyId !== expected.keyId || row.kind !== expected.kind || row.id !== expected.id ||
      !isHex(row.iv, 12) || !isHex(row.tag, 16) || typeof row.ciphertext !== 'string' || !HEX.test(row.ciphertext) || row.ciphertext.length > MAX_PLAINTEXT * 2) fail('VAULT_CORRUPT');
  return row as Envelope;
}

/** Immutable encrypted JSON objects in a trusted local directory. */
export class EncryptedVault implements Vault {
  private readonly directory: string;
  private readonly key: Buffer;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: { directory: string; namespace: string; keyId: string; key: Uint8Array }) {
    if (typeof options.directory !== 'string' || !options.directory) fail('VAULT_CONFIG');
    if (typeof options.namespace !== 'string' || !/^[0-9a-f]{64}$/.test(options.namespace)) fail('VAULT_CONFIG');
    if (typeof options.keyId !== 'string' || !KEY_ID.test(options.keyId)) fail('VAULT_CONFIG');
    if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) fail('VAULT_KEY');
    this.directory = resolve(options.directory);
    if (parse(this.directory).root === this.directory) fail('VAULT_CONFIG');
    this.namespace = options.namespace;
    this.keyId = options.keyId;
    this.key = Buffer.from(options.key);
  }

  private readonly namespace: string;
  private readonly keyId: string;

  async put(kind: ObjectKind, idInput: Hex, value: unknown): Promise<void> {
    if (!validKind(kind)) fail('VAULT_KIND');
    const id = requireId(idInput);
    // Serialize synchronously so callers cannot mutate nested input during I/O.
    const plaintext = Buffer.from(canonicalJson(value), 'utf8');
    if (plaintext.byteLength > MAX_PLAINTEXT) fail('VAULT_SIZE');
    const key = `${kind}:${id}`;
    await this.exclusive(key, async () => {
      await this.ensureDirectory();
      const path = objectPath(this.directory, kind, id);
      const existing = await this.readEnvelope(path, kind, id, true);
      if (existing !== undefined) {
        const opened = this.decrypt(existing, kind, id);
        if (!opened.equals(plaintext)) fail('VAULT_CONFLICT');
        return;
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(aadFor(this.namespace, this.keyId, kind, id));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: Envelope = {
        version: 1, namespace: this.namespace, keyId: this.keyId, kind, id,
        iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex'),
      };
      const encoded = Buffer.from(canonicalJson(envelope) + '\n', 'utf8');
      if (encoded.byteLength > MAX_FILE) fail('VAULT_SIZE');
      await this.createImmutable(path, encoded, kind, id);
    });
  }

  async get(kind: ObjectKind, idInput: Hex): Promise<unknown | undefined> {
    if (!validKind(kind)) fail('VAULT_KIND');
    const id = requireId(idInput);
    await this.ensureDirectory();
    const envelope = await this.readEnvelope(objectPath(this.directory, kind, id), kind, id, false);
    if (!envelope) return undefined;
    const plaintext = this.decrypt(envelope, kind, id);
    try {
      const value: unknown = JSON.parse(plaintext.toString('utf8'));
      // Reject alternate/noncanonical encodings and unsupported JSON values.
      if (canonicalJson(value) !== plaintext.toString('utf8')) fail('VAULT_CORRUPT');
      return value;
    } catch { fail('VAULT_CORRUPT'); }
  }

  private async ensureDirectory(): Promise<void> {
    try { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
    catch { fail('VAULT_UNAVAILABLE'); }
    try {
      const info = await lstat(this.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) fail('VAULT_UNSAFE_PATH');
    } catch (error) {
      if (error instanceof Error && error.message === 'VAULT_UNSAFE_PATH') throw error;
      fail('VAULT_UNAVAILABLE');
    }
  }

  private async readEnvelope(path: string, kind: ObjectKind, id: Hex, absentOkay: boolean): Promise<Envelope | undefined> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) fail('VAULT_UNSAFE_PATH');
      if ((info.mode & 0o777) !== 0o600 || info.size > MAX_FILE || info.size === 0) fail('VAULT_CORRUPT');
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.size > MAX_FILE) fail('VAULT_CORRUPT');
        bytes = await handle.readFile();
      } finally { await handle.close(); }
      if (bytes.byteLength > MAX_FILE || !bytes.toString('utf8').endsWith('\n')) fail('VAULT_CORRUPT');
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('VAULT_CORRUPT'); }
      const envelope = parseEnvelope(parsed, { namespace: this.namespace, keyId: this.keyId, kind, id });
      if (canonicalJson(envelope) + '\n' !== bytes.toString('utf8')) fail('VAULT_CORRUPT');
      return envelope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && absentOkay) return undefined;
      if (error instanceof Error && /^VAULT_/.test(error.message)) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      fail('VAULT_UNAVAILABLE');
    }
  }

  private decrypt(envelope: Envelope, kind: ObjectKind, id: Hex): Buffer {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'hex'));
      decipher.setAAD(aadFor(this.namespace, this.keyId, kind, id));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]);
      if (plain.byteLength > MAX_PLAINTEXT) fail('VAULT_CORRUPT');
      return plain;
    } catch (error) {
      if (error instanceof Error && error.message === 'VAULT_CORRUPT') throw error;
      fail('VAULT_CORRUPT');
    }
  }

  private async createImmutable(path: string, bytes: Buffer, kind: ObjectKind, id: Hex): Promise<void> {
    const tmp = join(this.directory, `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close(); handle = undefined;
      try { await link(tmp, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const found = await this.readEnvelope(path, kind, id, false);
        const candidate = parseEnvelope(JSON.parse(bytes.toString('utf8')), { namespace: this.namespace, keyId: this.keyId, kind, id });
        if (!found || !this.decrypt(found, kind, id).equals(this.decrypt(candidate, kind, id))) fail('VAULT_CONFLICT');
      }
      await unlink(tmp);
      const dir = await open(dirname(path), constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      if (error instanceof Error && /^VAULT_/.test(error.message)) throw error;
      fail('VAULT_WRITE_FAILED');
    } finally { await handle?.close().catch(() => undefined); await unlink(tmp).catch(() => undefined); }
  }

  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const queued = prior.then(() => gate);
    this.queues.set(key, queued);
    await prior;
    try { return await action(); }
    finally { release(); if (this.queues.get(key) === queued) this.queues.delete(key); }
  }
}
