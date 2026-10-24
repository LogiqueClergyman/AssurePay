import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient, readClientConfig, clientErrorCode } from '@assurepay/client-sdk';
import { privateKeyToAccount } from 'viem/accounts';

/** @typedef {import('viem').Hex} Hex */
/** @typedef {{kind:'preview'|'approve'} | {kind:'retrieve',id:Hex} | {kind:'state',id?:Hex} | {kind:'evidence',id:Hex,path:string} | {kind:'claim',id:Hex,evidenceHash:Hex}} Command */

/** @param {string | undefined} value @returns {value is Hex} */
function isHex(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value); }

/** @param {string[]} argv @returns {Command} */
function parseCommand(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--preview')) return { kind: 'preview' };
  const [command, ...args] = argv;
  if (command === '--approve' && args.length === 0) return { kind: 'approve' };
  if (command === '--retrieve' && args.length === 1 && isHex(args[0])) return { kind: 'retrieve', id: args[0] };
  if (command === '--state') {
    if (args.length === 0) return { kind: 'state' };
    if (args.length === 1 && isHex(args[0])) return { kind: 'state', id: args[0] };
  }
  if (command === '--evidence' && args.length === 2 && isHex(args[0]) && args[1]) return { kind: 'evidence', id: args[0], path: args[1] };
  if (command === '--claim' && args.length === 3 && isHex(args[0]) && isHex(args[1]) && args[2] === '--approve') {
    return { kind: 'claim', id: args[0], evidenceHash: args[1] };
  }
  throw new Error('CLIENT_INVALID_COMMAND');
}

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('CLIENT_CONFIGURATION_INVALID');
  return value;
}

function storageKey() {
  const value = required('ASSUREPAY_STORAGE_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('CLIENT_CONFIGURATION_INVALID');
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

/** @param {Command} command */
function payerAccount(command) {
  if (!['approve', 'evidence', 'claim'].includes(command.kind)) return undefined;
  const value = required('ASSUREPAY_PAYER_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('CLIENT_CONFIGURATION_INVALID');
  return privateKeyToAccount(/** @type {Hex} */ (value));
}

/** @param {unknown} value */
const safe = value => JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item);

async function main() {
  const command = parseCommand(process.argv.slice(2));
  const config = await readClientConfig(required('ASSUREPAY_CONFIG'));
  const account = payerAccount(command);
  const client = await createClient({ config,
    maxGross: required('ASSUREPAY_MAX_GROSS'),
    budget: { maxTotalGross: required('ASSUREPAY_MAX_TOTAL_GROSS'), maxPayments: Number(required('ASSUREPAY_MAX_PAYMENTS')) },
    storage: { directory: resolve(required('ASSUREPAY_STORAGE_DIRECTORY')), key: storageKey() },
    ...(account ? { payerAccount: account } : {}),
  });
  try {
    if (command.kind === 'retrieve') console.log(safe(await client.retrieve(command.id)));
    else if (command.kind === 'state') console.log(safe(await client.readState(command.id)));
    else if (command.kind === 'evidence') {
      const evidenceHash = await client.uploadEvidence(command.id, new Uint8Array(await readFile(resolve(command.path))));
      console.log(safe({ coverageId: command.id, evidenceHash }));
    } else if (command.kind === 'claim') {
      console.log(safe(await client.fileClaim(command.id, command.evidenceHash, { approved: true })));
    } else {
      const bodyPath = process.env.ASSUREPAY_REQUEST_BODY;
      const body = bodyPath ? new Uint8Array(await readFile(resolve(bodyPath))) : new TextEncoder().encode('assurepay client request');
      const preview = await client.preview(body);
      console.log(safe({ decision: command.kind === 'approve' ? 'host-approved-once' : 'preview-only', preview }));
      if (command.kind === 'approve') {
        const authorized = await client.authorize(preview.requestId, { approved: true });
        console.log(safe(await client.send(authorized.requestId)));
        console.log(safe(await client.readState(authorized.coverageId)));
      }
    }
  } finally { await client.close(); }
}

main().catch(error => {
  const code = clientErrorCode(error);
  process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
});
