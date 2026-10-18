import type { Address, Hex } from 'viem';
import { NATIVE_USDC } from './preflight.js';
import type { ProfileConfiguration } from './profile.js';

/** Disposable M1 terms only; these identifiers do not register a real policy. */
export const DEMO_TERMS = Object.freeze({
  providerId: `0x${'44'.repeat(32)}` as Hex,
  policyId: `0x${'55'.repeat(32)}` as Hex,
  policyHash: `0x${'66'.repeat(32)}` as Hex,
  requestHash: `0x${'77'.repeat(32)}` as Hex,
});
export function demoConfiguration(core: Address, providerPayout: Address, token: Address = NATIVE_USDC): ProfileConfiguration {
  return { bindings: { chainId: 84532n, core, token, ...DEMO_TERMS }, providerPayout,
    tokenName: 'USDC', tokenVersion: '2' };
}
