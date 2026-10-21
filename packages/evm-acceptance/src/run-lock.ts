import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const MARKER = 'assurepay-m5-run-lock-v1\n';

/** Acquire an exclusive lock file. Existing locks, including stale locks, fail closed. */
export async function acquireRunLock(path: string): Promise<() => Promise<void>> {
  if (!path) throw new Error('M5_RUN_LOCK_UNAVAILABLE');

  let handle: FileHandle | undefined;
  try {
    handle = await open(path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const identity = await handle.stat();
    if (!identity.isFile()) throw new Error();
    await handle.writeFile(MARKER, 'utf8');
    await handle.sync();
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    const created = await lstat(path);
    if (!created.isFile() || created.isSymbolicLink() || created.dev !== identity.dev || created.ino !== identity.ino) {
      throw new Error();
    }

    let released = false;
    return async () => {
      if (released) return;
      try {
        const current = await lstat(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new Error();
        }
        await unlink(path);
        const parent = await open(dirname(path), constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
        released = true;
      } catch {
        throw new Error('M5_RUN_LOCK_RELEASE_FAILED');
      } finally {
        await handle?.close().catch(() => undefined);
        handle = undefined;
      }
    };
  } catch {
    if (handle) {
      try {
        const identity = await handle.stat();
        const current = await lstat(path);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
          await unlink(path);
        }
      } catch { /* leave any path we cannot prove was created by this call */ }
      await handle.close().catch(() => undefined);
    }
    throw new Error('M5_RUN_LOCK_UNAVAILABLE');
  }
}
