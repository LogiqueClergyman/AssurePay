# Algorand x402 Assurance Protocol
## Proof-of-Concept Implementation Specification

**Version:** 0.1  
**Status:** POC source of truth  
**Target chain:** Algorand TestNet  
**Primary implementation language:** TypeScript  
**Last verified against implementation baselines:** 2026-08-30

---

## 1. Purpose

This document defines the smallest complete proof of concept required to validate the core protocol thesis:

> An x402 service provider can opt into an assurance layer where each covered payment atomically splits provider revenue, insurance premium, optional provider collateral, and coverage registration; contract state determines whether new coverage is valid; request/response evidence is cryptographically bound to the payment; and an approved claim can reimburse the original payer on-chain.

This is intentionally narrower than the full architecture specification. It is the implementation contract for the first working system and should be treated as authoritative for POC code unless explicitly amended.

The POC is successful only if it proves the protocol mechanics end-to-end on Algorand TestNet. It does not need to prove final underwriting, production scalability, regulatory structure, or decentralized arbitration.

---

## 2. POC success criteria

The POC MUST demonstrate all of the following:

1. A provider can register with the Assurance Core contract.
2. A provider can create an assurance policy for an x402 endpoint.
3. A caller can request the endpoint and receive x402 payment requirements containing assurance metadata.
4. The caller can authorize one Algorand atomic transaction group containing:
   - provider net USDC payment;
   - assurance premium USDC payment;
   - optional provider stake top-up;
   - Assurance Core `openCoverage` application call;
   - facilitator fee abstraction transaction if required.
5. If any assurance contract check fails, the entire payment group fails and the provider is not paid.
6. If the group succeeds, the contract records an active coverage liability tied to the payer, provider, policy, payment, amount, and request commitment.
7. Provider capacity is derived from on-chain stake/exposure state.
8. A provider cannot withdraw collateral required by active liabilities.
9. If the provider withdraws all unencumbered collateral and has no remaining capacity, future covered payments fail automatically without a centralized ban.
10. The provider middleware produces a signed response receipt containing the request and response commitments.
11. Raw request and response payloads are stored encrypted off-chain and can be verified against their commitments.
12. The original payer can open a claim using the coverage ID and prove control of the payer account.
13. An authorized POC adjudicator can approve or reject the claim.
14. An approved claim causes the Assurance Core contract to transfer USDC to the original payer.
15. Provider-fault claims can consume provider stake before shared pool reserves according to the POC loss waterfall.
16. A minimal indexer/backend can reconstruct provider, coverage, claim, premium, refund, and stake state from chain events plus off-chain evidence metadata.

If these sixteen properties work on TestNet, the POC is considered complete.

---

## 3. Explicit POC non-goals

The POC MUST NOT expand scope to solve the following unless all core success criteria are already complete:

- multi-chain support;
- production actuarial pricing;
- subjective AI-output adjudication;
- autonomous human-free arbitration for ambiguous claims;
- licensed insurance or regulatory workflows;
- real Amazon, airline, ticketing, or other merchant integrations;
- protocol-owned merchant/orchestrator behavior;
- production-grade public rankings;
- provider rewards or token incentives;
- decentralized governance;
- threshold cryptography;
- decentralized storage;
- Merkle batching of evidence roots;
- advanced fraud models;
- sophisticated Bayesian reputation models;
- dynamic per-request pricing;
- production KMS/HSM integration;
- long-lived physical-fulfilment coverage;
- large-scale UI work.

The POC may use one demo x402 resource provider controlled by the development team. This demo provider exists only to exercise the provider-side middleware; the assurance protocol itself remains middleware and does not become an orchestrator.

---

## 4. Fixed implementation baseline

### 4.1 Technology stack

Use the following stack unless a blocking technical issue is discovered:

| Area | POC choice |
|---|---|
| Smart contract | Algorand TypeScript compiled with PuyaTs / AlgoKit |
| Chain tooling | `@algorandfoundation/algokit-utils` |
| x402 | `@x402/core`, `@x402/avm`, `@x402/express` |
| Provider demo server | Node.js + Express |
| Provider SDK | TypeScript |
| Caller/client | TypeScript Node client first |
| Backend API | Node.js + TypeScript; Express or Fastify |
| Database | PostgreSQL |
| Evidence storage | S3-compatible object storage; MinIO locally |
| Encryption | AES-256-GCM per evidence object / coverage DEK |
| Dev key wrapping | Local/env KEK abstraction; replaceable by KMS later |
| Testing | AlgoKit contract tests + TypeScript integration tests |
| Deployment | LocalNet for development, Algorand TestNet for acceptance |

### 4.2 x402 wire-profile gating decision

The logical payment profile is called **Atomic-Assured**.

Current AVM x402 payloads already carry an Algorand `paymentGroup`. The first implementation task is therefore to prove whether the existing AVM `exact` scheme can be safely extended to include the premium transfer and Assurance Core application call.

POC decision order:

1. Attempt `exact` + assurance extension / extended AVM group.
2. Verify client construction, facilitator validation, fee abstraction, and settlement.
3. If the current exact implementation cannot safely express/verify the required group, create a dedicated scheme identifier such as `assured-exact`.

The rest of this document is independent of that wire-level choice.

---

## 5. System components

The POC contains the following deployable components.

### 5.1 Assurance Core smart contract

Authoritative for:

- provider registration;
- provider status;
- policy registration;
- provider stake accounting;
- pool accounting;
- coverage creation;
- open exposure;
- collateral capacity;
- stake withdrawal constraints;
- claim finalization;
- refunds;
- provider-fault stake consumption;
- pause controls.

The contract is the source of truth for financial correctness and new-coverage eligibility.

### 5.2 Provider Assurance SDK

Integrated into an x402 resource provider. Responsibilities:

- load provider/policy configuration;
- expose assurance metadata in the x402 payment requirement;
- compute the canonical request commitment;
- ensure the request commitment is included in coverage creation;
- capture the final response bytes;
- compute the response commitment;
- generate a provider-signed response receipt;
- asynchronously upload encrypted request/response evidence;
- expose coverage ID and receipt to the caller.

The SDK MUST NOT hold authority to move provider treasury funds.

### 5.3 Assurance-aware AVM client

Responsibilities:

- interpret Atomic-Assured payment requirements;
- construct the required Algorand transaction group;
- sign caller-owned transactions;
- preserve compatibility with facilitator fee abstraction;
- submit the x402 payment payload;
- verify the returned provider response receipt.

### 5.4 x402 facilitator

The POC SHOULD use the GoPlausible Algorand x402 facilitator path used by the challenge where possible.

The facilitator remains responsible for x402 payment verification and settlement. It is not the insurance adjudicator and does not own the insurance pool.

### 5.5 Assurance API backend

Minimal off-chain control/evidence/claims API. Responsibilities:

- provider metadata projection;
- coverage projection;
- evidence metadata;
- encrypted evidence ingestion/retrieval;
- claim creation;
- POC adjudication endpoint;
- chain-event ingestion/reconciliation.

### 5.6 Chain observer

Indexes Assurance Core transactions/events and projects them into PostgreSQL.

For the POC this can be part of the backend process rather than a separate service.

### 5.7 Evidence object store

Stores encrypted request/response evidence. The object store is not trusted for integrity; hashes and signatures provide integrity verification.

### 5.8 Minimal claim interface

A REST endpoint and CLI/simple page are sufficient. No production UI is required.

---

## 6. Core entities

### 6.1 Provider

Minimum logical fields:

```text
providerId
ownerAddress
payoutAddress
receiptSigningPublicKey
status
stakeTotal
stakeLocked/openFaultExposure
createdAt
```

`providerId` is stable even if payout/signing keys later rotate.

### 6.2 Policy

POC policy fields:

```text
policyId
providerId
active
premiumBps
collateralRatioBps
maxCoverageAmount
claimWindowSeconds
objectiveFailureMode
createdAt
```

Policies are immutable once referenced by a coverage. Updating terms creates a new policy version.

### 6.3 Coverage

Minimum authoritative fields or commitments:

```text
coverageId
providerId
policyId
payerAddress
grossAmount
providerNetAmount
premiumAmount
stakeTopupAmount
requestHash
openedAt
expiresAt
status
```

Optional if cheap enough for the POC:

```text
paymentId
intentHash
```

### 6.4 Provider response receipt

```text
receiptVersion
coverageId
providerId
requestHash
responseHash
httpStatus
contentType
servedAt
latencyMs
signingKeyVersion
signature
```

### 6.5 Claim

```text
claimId
coverageId
claimantAddress
reasonCode
status
requestedAmount
providerFault
openedAt
resolvedAt
resolutionCode
refundTxId
```

---

## 7. Atomic-Assured payment model

### 7.1 Gross price semantics

The provider configures a gross caller price `G`.

For the POC:

```text
premium = floorOrConfiguredRound(G * premiumBps / 10_000)
stakeTopup = configured bootstrap amount or 0
providerNet = G - premium - stakeTopup
```

The caller pays total value `G`; the premium is funded from provider gross revenue, not added as a second charge on top of `G`.

Example:

```text
Gross price:       1.000000 USDC
Premium:           0.010000 USDC
Stake top-up:      0.040000 USDC
Provider net:      0.950000 USDC
Total caller cost: 1.000000 USDC
```

### 7.2 Logical atomic group

The group contains these roles:

```text
[PROVIDER] caller -> provider payout wallet, providerNet USDC
[PREMIUM]  caller -> Assurance Core app account, premium USDC
[STAKE]    optional caller -> Assurance Core app account, stakeTopup USDC
[COVERAGE] caller -> Assurance Core.openCoverage(...)
[FEE]      optional facilitator fee-payer transaction
```

All transactions belong to one Algorand atomic group. Either all succeed or none succeed.

### 7.3 `openCoverage` contract validation

The contract MUST validate at least:

1. protocol accepts new coverage;
2. provider exists and is active;
3. policy exists, belongs to provider, and is active;
4. coverage ID is unused;
5. payer matches the caller-owned group transactions;
6. provider transfer uses configured USDC ASA;
7. provider transfer receiver equals registered payout address;
8. premium transfer receiver equals Assurance Core app account;
9. optional stake top-up is correctly attributed;
10. `providerNet + premium + stakeTopup == grossAmount`;
11. premium meets policy pricing rules;
12. request hash is present and correctly sized;
13. call amount does not exceed policy max coverage;
14. provider has enough post-group capacity;
15. new exposure does not violate collateral rules;
16. dangerous group fields such as rekey/close are absent where relevant;
17. group structure matches the accepted Atomic-Assured profile.

Any failure rejects the whole group.

### 7.4 POC capacity formula

Use a deliberately simple formula:

```text
maxFaultExposure = stakeTotal * 10_000 / collateralRatioBps
availableCapacity = maxFaultExposure - openFaultExposure
```

Example with 10% collateral:

```text
stakeTotal = 100 USDC
maxFaultExposure = 1,000 USDC
```

The POC may treat the full covered amount as fault exposure to keep accounting simple. Later versions can separate provider-fault exposure from pool-only subjective exposure.

### 7.5 Withdrawal rule

A provider may withdraw only if post-withdrawal collateral still covers current open exposure.

Equivalent invariant:

```text
postWithdrawalMaxFaultExposure >= openFaultExposure
```

If `openFaultExposure == 0`, the provider may withdraw all stake. Once capacity reaches zero, future covered payments fail at `openCoverage`.

This behavior MUST be demonstrated in acceptance testing.

---

## 8. Provider onboarding flow

POC flow:

1. Provider generates/owns an Algorand control wallet.
2. Provider generates a dedicated Ed25519 response-receipt signing keypair.
3. Provider calls `registerProvider(owner, payoutAddress, receiptSigningPublicKey)`.
4. Provider optionally deposits initial stake.
5. Provider calls `createPolicy(...)`.
6. Provider configures its middleware with:
   - `providerId`;
   - `policyId`;
   - Assurance Core app ID;
   - TestNet USDC ASA ID;
   - facilitator URL;
   - receipt signing private key;
   - evidence API credentials.
7. Assured route becomes available only when the contract indicates sufficient capacity for the requested amount.

For POC convenience, provider metadata such as display name and endpoint URL may live only in PostgreSQL; financial state remains on-chain.

---

## 9. Covered request flow

### 9.1 Initial request

Caller sends a normal HTTP request to the provider.

Provider middleware computes the canonical request commitment before returning payment requirements.

POC request hash:

```text
requestHash = SHA-256(
  domainSeparator ||
  method ||
  canonicalResourceURL ||
  selectedHeaderBlock ||
  rawBodyBytes
)
```

Use an explicit versioned encoding. Never rely on ad-hoc JSON serialization.

### 9.2 402 response

The x402 payment requirements must expose enough assurance metadata for the client to construct the atomic group:

```text
protocolVersion
providerId
policyId
assuranceAppId
USDC asset ID
grossAmount
premium rule or resolved premium
stakeTopup if required
requestHash
coverageId or deterministic coverage nonce
claim window
```

### 9.3 Settlement

The client constructs/signs Atomic-Assured group and returns the x402 payment payload.

The facilitator verifies/settles the group.

`openCoverage` executes atomically with provider/premium/stake transfers.

### 9.4 Provider response

After successful settlement, provider business logic produces response bytes.

Middleware computes:

```text
responseHash = SHA-256(domainSeparator || rawResponseBytes)
```

It generates and signs the response receipt.

The caller verifies:

```text
receipt.coverageId matches expected coverage
receipt.requestHash == original requestHash
receipt.responseHash == locally computed responseHash
receipt signature verifies against provider registered signing key
```

The caller receives normal response data plus the assurance receipt.

---

## 10. Evidence handling

### 10.1 POC objective

Prove that a dispute resolver can reconstruct the exact request and response while neither plaintext payload is stored on-chain.

### 10.2 Storage model

For each coverage:

```text
coverage/{coverageId}/request.enc
coverage/{coverageId}/response.enc
coverage/{coverageId}/manifest.json
```

The request and response are encrypted before persistent object storage.

### 10.3 Encryption model

POC envelope encryption:

1. Generate random 256-bit coverage data-encryption key (`DEK`).
2. Encrypt request with AES-256-GCM.
3. Encrypt response with AES-256-GCM.
4. Wrap the DEK using a POC key-encryption key (`KEK`) behind a `KeyWrapper` interface.
5. Persist only wrapped DEK plus IV/nonces, tags, object locations, and hashes.

Local development may use an environment-backed KEK. The interface MUST allow replacement by cloud KMS without changing evidence formats.

### 10.4 Evidence manifest

Minimum manifest:

```json
{
  "version": 1,
  "coverageId": "...",
  "request": {
    "plaintextHash": "...",
    "ciphertextHash": "...",
    "objectKey": "..."
  },
  "response": {
    "plaintextHash": "...",
    "ciphertextHash": "...",
    "objectKey": "..."
  },
  "receiptHash": "...",
  "createdAt": "..."
}
```

### 10.5 Redaction rules

The provider SDK MUST exclude obvious credentials from assurance evidence by default, including:

- `Authorization`;
- cookies;
- bearer tokens;
- API keys;
- session secrets.

The POC need not implement arbitrary JSON-path redaction beyond a minimal configurable deny list.

### 10.6 Evidence reliability

Evidence upload happens after successful service execution and MUST be idempotent.

For the POC, failed uploads may be retried from an encrypted local spool. Missing evidence should mark the coverage projection as `EVIDENCE_INCOMPLETE`, but it does not retroactively invalidate an already-created on-chain coverage.

---

## 11. Claim and refund flow

### 11.1 Claim creation

Caller submits:

```text
coverageId
reasonCode
optional statement/evidence
payer ownership signature
```

The backend verifies:

- coverage exists;
- claimant controls the original payer address;
- claim window is open;
- no finalized duplicate claim exists for the same coverage/reason domain.

### 11.2 POC claim reasons

Implement only a small deterministic taxonomy:

```text
NO_RESPONSE
INVALID_RESPONSE_RECEIPT
OBJECTIVE_PROVIDER_FAILURE
MANUAL_POC_DISPUTE
```

Do not implement generic `UNSATISFIED_WITH_AI_RESPONSE` in the POC.

### 11.3 Adjudication

For POC, an authorized claims key may finalize the result after backend verification.

This is intentionally centralized operationally but contract-constrained financially.

Required result fields:

```text
claimId
coverageId
approved
refundAmount
providerFault
resolutionCode
```

### 11.4 Loss waterfall

For an approved full refund:

```text
refundAmount = min(approvedAmount, coverage.grossAmount)
```

If `providerFault == true`:

1. consume available provider stake accounting up to refund amount;
2. consume shared pool reserve for any remainder;
3. transfer the approved refund to `coverage.payerAddress`.

If `providerFault == false`, use shared pool reserve only.

Because provider stake and premium liquidity may both reside in the Assurance Core application account in the POC, separate them through internal accounting even if the physical USDC balance is shared.

### 11.5 Coverage state after claim

Suggested states:

```text
OPEN
CLAIM_OPEN
REFUNDED
CLOSED
```

The POC may use one claim lifecycle per coverage.

A refunded or closed coverage releases its open exposure exactly once.

---

## 12. Minimal APIs

Exact paths may change, but equivalent functionality is required.

### Provider/control

```text
POST /providers/sync
GET  /providers/:providerId
GET  /providers/:providerId/capacity
GET  /providers/:providerId/coverages
```

Provider registration/policy/stake mutations should preferably be direct chain calls through typed clients rather than authoritative backend mutations.

### Evidence

```text
POST /evidence/request
POST /evidence/response
GET  /evidence/:coverageId/status
```

Plaintext evidence retrieval should be restricted to the POC adjudicator path.

### Claims

```text
POST /claims
GET  /claims/:claimId
POST /claims/:claimId/approve     # POC admin only
POST /claims/:claimId/reject      # POC admin only
```

### Public/debug

```text
GET /coverage/:coverageId
GET /providers/:providerId/summary
GET /health
```

---

## 13. Repository structure

Use a single TypeScript monorepo for the POC.

```text
/apps
  /demo-provider          # Express x402 resource server
  /api                    # control/evidence/claims API
  /client-demo            # assurance-aware caller / CLI

/packages
  /protocol-types         # shared schemas/types/constants
  /commitments            # canonical encodings and hashes
  /receipt                # provider receipt signing/verification
  /provider-sdk           # middleware/core provider integration
  /client-sdk             # Atomic-Assured client integration
  /database               # PostgreSQL schema/access

/contracts
  /assurance-core         # Algorand TypeScript contract + generated client

/infra
  docker-compose.yml      # Postgres + MinIO for local development

/scripts
  deploy-testnet.ts
  seed-demo.ts
  run-happy-path.ts
  run-refund-demo.ts

/docs
  poc-spec.md
  atomic-profile-notes.md
```

Avoid splitting the POC into microservices. Logical boundaries should exist in code, but one backend process is sufficient.

---

## 14. Contract interface - conceptual POC ABI

Final names/types may change during contract LLD, but functionality should map closely to:

```text
registerProvider(
  providerId,
  payoutAddress,
  receiptSigningPublicKey
)

setProviderStatus(providerId, status)

createPolicy(
  policyId,
  providerId,
  premiumBps,
  collateralRatioBps,
  maxCoverageAmount,
  claimWindowSeconds
)

depositStake(providerId, amountRef)

withdrawStake(providerId, amount)

openCoverage(
  coverageId,
  providerId,
  policyId,
  requestHash,
  grossAmount,
  providerNetAmount,
  premiumAmount,
  stakeTopupAmount
)

finalizeClaim(
  claimId,
  coverageId,
  approvedAmount,
  providerFault,
  resolutionCode
)

closeCoverage(coverageId)

setPaused(paused)
```

The implementation SHOULD derive values from grouped transactions whenever possible rather than trusting duplicate arguments.

---

## 15. Required on-chain invariants

These are mandatory test properties.

### INV-1 Atomicity

No covered provider payment may settle unless `openCoverage` succeeds in the same group.

### INV-2 Revenue-funded premium

`providerNet + premium + stakeTopup == grossAmount` for every coverage.

### INV-3 Correct recipients

Provider revenue goes only to registered provider payout address. Premium/stake funds go only to Assurance Core-controlled account(s).

### INV-4 Capacity

`openFaultExposure <= maxFaultExposure` after every state transition.

### INV-5 Withdrawal safety

A stake withdrawal can never make existing exposure undercollateralized.

### INV-6 Unique coverage

A `coverageId` can be opened at most once.

### INV-7 Bound payer

Refund recipient is the original on-chain payer, not an arbitrary address supplied during claim finalization.

### INV-8 Single exposure release

A coverage can release exposure at most once.

### INV-9 Accounting

Internal premium reserve + provider stake liabilities + other tracked protocol balances must reconcile to or be bounded by actual Assurance Core USDC balance.

### INV-10 No unsafe group controls

Accepted payment groups must not permit unexpected rekey, close-out, recipient substitution, or asset substitution on transactions used by the protocol.

---

## 16. POC database tables

Keep the schema minimal.

### `providers`

```text
provider_id PK
owner_address
payout_address
receipt_public_key
status
chain_synced_round
created_at
```

### `policies`

```text
policy_id PK
provider_id
premium_bps
collateral_ratio_bps
max_coverage_amount
claim_window_seconds
active
chain_synced_round
```

### `coverages`

```text
coverage_id PK
provider_id
policy_id
payer_address
group_tx_id
gross_amount
premium_amount
stake_topup_amount
request_hash
status
opened_round
expires_at
evidence_status
```

### `receipts`

```text
coverage_id PK
response_hash
http_status
served_at
latency_ms
receipt_json
signature
```

### `evidence_objects`

```text
id PK
coverage_id
kind
object_key
plaintext_hash
ciphertext_hash
wrapped_dek
nonce
created_at
```

### `claims`

```text
claim_id PK
coverage_id
claimant_address
reason_code
status
requested_amount
provider_fault
resolution_code
refund_tx_id
created_at
resolved_at
```

The database is a projection/cache. Chain state wins for financial truth.

---

## 17. Demo scenarios

The final POC demo MUST include at least these scenarios.

### Demo A - successful assured call

1. Active provider with capacity.
2. Caller hits insured x402 endpoint.
3. Atomic group settles.
4. Coverage appears on-chain.
5. Provider receives net revenue.
6. Assurance pool receives premium.
7. Response receipt verifies.
8. Encrypted request/response evidence exists.

### Demo B - insufficient provider capacity

1. Provider has insufficient stake/capacity.
2. Client attempts identical covered call.
3. `openCoverage` rejects.
4. Entire group fails.
5. Provider receives no service payment.

### Demo C - withdrawal safety

1. Provider has open exposure.
2. Provider tries withdrawing too much stake.
3. Contract rejects withdrawal.
4. After exposure closes, withdrawal succeeds.
5. With zero remaining capacity, future covered calls fail.

### Demo D - approved refund

1. Successful covered payment exists.
2. Caller opens claim.
3. POC adjudicator approves provider-fault refund.
4. Contract pays original payer.
5. Provider stake accounting is reduced first.
6. Coverage becomes `REFUNDED` and exposure is released.

### Demo E - tampered evidence

1. Modify stored/decrypted response bytes or substitute another response.
2. `responseHash` no longer matches signed receipt.
3. Verification fails visibly.

This demonstrates why the evidence system is cryptographically useful rather than merely a logging database.

---

## 18. Acceptance tests

### Smart-contract tests

Must include:

- valid provider registration;
- duplicate provider rejection;
- policy ownership checks;
- correct premium arithmetic;
- wrong provider recipient rejection;
- wrong premium recipient rejection;
- wrong ASA rejection;
- duplicate coverage rejection;
- insufficient capacity rejection;
- same-group stake top-up capacity success if implemented;
- over-withdrawal rejection;
- valid withdrawal success;
- claim payout only to payer;
- payout cannot exceed approved/covered amount;
- exposure released once;
- pause blocks new coverage;
- malicious rekey/close group rejection where applicable.

### Integration tests

Must include:

- 402 -> payment group -> settlement -> response;
- facilitator fee abstraction if enabled;
- request hash consistency between client/provider/contract;
- provider receipt signature verification;
- evidence encrypt -> store -> retrieve -> decrypt -> verify;
- claim creation with payer signature;
- refund transaction confirmation;
- backend chain projection reconciliation.

### TestNet acceptance

Before calling the POC complete, run the five demo scenarios against Algorand TestNet and record transaction/application IDs in a release note.

---

## 19. Implementation order

### P0 - Atomic group spike

Goal: remove the largest protocol uncertainty first.

Build only:

- tiny Assurance Core contract with `openCoverage` assertion;
- provider USDC transfer;
- premium USDC transfer;
- AppCall in same group;
- x402 AVM client/facilitator settlement.

Exit condition: the group settles through the intended x402 path on TestNet and a failing AppCall prevents both transfers.

### P1 - On-chain assurance core

Add:

- provider registration;
- policy;
- stake;
- capacity;
- withdrawal;
- coverage storage;
- claim finalization/refund;
- invariant tests.

### P2 - Provider/client SDK path

Add:

- Express provider middleware;
- assurance-aware client;
- request commitments;
- response receipt signing/verification;
- happy-path integration test.

### P3 - Evidence and claims backend

Add:

- PostgreSQL;
- MinIO/S3 storage;
- envelope encryption;
- chain projection;
- claim creation;
- adjudicator action;
- refund execution.

### P4 - Demo hardening

Add:

- CLI/scripts for all demo scenarios;
- minimal provider summary endpoint;
- logs and readable errors;
- TestNet deployment/reproducibility documentation.

Do not begin ranking, subjective risk scoring, commerce integrations, or production UI before P4 is complete.

---

## 20. Open POC decisions

Only these questions are intentionally left open and should be resolved during P0/P1:

1. **x402 representation:** existing AVM `exact` with assurance extension vs dedicated `assured-exact` scheme.
2. **Coverage storage:** exact box/global-state layout and minimum-balance implications.
3. **Premium rounding:** integer rounding direction for 6-decimal USDC and whether a minimum premium atomic unit is required.
4. **Coverage closure:** explicit `closeCoverage` transaction vs lazy/keeper close. For POC, explicit close is acceptable.
5. **Claims authority:** single development key vs multisig. Single secured dev key is acceptable for POC; production is not.
6. **Same-group stake bootstrap:** implement if it does not complicate P0 materially; otherwise initial provider stake deposit is acceptable for the POC only. The production economic design remains revenue-funded.

No other architecture decisions should be reopened during POC implementation without a documented blocker.

---

## 21. What the POC proves - and what it does not

If complete, this POC proves:

- x402 service assurance can be implemented as middleware rather than a proxy;
- premium collection can be coupled to provider revenue in an Algorand atomic group;
- coverage validity can depend directly on decentralized contract state;
- provider collateral can bound new liability and cannot be escaped while encumbered;
- payment, premium, and liability creation can be all-or-nothing;
- request/response history can be cryptographically bound without publishing plaintext on-chain;
- a claim can end in a verifiable on-chain reimbursement to the original payer;
- the same primitives can later support higher-value deterministic agentic transactions.

It does **not** prove that the final premium rates are profitable, that subjective claims are solvable, that large commerce losses are sufficiently capitalized, or that the protocol is legally an insurance product. Those require later underwriting, risk, legal, and production design work.

---

## 22. Implementation baselines

The POC should track current upstream packages rather than copy old examples blindly.

Current baselines verified on 2026-08-30:

- Algorand TypeScript is an official AVM smart-contract language compiled through PuyaTs and integrates with AlgoKit typed clients.
- Current GoPlausible/x402 AVM TypeScript documentation uses `@x402/avm` and represents AVM payment payloads as a `paymentGroup` of encoded Algorand transactions.
- Current AVM x402 fee abstraction already uses an Algorand atomic transaction group where the facilitator signs a fee-covering transaction.

Reference URLs:

- https://dev.algorand.co/docs/algorand-typescript/typescript/latest/
- https://dev.algorand.co/algokit/algokit-intro/
- https://github.com/GoPlausible/.github/blob/main/profile/algorand-x402-documentation/typescript/x402-avm-avm-examples.md
- https://github.com/GoPlausible/.github/blob/main/profile/algorand-x402-documentation/typescript/x402-avm-core-examples.md

---

## 23. POC completion definition

The POC is complete when a clean checkout can:

```text
1. start local dependencies;
2. deploy Assurance Core;
3. register/seed a provider and policy;
4. start the demo x402 provider;
5. execute a successful Atomic-Assured paid request;
6. verify the signed response receipt;
7. show encrypted request/response evidence;
8. demonstrate capacity and withdrawal enforcement;
9. submit and approve a claim;
10. show the refund arriving at the original payer address;
11. repeat the core flow on Algorand TestNet.
```

Everything beyond this list belongs to the next iteration.
