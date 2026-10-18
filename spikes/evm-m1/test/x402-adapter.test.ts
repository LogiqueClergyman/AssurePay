import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SPIKE_CORE_ABI, type PreparedCoreCall } from "../src/call.js";
import { buildRequirements, createProfileServer, type ProfileConfiguration } from "../src/profile.js";
import {
  createAssuredSchemeFacilitator,
  createAssuredX402Client,
  createAssuredX402Facilitator,
  type AssuredSettlementDriver,
} from "../src/x402.js";
import type { RelayReceipt } from "../src/relay.js";

const NETWORK = "eip155:84532";
const NOW = 1_800_000_000n;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const core = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const providerId = `0x${"44".repeat(32)}` as Hex;
const policyId = `0x${"55".repeat(32)}` as Hex;
const policyHash = `0x${"66".repeat(32)}` as Hex;
const requestHash = `0x${"77".repeat(32)}` as Hex;
const payerAccount = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());

const configuration: ProfileConfiguration = {
  bindings: { chainId: 84532n, core, token, providerId, policyId, policyHash, requestHash },
  providerPayout: "0x9999999999999999999999999999999999999999",
  tokenName: "USDC",
  tokenVersion: "2",
};
const requirements = buildRequirements(configuration);

function harness(options: {
  initialTime?: bigint;
  receipts?: Array<RelayReceipt | null | Error>;
  verifySuccess?: (receipt: RelayReceipt, call: PreparedCoreCall, payment: Readonly<{ intent: any }>) => Promise<boolean>;
  prepareGate?: Promise<void>;
} = {}) {
  let time = options.initialTime ?? NOW;
  const counts = { now: 0, simulations: 0, prepares: 0, broadcasts: 0, reads: 0, verifies: 0 };
  const receiptQueue = [...(options.receipts ?? [{ transactionHash: TX_HASH, status: "success" }])];
  const calls: PreparedCoreCall[] = [];
  const driver: AssuredSettlementDriver = {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address,
    now: async () => { counts.now++; return time; },
    simulate: async (call) => {
      counts.simulations++;
      calls.push(call);
      assert.equal(call.to, core);
      assert.equal(decodeFunctionData({ abi: SPIKE_CORE_ABI, data: call.data }).functionName, "settleAssured");
    },
    prepareCall: async (call) => {
      counts.prepares++;
      calls.push(call);
      if (options.prepareGate) await options.prepareGate;
      assert.equal(call.to, core);
      return {
        hash: TX_HASH,
        broadcast: async () => { counts.broadcasts++; },
      };
    },
    getReceipt: async (hash) => {
      counts.reads++;
      assert.equal(hash, TX_HASH);
      const next = receiptQueue.length === 0
        ? { transactionHash: TX_HASH, status: "success" as const }
        : receiptQueue.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    verifySuccess: async (receipt, call, payment) => {
      counts.verifies++;
      assert.equal(receipt.transactionHash, TX_HASH);
      assert.equal(call.to, core);
      assert.equal(payment.intent.payer, payerAccount.address.toLowerCase());
      return options.verifySuccess ? options.verifySuccess(receipt, call, payment) : true;
    },
  };
  return {
    driver,
    counts,
    calls,
    advanceTime(next: bigint) { time = next; },
  };
}

function makeClient(now = NOW) {
  return createAssuredX402Client({
    configuration,
    payer: {
      address: payerAccount.address,
      signTypedData: data => payerAccount.signTypedData(data),
    },
    now: () => now,
    createSalt: () => `0x${randomBytes(32).toString("hex")}` as Hex,
  });
}

async function createPaymentPayload(): Promise<PaymentPayload> {
  const generated = await makeClient().createPaymentPayload({
    x402Version: 2,
    resource: { url: "https://example.invalid/paid" },
    accepts: [structuredClone(requirements)],
  });
  // The real client/server boundary is JSON. The SDK may include optional
  // properties with `undefined` in memory, and JSON serialization omits them.
  return JSON.parse(JSON.stringify(generated)) as PaymentPayload;
}

function changedRequirements(): PaymentRequirements {
  return { ...structuredClone(requirements), amount: "101" };
}

test("pinned x402 client and facilitator register the receive-profile and settle before handler admission", async () => {
  const payload = await createPaymentPayload();
  assert.equal(payload.x402Version, 2);
  assert.equal(payload.accepted.scheme, "assured-exact");
  assert.equal(payload.accepted.extra.paymentFlow, "upfront");

  const state = harness();
  const registeredFacilitator = createAssuredX402Facilitator({ configuration, driver: state.driver, maxReceiptReads: 1 });
  const facilitator = {
    verify: registeredFacilitator.verify.bind(registeredFacilitator),
    settle: registeredFacilitator.settle.bind(registeredFacilitator),
    getSupported: async () => registeredFacilitator.getSupported() as SupportedResponse,
  };
  const server = new x402ResourceServer(facilitator).register(NETWORK, createProfileServer(configuration));
  await server.initialize();

  // The SDK intentionally skips facilitator.verify for upfront flow. This check does not reserve admission.
  assert.deepEqual(await server.verifyPayment(payload, requirements), { isValid: true });
  assert.equal(state.counts.verifies, 0);
  const explicitVerify = await facilitator.verify(payload, requirements);
  assert.equal(explicitVerify.isValid, true);
  assert.equal(explicitVerify.payer?.toLowerCase(), payerAccount.address.toLowerCase());
  assert.equal(state.counts.simulations, 0);

  const settled = await server.settlePayment(payload, requirements, {}, undefined, undefined, "before-handler");
  assert.deepEqual(settled, { success: true, transaction: TX_HASH, network: NETWORK, payer: payerAccount.address.toLowerCase() });
  assert.equal(state.counts.simulations, 1);
  assert.equal(state.counts.prepares, 1);
  assert.equal(state.counts.broadcasts, 1);
});

test("verify snapshots payload identity and rejects mutation before simulation or submission", async () => {
  const payload = await createPaymentPayload();
  const state = harness();
  const facilitator = createAssuredSchemeFacilitator({ configuration, driver: state.driver, maxReceiptReads: 1 });
  assert.equal((await facilitator.verify(payload, requirements)).isValid, true);
  (payload.payload.intent as Record<string, unknown>).payerSalt = `0x${"aa".repeat(32)}`;

  const result = await facilitator.settle(payload, requirements);
  assert.equal(result.success, false);
  assert.equal(result.errorReason, "M1_PAYMENT_MISMATCH");
  assert.equal(result.transaction, "");
  assert.deepEqual(Object.keys(result).sort(), ["errorReason", "network", "payer", "success", "transaction"]);
  assert.equal(state.counts.simulations, 0);
  assert.equal(state.counts.prepares, 0);
  assert.equal(state.counts.broadcasts, 0);
});

test("pending transaction retries reconcile the same hash after expiry without replacement", async () => {
  const payload = await createPaymentPayload();
  const state = harness({
    receipts: [null, { transactionHash: TX_HASH, status: "success" }, { transactionHash: TX_HASH, status: "success" }],
    verifySuccess: async (_receipt, _call, _payment) => {
      if (state.counts.verifies === 1) throw new Error("state read unavailable");
      return true;
    },
  });
  const facilitator = createAssuredSchemeFacilitator({ configuration, driver: state.driver, maxReceiptReads: 1 });
  assert.equal((await facilitator.verify(payload, requirements)).isValid, true);

  const first = await facilitator.settle(payload, requirements);
  assert.equal(first.success, false);
  assert.equal(first.errorReason, "settlement_pending");
  assert.equal(first.transaction, TX_HASH);
  assert.equal(state.counts.prepares, 1);
  assert.equal(state.counts.broadcasts, 1);

  state.advanceTime(NOW + 300n);
  const transient = await facilitator.settle(payload, requirements);
  assert.equal(transient.success, false);
  assert.equal(transient.errorReason, "settlement_pending");
  assert.equal(transient.transaction, TX_HASH);
  assert.equal(state.counts.prepares, 1);
  assert.equal(state.counts.broadcasts, 1);

  const second = await facilitator.settle(payload, requirements);
  assert.equal(second.success, true);
  assert.equal(second.transaction, TX_HASH);
  assert.equal(state.counts.simulations, 1);
  assert.equal(state.counts.prepares, 1);
  assert.equal(state.counts.broadcasts, 1);
  assert.equal(state.counts.reads, 3);
});

test("invalid requirements and invalid signatures fail with fixed outputs and no arbitrary call", async () => {
  const payload = await createPaymentPayload();
  const state = harness();
  const facilitator = createAssuredSchemeFacilitator({ configuration, driver: state.driver, maxReceiptReads: 1 });

  const badRequirements = await facilitator.verify(payload, changedRequirements());
  assert.deepEqual(badRequirements, { isValid: false, invalidReason: "M1_INVALID_PAYMENT" });
  const invalidSignature = structuredClone(payload);
  invalidSignature.payload.signature = `0x${randomBytes(65).toString("hex")}`;
  assert.deepEqual(await facilitator.verify(invalidSignature, requirements), {
    isValid: false,
    invalidReason: "M1_INVALID_PAYMENT",
  });
  assert.equal((await facilitator.settle(payload, changedRequirements())).errorReason, "M1_INVALID_REQUIREMENTS");

  const injectedTarget = structuredClone(payload);
  (injectedTarget.payload as Record<string, unknown>).to = outsider.address;
  const rejectedTarget = await facilitator.verify(injectedTarget, requirements);
  assert.equal(rejectedTarget.isValid, false);
  assert.equal(state.calls.length, 0);
  assert.equal(state.counts.prepares, 0);
  assert.equal(state.counts.broadcasts, 0);
});

test("same-key concurrent settlement calls coalesce before preparation", async () => {
  const payload = await createPaymentPayload();
  let release!: () => void;
  const prepareGate = new Promise<void>(resolve => { release = resolve; });
  const state = harness({ prepareGate, receipts: [null] });
  const facilitator = createAssuredSchemeFacilitator({ configuration, driver: state.driver, maxReceiptReads: 1 });
  const one = facilitator.settle(payload, requirements);
  const two = facilitator.settle(structuredClone(payload), structuredClone(requirements));
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [first, second] = await Promise.all([one, two]);
  assert.equal(first.transaction, TX_HASH);
  assert.deepEqual(second, first);
  assert.equal(state.counts.simulations, 1);
  assert.equal(state.counts.prepares, 1);
  assert.equal(state.counts.broadcasts, 1);
});

test("different logical intents are refused while the relayer hash remains pending", async () => {
  const firstPayload = await createPaymentPayload();
  const secondPayload = await createPaymentPayload();
  const state = harness({ receipts: [null] });
  const facilitator = createAssuredSchemeFacilitator({ configuration, driver: state.driver, maxReceiptReads: 1 });
  const first = await facilitator.settle(firstPayload, requirements);
  assert.equal(first.errorReason, "settlement_pending");
  const second = await facilitator.settle(secondPayload, requirements);
  assert.equal(second.errorReason, "M1_RELAYER_BUSY");
  assert.equal(second.transaction, "");
  assert.equal(state.counts.prepares, 1);
  assert.equal(state.counts.broadcasts, 1);
});
