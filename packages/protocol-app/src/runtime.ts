import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { createClients, ensureDirectory } from '../../developer-pilot/src/config.js';
import { authorize } from '../../developer-pilot/src/auth.js';
import { createClaimsClient } from '../../developer-pilot/src/claims-client.js';
import { acquireRunLock } from '../../evm-acceptance/src/run-lock.js';
import { captureAccount } from './accounts.js';
import { amount, exact, hashValue, id, roleAddress } from './common.js';
import { validateProtocolConfig } from './config.js';
import { protocolErrorCode } from './errors.js';
import { CORE_ABI } from './abi.js';
import { createReadModel } from './reads.js';
import { createRoleSender } from './sender.js';
import type { ActionResult, Operation, ProtocolOptions, ProtocolRuntime, Role, RoleSender, SigningRole } from './types.js';

const signingRoles = ['admin', 'provider', 'adjudicator'] as const;
const allowed: Readonly<Record<SigningRole, readonly Operation['kind'][]>> = {
  admin: ['registerProvider','registerPolicy','setPaused','fundPool','approveCore'],
  provider: ['depositStake','withdrawStake','approveCore'], adjudicator: ['finalizeClaim'],
};
async function privateFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > 2_097_152)
    throw Error('PROTOCOL_STORAGE_INVALID');
}

/** Single-host role composition; browser authority is supplied only by http.ts sessions. */
export async function createProtocolRuntime(options: ProtocolOptions): Promise<ProtocolRuntime> {
  let release: (() => Promise<void>) | undefined;
  const senders = new Map<SigningRole, RoleSender>();
  try {
    exact(options, ['config','storage','limits',...(Object.hasOwn(options,'accounts') ? ['accounts'] : [])]);
    exact(options.storage, ['directory','key']);
    exact(options.limits, ['maxActionAmount','maxActions']);
    if (options.accounts !== undefined) {
      const keys = Reflect.ownKeys(options.accounts);
      if (keys.some(key => typeof key !== 'string' || !signingRoles.includes(key as SigningRole))) throw Error('PROTOCOL_ARGUMENT_INVALID');
      exact(options.accounts, keys as string[]);
    }
    const config = validateProtocolConfig(options.config), directoryInput = options.storage.directory;
    const key = options.storage.key;
    if (typeof directoryInput !== 'string' || !directoryInput || !(key instanceof Uint8Array) || key.length !== 32)
      throw Error('PROTOCOL_ARGUMENT_INVALID');
    const keyHash = keccak256(Uint8Array.from(key));
    const limits = Object.freeze({ maxActionAmount: amount(options.limits.maxActionAmount), maxActions: options.limits.maxActions });
    if (BigInt(limits.maxActionAmount) === 0n || !Number.isInteger(limits.maxActions) || limits.maxActions < 1 || limits.maxActions > 256)
      throw Error('PROTOCOL_LIMIT');
    const accounts = Object.fromEntries(signingRoles.map(role => [role, captureAccount(options.accounts?.[role], roleAddress(config, role))]));
    const namespace = hashValue({ config, limits, keyHash });
    const directory = await ensureDirectory(directoryInput);
    if (((await lstat(directory)).mode & 0o077) !== 0) throw Error('PROTOCOL_STORAGE_INVALID');
    try { release = await acquireRunLock(join(directory, 'app.lock')); } catch { throw Error('PROTOCOL_LOCKED'); }
    const contextPath = join(directory, 'context.json');
    let existing = false;
    try {
      await privateFile(contextPath);
      const handle = await open(contextPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(); if (stat.size > 4096) throw Error('PROTOCOL_STORAGE_INVALID');
        const row = exact(JSON.parse(await handle.readFile('utf8')), ['version', 'namespace']);
        if (row.version !== 1 || row.namespace !== namespace) throw Error('PROTOCOL_CONTEXT_MISMATCH');
      } finally { await handle.close(); }
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if ((await readdir(directory)).some(name => name !== 'app.lock')) throw Error('PROTOCOL_JOURNAL_MISSING');
    }
    const { client, wallet } = createClients(config.pilot);
    const actorDirectory = await ensureDirectory(join(directory, 'actors'));
    for (const role of signingRoles) {
      const path = await ensureDirectory(join(actorDirectory, role));
      if (existing) {
        try { await privateFile(join(path, 'journal.json')); }
        catch { throw Error('PROTOCOL_JOURNAL_MISSING'); }
      }
      senders.set(role, await createRoleSender({ config, role, account: accounts[role], directory: path, limits, client, wallet }));
    }
    const readDirectory = await ensureDirectory(join(directory, 'reads'));
    const readModel = createReadModel({ config, client, directory: readDirectory });
    // Record the completed layout last. Interrupted partial creation cannot reset.
    if (!existing) {
      const handle = await open(contextPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, namespace })); await handle.sync(); } finally { await handle.close(); }
      const dir = await open(directory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    }
    const claims = createClaimsClient({ url: config.pilot.claimsUrl });
    const active = new Set<Promise<unknown>>(); let closing = false, closePromise: Promise<void> | undefined;
    function operation<T>(task: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(Error('PROTOCOL_CLOSED'));
      const promise = (async () => task())().catch(error => { throw Error(protocolErrorCode(error)); });
      active.add(promise); void promise.finally(() => active.delete(promise)).catch(() => undefined); return promise;
    }
    function sender(role: Role): RoleSender {
      roleAddress(config, role);
      if (role === 'operator') throw Error('PROTOCOL_FORBIDDEN');
      return senders.get(role)!;
    }
    const capabilities = Object.freeze({
      admin: Object.freeze(accounts.admin ? [...allowed.admin] : []), provider: Object.freeze(accounts.provider ? [...allowed.provider] : []),
      adjudicator: Object.freeze(accounts.adjudicator ? [...allowed.adjudicator] : []), operator: Object.freeze([]),
    });
    return Object.freeze({
      config, capabilities,
      snapshot() { return operation(() => readModel.snapshot()); },
      assertAnchor(anchor) { return operation(() => readModel.assertAnchor({ ...anchor })); },
      preview(role, input) { return operation(() => sender(role).preview(input)); },
      confirm(role, previewId, approval) { return operation(() => sender(role).confirm(previewId, approval)); },
      reconcile(role) { return operation(async () => {
        roleAddress(config, role);
        if (role !== 'operator') return sender(role).reconcile();
        const rows: ActionResult[] = [];
        for (const current of senders.values()) rows.push(...await current.reconcile());
        return rows;
      }); },
      readEvidence(role, coverageId) { return operation(async () => {
        if (role !== 'adjudicator') throw Error('PROTOCOL_FORBIDDEN');
        const account = accounts.adjudicator; if (!account) throw Error('PROTOCOL_SIGNER_REQUIRED');
        id(coverageId);
        const snapshot = await readModel.snapshot(), coverage = snapshot.coverages.find(row => row.coverageId === coverageId);
        if (!coverage || ![2,3,4].includes(coverage.status) || !coverage.hasEvidence) throw Error('PROTOCOL_NOT_FOUND');
        const raw = await client.readContract({ address: config.pilot.core, abi: CORE_ABI, functionName: 'coverages',
          args: [coverageId], blockNumber: BigInt(snapshot.anchor.number) });
        const evidenceHash = id(raw[14]); await readModel.assertAnchor(snapshot.anchor);
        const auth = await authorize(client, config.pilot, account, 'readEvidence', coverageId, { evidenceHash });
        const bytes = await claims.readEvidence(coverageId, evidenceHash, auth);
        if (bytes.byteLength > 65_536) throw Error('PROTOCOL_LIMIT');
        return Uint8Array.from(bytes);
      }); },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          await Promise.allSettled([...active]);
          const stopped = await Promise.allSettled([...senders.values()].map(row => row.close()));
          if (stopped.some(row => row.status === 'rejected')) throw Error('PROTOCOL_CLOSE_FAILED');
          try { await release!(); } catch { throw Error('PROTOCOL_CLOSE_FAILED'); }
        })(); return closePromise;
      },
    } satisfies ProtocolRuntime);
  } catch (error) {
    const stopped = await Promise.allSettled([...senders.values()].map(row => row.close()));
    if (stopped.every(row => row.status === 'fulfilled')) await release?.().catch(() => undefined);
    throw Error(protocolErrorCode(error));
  }
}
