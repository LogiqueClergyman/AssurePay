import { readFile } from 'node:fs/promises';
import { exact } from './common.js';
import { protocolErrorCode } from './errors.js';
import { startProtocolServer } from './http.js';
import type { ProtocolRuntime, ProtocolServer, Role } from './types.js';

const ROLES: readonly Role[] = ['admin', 'provider', 'adjudicator', 'operator'];

/** Starts the fixed application-owned browser console for one trusted host-selected role. */
export async function startProtocolConsole(input: { readonly runtime: ProtocolRuntime; readonly role: Role }): Promise<ProtocolServer> {
  try {
    const row = exact(input, ['runtime', 'role']);
    const runtime = row.runtime as ProtocolRuntime;
    const role = row.role as Role;
    if (!runtime || typeof runtime !== 'object' || !ROLES.includes(role)) throw Error('PROTOCOL_ARGUMENT_INVALID');
    const [html, javascript, stylesheet] = await Promise.all([
      readFile(new URL('../console/index.html', import.meta.url), 'utf8'),
      readFile(new URL('../console/app.js', import.meta.url), 'utf8'),
      readFile(new URL('../console/styles.css', import.meta.url), 'utf8'),
    ]);
    return await startProtocolServer({ runtime, console: { role, assets: { html, javascript, stylesheet } } });
  } catch (error) { throw Error(protocolErrorCode(error)); }
}
