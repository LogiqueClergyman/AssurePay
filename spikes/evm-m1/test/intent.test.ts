import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeAbiParameters, encodePacked, keccak256, toBytes } from "viem";
import {
  FIXTURE_GROSS,
  INTENT_FIELDS,
  INTENT_TYPE_LITERAL,
  IntentValidationError,
  MAX_AUTHORIZATION_SECONDS,
  buildReceiveWithAuthorization,
  hashIntent,
  parseIntent,
  type Intent,
  type TrustedIntentBindings,
} from "../src/intent.js";

const valid: Intent = {
  chainId: "84532",
  core: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
  payer: "0x3333333333333333333333333333333333333333",
  providerId: `0x${"44".repeat(32)}`,
  policyId: `0x${"55".repeat(32)}`,
  policyHash: `0x${"66".repeat(32)}`,
  requestHash: `0x${"77".repeat(32)}`,
  gross: FIXTURE_GROSS,
  payerSalt: `0x${"88".repeat(32)}`,
  validAfter: "1000",
  validBefore: "1300",
};

const trusted: TrustedIntentBindings = {
  chainId: 84532n,
  core: valid.core,
  token: valid.token,
  providerId: valid.providerId,
  policyId: valid.policyId,
  policyHash: valid.policyHash,
  requestHash: valid.requestHash,
  gross: FIXTURE_GROSS,
};

function parse(candidate: unknown = valid, bindings = trusted, now = 1100n): Intent {
  return parseIntent(candidate, bindings, now);
}

function expectInvalid(candidate: unknown, bindings = trusted, now = 1100n): void {
  assert.throws(() => parse(candidate, bindings, now), IntentValidationError);
}

test("parses exact canonical intent and enforces all trusted bindings", () => {
  assert.deepEqual(parse(), valid);

  const mismatches: Array<[keyof Intent, unknown]> = [
    ["chainId", "84533"],
    ["core", "0x9999999999999999999999999999999999999999"],
    ["token", "0x9999999999999999999999999999999999999999"],
    ["providerId", `0x${"99".repeat(32)}`],
    ["policyId", `0x${"99".repeat(32)}`],
    ["policyHash", `0x${"99".repeat(32)}`],
    ["requestHash", `0x${"99".repeat(32)}`],
    ["gross", "101"],
  ];
  for (const [field, value] of mismatches) {
    expectInvalid({ ...valid, [field]: value });
  }
  expectInvalid(valid, { ...trusted, chainId: 0n });
});

test("normalizes trusted checksummed addresses while requiring canonical lowercase intent", () => {
  const checkedToken = "0x036CbD53842c5426634e7929541eC2318f3dCF7c" as const;
  const lowercaseToken = checkedToken.toLowerCase() as Intent["token"];
  const tokenIntent = { ...valid, token: lowercaseToken };
  const checkedBindings = { ...trusted, token: checkedToken };
  assert.equal(parse(tokenIntent, checkedBindings).token, lowercaseToken);
  assert.equal(hashIntent(parse(tokenIntent, checkedBindings)), hashIntent({ ...valid, token: lowercaseToken }));

  const typed = buildReceiveWithAuthorization(parse(tokenIntent, checkedBindings), hashIntent(tokenIntent), {
    name: "USD Coin", version: "2", chainId: 84532n, token: checkedToken,
  });
  assert.equal(typed.domain.verifyingContract, lowercaseToken);
  expectInvalid({ ...tokenIntent, token: checkedToken }, checkedBindings);
  expectInvalid(tokenIntent, { ...checkedBindings, token: "0xinvalid" as `0x${string}` });
  assert.throws(() => buildReceiveWithAuthorization(parse(tokenIntent, checkedBindings), hashIntent(tokenIntent), {
    name: "USD Coin", version: "2", chainId: 84532n, token: "0xinvalid" as `0x${string}`,
  }), IntentValidationError);
});

test("intent hash uses the literal type hash and standard ABI encoding", () => {
  const typeHash = keccak256(toBytes(INTENT_TYPE_LITERAL));
  const expectedEncoding = encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" },
      { type: "address" }, { type: "address" }, { type: "address" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" },
    ],
    [typeHash, 84532n, valid.core, valid.token, valid.payer,
      valid.providerId, valid.policyId, valid.policyHash, valid.requestHash,
      100n, valid.payerSalt, 1000n, 1300n],
  );
  assert.equal(hashIntent(valid), keccak256(expectedEncoding));

  const packed = encodePacked(
    ["bytes32", "uint256", "address", "address", "address", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256"],
    [typeHash, 84532n, valid.core, valid.token, valid.payer,
      valid.providerId, valid.policyId, valid.policyHash, valid.requestHash,
      100n, valid.payerSalt, 1000n, 1300n],
  );
  assert.notEqual(hashIntent(valid), keccak256(packed));
});

test("published unsigned vector freezes the exact type and expected intent nonce", () => {
  const vector = JSON.parse(readFileSync(new URL('../vectors/intent-v1.json', import.meta.url), 'utf8'));
  assert.equal(vector.typeLiteral, INTENT_TYPE_LITERAL);
  assert.equal(vector.typeHash, keccak256(toBytes(INTENT_TYPE_LITERAL)));
  assert.equal(hashIntent(vector.intent), vector.intentHash);
  assert.equal(vector.intentHash, '0x99783f4fb0169e85861358efef82612a93ef8fca786405e5686acab584fd7050');
  assert.equal(vector.authorizationNonce, vector.intentHash);
  assert.equal(vector.coverageId, vector.intentHash);
});

test("changing each intent field changes its authorization nonce", () => {
  const variants: Array<[keyof Intent, Intent[keyof Intent]]> = [
    ["chainId", "84533"],
    ["core", "0x9999999999999999999999999999999999999999"],
    ["token", "0x9999999999999999999999999999999999999999"],
    ["payer", "0x9999999999999999999999999999999999999999"],
    ["providerId", `0x${"99".repeat(32)}`],
    ["policyId", `0x${"99".repeat(32)}`],
    ["policyHash", `0x${"99".repeat(32)}`],
    ["requestHash", `0x${"99".repeat(32)}`],
    ["gross", "101"],
    ["payerSalt", `0x${"99".repeat(32)}`],
    ["validAfter", "1001"],
    ["validBefore", "1301"],
  ];
  const original = hashIntent(valid);
  for (const [field, value] of variants) {
    assert.notEqual(hashIntent({ ...valid, [field]: value } as Intent), original, field);
  }
});

test("accepts uint256 maximum and rejects noncanonical or overflowing values", () => {
  const max = ((1n << 256n) - 1n).toString();
  const maxIntent: Intent = {
    ...valid,
    chainId: max,
    validAfter: (BigInt(max) - 300n).toString(),
    validBefore: max,
  };
  const maxBindings = { ...trusted, chainId: BigInt(max) };
  assert.equal(parse(maxIntent, maxBindings, BigInt(max) - 150n).chainId, max);
  assert.notEqual(hashIntent(maxIntent), hashIntent(valid));

  for (const bad of ["", "-1", "+1", "01", " 1", "1.0", "1e3", (BigInt(max) + 1n).toString()]) {
    expectInvalid({ ...valid, chainId: bad });
  }
  expectInvalid({ ...valid, validBefore: (BigInt(max) + 1n).toString() });
  expectInvalid({ ...valid, chainId: `1${"0".repeat(78)}` });
});

test("gross and trusted gross must be canonical positive uint256 values", () => {
  expectInvalid({ ...valid, gross: "0" });
  expectInvalid(valid, { ...trusted, gross: "0" });
  expectInvalid(valid, { ...trusted, gross: "0100" });
  expectInvalid(valid, { ...trusted, gross: `1${"0".repeat(78)}` });
});

test("rejects arrays, missing or extra keys, and non-plain objects", () => {
  expectInvalid([]);
  const { payer: _payer, ...missing } = valid;
  expectInvalid(missing);
  expectInvalid({ ...valid, memo: "untrusted metadata" });
  const inherited = Object.assign(Object.create({ payer: valid.payer }), valid);
  delete inherited.payer;
  expectInvalid(inherited);
  assert.equal(INTENT_FIELDS.length, 12);
});

test("rejects zero values, malformed hex, checksum or uppercase addresses", () => {
  for (const [field, value] of [
    ["core", `0x${"00".repeat(20)}`],
    ["token", "0x222222222222222222222222222222222222222"],
    ["payer", "0x333333333333333333333333333333333333333G"],
    ["core", "0x111111111111111111111111111111111111111A"],
    ["providerId", `0x${"00".repeat(32)}`],
    ["policyId", `0x${"55".repeat(31)}`],
    ["policyHash", `0x${"ab".repeat(32).toUpperCase()}`],
    ["requestHash", `0x${"77".repeat(32)}0`],
    ["payerSalt", `0x${"00".repeat(32)}`],
  ] as const) {
    expectInvalid({ ...valid, [field]: value });
  }
});

test("authorization duration is capped at 300 seconds and time endpoints are exclusive", () => {
  assert.equal(MAX_AUTHORIZATION_SECONDS, 300n);
  assert.equal(parse(valid, trusted, 1001n).validAfter, "1000");
  expectInvalid(valid, trusted, 1000n);
  expectInvalid(valid, trusted, 1300n);
  expectInvalid({ ...valid, validBefore: "1301" }, trusted, 1100n);
  expectInvalid({ ...valid, validAfter: "1300", validBefore: "1000" });
  expectInvalid({ ...valid, validAfter: "0" });
  expectInvalid({ ...valid, validBefore: "0" });
});

test("builds receive-with-authorization typed data using trusted token domain", () => {
  const intent = parse();
  const nonce = hashIntent(intent);
  const typed = buildReceiveWithAuthorization(intent, nonce, {
    name: "USD Coin",
    version: "2",
    chainId: 84532n,
    token: valid.token,
  });
  assert.deepEqual(typed.domain, {
    name: "USD Coin", version: "2", chainId: 84532n, verifyingContract: valid.token,
  });
  assert.equal(typed.primaryType, "ReceiveWithAuthorization");
  assert.deepEqual(typed.message, {
    from: valid.payer,
    to: valid.core,
    value: 100n,
    validAfter: 1000n,
    validBefore: 1300n,
    nonce,
  });
  assert.throws(() => buildReceiveWithAuthorization(intent, `0x${"99".repeat(32)}`, {
    name: "USD Coin", version: "2", chainId: 84532n, token: valid.token,
  }), IntentValidationError);
  expectInvalidDomain(typed, intent, nonce);
});

function expectInvalidDomain(typed: ReturnType<typeof buildReceiveWithAuthorization>, intent: Intent, nonce: `0x${string}`): void {
  assert.throws(() => buildReceiveWithAuthorization(intent, nonce, {
    name: "USD Coin", version: "2", chainId: 84532n, token: "0x9999999999999999999999999999999999999999",
  }), IntentValidationError);
  assert.equal(typed.types.ReceiveWithAuthorization.length, 6);
}
