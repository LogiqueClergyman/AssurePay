import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer } from '@x402/core/server';
import type { SchemeNetworkFacilitator } from '@x402/core/types';
import { hashIntent, type Intent } from '../src/intent.js';
import { NATIVE_USDC } from '../src/preflight.js';
import {
  buildRequirements, createProfileServer, validatePayment, validateRequirements,
  PAYMENT_FLOW, PROFILE, SCHEME, TRANSFER_METHOD, type ProfileConfiguration,
} from '../src/profile.js';

const intent: Intent = {
  chainId: '84532', core: '0x1111111111111111111111111111111111111111',
  token: '0x2222222222222222222222222222222222222222', payer: '0x3333333333333333333333333333333333333333',
  providerId: `0x${'44'.repeat(32)}`, policyId: `0x${'55'.repeat(32)}`, policyHash: `0x${'66'.repeat(32)}`,
  requestHash: `0x${'77'.repeat(32)}`, gross: '100', payerSalt: `0x${'88'.repeat(32)}`,
  validAfter: '1000', validBefore: '1300',
};
const configuration: ProfileConfiguration = {
  bindings: { chainId: 84532n, core: intent.core, token: intent.token, providerId: intent.providerId,
    policyId: intent.policyId, policyHash: intent.policyHash, requestHash: intent.requestHash },
  providerPayout: '0x9999999999999999999999999999999999999999', tokenName: 'USDC', tokenVersion: '2',
};
const requirements = buildRequirements(configuration);
function payment() {
  return { x402Version: 2, accepted: structuredClone(requirements),
    payload: { intent: { ...intent }, intentHash: hashIntent(intent), signature: `0x${randomBytes(65).toString('hex')}` } };
}

test('wire format binds trusted economics, domain, profile and upfront flow', () => {
  const result = validatePayment(payment(), configuration, 1100n);
  assert.equal(result.intentHash, hashIntent(intent));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.intent) && Object.isFrozen(result.requirements.extra));
  for (const field of Object.keys(requirements)) {
    if (field === 'extra') continue;
    const changed = { ...requirements, [field]: 'substituted' };
    assert.throws(() => validateRequirements(changed, configuration), { message: 'M1_PROFILE_REQUIREMENTS' });
  }
  for (const field of Object.keys(requirements.extra)) {
    assert.throws(() => validateRequirements({ ...requirements, extra: { ...requirements.extra, [field]: 'substituted' } }, configuration));
  }
  assert.throws(() => validateRequirements({ ...requirements, extra: { ...requirements.extra, arbitrary: true } }, configuration));
  assert.throws(() => validateRequirements({ ...requirements, arbitrary: true }, configuration));
});

test('payload rejects altered intent/hash, malformed signature and unknown transport fields', () => {
  assert.throws(() => validatePayment({ ...payment(), x402Version: 1 }, configuration, 1100n));
  const changed = payment(); changed.payload.intent.gross = '101';
  assert.throws(() => validatePayment(changed, configuration, 1100n), { message: 'M1_PROFILE_INTENT' });
  const badHash = payment(); badHash.payload.intentHash = `0x${'00'.repeat(32)}`;
  assert.throws(() => validatePayment(badHash, configuration, 1100n));
  const badSignature = payment(); badSignature.payload.signature = '0x';
  assert.throws(() => validatePayment(badSignature, configuration, 1100n));
  assert.throws(() => validatePayment({ ...payment(), extensions: { unnegotiated: true } }, configuration, 1100n));
  assert.throws(() => validatePayment({ ...payment(), payload: { ...payment().payload, arbitrary: true } }, configuration, 1100n));
  assert.throws(() => validatePayment(payment(), configuration, 1300n));
  assert.doesNotThrow(() => validatePayment({ ...payment(), resource: { url: 'https://example.invalid/resource' } }, configuration, 1100n));
});

test('preflight token identity feeds canonical intent/requirements without address-casing mismatch', () => {
  const nativeConfiguration: ProfileConfiguration = {
    ...configuration,
    bindings: { ...configuration.bindings, token: NATIVE_USDC },
    providerPayout: `0x${'aB'.repeat(20)}`,
  };
  const nativeIntent = { ...intent, token: NATIVE_USDC.toLowerCase() as `0x${string}` };
  const nativePayment = {
    ...payment(), accepted: buildRequirements(nativeConfiguration),
    payload: { ...payment().payload, intent: nativeIntent, intentHash: hashIntent(nativeIntent) },
  };
  const parsed = validatePayment(nativePayment, nativeConfiguration, 1100n);
  assert.equal(parsed.requirements.asset, NATIVE_USDC.toLowerCase());
  assert.equal(parsed.requirements.extra.providerPayout, nativeConfiguration.providerPayout.toLowerCase());
  assert.equal(parsed.intent.token, NATIVE_USDC.toLowerCase());
});

test('registers a distinct upfront-only profile through real x402 core without pretending to settle', async () => {
  const serverScheme = createProfileServer(configuration);
  assert.deepEqual(serverScheme.paymentFlows, { [TRANSFER_METHOD]: { supported: ['upfront'], default: 'upfront' } });
  const unimplemented: SchemeNetworkFacilitator = {
    scheme: SCHEME, caipFamily: 'eip155:*',
    getExtra: () => ({ profile: PROFILE, assetTransferMethod: TRANSFER_METHOD, paymentFlow: PAYMENT_FLOW }),
    getSigners: () => [],
    async verify() { return { isValid: false, invalidReason: 'M1_EXECUTION_NOT_IMPLEMENTED' }; },
    async settle() { return { success: false, errorReason: 'M1_EXECUTION_NOT_IMPLEMENTED', transaction: '', network: 'eip155:84532' }; },
  };
  const facilitator = new x402Facilitator().register('eip155:84532', unimplemented);
  const supported = facilitator.getSupported();
  assert.equal(supported.kinds.length, 1);
  assert.equal(supported.kinds[0]?.scheme, SCHEME);
  const server = new x402ResourceServer({
    async getSupported() {
      return { ...supported, kinds: supported.kinds.map(kind => ({ ...kind, network: 'eip155:84532' as const })) };
    },
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
  }).register('eip155:84532', serverScheme);
  await server.initialize();
  const built = await server.buildPaymentRequirements({ scheme: SCHEME, network: 'eip155:84532',
    price: { asset: configuration.bindings.token, amount: '100' }, payTo: configuration.bindings.core, maxTimeoutSeconds: 300 });
  assert.deepEqual(built, [requirements]);
  const rejected = await facilitator.verify(payment(), requirements);
  assert.equal(rejected.isValid, false);
  assert.equal(rejected.invalidReason, 'M1_EXECUTION_NOT_IMPLEMENTED');
  await assert.rejects(() => serverScheme.parsePrice('$0.0001', 'eip155:84532'));
  assert.equal(serverScheme.validateFacilitatorSupport?.('eip155:84532', {
    x402Version: 2, network: 'eip155:84532', scheme: 'exact',
  }, []), 'M1_PROFILE_CAPABILITY_MISMATCH');
});
