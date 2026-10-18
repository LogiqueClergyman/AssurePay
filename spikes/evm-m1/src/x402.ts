import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentPayload,
  PaymentRequirements,
  Network,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { Address, Hex } from "viem";
import {
  buildReceiveWithAuthorization,
  hashIntent,
  MAX_AUTHORIZATION_SECONDS,
  type Intent,
  type ReceiveWithAuthorizationTypedData,
} from "./intent.js";
import { prepareCoreCall, revalidateCoreCall, type PreparedCoreCall } from "./call.js";
import { createRelay, type RelayReceipt } from "./relay.js";
import {
  buildRequirements,
  ProfileError,
  validatePayment,
  validateRequirements,
  type ProfileConfiguration,
} from "./profile.js";

const NETWORK = "eip155:84532" as const;
const SCHEME = "assured-exact";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

export type AssuredPayerSigner = {
  address: Address;
  signTypedData: (data: ReceiveWithAuthorizationTypedData) => Promise<Hex>;
};

export type AssuredSettlementDriver = {
  address: Address;
  now: () => Promise<bigint>;
  simulate: (call: PreparedCoreCall) => Promise<void>;
  prepareCall: (call: PreparedCoreCall) => Promise<{ hash: Hex; broadcast: () => Promise<void> }>;
  getReceipt: (hash: Hex) => Promise<RelayReceipt | null>;
  verifySuccess(receipt: RelayReceipt, call: PreparedCoreCall, payment: Readonly<{ intent: Intent }>): Promise<boolean>;
};

export type AssuredSchemeClientOptions = {
  configuration: ProfileConfiguration;
  payer: AssuredPayerSigner;
  now?: () => bigint | Promise<bigint>;
  createSalt?: () => Hex;
};

export type AssuredSchemeFacilitatorOptions = {
  configuration: ProfileConfiguration;
  driver: AssuredSettlementDriver;
  maxReceiptReads?: number;
};

type SnapshotRecord = {
  readonly key: string;
  readonly capturedAt: bigint;
  readonly payment: PaymentPayload;
  readonly requirements: PaymentRequirements;
  readonly call: PreparedCoreCall;
  readonly intent: Intent;
  readonly canonicalPayment: string;
  knownHash: Hex | null;
};

function cloneAndFreeze<T>(input: T): T {
  const clone = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}

function safeCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("INVALID_SNAPSHOT");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(safeCanonical).join(",")}]`;
  if (typeof value !== "object") throw new Error("INVALID_SNAPSHOT");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${safeCanonical(record[key])}`).join(",")}}`;
}

function freezeConfiguration(configuration: ProfileConfiguration): ProfileConfiguration {
  buildRequirements(configuration);
  return cloneAndFreeze(configuration);
}

function normalizedAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}

function createIntent(
  configuration: ProfileConfiguration,
  payer: Address,
  now: bigint,
  payerSalt: Hex,
): Intent {
  return {
    chainId: configuration.bindings.chainId.toString(),
    core: normalizedAddress(configuration.bindings.core),
    token: normalizedAddress(configuration.bindings.token),
    payer: normalizedAddress(payer),
    providerId: configuration.bindings.providerId,
    policyId: configuration.bindings.policyId,
    policyHash: configuration.bindings.policyHash,
    requestHash: configuration.bindings.requestHash,
    gross: configuration.bindings.gross ?? "100",
    payerSalt,
    validAfter: (now - 1n).toString(),
    validBefore: (now + MAX_AUTHORIZATION_SECONDS - 1n).toString(),
  };
}

function createSalt(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

function invalidVerify(): VerifyResponse {
  return { isValid: false, invalidReason: "M1_INVALID_PAYMENT" };
}

function failedSettle(network: Network, reason: string, transaction = "", payer?: Address): SettleResponse {
  return {
    success: false,
    errorReason: reason,
    transaction,
    network,
    ...(payer ? { payer } : {}),
  };
}

function requirementsFor(input: unknown, configuration: ProfileConfiguration): PaymentRequirements {
  const canonical = validateRequirements(input, configuration);
  if (canonical.network !== NETWORK) throw new Error("M1_INVALID_REQUIREMENTS");
  return cloneAndFreeze(canonical);
}

async function makeClientPayment(
  requirementsInput: PaymentRequirements,
  x402Version: number,
  options: Required<Pick<AssuredSchemeClientOptions, "configuration" | "payer">>
    & Pick<AssuredSchemeClientOptions, "now" | "createSalt">,
): Promise<{ intent: Intent; intentHash: Hex; signature: Hex }> {
  if (x402Version !== 2) throw new Error("M1_UNSUPPORTED_VERSION");
  const requirements = requirementsFor(requirementsInput, options.configuration);
  const now = await (options.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))();
  if (now <= 1n) throw new Error("M1_INVALID_CLOCK");
  const salt = (options.createSalt ?? createSalt)();
  const intent = createIntent(options.configuration, options.payer.address, now, salt);
  const intentHash = hashIntent(intent);
  const typed = buildReceiveWithAuthorization(intent, intentHash, {
    name: options.configuration.tokenName,
    version: options.configuration.tokenVersion,
    chainId: options.configuration.bindings.chainId,
    token: options.configuration.bindings.token,
  });
  const signature = await options.payer.signTypedData(typed);
  const payment: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { intent, intentHash, signature },
  };
  await prepareCoreCall(payment, options.configuration, now);
  return { intent, intentHash, signature };
}

export function createAssuredSchemeClient(options: AssuredSchemeClientOptions): SchemeNetworkClient {
  const configuration = freezeConfiguration(options.configuration);
  if (normalizedAddress(options.payer.address) === ZERO_ADDRESS) throw new Error("M1_INVALID_PAYER");
  const payer = Object.freeze({
    address: normalizedAddress(options.payer.address),
    signTypedData: options.payer.signTypedData.bind(options.payer),
  });
  const boundOptions = Object.freeze({
    configuration,
    payer,
    ...(options.now ? { now: options.now } : {}),
    ...(options.createSalt ? { createSalt: options.createSalt } : {}),
  });
  return {
    scheme: SCHEME,
    async createPaymentPayload(x402Version, paymentRequirements) {
      const payment = await makeClientPayment(paymentRequirements, x402Version, boundOptions);
      return {
        x402Version: 2,
        payload: { intent: payment.intent, intentHash: payment.intentHash, signature: payment.signature },
      };
    },
  };
}

export function createAssuredX402Client(options: AssuredSchemeClientOptions): x402Client {
  const configuration = freezeConfiguration(options.configuration);
  return x402Client.fromConfig({
    schemes: [{ network: NETWORK, client: createAssuredSchemeClient({ ...options, configuration }) }],
    spendControls: {
      allowedAssets: [{
        network: NETWORK,
        asset: normalizedAddress(configuration.bindings.token),
        maxAmountPerPayment: "100",
      }],
    },
  });
}

export function createAssuredSchemeFacilitator(options: AssuredSchemeFacilitatorOptions): SchemeNetworkFacilitator {
  const configuration = freezeConfiguration(options.configuration);
  const network = `eip155:${configuration.bindings.chainId}` as Network;
  const driver = Object.freeze({
    address: normalizedAddress(options.driver.address),
    now: options.driver.now.bind(options.driver),
    simulate: options.driver.simulate.bind(options.driver),
    prepareCall: options.driver.prepareCall.bind(options.driver),
    getReceipt: options.driver.getReceipt.bind(options.driver),
    verifySuccess: options.driver.verifySuccess.bind(options.driver),
  });
  const maxReceiptReads = options.maxReceiptReads;
  const records = new Map<string, SnapshotRecord>();
  const recordsByHash = new Map<string, SnapshotRecord>();
  let activeNewIntent: string | null = null;
  const settleFlights = new Map<string, { payment: string; requirements: string; promise: Promise<SettleResponse> }>();
  const relay = createRelay({
    getReceipt: hash => driver.getReceipt(hash),
    verifySuccess: async receipt => {
      const record = recordsByHash.get(receipt.transactionHash.toLowerCase());
      if (!record) return false;
      return driver.verifySuccess(receipt, record.call, { intent: record.intent });
    },
    ...(maxReceiptReads === undefined ? {} : { maxReceiptReads }),
    prepareCall: async () => {
      const record = activeNewIntent === null ? undefined : records.get(activeNewIntent);
      if (!record) throw new Error("M1_RELAY_CALL_NOT_BOUND");
      const prepared = await driver.prepareCall(record.call);
      record.knownHash = prepared.hash;
      recordsByHash.set(prepared.hash.toLowerCase(), record);
      return prepared;
    },
  });

  function snapshot(
    paymentInput: PaymentPayload,
    requirementsInput: PaymentRequirements,
    capturedAt: bigint,
  ): Promise<SnapshotRecord> {
    return (async () => {
      const payment = cloneAndFreeze(paymentInput);
      const requirements = requirementsFor(requirementsInput, configuration);
      const accepted = requirementsFor(payment.accepted, configuration);
      if (!isDeepStrictEqual(accepted, requirements)) throw new Error("M1_REQUIREMENTS_MISMATCH");
      const canonicalPayment = safeCanonical(payment);
      const call = await prepareCoreCall(payment, configuration, capturedAt);
      const intent = (payment.payload as Record<string, unknown>).intent as Intent;
      return {
        key: call.intentHash.toLowerCase(),
        capturedAt,
        payment,
        requirements,
        call,
        intent,
        canonicalPayment,
        knownHash: null,
      };
    })();
  }

  function sameIdentity(record: SnapshotRecord, payment: PaymentPayload, requirements: PaymentRequirements): boolean {
    try {
      const paymentCopy = cloneAndFreeze(payment);
      const requirementsCopy = requirementsFor(requirements, configuration);
      return record.canonicalPayment === safeCanonical(paymentCopy)
        && isDeepStrictEqual(record.requirements, requirementsCopy);
    } catch {
      return false;
    }
  }

  async function settleRecord(record: SnapshotRecord): Promise<SettleResponse> {
    const key = record.key;
    if (record.knownHash) {
      try {
        await revalidateCoreCall(record.call, record.payment, configuration, record.capturedAt);
      } catch {
        return failedSettle(network, "M1_PAYMENT_MISMATCH", record.knownHash, record.call.payer);
      }
      const result = await relay.settle(key);
      if (result.status === "confirmed") {
        if (activeNewIntent === key) activeNewIntent = null;
        return { success: true, transaction: result.transaction, network, payer: record.call.payer };
      }
      if (result.status === "reverted") {
        if (activeNewIntent === key) activeNewIntent = null;
        return failedSettle(network, "M1_SETTLEMENT_REVERTED", result.transaction, record.call.payer);
      }
      return failedSettle(
        network,
        result.status === "mismatch" ? "M1_SETTLEMENT_MISMATCH" : "settlement_pending",
        result.transaction,
        record.call.payer,
      );
    }

    if (activeNewIntent !== null && activeNewIntent !== key) {
      return failedSettle(network, "M1_RELAYER_BUSY", "", record.call.payer);
    }
    activeNewIntent = key;
    try {
      const now = await driver.now();
      const call = await revalidateCoreCall(record.call, record.payment, configuration, now);
      await driver.simulate(call);
      const result = await relay.settle(key);
      if (result.status === "confirmed") {
        activeNewIntent = null;
        return { success: true, transaction: result.transaction, network, payer: record.call.payer };
      }
      if (result.status === "reverted") {
        activeNewIntent = null;
        return failedSettle(network, "M1_SETTLEMENT_REVERTED", result.transaction, record.call.payer);
      }
      return failedSettle(
        network,
        result.status === "mismatch" ? "M1_SETTLEMENT_MISMATCH" : "settlement_pending",
        result.transaction,
        record.call.payer,
      );
    } catch {
      if (!record.knownHash) activeNewIntent = null;
      return failedSettle(network, "M1_SETTLEMENT_UNAVAILABLE", record.knownHash ?? "", record.call.payer);
    }
  }

  return {
    scheme: SCHEME,
    caipFamily: "eip155:*",
    getExtra: () => ({ profile: "assurepay-evm-v1", assetTransferMethod: "assured-eip3009-receive", paymentFlow: "upfront" }),
    getSigners: () => [options.driver.address],
    async verify(paymentInput, requirementsInput): Promise<VerifyResponse> {
      try {
        const now = await driver.now();
        const record = await snapshot(paymentInput, requirementsInput, now);
        const existing = records.get(record.key);
        if (existing && !sameIdentity(existing, record.payment, record.requirements)) return invalidVerify();
        if (!existing) records.set(record.key, record);
        // A successful upfront-flow check is read-only and does not reserve admission.
        return { isValid: true, payer: record.call.payer };
      } catch {
        return invalidVerify();
      }
    },
    async settle(paymentInput, requirementsInput): Promise<SettleResponse> {
      let record: SnapshotRecord | undefined;
      try {
        const payment = cloneAndFreeze(paymentInput);
        const requirements = requirementsFor(requirementsInput, configuration);
        const accepted = requirementsFor(payment.accepted, configuration);
        if (!isDeepStrictEqual(accepted, requirements)) return failedSettle(network, "M1_INVALID_REQUIREMENTS");
        const canonicalPayment = safeCanonical(payment);
        const payloadHash = typeof payment.payload?.intentHash === "string" ? payment.payload.intentHash.toLowerCase() : "";
        if (!/^0x[0-9a-f]{64}$/.test(payloadHash)) return failedSettle(network, "M1_INVALID_PAYMENT");
        const requirementsIdentity = safeCanonical(requirements);
        const inflight = settleFlights.get(payloadHash);
        if (inflight) {
          if (inflight.payment !== canonicalPayment || inflight.requirements !== requirementsIdentity) {
            return failedSettle(network, "M1_PAYMENT_MISMATCH");
          }
          return await inflight.promise;
        }

        record = records.get(payloadHash);
        if (record) {
          if (!sameIdentity(record, payment, requirements)) return failedSettle(network, "M1_PAYMENT_MISMATCH", record.knownHash ?? "", record.call.payer);
        }

        const flight = (async () => {
          let current = record;
          if (!current) {
            const now = await driver.now();
            current = await snapshot(payment, requirements, now);
            if (current.key !== payloadHash) return failedSettle(network, "M1_INVALID_PAYMENT", "", current.call.payer);
            records.set(current.key, current);
          }
          return settleRecord(current);
        })();
        settleFlights.set(payloadHash, { payment: canonicalPayment, requirements: requirementsIdentity, promise: flight });
        try {
          return await flight;
        } finally {
          const currentFlight = settleFlights.get(payloadHash);
          if (currentFlight?.promise === flight) settleFlights.delete(payloadHash);
        }
      } catch (error) {
        if (error instanceof ProfileError) return failedSettle(network, "M1_INVALID_REQUIREMENTS");
        return failedSettle(network, "M1_SETTLEMENT_UNAVAILABLE", record?.knownHash ?? "", record?.call.payer);
      }
    },
  };
}

export function createAssuredX402Facilitator(options: AssuredSchemeFacilitatorOptions): x402Facilitator {
  const configuration = freezeConfiguration(options.configuration);
  const network = `eip155:${configuration.bindings.chainId}` as Network;
  return new x402Facilitator().register(network, createAssuredSchemeFacilitator({ ...options, configuration }));
}
