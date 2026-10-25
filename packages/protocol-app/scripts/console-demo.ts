import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createConsoleFixture, parseConsoleArgs } from '../test/console-fixture.js';
import type { Role } from '../src/types.js';

function safeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return /^PROTOCOL_[A-Z_]+$/.test(code) || /^CONSOLE_[A-Z_]+$/.test(code) ? code : 'CONSOLE_COMMAND_FAILED';
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Validate the complete grammar before allocating a fixture, directory, provider or chain.
  let selected: Role;
  try { selected = parseConsoleArgs(args); }
  catch { throw Error('CONSOLE_ARGUMENT_INVALID'); }
  const fixture = await createConsoleFixture({ role: selected, startServer: false });
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let input: ReturnType<typeof createInterface> | undefined;
  try {
    const url = await fixture.startRole(selected);
    // Only public host URL and explicitly selected role are printed at startup.
    stdout.write(`Ready: ${url} (${selected})\n`);
    input = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    while (!abort.signal.aborted) {
      let line: string;
      try { line = await input.question('console> ', { signal: abort.signal }); }
      catch { break; }
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const [command, value, ...extra] = parts;
      if (command === 'quit' && parts.length === 1) break;
      try {
        if (command === 'status' && parts.length === 1) {
          const snapshot = await fixture.snapshot();
          const payerBalanceAtomic = (await fixture.payerBalance(BigInt(snapshot.anchor.number))).toString();
          const output = {
            role: fixture.role,
            context: { localOnly: true, chainId: 84532, core: fixture.runtime.config.pilot.core,
              token: fixture.runtime.config.pilot.token, providerId: fixture.runtime.config.pilot.providerId,
              policyId: fixture.runtime.config.pilot.policyId },
            anchor: snapshot.anchor,
            summary: snapshot.summary,
            payerBalanceAtomic,
            counters: fixture.counters(),
            coverageIds: fixture.ids,
          };
          stdout.write(`${JSON.stringify(output)}\n`);
        } else if (command === 'role' && parts.length === 2 && extra.length === 0 &&
          ['admin', 'provider', 'adjudicator', 'operator'].includes(value ?? '')) {
          const role = value as Role;
          const nextUrl = await fixture.startRole(role);
          stdout.write(`Ready: ${nextUrl} (${role})\n`);
        } else if (command === 'rpc-off' && parts.length === 1) {
          fixture.rpcOff(); stdout.write('RPC offline\n');
        } else if (command === 'rpc-on' && parts.length === 1) {
          fixture.rpcOn(); stdout.write('RPC online\n');
        } else if (command === 'expire-preview' && parts.length === 1) {
          await fixture.expirePreview(); stdout.write('Local preview time advanced\n');
        } else if (command === 'lose-next-send' && parts.length === 1) {
          fixture.loseNextSend(); stdout.write('One-send response loss armed\n');
        } else if (command === 'reveal' && parts.length === 1) {
          fixture.reveal(); stdout.write('Original transaction is visible to read-only reconciliation\n');
        } else {
          stdout.write('CONSOLE_COMMAND_INVALID\n');
        }
      } catch (error) { stdout.write(`${safeErrorCode(error)}\n`); }
    }
  } finally {
    input?.close();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    await fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => { stdout.write(`${safeErrorCode(error)}\n`); process.exitCode = 1; });
}
