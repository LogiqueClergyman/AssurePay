# M3 — policy-backed client/provider HTTP flow

State: REVIEW. Local implementation and required checks pass; results:
`planning/EVM_M3_RESULTS.md`. M2 ACCEPTED under EVM-018; interface boundary EVM-019.
Read AGENTS.md, SESSION_HANDOFF.md, EVM-016..021 in DECISIONS.md and this packet.
No `/docs` material is in scope. This packet is self-contained.

## Allowed scope and exit condition

Write `packages/x402-assurance/**`, this packet, planning/EVM_M3_RESULTS.md and
focused DECISIONS/handoff/plan updates. Read-only reuse: packages/evm-core/**
(exclude node_modules/envs), M1 src/{intent,profile,call,x402,flow,relay,receipt,
evm-driver}.ts, package.json/lock/toolchain and vectors/intent-v1.json under
spikes/evm-m1, and installed pinned x4022.28.0 source/types under that spike's
node_modules/@x402. Preserve earlier packages/contracts, evidence, wallets and
journals. Root tooling changes require a focused documented need.

Deliver isolated pinned package, real registered x402 client/server/facilitator,
strict canonical schemas and chain-term reader, restricted settlement engine
with durable hash recovery/verifier, real HTTP client/provider wrappers,
owner-signed response receipts, service idempotency journal, actual local-EVM
HTTP integration/negative/restart tests, independent review and results.
No production UI, evidence/claims backend, automated decisions, new contracts,
multiple chains/assets, public mutation or populated env access. No service
semantics beyond an injected bounded byte handler. No proxy/external commerce.

## Profile and shared semantics

Pin @x402/core and @x402/evm2.28.0, viem2.57.7, TS5.9.3, tsx4.20.6;
Node24.18/npm11.16, reuse M2 pinned compile/Anvil1.7.1 for tests only.
Scheme assured-exact, profile assurepay-evm-v2, ATM
assured-eip3009-receive-v2, network eip155:84532, paymentFlow upfront only.
Use actual x402 SDK registration/resource-server before-handler settlement.
Standard exact is not our Core handler. Standard PAYMENT-REQUIRED,
PAYMENT-SIGNATURE, PAYMENT-RESPONSE headers use installed SDK JSON/base64 codec.
Unknown financial/extension fields and unsupported negotiation are rejected.

Trusted config: chainId84532, Core/token/providerId/policyId and client maxGross
atomic string. No unsolicited choice of network/token/Core/recipient/policy.
A canonical same-block reader verifies chain ID, Core/token deployed code,
Core.token, immutable provider owner/payout, policy association/hash/parameters,
independent integer quote and token USDC/2/6-decimal EIP712 domain. Recheck the
canonical block after reads. Return flat JSON-safe Terms; monetary amounts and
duration are canonical uint decimal strings, BPS are bounded safe integers.
Terms include trust IDs, providerOwner/providerPayout,policyHash,premiumBps,
stakeBps,withholdingBps,duration,poolOnlyAllowed,gross,premium,withheld,net,
stakeLock,poolReservation,tokenName='USDC',tokenVersion='2'. Observation block
metadata is separate from immutable wire terms. Admission is not reserved by
verify; simulate/recheck exact Core call before new submission.

Terms and payload validation binds all negotiated requirements to independently
trusted terms. Payment payload uses intent/intentHash/signature; exact M2 intent
literal and hash and token receive typed data remain unchanged. Client signs
once for a new purchase with fresh random salt, strict300-second maximum token
window, explicit token spend allowlist/cap. Retries reuse that payment object.
Recovered known transactions may be checked after authorization expiry; a new
submission must still be live. No automatic fresh purchase on a failed response.

## Canonical request and response receipt

Support POST at one configured absolute resource URL, no query/hash/userinfo;
URL serialization must already be canonical. HTTPS required outside loopback;
local tests use http://127.0.0.1:<port>/assured. Provider trusts its configured
URL, never incoming Host/forwarded headers. Exact content type is
application/octet-stream. Limit request/response body to65536 bytes and payment
header to16384 bytes. Reject unsupported encoding, duplicate financial/request
ID headers, malformed IDs, method/path/content type and oversized bodies.

Client sends ASSUREPAY-REQUEST-ID nonzero lowercase bytes32. Request hash is
keccak256(abi.encode(typehash,method,url,contentType,keccak256(body),requestId)),
where method='POST', contentType as above and literal exactly:
`AssuredRequestV1(string method,string url,string contentType,bytes32 bodyHash,bytes32 requestId)`.
Exact bytes are signed; no JSON reserialization, query sorting or implicit
normalization. Client independently recomputes hash from its own URL/body/ID.

Response receipt message has chainId(uint256),core(address),coverageId(bytes32),
requestHash(bytes32),responseHash(bytes32),status(uint16),completedAt(uint256),
primary type AssuredResponseV1, EIP712 domain name AssurePayResponse,version1,
chainId84532,verifyingContract Core. responseHash=keccak256(exact response bytes).
Owner signer must recover to immutable providerOwner. Status matches actual HTTP
status200..599. completedAt is canonical provider-asserted UTC seconds, not a
proven on-chain completion timestamp. ASSUREPAY-RECEIPT carries JSON/base64
message+signature. Client verifies identity/signature/body/status and independently
verifies payment confirmation before accepting a paid response. No receipt proves
service quality or claim eligibility. Invalid/tampered receipts fail explicitly.

## Settlement and service execution

Restricted engine accepts only a frozen validated Core call and configured terms;
revalidate all fields, receive signature, encoded data and live time before new
submission. Gas/fee/native-value bounds and confirmed/pending nonce must match
prepared AND signed transaction. Only Core.settleAssured, native value0. Derive
hash locally and fsync exclusive public journal before attempting one broadcast.
Persist only chain/Core/token/relayer/intentHash/calldataHash/nonce/transaction
identity and safe terms; never signatures, signed bytes or populated envs.
Use a serialized queue across different intents and coalesce identical calls.
Existing journal records recover read-only, including after process restart;
unknown receipt/RPC errors remain pending, never infer failure/rebroadcast.

Signer-free verification requires chain/transaction identity, exact Core data
hash/value/relayer/chain, canonical receipt/block/configured minimum1 inclusion,
matching CoverageOpened financial fields, exact receive/provider Transfer and
AuthorizationUsed logs, nonce consumed and exact stored coverage at receipt block.
Recheck canonical block after state reads. Prove inclusion, not finality. Do not
require whole-block aggregate balance deltas: independent purchases may share a
block. Reverted matched canonical receipts are terminal; missing/mismatched or
uncertain reads never admit service. Engine reconcile should not need a signer.

Provider handles unpaid request with402 and does not run handler. Paid request
settles through registered resource server upfront flow, then handler only after
verified confirmation. EVM-020 additionally requires a canonical current-state
Active coverage with now<expiresAt before creating a new service-start record.
Provider canServe(call) is required; uncertainty never starts the handler. Cached
responses remain retrievable without re-execution after coverage expiry. Pending returns202 with known transaction/coverage ID,
never a fresh authorization request. A failed/reverted payment never runs handler.

EVM-021 reserves service identity by coverageId+requestHash before settlement
to reject a second payment for the same request before charging. Reservation
transitions to an exclusive durable start record before handler entry; reserved
restart can reconcile/start, started restart cannot rerun. Concurrent duplicate requests share one in-memory
flight and response cache. Repeated exact payment does not pay or run twice.
Changed URL/body/ID/policy/payment is rejected. Completed/failed public-only
metadata records status/hash/time; bytes and receipt signature are in-memory
only. On restart, running record -> indeterminate, completed record without cache
-> response unavailable. Neither reruns handler. Handler throws produce one signed
bounded500 response, preserve paid coverage, and do not automatically refund.
No exactly-once claim for arbitrary external effects or multi-process deployment.

## Component interface contracts

Shared `src/types.ts` defines Trust, Terms, Intent, PreparedCall, PaymentResult,
PayerSigner and ReceiptMessage. PreparedCall contains intent,intentHash,signature,
to,data; PaymentResult contains state confirmed|pending|reverted|invalid,
transaction,coverageId and optional blockNumber/blockHash. Engine.settle(call)
returns PaymentResult. Engine verifies against its configured Terms and keeps
known-hash recovery durable. Namespaced journals bind terms/relayer/chain and
reject cross-context reuse. Module owners coordinate exports before dependent
code; record substantive interface/assumption changes in DECISIONS before use.

Protocol exports canonical request hash, response receipt sign/verify, strict
requirements/payload/prepared-call validation and registered SDK adapter factories.
Chain exports readTerms(client,trust,gross), verifier, settlement engine and
isServiceAdmissible(client,terms,call):Promise<boolean>.
HTTP client accepts opaque payer, trusted IDs/cap, readTerms/now/verify callbacks;
creates one reusable purchase session with send/retry using the same payment.
Provider accepts trusted terms, engine, required canServe(call) callback,
owner receipt signer, injected handler,
journal path and configured resource URL. HTTP wrappers never log raw payments,
signatures, transactions, RPC errors or secrets. Safe fixed error codes only.

## Required verification

- Strict typecheck and meaningful schema/canonical-byte/receipt negative tests.
- Actual registered x402 + real localhost HTTP + actual M2 Anvil contract with
  faithful ERC3009 signed receive: dynamic P/W/L/Q quote, atomic ledger/coverage,
  verified response, one broadcast/signature/handler on duplicate/retry.
- No handler for unpaid, malformed, wrong request/terms, invalid signature,
  stale new authorization, pause, insufficient stake/pool or reverted transaction.
- Ambiguous/lost broadcast and response, pending and expired-known-hash recovery,
  concurrent distinct/identical requests, process-style engine restart recovery
  without signer; journal mismatches/overwrite/tampering fail closed.
- Lost HTTP response returns identical cached response without repayment;
  service-start restart is indeterminate, completed restart unavailable, never
  re-executes. Handler failure has signed500 and preserved paid coverage.
- Tampered request/response bytes/status/receipt signer and spend-cap/redirect/
  unsupported profile are rejected; no leaks in test errors or committed evidence.
- Verify collateral solvency/isolation after financial successes and reverts.
- Independent scoped review plus primary verification; record tests/artifacts,
  transport limitations and exact next action in planning/EVM_M3_RESULTS.md.

Run npm run typecheck and npm test in packages/x402-assurance. M2 contracts are
read-only; this gate proves local composition, not public native-USDC acceptance
of the combined HTTP stack. Stop at M3 REVIEW. M4 needs acceptance and its own
self-contained packet; do not implement encrypted claims/evidence implicitly.
