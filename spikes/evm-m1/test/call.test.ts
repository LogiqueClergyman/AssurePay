import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildReceiveWithAuthorization, hashIntent, type Intent } from "../src/intent.js";
import { CoreCallError, prepareCoreCall, revalidateCoreCall, SPIKE_CORE_ABI } from "../src/call.js";
import { buildRequirements, type ProfileConfiguration } from "../src/profile.js";

const NOW = 1_800_000_000n;
const core = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const providerId = `0x${"44".repeat(32)}` as Hex;
const policyId = `0x${"55".repeat(32)}` as Hex;
const policyHash = `0x${"66".repeat(32)}` as Hex;
const requestHash = `0x${"77".repeat(32)}` as Hex;
const configuration: ProfileConfiguration = {
  bindings: { chainId: 84532n, core, token, providerId, policyId, policyHash, requestHash },
  providerPayout: "0x9999999999999999999999999999999999999999",
  tokenName: "USDC",
  tokenVersion: "2",
};
const accepted = buildRequirements(configuration);
const payer = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());

function newIntent(payerAddress: Address = payer.address): Intent {
  return {
    chainId: "84532",
    core,
    token,
    payer: payerAddress.toLowerCase() as Address,
    providerId,
    policyId,
    policyHash,
    requestHash,
    gross: "100",
    payerSalt: `0x${randomBytes(32).toString("hex")}` as Hex,
    validAfter: (NOW - 100n).toString(),
    validBefore: (NOW + 200n).toString(),
  };
}

async function signedPayment(
  signer = payer,
  intent = newIntent(signer.address),
  domainOverride?: { name?: string; version?: string; chainId?: bigint; verifyingContract?: Address },
) {
  const intentHash = hashIntent(intent);
  const typed = buildReceiveWithAuthorization(intent, intentHash, {
    name: configuration.tokenName,
    version: configuration.tokenVersion,
    chainId: configuration.bindings.chainId,
    token: configuration.bindings.token,
  });
  const signature = await signer.signTypedData({
    ...typed,
    domain: { ...typed.domain, ...domainOverride },
  });
  return {
    x402Version: 2,
    accepted: structuredClone(accepted),
    payload: { intent: { ...intent }, intentHash, signature },
  };
}

test("prepares exact Core calldata only after recovering the payer's receive signature", async () => {
  const payload = await signedPayment();
  const prepared = await prepareCoreCall(payload, configuration, NOW);
  const decoded = decodeFunctionData({ abi: SPIKE_CORE_ABI, data: prepared.data });
  assert.equal(decoded.functionName, "settleAssured");
  assert.equal(prepared.to, core);
  assert.equal(prepared.intentHash, payload.payload.intentHash);
  assert.equal(prepared.payer, payer.address.toLowerCase());
  assert.ok(Object.isFrozen(prepared));
  const [intentArg, v] = decoded.args;
  assert.equal(intentArg.chainId, 84532n);
  assert.equal(intentArg.gross, 100n);
  assert.equal(intentArg.payer.toLowerCase(), payer.address.toLowerCase());
  assert.ok(v === 27 || v === 28);
});

test("rejects signatures from another payer, another domain, or the transfer authorization type", async () => {
  const wrongSigner = await signedPayment(outsider, newIntent(payer.address));
  await assert.rejects(prepareCoreCall(wrongSigner, configuration, NOW), { message: "M1_CORE_CALL_INVALID_SIGNATURE" });

  const wrongDomain = await signedPayment(payer, newIntent(), { chainId: 1n });
  await assert.rejects(prepareCoreCall(wrongDomain, configuration, NOW), { message: "M1_CORE_CALL_INVALID_SIGNATURE" });

  const intent = newIntent();
  const intentHash = hashIntent(intent);
  const typed = buildReceiveWithAuthorization(intent, intentHash, {
    name: configuration.tokenName,
    version: configuration.tokenVersion,
    chainId: configuration.bindings.chainId,
    token: configuration.bindings.token,
  });
  const transferSignature = await payer.signTypedData({
    domain: typed.domain,
    primaryType: "TransferWithAuthorization",
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    message: typed.message,
  });
  const transferPayload = {
    x402Version: 2,
    accepted: structuredClone(accepted),
    payload: { intent: { ...intent }, intentHash, signature: transferSignature },
  };
  await assert.rejects(prepareCoreCall(transferPayload, configuration, NOW), { message: "M1_CORE_CALL_INVALID_SIGNATURE" });
});

test("revalidation rejects changed signed bytes before a submit stub runs", async () => {
  const payload = await signedPayment();
  const prepared = await prepareCoreCall(payload, configuration, NOW);
  const changed = structuredClone(payload);
  changed.payload.intent.payerSalt = `0x${"aa".repeat(32)}`;

  let submissions = 0;
  await assert.rejects(async () => {
    await revalidateCoreCall(prepared, changed, configuration, NOW);
    submissions++;
  }, { message: "M1_CORE_CALL_CALL_REVALIDATION_FAILED" });
  assert.equal(submissions, 0);
  assert.ok(Object.isFrozen(prepared));
  assert.equal(prepared.data, (await revalidateCoreCall(prepared, payload, configuration, NOW)).data);
});

test("accepts an equivalent signed call and rejects expired authorizations", async () => {
  const payload = await signedPayment();
  const prepared = await prepareCoreCall(payload, configuration, NOW);
  const equivalent = { ...structuredClone(payload), resource: { url: "https://example.invalid/" } };
  assert.equal(await revalidateCoreCall(prepared, equivalent, configuration, NOW), prepared);
  await assert.rejects(prepareCoreCall(payload, configuration, NOW + 201n), { message: "M1_CORE_CALL_INVALID_PAYMENT" });
});

test("rejects noncanonical recovery bytes instead of building calldata", async () => {
  const payload = await signedPayment();
  payload.payload.signature = `${payload.payload.signature.slice(0, -2)}00` as Hex;
  await assert.rejects(prepareCoreCall(payload, configuration, NOW), { message: "M1_CORE_CALL_INVALID_SIGNATURE" });

  const malleable = await signedPayment();
  const body = malleable.payload.signature.slice(2);
  const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = (curveOrder - BigInt(`0x${body.slice(64, 128)}`)).toString(16).padStart(64, "0");
  const flippedV = body.slice(128) === "1b" ? "1c" : "1b";
  malleable.payload.signature = `0x${body.slice(0, 64)}${highS}${flippedV}` as Hex;
  await assert.rejects(prepareCoreCall(malleable, configuration, NOW), { message: "M1_CORE_CALL_INVALID_SIGNATURE" });
});
