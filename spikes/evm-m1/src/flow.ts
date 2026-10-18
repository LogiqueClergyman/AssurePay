import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload } from '@x402/core/types';
import { createProfileServer, SCHEME, type ProfileConfiguration } from './profile.js';
import { createAssuredX402Client, createAssuredX402Facilitator,
  type AssuredPayerSigner, type AssuredSettlementDriver } from './x402.js';
import type { Hex } from 'viem';

/** Real SDK registration, intentionally self-hosted and without an HTTP service. */
export async function createRegisteredFlow(options: {
  configuration: ProfileConfiguration;
  payer: AssuredPayerSigner;
  driver: AssuredSettlementDriver;
  createSalt: () => Hex;
}) {
  const configuration = structuredClone(options.configuration);
  Object.freeze(configuration.bindings);
  Object.freeze(configuration);
  const network = 'eip155:84532' as const;
  const facilitator = createAssuredX402Facilitator({ configuration, driver: options.driver });
  const client = createAssuredX402Client({ configuration, payer: options.payer,
    now: () => options.driver.now(), createSalt: options.createSalt });
  const server = new x402ResourceServer({
    async getSupported() {
      const supported = facilitator.getSupported();
      return { ...supported, kinds: supported.kinds.map(kind => ({ ...kind, network })) };
    },
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
  }).register(network, createProfileServer(configuration));
  await server.initialize();
  const requirements = await server.buildPaymentRequirements({ scheme: SCHEME, network,
    price: { amount: '100', asset: configuration.bindings.token.toLowerCase() },
    payTo: configuration.bindings.core.toLowerCase(), maxTimeoutSeconds: 300 });
  const selected = requirements[0];
  if (requirements.length !== 1 || !selected) throw new Error('M1_FLOW_REQUIREMENTS');
  const paymentRequired = await server.createPaymentRequiredResponse(requirements,
    { url: 'https://example.invalid/m1-assured-resource', description: 'M1 fixed assurance spike' });
  return {
    client, server, facilitator, requirements: selected, paymentRequired,
    async purchase(): Promise<PaymentPayload> {
      // Model the JSON wire boundary: SDK optional undefined properties are omitted.
      return JSON.parse(JSON.stringify(await client.createPaymentPayload(paymentRequired))) as PaymentPayload;
    },
    // SDK upfront verify alone does not establish payment or liability.
    async settleBeforeService(payment: PaymentPayload) {
      return server.settlePayment(payment, selected, undefined, undefined, undefined, 'before-handler');
    },
  };
}
