import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  encodeAbiParameters, keccak256, recoverTypedDataAddress, toHex,
  type Address, type Hex,
} from 'viem';
import { canonicalJson, contextNamespace, exact, hashJson, normalizeContext, requireAddress, requireId, uint } from './common.js';
import type { Authorization, BackendContext, Operation } from './types.js';

const OPERATIONS = new Set<Operation>(['uploadEvidence', 'readEvidence', 'prepareClaim', 'prepareDecision']);
const MAX_REPLAY_ENTRIES = 10_000;
const MAX_REPLAY_FILE_BYTES = 1_000_000;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;

export function operationPayloadHash(payload: unknown): Hex {
  return hashJson(payload);
}

export function operationTypedData(contextInput: BackendContext, messageInput: Omit<Authorization, 'signature'>) {
  const context = normalizeContext(contextInput);
  const message = exact(messageInput, ['actor', 'operation', 'coverageId', 'payloadHash', 'nonce', 'deadline']);
  const actor = requireAddress(message.actor);
  if (!OPERATIONS.has(message.operation as Operation)) throw new Error('AUTH_INVALID');
  const coverageId = requireId(message.coverageId);
  const payloadHash = requireId(message.payloadHash, true);
  const nonce = requireId(message.nonce);
  const deadline = uint(message.deadline);
  if (deadline > BigInt(Number.MAX_SAFE_INTEGER) || typeof message.deadline !== 'string') throw new Error('AUTH_INVALID');
  return {
    domain: {
      name: 'AssurePayBackend', version: '1', chainId: context.chainId,
      verifyingContract: context.core, salt: context.serviceId,
    },
    types: {
      BackendOperationV1: [
        { name: 'actor', type: 'address' },
        { name: 'operation', type: 'string' },
        { name: 'coverageId', type: 'bytes32' },
        { name: 'payloadHash', type: 'bytes32' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'BackendOperationV1' as const,
    message: { actor, operation: message.operation as Operation, coverageId, payloadHash, nonce, deadline },
  };
}

type ReplayHeader = { version: 1; namespace: string };
type ReplayRow = { digest: Hex };

/** A single-process append-only replay journal. Only actor/nonce hashes are stored. */
export class ReplayJournal {
  private readonly used = new Set<Hex>();
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private readonly namespace: string) {}

  static async open(path: string, context: BackendContext): Promise<ReplayJournal> {
    if (typeof path !== 'string' || !path) throw new Error('REPLAY_PATH');
    const journal = new ReplayJournal(path, contextNamespace(context));
    let bytes: Buffer;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > MAX_REPLAY_FILE_BYTES) throw new Error('REPLAY_CORRUPT');
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { bytes = await handle.readFile(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return journal;
      if (error instanceof Error && error.message.startsWith('REPLAY_')) throw error;
      throw new Error('REPLAY_UNAVAILABLE');
    }
    const content = bytes.toString('utf8');
    if (!content.endsWith('\n') || Buffer.byteLength(content) > MAX_REPLAY_FILE_BYTES) throw new Error('REPLAY_CORRUPT');
    const lines = content.slice(0, -1).split('\n');
    if (lines.length < 1 || lines.length > MAX_REPLAY_ENTRIES + 1) throw new Error('REPLAY_CORRUPT');
    let header: ReplayHeader;
    try {
      const row = exact(JSON.parse(lines[0]!) as unknown, ['version', 'namespace']);
      if (row.version !== 1 || typeof row.namespace !== 'string' || !/^[0-9a-f]{64}$/.test(row.namespace)) throw new Error();
      header = row as ReplayHeader;
    } catch { throw new Error('REPLAY_CORRUPT'); }
    if (header.namespace !== journal.namespace) throw new Error('REPLAY_CONTEXT');
    for (const line of lines.slice(1)) {
      try {
        const row = exact(JSON.parse(line) as unknown, ['digest']) as ReplayRow;
        if (typeof row.digest !== 'string' || !/^0x[0-9a-f]{64}$/.test(row.digest) || journal.used.has(row.digest)) throw new Error();
        journal.used.add(row.digest);
      } catch { throw new Error('REPLAY_CORRUPT'); }
    }
    return journal;
  }

  async consume(actor: Address, nonce: Hex): Promise<void> {
    // Both fields have fixed ABI widths, so this is an unambiguous actor/nonce key.
    const digest = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [actor, nonce]));
    const run = this.writeTail.then(() => this.consumeOne(digest));
    this.writeTail = run.catch(() => undefined);
    return run;
  }

  private async consumeOne(digest: Hex): Promise<void> {
    if (this.used.has(digest)) throw new Error('AUTH_REPLAY');
    if (this.used.size >= MAX_REPLAY_ENTRIES) throw new Error('REPLAY_CAP');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).catch(() => { throw new Error('REPLAY_UNAVAILABLE'); });
    let handle;
    try {
      let exists = true;
      try {
        const info = await lstat(this.path);
        if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > MAX_REPLAY_FILE_BYTES) throw new Error('REPLAY_CORRUPT');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else throw error;
      }
      if (!exists) {
        handle = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(`${canonicalJson({ version: 1, namespace: this.namespace } satisfies ReplayHeader)}\n`, 'utf8');
      } else {
        handle = await open(this.path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
      }
      await handle.writeFile(`${canonicalJson({ digest } satisfies ReplayRow)}\n`, 'utf8');
      await handle.sync();
      if (!exists) {
        const dir = await open(dirname(this.path), constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      }
      this.used.add(digest);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('REPLAY_')) throw error;
      throw new Error('REPLAY_WRITE_FAILED');
    } finally { await handle?.close().catch(() => undefined); }
  }
}

export async function verifyAuthorization(
  context: BackendContext,
  authorizationInput: Authorization,
  expected: { operation: Operation; coverageId: Hex; payloadHash: Hex; now: bigint },
): Promise<Authorization> {
  try {
    const raw = exact(authorizationInput, ['actor', 'operation', 'coverageId', 'payloadHash', 'nonce', 'deadline', 'signature']);
    const actor = requireAddress(raw.actor);
    if (actor === ZERO_ADDRESS || raw.operation !== expected.operation) throw new Error();
    const coverageId = requireId(raw.coverageId);
    const payloadHash = requireId(raw.payloadHash, true);
    const nonce = requireId(raw.nonce);
    if (nonce === ZERO32 || coverageId !== expected.coverageId || payloadHash !== expected.payloadHash) throw new Error();
    const deadline = uint(raw.deadline);
    if (deadline <= expected.now || deadline > expected.now + 300n) throw new Error();
    if (typeof raw.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(raw.signature)) throw new Error();
    const typed = operationTypedData(context, { actor, operation: expected.operation, coverageId, payloadHash, nonce, deadline: raw.deadline });
    const recovered = await recoverTypedDataAddress({ ...typed, signature: raw.signature as Hex });
    if (recovered.toLowerCase() !== actor) throw new Error();
    return { actor, operation: expected.operation, coverageId, payloadHash, nonce, deadline: raw.deadline, signature: raw.signature as Hex };
  } catch { throw new Error('AUTH_INVALID'); }
}

export function randomNonce(): Hex { return toHex(randomBytes(32)); }
