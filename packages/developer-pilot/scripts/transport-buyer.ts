// Internal local rehearsal worker. This is not a public-chain CLI.
import { readFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, type Hex } from 'viem';
import { createBuyer } from '../src/buyer.js';
import { createClients, trustFor, validateConfig, safeCode } from '../src/config.js';
import { createTrustedFetch } from '../src/local-https.js';

try {
  const [mode, configPath, directory, finalArg] = process.argv.slice(2);
  if (!['purchase', 'retrieve'].includes(mode ?? '') || !configPath || !directory || !finalArg || process.argv.length !== 6) throw Error('TRANSPORT_BUYER_ARGUMENTS');
  const input = JSON.parse(await readFile(configPath, 'utf8'));
  const config = validateConfig(input.config);
  const origin = new URL(input.resourceUrl);
  if (origin.protocol !== 'https:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.search || origin.hash || origin.username || origin.password) throw Error('TRANSPORT_LOCAL_ORIGIN_REQUIRED');
  const key = process.env.PILOT_DATA_KEY;
  if (!key || !/^[0-9a-f]{64}$/.test(key)) throw Error('TRANSPORT_BUYER_KEY');
  let signatures = 0;
  let signer;
  if (mode === 'purchase') {
    const privateKey = process.env.PILOT_PAYER_PRIVATE_KEY;
    if (!privateKey || !/^0x[0-9a-f]{64}$/.test(privateKey)) throw Error('TRANSPORT_BUYER_SIGNER');
    const account = privateKeyToAccount(privateKey as Hex);
    if (account.address.toLowerCase() !== config.roles.payer) throw Error('TRANSPORT_BUYER_SIGNER');
    signer = { address: account.address, async signTypedData(data: any) { signatures++; return account.signTypedData(data); } };
  }
  const { client } = createClients(config);
  const buyer = await createBuyer({ binding: {url: input.resourceUrl, trust: trustFor(config), maxGross: config.gross, payer: config.roles.payer},
    directory, key: Buffer.from(key, 'hex'), client, relayer: config.roles.relayer, payerSigner: signer,
    fetch: createTrustedFetch(await readFile(input.certPath, 'utf8'), origin.origin) });
  try {
    const prepared = mode === 'purchase' ? await buyer.prepare(new Uint8Array(await readFile(finalArg))) : undefined;
    if (prepared) process.stdout.write(JSON.stringify({code: 'TRANSPORT_BUYER_PREPARED', ...prepared}) + '\n');
    const result = prepared ? await buyer.send(prepared.requestId) : await buyer.retrieve(finalArg as Hex);
    if (!result.paid) throw Error('TRANSPORT_RESULT_UNCONFIRMED');
    process.stdout.write(JSON.stringify({code: 'TRANSPORT_BUYER_RESULT', status: result.status, bodyHash: keccak256(result.body),
      transaction: (result.paymentResponse as any).transaction, signatures}) + '\n');
  } finally { await buyer.close(); }
} catch (error) {
  process.stdout.write(JSON.stringify({ok: false, code: safeCode(error)}) + '\n');
  process.exitCode = 1;
}
