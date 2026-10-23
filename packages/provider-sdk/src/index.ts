import type { LocalAccount } from 'viem';
import { createClients, readConfig, validateConfig } from '../../developer-pilot/src/config.js';
import { startPilotProvider } from '../../developer-pilot/src/provider.js';
import type { ProviderConfig, ProviderOptions, ProviderService, ReceiptSigner } from './types.js';

export type { ProviderConfig, ProviderOptions, ProviderService, ReceiptSigner } from './types.js';

// A fixed vocabulary prevents arbitrary error messages from reaching logs or tools.
const PUBLIC_CODES = new Set([
  'PROVIDER_OPERATION_FAILED', 'PROVIDER_OPTIONS_INVALID',
  'PILOT_SCHEMA_INVALID', 'PILOT_AMOUNT_INVALID', 'PILOT_ADDRESS_INVALID',
  'PILOT_ID_INVALID', 'PILOT_LOCAL_URL_REQUIRED', 'PILOT_CONFIG_INVALID',
  'PILOT_LOCAL_TOKEN_REQUIRED', 'PILOT_DIRECTORY_INVALID',
  'PILOT_PROVIDER_CONFIG_INVALID', 'PILOT_RELAYER_MISMATCH',
  'PILOT_CHAIN_MISMATCH', 'PILOT_FEE_CAP_UNAVAILABLE',
  'PILOT_DEPLOYMENT_RANGE_INVALID', 'PILOT_CONTEXT_MISMATCH',
  'PILOT_PROVIDER_MISMATCH', 'PILOT_CANONICALITY_UNAVAILABLE',
  'PILOT_SERVER_CLOSE_FAILED', 'M5_RUN_LOCK_UNAVAILABLE',
  'M5_RUN_LOCK_RELEASE_FAILED', 'ACTION_LOCK_UNAVAILABLE', 'ACTION_LOCK_RELEASE_FAILED',
  'PROVIDER_SIGNER_MISMATCH', 'PAYMENT_JOURNAL_CORRUPT',
  'PAYMENT_JOURNAL_UNAVAILABLE', 'SERVICE_JOURNAL_CORRUPT',
  'SERVICE_JOURNAL_UNAVAILABLE',
]);

export function providerErrorCode(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : undefined;
    return typeof message === 'string' && PUBLIC_CODES.has(message)
      ? message : 'PROVIDER_OPERATION_FAILED';
  } catch { return 'PROVIDER_OPERATION_FAILED'; }
}

export function validateProviderConfig(input: unknown): ProviderConfig {
  try { return validateConfig(input); }
  catch (error) { throw new Error(providerErrorCode(error)); }
}

export async function readProviderConfig(path: string): Promise<ProviderConfig> {
  try { return await readConfig(path); }
  catch (error) { throw new Error(providerErrorCode(error)); }
}

function captureAccount(account: LocalAccount, expected: string): LocalAccount {
  if (!account || account.type !== 'local' || account.address?.toLowerCase() !== expected ||
      typeof account.signTransaction !== 'function' || typeof account.signMessage !== 'function' ||
      typeof account.signTypedData !== 'function') throw new Error('PILOT_RELAYER_MISMATCH');
  // Copy identity and capture function references before any asynchronous work.
  return Object.freeze({
    address: account.address, publicKey: account.publicKey, source: account.source, type: 'local',
    signTransaction: account.signTransaction.bind(account),
    signMessage: account.signMessage.bind(account),
    signTypedData: account.signTypedData.bind(account),
    ...(account.sign ? { sign: account.sign.bind(account) } : {}),
    ...(account.signAuthorization ? { signAuthorization: account.signAuthorization.bind(account) } : {}),
  });
}

export async function createProvider(options: ProviderOptions): Promise<ProviderService> {
  try {
    const config = validateProviderConfig(options?.config);
    if (!options.storage || typeof options.storage.directory !== 'string' || !options.storage.directory ||
        !(options.storage.key instanceof Uint8Array) || options.storage.key.length !== 32 ||
        typeof options.handler !== 'function') throw new Error('PROVIDER_OPTIONS_INVALID');
    const directory = options.storage.directory;
    const key = Uint8Array.from(options.storage.key);
    const handler = options.handler;
    const suppliedSigner = options.receiptSigner;
    if (!suppliedSigner || suppliedSigner.address?.toLowerCase() !== config.roles.provider ||
        typeof suppliedSigner.signTypedData !== 'function') throw new Error('PILOT_PROVIDER_CONFIG_INVALID');
    const receiptSigner: ReceiptSigner = Object.freeze({
      address: suppliedSigner.address, signTypedData: suppliedSigner.signTypedData.bind(suppliedSigner),
    });
    const relayerAccount = options.relayerAccount === undefined
      ? undefined : captureAccount(options.relayerAccount, config.roles.relayer);
    const { client, wallet } = createClients(config);
    const runtime = await startPilotProvider({
      config, directory, key, receiptSigner, handler, client,
      ...(relayerAccount ? { relayerAccount, wallet } : {}),
    });
    return Object.freeze({
      resourceUrl: config.resourceUrl, claimsUrl: config.claimsUrl,
      mode: relayerAccount ? 'settlement-enabled' as const : 'retrieval-only' as const,
      async close(): Promise<void> {
        try { await runtime.close(); }
        catch (error) { throw new Error(providerErrorCode(error)); }
      },
    });
  } catch (error) { throw new Error(providerErrorCode(error)); }
}
