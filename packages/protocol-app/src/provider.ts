import type { LocalAccount } from 'viem';
import { startPilotProvider } from '../../developer-pilot/src/provider.js';
import { captureAccount } from './accounts.js';
import { validateProtocolConfig } from './config.js';
import { protocolErrorCode } from './errors.js';
import type { ProtocolConfig } from './types.js';

/** Explicit product composition: admin identity is pinned, never an online signer. */
export async function startProtocolProvider(options: {
  config: ProtocolConfig; storage: { directory: string; key: Uint8Array };
  receiptSigner: Pick<LocalAccount, 'address' | 'signTypedData'>; relayerAccount?: LocalAccount;
  handler: (body: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}) {
  try {
    const config = validateProtocolConfig(options.config);
    if (!(options.storage?.key instanceof Uint8Array)) throw Error('PROTOCOL_ARGUMENT_INVALID');
    const directory = options.storage.directory, key = Uint8Array.from(options.storage.key), handler = options.handler;
    const source = options.receiptSigner;
    if (!source || source.address?.toLowerCase() !== config.pilot.roles.provider || typeof source.signTypedData !== 'function' ||
        key.length !== 32 || typeof directory !== 'string' || !directory || typeof handler !== 'function') throw Error('PROTOCOL_ARGUMENT_INVALID');
    const receiptSigner = Object.freeze({ address: source.address, signTypedData: source.signTypedData.bind(source) });
    const relayerAccount = captureAccount(options.relayerAccount, config.pilot.roles.relayer);
    return await startPilotProvider({ config: config.pilot, directory, key, receiptSigner, handler,
      expectedAdmin: config.admin, ...(relayerAccount ? { relayerAccount } : {}) });
  } catch (error) { throw Error(protocolErrorCode(error)); }
}
