import type { LocalAccount } from 'viem';
import { same } from './common.js';

export function captureAccount(account: LocalAccount | undefined, expected: string): LocalAccount | undefined {
  if (account === undefined) return undefined;
  if (!account || account.type !== 'local' || !same(account.address, expected) ||
      typeof account.signTypedData !== 'function' || typeof account.signTransaction !== 'function' ||
      typeof account.signMessage !== 'function') throw Error('PROTOCOL_ACCOUNT_INVALID');
  return Object.freeze({ address: account.address, publicKey: account.publicKey, source: account.source, type: 'local',
    signTypedData: account.signTypedData.bind(account), signTransaction: account.signTransaction.bind(account),
    signMessage: account.signMessage.bind(account),
    ...(account.sign ? { sign: account.sign.bind(account) } : {}),
    ...(account.signAuthorization ? { signAuthorization: account.signAuthorization.bind(account) } : {}) });
}
