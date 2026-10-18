import type {
  PaymentRequirements,
  SchemeNetworkServer,
} from '@x402/core/types';
import type { Address, Hex } from 'viem';
import { hashIntent, parseIntent, type Intent, type TrustedIntentBindings } from './intent.js';

export const SCHEME = 'assured-exact';
export const PROFILE = 'assurepay-evm-v1';
export const TRANSFER_METHOD = 'assured-eip3009-receive';
export const PAYMENT_FLOW = 'upfront';

export interface ProfileConfiguration {
  bindings: TrustedIntentBindings;
  providerPayout: Address;
  tokenName: string;
  tokenVersion: string;
}

export class ProfileError extends Error {
  constructor(readonly code: 'requirements' | 'payload' | 'intent' | 'capability') {
    super(`M1_PROFILE_${code.toUpperCase()}`);
    this.name = 'ProfileError';
  }
}

function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProfileError('payload');
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ProfileError('payload');
  const record = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(record, key)) ||
      Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) throw new ProfileError('payload');
  return record;
}

/** Fixed demo economics. This module does not implement capacity or underwriting. */
export function buildRequirements(configuration: ProfileConfiguration): PaymentRequirements {
  const { bindings, tokenName, tokenVersion } = configuration;
  const core = bindings.core.toLowerCase() as Address;
  const token = bindings.token.toLowerCase() as Address;
  const providerPayout = configuration.providerPayout.toLowerCase() as Address;
  if (bindings.chainId !== 84532n || (bindings.gross ?? '100') !== '100' ||
      [core, token, providerPayout].some(address => !/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address)) ||
      !tokenName || tokenName.length > 64 || !tokenVersion || tokenVersion.length > 32) {
    throw new ProfileError('requirements');
  }
  return {
    scheme: SCHEME,
    network: `eip155:${bindings.chainId}`,
    asset: token,
    amount: '100',
    payTo: core,
    maxTimeoutSeconds: 300,
    extra: {
      profile: PROFILE,
      assetTransferMethod: TRANSFER_METHOD,
      paymentFlow: PAYMENT_FLOW,
      name: tokenName,
      version: tokenVersion,
      providerId: bindings.providerId,
      policyId: bindings.policyId,
      policyHash: bindings.policyHash,
      requestHash: bindings.requestHash,
      providerPayout,
      providerNet: '93',
      premium: '7',
    },
  };
}

/** Compare untrusted requirements with independently configured terms, not with themselves. */
export function validateRequirements(input: unknown, configuration: ProfileConfiguration): PaymentRequirements {
  try {
    const expected = buildRequirements(configuration);
    const actual = object(input, Object.keys(expected));
    const extra = object(actual.extra, Object.keys(expected.extra));
    if (Object.entries(expected).some(([key, value]) => key !== 'extra' && actual[key] !== value) ||
        Object.entries(expected.extra).some(([key, value]) => extra[key] !== value)) {
      throw new ProfileError('requirements');
    }
    return expected;
  } catch {
    throw new ProfileError('requirements');
  }
}

export interface ValidatedPayment {
  readonly requirements: PaymentRequirements;
  readonly intent: Intent;
  readonly intentHash: Hex;
  readonly signature: Hex;
}

/** Syntax/binding validation only: Gate B/C must also verify signature and execute Core. */
export function validatePayment(
  input: unknown,
  configuration: ProfileConfiguration,
  nowSeconds: bigint,
): ValidatedPayment {
  const root = object(input, ['x402Version', 'accepted', 'payload'], ['resource']);
  if (root.x402Version !== 2) throw new ProfileError('payload');
  if (root.resource !== undefined) {
    const resource = object(root.resource, ['url'], ['description', 'mimeType']);
    if (typeof resource.url !== 'string' || resource.url.length > 2048 ||
        Object.values(resource).some(value => typeof value !== 'string' || value.length > 2048)) {
      throw new ProfileError('payload');
    }
  }
  const requirements = validateRequirements(root.accepted, configuration);
  const payload = object(root.payload, ['intent', 'intentHash', 'signature']);
  if (typeof payload.signature !== 'string' || !/^0x[0-9a-f]{130}$/.test(payload.signature)) throw new ProfileError('payload');
  let intent: Intent;
  try {
    intent = parseIntent(payload.intent, configuration.bindings, nowSeconds);
  } catch {
    throw new ProfileError('intent');
  }
  const intentHash = hashIntent(intent);
  if (payload.intentHash !== intentHash) throw new ProfileError('intent');
  Object.freeze(requirements.extra);
  Object.freeze(requirements);
  return Object.freeze({ requirements, intent: Object.freeze(intent), intentHash, signature: payload.signature as Hex });
}

/** Real SDK server contract, deliberately supports settlement-before-service only. */
export function createProfileServer(configuration: ProfileConfiguration): SchemeNetworkServer {
  return {
    scheme: SCHEME,
    defaultAssetTransferMethod: TRANSFER_METHOD,
    paymentFlows: { [TRANSFER_METHOD]: { supported: [PAYMENT_FLOW], default: PAYMENT_FLOW } },
    async parsePrice(price, network) {
      const expected = buildRequirements(configuration);
      if (network !== expected.network || typeof price !== 'object' || price === null ||
          price.amount !== expected.amount || price.asset !== expected.asset) throw new ProfileError('requirements');
      return { amount: expected.amount, asset: expected.asset, extra: { ...expected.extra } };
    },
    validateFacilitatorSupport(network, kind) {
      if (network !== `eip155:${configuration.bindings.chainId}` || kind.scheme !== SCHEME ||
          kind.extra?.profile !== PROFILE || kind.extra.assetTransferMethod !== TRANSFER_METHOD ||
          kind.extra.paymentFlow !== PAYMENT_FLOW) return 'M1_PROFILE_CAPABILITY_MISMATCH';
    },
    async enhancePaymentRequirements(requirements, kind) {
      if (kind.scheme !== SCHEME || kind.extra?.profile !== PROFILE ||
          kind.extra.assetTransferMethod !== TRANSFER_METHOD || kind.extra.paymentFlow !== PAYMENT_FLOW) {
        throw new ProfileError('capability');
      }
      return validateRequirements(requirements, configuration);
    },
  };
}
