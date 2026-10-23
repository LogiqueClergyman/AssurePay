import { readProviderConfig, createProvider } from '@assurepay/provider-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { profileCsv } from './profile-csv.js';

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error('EXAMPLE_CONFIG_INVALID');
  return value;
}

function parseStorageKey(value) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('EXAMPLE_CONFIG_INVALID');
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

async function main() {
  const mode = process.env.ASSUREPAY_MODE ?? 'profile';
  if (!['profile', 'fail', 'retrieve-only'].includes(mode)) throw new Error('EXAMPLE_CONFIG_INVALID');
  const config = await readProviderConfig(requiredEnv('ASSUREPAY_CONFIG'));
  const storage = {
    directory: requiredEnv('ASSUREPAY_STORAGE_DIRECTORY'),
    key: parseStorageKey(requiredEnv('ASSUREPAY_STORAGE_KEY')),
  };

  let receiptSigner;
  let relayerAccount;
  if (mode === 'retrieve-only') {
    receiptSigner = {
      address: config.roles.provider,
      async signTypedData() { throw new Error('RETRIEVAL_SIGNER_MUST_NOT_BE_USED'); },
    };
  } else {
    const providerKey = requiredEnv('ASSUREPAY_PROVIDER_PRIVATE_KEY');
    if (!/^0x[0-9a-fA-F]{64}$/.test(providerKey)) throw new Error('EXAMPLE_CONFIG_INVALID');
    receiptSigner = privateKeyToAccount(/** @type {import('viem').Hex} */ (providerKey));
    if (receiptSigner.address.toLowerCase() !== config.roles.provider.toLowerCase()) throw new Error('EXAMPLE_SIGNER_MISMATCH');
    const relayerKey = requiredEnv('ASSUREPAY_RELAYER_PRIVATE_KEY');
    if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKey)) throw new Error('EXAMPLE_CONFIG_INVALID');
    relayerAccount = privateKeyToAccount(/** @type {import('viem').Hex} */ (relayerKey));
    if (relayerAccount.address.toLowerCase() !== config.roles.relayer.toLowerCase()) throw new Error('EXAMPLE_SIGNER_MISMATCH');
  }

  const handler = mode === 'retrieve-only'
    ? async () => { throw new Error('RETRIEVAL_HANDLER_MUST_NOT_BE_USED'); }
    : mode === 'fail'
      ? async () => { throw new Error('EXAMPLE_CONTROLLED_FAILURE'); }
      : async (body) => profileCsv(body);

  const service = await createProvider({
    config,
    storage,
    receiptSigner,
    ...(relayerAccount ? { relayerAccount } : {}),
    handler,
  });
  process.stdout.write(`${JSON.stringify({ resourceUrl: service.resourceUrl, claimsUrl: service.claimsUrl, mode: service.mode })}\n`);

  let closing;
  const close = () => {
    if (!closing) closing = service.close();
    return closing;
  };
  const onSignal = (signal) => {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    void close().then(() => {
      process.exitCode = signal === 'SIGINT' ? 130 : 0;
    }, () => {
      process.stderr.write('PROVIDER_CLOSE_FAILED\n');
      process.exitCode = 1;
    });
  };
  const onTerm = () => onSignal('SIGTERM');
  const onInt = () => onSignal('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
}

main().catch(() => {
  process.stderr.write('EXAMPLE_START_FAILED\n');
  process.exitCode = 1;
});
