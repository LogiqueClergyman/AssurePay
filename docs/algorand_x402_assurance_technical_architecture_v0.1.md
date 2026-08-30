# Algorand x402 Assurance Protocol
## Technical Architecture Specification

**Document status:** Architecture source of truth - v0.1  
**Date:** 2026-08-30  
**Initial network:** Algorand MainNet / TestNet  
**Initial settlement asset:** USDC (Algorand Standard Asset)  
**Protocol focus:** Provider-integrated assurance, refunds, verifiable service records, staking, risk analytics, and reputation for x402-paid services

---

## 1. Purpose of this document

This document is the technical source of truth for the first implementation of an assurance layer for x402 services on Algorand. It is intended to be detailed enough to serve as the upstream architecture specification from which lower-level design documents, smart-contract specifications, SDK designs, database schemas, API specifications, threat models, test plans, and implementation tasks can be generated.

The protocol is **not** an x402 service orchestrator, proxy, merchant of record, or downstream purchasing agent. Existing x402 resource providers continue to serve their own requests and receive their own service revenue directly. The protocol is a middleware and economic-assurance layer that providers opt into by integrating an SDK and registering on the protocol.

The protocol adds the following capabilities to an otherwise ordinary x402 interaction:

1. An atomic payment profile in which part of the provider's advertised gross service price is directed to a shared assurance pool as premium.
2. Optional revenue-funded provider stake accumulation, avoiding a mandatory up-front premium payment and allowing small providers to bootstrap collateral from earned revenue.
3. A stateful Algorand smart contract that determines whether a provider is currently eligible to create new covered liabilities.
4. A cryptographically bound coverage record for every insured call.
5. Request and response commitments that make later alteration detectable.
6. Encrypted off-chain evidence retention for claims and disputes.
7. Automated and human-assisted claims handling and reimbursement.
8. Provider staking, slashing/recovery, risk scoring, analytics, certification, and public rankings.
9. A design that can later support high-value agentic transactions, including booking, purchasing, and other real-world actions, without the assurance protocol itself executing those actions.

This document is deliberately Algorand-specific. Chain abstraction is a future concern and MUST NOT complicate the first implementation.

---

## 2. Normative terminology

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used normatively.

### 2.1 Status labels used in this document

- **COMMITTED** - considered part of the architecture and should be treated as a requirement unless explicitly revised.
- **MVP** - required for the first working implementation.
- **FUTURE** - intentionally deferred; the MVP should not depend on it.
- **OPEN** - a design decision that requires a proof of concept, benchmark, external integration confirmation, or underwriting decision before it is frozen.

---

## 3. Core product thesis

The protocol provides an economically backed assurance layer for x402 interactions.

A resource provider integrates protocol middleware around its existing x402 resource server. Callers continue to call that provider directly. The provider does not forward calls through the assurance protocol. The assurance protocol also does not perform a downstream purchase, booking, API invocation, or other service action on behalf of the provider.

For a covered x402 call, payment settlement and creation of the corresponding assurance liability are atomic on Algorand. The payment group includes:

- the provider's net service revenue;
- the assurance premium;
- an optional provider stake bootstrap contribution; and
- an Algorand application call that creates the coverage record and validates current provider eligibility.

The protocol then records cryptographic evidence about the request and response. If a valid claim is later approved, the original payer is reimbursed according to policy.

The long-term network effect is:

```text
buyer protection
      -> claims + service telemetry
      -> provider risk history
      -> reputation / certification / pricing
      -> economic incentive for better service
      -> more trustworthy agentic commerce
```

The data product is therefore as important as the refund product. Provider rankings are backed by real paid interactions, real coverage liabilities, signed response receipts, claims, stake, and observed outcomes rather than unverified star ratings.

---

## 4. Explicit non-goals

The first implementation MUST NOT become any of the following:

1. **A proxy for all x402 traffic.** Requests travel directly between the caller and the resource provider.
2. **An x402 marketplace that performs the underlying service.** Providers remain responsible for their own API, AI inference, purchase, booking, execution, or other action.
3. **A merchant of record.** The protocol does not buy Amazon products, flight tickets, or other goods for callers.
4. **A general-purpose escrow of provider revenue.** Under the primary atomic flow, provider net revenue settles directly to the provider wallet.
5. **A plaintext request/response surveillance system.** Sensitive evidence is encrypted off-chain and accessed only for legitimate protocol operations.
6. **A claim engine that attempts to semantically judge every AI response.** Subjective claims are primarily handled through risk policy, history, budgets, and escalation rather than universal response-quality scoring.
7. **A chain-agnostic abstraction in v1.** Algorand primitives are used directly where they simplify the design.
8. **A promise of fully decentralized arbitration in the MVP.** Payment eligibility and financial constraints are on-chain; complex dispute adjudication may initially require an authorized protocol claims authority, with decentralized arbitration treated as a future upgrade.

---

## 5. System actors and entities

### 5.1 Caller / Agent

The entity purchasing access to an x402 resource.

Responsibilities:

- sends the original HTTP request;
- understands or uses a client that understands the Atomic-Assured payment profile;
- signs its own Algorand transactions;
- receives the provider response and assurance receipt;
- may file a claim;
- proves control of the original payer wallet when filing or modifying a claim.

The caller MUST NOT need an account on the assurance dashboard merely to receive coverage.

### 5.2 Resource Provider

An independent x402 service provider.

Examples:

- AI inference API;
- search API;
- data API;
- computation service;
- booking service;
- shopping/purchasing service;
- on-chain action service;
- any other HTTP resource monetized through x402.

The provider:

- owns and operates the resource server;
- integrates the provider SDK/middleware;
- registers its provider identity, payout wallet, signing key, endpoints, and assurance policies;
- receives provider net revenue directly;
- maintains or accumulates provider stake;
- may challenge a claim;
- receives risk analytics, rankings, and certification benefits.

### 5.3 Assurance Client SDK

The client-side x402 integration that understands the Atomic-Assured payment profile.

Responsibilities:

- parses assurance metadata from the `402 Payment Required` response;
- validates policy parameters before signing;
- computes the request commitment;
- constructs the required Algorand atomic transaction group;
- signs only transactions owned by the caller;
- sends the x402 payment payload;
- verifies the provider-signed response receipt;
- optionally uploads or retains caller-side evidence;
- exposes the resulting `coverageId` to the caller application.

### 5.4 Provider Assurance SDK / Middleware

A package installed by the provider around its existing x402 middleware and HTTP response path.

Responsibilities:

- obtains provider/policy configuration;
- advertises assurance information in the `402` response;
- participates in x402 payment verification/settlement using the configured facilitator;
- maps x402 payment identifiers and Algorand transaction/group identifiers to a coverage record;
- captures assurance-relevant request metadata;
- computes and signs response receipts;
- uploads encrypted evidence and outcome events;
- reports service telemetry;
- provides a graceful uninsured fallback only if explicitly configured.

The provider API key authenticates provider calls to the protocol control plane and evidence APIs. It MUST NOT authorize blockchain fund movement.

### 5.5 x402 Resource Server

The provider's normal x402-protected HTTP server. It remains provider-operated and provider-hosted.

### 5.6 Facilitator

The x402 facilitator verifies and settles payment payloads. For the Algorand Global x402 Challenge deployment, the target facilitator is GoPlausible's Algorand x402 facilitator.

The facilitator is not the insurer and does not adjudicate claims.

### 5.7 Algorand Network

The initial trust-minimized settlement and state layer.

The protocol relies on Algorand for:

- atomic transaction groups;
- ASA transfers, primarily USDC;
- stateful application calls;
- provider stake custody/accounting;
- premium pool custody/accounting;
- coverage registration;
- enforcement of provider capacity;
- withdrawal constraints;
- refund execution;
- immutable event/commitment anchoring.

### 5.8 Assurance Core Application

The primary stateful Algorand application for the MVP.

Logical responsibilities:

- protocol configuration;
- provider registry;
- provider state and status;
- policy commitments;
- provider stake accounting;
- pool accounting;
- coverage creation;
- open exposure accounting;
- stake withdrawal constraints;
- claim finalization authorization;
- refund execution;
- evidence-root anchoring.

For the MVP, these responsibilities MAY be implemented in one stateful application to reduce cross-application complexity. The internal state and accounting MUST nevertheless preserve strict logical separation between shared pool funds and provider-attributable stake.

Future deployments MAY split these modules across multiple applications without changing the logical protocol.

### 5.9 Assurance Core Application Account

The Algorand application account associated with the Assurance Core Application.

It can hold USDC and ALGO. In the MVP it is the likely custody account for:

- shared assurance pool USDC;
- provider stake USDC;
- protocol reserves required for operational transactions and Algorand minimum balance requirements.

The fact that these funds share an application account MUST NOT imply shared ownership. Internal on-chain accounting MUST distinguish provider stake liabilities from free shared pool liquidity.

### 5.10 Claims API / Refund Interface

The direct caller-facing interface for reimbursement requests.

The external UX MAY expose `/refund`, but internally every refund request is a `Claim` with a state machine. A caller request MUST NOT imply automatic approval.

### 5.11 Claims Engine

The off-chain service that evaluates claims.

Inputs may include:

- on-chain coverage record;
- provider policy;
- caller history;
- provider history;
- objective SLA telemetry;
- request/response evidence;
- provider-signed receipt;
- external outcome evidence;
- claim reason and attachments;
- anti-fraud signals.

Outputs:

- automatic approval;
- automatic rejection;
- request for additional evidence;
- provider challenge window;
- manual/arbitration escalation;
- finalized refund amount and fault attribution.

### 5.12 Evidence Service

Off-chain encrypted evidence ingestion and retrieval system.

It stores encrypted request/response content, manifests, receipts, external outcome evidence, and claim attachments while anchoring integrity commitments to Algorand.

### 5.13 Blockchain Indexer / Chain Observer

An internal service that follows Algorand application and asset-transfer activity and projects authoritative chain state into queryable off-chain databases.

It is not authoritative for financial eligibility. The contract remains authoritative.

### 5.14 Risk Engine

Calculates versioned provider and caller risk signals for underwriting, claim decisions, premium tiers, collateral ratios, coverage limits, and public reputation.

### 5.15 Provider Dashboard

Authenticated UI for:

- provider onboarding;
- endpoint and policy management;
- stake and capacity visibility;
- premium and insured-volume analytics;
- claims and challenges;
- evidence health;
- performance metrics;
- reward/certification status;
- signing-key rotation;
- API key management.

### 5.16 Public Rankings / Certification Interface

Public read-only view of assured provider performance.

Only verifiable covered interactions count toward protocol rankings.

### 5.17 Protocol Claims Authority

**MVP:** an authorized key, preferably a multisig or threshold-controlled operational authority, allowed to submit finalized claim decisions to the Assurance Core Application.

This is intentionally separated from the contract's deterministic financial rules. The authority can request a payout, but the contract MUST still enforce:

- claim uniqueness;
- coverage existence;
- payout limits;
- valid destination;
- available pool/stake accounting;
- state transition legality.

**FUTURE:** replace or augment with decentralized arbitration, committee signatures, optimistic dispute windows, or threshold arbitration.

---

## 6. Trust model

### 6.1 What the protocol does not trust

The design MUST NOT trust any single one of the following to describe a covered interaction correctly:

- caller;
- resource provider;
- provider SDK;
- protocol backend database;
- analytics indexer;
- evidence object store.

### 6.2 What is trusted or partially trusted in the MVP

The MVP necessarily trusts:

- Algorand consensus and AVM execution;
- the configured x402 facilitator to perform its advertised verification/settlement role;
- the claims authority for ambiguous claim adjudication;
- protocol KMS/HSM policy for managed evidence decryption;
- protocol backend availability for evidence ingestion, claims, dashboards, and analytics.

The financial path MUST minimize the consequences of backend compromise by keeping eligibility, capacity, payment splitting, stake withdrawal rules, coverage existence, and payout caps on-chain.

### 6.3 Decentralization boundary

The core decentralization invariant is:

> No interaction may be represented as a valid covered Atomic-Assured x402 payment unless the Assurance Core Application accepts the corresponding liability in the same Algorand atomic transaction group.

Therefore:

- a stale or malicious SDK cannot create valid coverage if the contract rejects it;
- a provider that has withdrawn available stake loses future coverage capacity automatically;
- simultaneous callers cannot over-allocate the same capacity because contract state serializes accepted liability;
- an off-chain database cannot fabricate on-chain coverage.

---

## 7. Core protocol invariants

The implementation MUST preserve the following invariants.

### I-1: Atomicity of payment and liability

Provider payment, premium allocation, optional stake bootstrap, and coverage creation either all succeed or all fail.

There MUST NOT be a valid state where a caller paid an Atomic-Assured request but the corresponding on-chain coverage creation failed.

### I-2: Premium is revenue-funded, not prepaid

For the primary flow, the premium is carved out of the provider's advertised gross service price during the covered x402 payment.

If gross service price is `G`:

```text
providerNet + premium + optionalStakeTopup = G
```

The caller pays `G` in total. The provider receives `providerNet`. Economically, premium and optional stake bootstrap are provider operational costs funded from revenue, not a separate up-front provider deposit.

A future product MAY allow provider-configured caller-paid surcharges, but that is not the default MVP economic model.

### I-3: Direct provider settlement

The provider net amount settles directly to the provider payout wallet. There is no provider revenue settlement vault in the primary flow.

### I-4: Contract-state eligibility

The final authority on whether a new coverage liability can be created is the Assurance Core Application's current state at transaction execution time.

SDK-side checks are only UX optimizations.

### I-5: Existing liability cannot be escaped by withdrawal

A provider may withdraw only free/unencumbered stake. Withdrawal MUST NOT reduce remaining collateral below the contract-defined requirement for currently open provider-fault exposure.

### I-6: Zero stake means zero future capacity unless same-group top-up restores capacity

A provider with no free capacity cannot create new covered liabilities. It may continue serving uninsured x402 traffic outside the protocol.

### I-7: Coverage is uniquely identifiable

Every covered call has a unique `coverageId`. The contract MUST reject duplicate creation.

### I-8: Request immutability

A cryptographic request commitment is included in the on-chain coverage creation. A different request cannot later be substituted without detection.

### I-9: Response non-repudiation

The provider produces a signed response receipt binding the `coverageId`, request commitment, response commitment, policy, and response metadata.

### I-10: Full-refund destination is bound to the payer

Unless an explicitly versioned future policy permits otherwise, refunds MUST go to the original payer address recorded by the coverage.

### I-11: One claim lifecycle per coverage/reason domain

The protocol MUST prevent double reimbursement for the same covered loss.

### I-12: Evidence plaintext is not stored on-chain

Raw requests, responses, PII, order details, prompts, and attachments MUST NOT be stored in Algorand application state or transaction notes.

### I-13: Public rankings include only assured activity

Uninsured or unverifiable provider traffic MUST NOT inflate protocol performance rankings.

### I-14: API keys never authorize asset movement

Provider API keys authenticate off-chain APIs only. On-chain fund movement requires Algorand authorization or contract logic.

### I-15: Financial accounting reconciles to actual assets

The Assurance Core Application MUST maintain an invariant relating actual USDC held to internal pool and stake ledgers. No off-chain ledger is authoritative for spendable protocol funds.

---

## 8. Algorand and x402 foundation

### 8.1 x402 role

x402 uses HTTP `402 Payment Required` to communicate machine-readable payment requirements. Clients construct payment payloads, resource servers forward them to facilitators for verification/settlement, and successful settlement unlocks the protected resource.

### 8.2 Algorand AVM x402 properties used by this protocol

The existing Algorand x402 implementation already represents AVM payments as an Algorand transaction group and supports fee abstraction using a facilitator-controlled fee-payer transaction. Its documentation also describes the payment group as composable and able to contain additional transactions.

Algorand atomic groups support up to 16 transactions and execute all-or-nothing. Application logic can inspect other transactions in the same group.

These properties are the basis of Atomic-Assured.

### 8.3 Network identifiers

Initial network identifiers follow the current AVM x402 CAIP-2 values:

```text
Algorand TestNet:
algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=

Algorand MainNet:
algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=
```

These MUST be imported from the current `@x402/avm` package rather than duplicated as handwritten application constants when an SDK constant exists.

### 8.4 USDC asset IDs

Current AVM x402 documentation identifies:

```text
Algorand MainNet USDC ASA ID: 31566704
Algorand TestNet USDC ASA ID: 10458941
USDC decimals: 6
```

Production code MUST keep network and asset configuration explicit and environment-specific.

### 8.5 Atomic-Assured: logical profile vs x402 wire representation

**COMMITTED:** the financial and coverage flow is an Algorand atomic group.

**OPEN:** the exact x402 wire-level representation is not frozen until a compatibility proof of concept is completed with the target GoPlausible facilitator and current x402 SDK.

Two implementation options are valid:

#### Option A - preferred if supported cleanly: `exact` + assurance extension

Use the existing AVM `exact` scheme and an `assurance` x402 extension. The assurance-aware client augments the existing AVM payment group with the premium transfer, optional stake transfer, and Assurance Core AppCall.

Advantages:

- maximizes compatibility with existing AVM facilitator support;
- aligns with documented AVM payment-group composability;
- avoids unnecessary scheme proliferation.

Requirements:

- assurance-aware client must be able to augment the payment group;
- facilitator must accept and safely verify the additional asset transfers and AppCall;
- extension semantics must clearly communicate total gross payment and assurance allocations.

#### Option B - fallback: new scheme identifier such as `assured-exact`

Implement dedicated client, server, and facilitator scheme handlers.

Advantages:

- explicit settlement semantics;
- cleaner type system for a multi-leg assured payment;
- facilitator can validate the exact group layout directly.

Disadvantage:

- requires facilitator support for the new `(scheme, network)` combination.

This document uses the term **Atomic-Assured** for the logical profile independent of which wire representation is selected.

---

## 9. Primary Atomic-Assured payment model

### 9.1 Gross price semantics

The provider configures a gross price `G`, meaning the total amount the caller authorizes for the resource.

For a provider-funded premium:

```text
premium = premiumFunction(G, policy)
stakeTopup = bootstrapStakeFunction(G, providerState, policy)
providerNet = G - premium - stakeTopup
```

`providerNet` MUST be non-negative.

The caller's total value transfer for the service remains `G`.

Example:

```text
Gross service price:       1.000000 USDC
Premium rate:              0.50%
Premium:                   0.005000 USDC
Optional stake bootstrap:  0.020000 USDC
Provider net revenue:      0.975000 USDC
Total caller transfer:     1.000000 USDC
```

### 9.2 Canonical group roles

A logical Atomic-Assured group contains the following roles. Exact transaction indices are an implementation detail and MUST be validated by role, expected index profile, or both.

```text
[FEE]      optional facilitator fee-payer transaction
[PROVIDER] caller -> provider payout wallet, providerNet USDC
[PREMIUM]  caller -> Assurance Core app account, premium USDC
[STAKE]    optional caller -> Assurance Core app account, stakeTopup USDC
[COVERAGE] caller -> Assurance Core application call: open_coverage(...)
```

All value transferred from the caller in `[PROVIDER] + [PREMIUM] + [STAKE]` equals the gross price.

The `[STAKE]` transfer is economically provider revenue withheld into the provider's own stake position. It is not a caller-owned deposit.

### 9.3 Fee abstraction

The current AVM x402 implementation can include a facilitator fee-payer self-payment in the atomic group. Atomic-Assured MUST be compatible with this pattern.

The Assurance Core contract MUST NOT assume a fixed group size of exactly three or four transactions if fee abstraction or future safe auxiliary transactions are present. Instead, the protocol should use a versioned group profile with explicit role indices or validated references.

No group may exceed Algorand's current 16-transaction maximum.

### 9.4 Group-level safety

The client, facilitator integration, and Assurance Core contract SHOULD collectively reject dangerous or unrelated transaction behavior, including where applicable:

- `rekeyTo`;
- account close-out/close remainder;
- ASA close-out;
- key registration;
- unexpected recipients;
- unexpected assets;
- unexpected sender identities;
- unbounded fees;
- additional asset movement not permitted by the Atomic-Assured group profile.

The contract MUST independently validate all transactions whose correctness is required for financial safety.

### 9.5 Coverage application call

Conceptual arguments:

```text
open_coverage(
  protocolVersion,
  coverageId,
  providerId,
  policyId,
  requestHash,
  intentHash?,
  grossAmount,
  providerNetAmount,
  premiumAmount,
  stakeTopupAmount,
  paymentId?,
  requestNonce,
  evidenceMode
)
```

The final ABI MUST minimize argument count and byte footprint and may move some fields into a compact encoded struct or derive them from group transactions/state.

### 9.6 Contract checks when opening coverage

The Assurance Core Application MUST validate at least:

1. protocol is not globally paused for new coverage;
2. provider exists and is enabled;
3. policy exists, belongs to provider, and is active;
4. policy is valid for the current time/round;
5. `coverageId` is unused;
6. payer is the expected sender for the caller-owned group transactions;
7. provider transfer asset is the configured USDC ASA;
8. provider transfer receiver equals the registered provider payout wallet;
9. premium transfer receiver equals the Assurance Core application account;
10. stake top-up, if present, is directed to the Assurance Core account and attributed to the correct provider;
11. gross arithmetic reconciles exactly;
12. premium amount satisfies policy pricing rules;
13. request commitment is present and correctly sized/versioned;
14. maximum per-call coverage is not exceeded;
15. provider has sufficient post-group coverage capacity, including same-group stake top-up if allowed;
16. resulting open exposure and stake accounting remain valid;
17. no duplicate payment/coverage identifier is accepted;
18. application call and transfer group structure match the supported profile.

If any check fails, the AppCall fails and the entire group fails.

### 9.7 Concurrency safety

Coverage capacity is consumed in contract state when `open_coverage` succeeds. Therefore two concurrent callers cannot both consume the same last unit of capacity. The first accepted state transition reduces remaining capacity; the second group fails if it would exceed limits.

---

## 10. Provider registration and lifecycle

### 10.1 Provider identity

A provider has:

```text
providerId
owner/control wallet
payout wallet
receipt-signing public key
status
createdAt
risk tier / underwriting profile reference
stake accounting
open exposure accounting
policy references
metadata commitment
```

`providerId` SHOULD be a protocol-generated stable identifier rather than a raw wallet address so payout wallets and signing keys can rotate without changing historical identity.

### 10.2 Wallet proof

Provider onboarding MUST require proof of control of the provider control wallet. Payout-wallet changes MUST require authenticated authorization and SHOULD include a delay for high-value providers.

### 10.3 Receipt signing key

The provider SHOULD register a dedicated Ed25519 assurance signing public key rather than using its treasury/payout private key on the resource server.

The signing key is used for response receipts and provider-originated outcome events. Key rotation MUST preserve historical verification by retaining key-version history.

### 10.4 Provider status

Suggested states:

```text
PENDING
ACTIVE
CAPACITY_EXHAUSTED   (derived condition; may not need persistent status)
SUSPENDED
EXITING
CLOSED
```

The contract is authoritative for whether new coverage may be opened.

### 10.5 Provider exit

A provider may stop using the protocol without permission.

It may:

- disable assured routes;
- wait for open coverage to expire/resolve;
- withdraw free stake;
- ultimately withdraw remaining unlocked stake.

It MUST NOT withdraw stake still required by open liabilities.

Historical assured metrics remain part of the public record even after exit.

---

## 11. Provider stake and coverage capacity

### 11.1 No universal mandatory fixed stake

The architecture does not require a fixed global minimum such as `$100` or `$500`.

Instead, current stake determines current capacity.

### 11.2 Stake variables

Conceptual provider state:

```text
stakeTotal
stakeLocked
stakeFree = stakeTotal - stakeLocked
openFaultExposure
openTotalExposure
coverageCapacity
```

### 11.3 Capacity model

The exact underwriting formula is configurable and versioned.

A simple initial form is:

```text
maxFaultExposure = stakeTotal / collateralRatio
availableFaultCapacity = maxFaultExposure - openFaultExposure
```

Equivalent leverage form:

```text
maxFaultExposure = stakeTotal * leverageFactor
```

A policy may also impose pool-wide and per-provider concentration limits.

### 11.4 Withdrawal rule

A withdrawal of amount `W` is valid only if the provider's post-withdrawal stake still satisfies all open-liability requirements.

Conceptually:

```text
postStake = stakeTotal - W
requiredStake = requiredCollateral(openFaultExposure, providerRiskTier, policyMix)
assert postStake >= requiredStake
```

If open exposure is zero, a provider may withdraw all stake. Its future coverage capacity then falls to zero unless a new deposit or same-group revenue-funded stake top-up restores capacity.

### 11.5 Revenue-funded stake bootstrap

To support providers with little initial capital, policies MAY reserve part of gross revenue into provider stake.

Example:

```text
premiumBps = 50
bootstrapStakeBps = 200 while provider stake < target
```

The optional stake top-up is included in the same atomic group. The contract MAY count it when determining whether that same coverage can be accepted.

This mechanism is practical for high-margin API services. High-value commerce providers may require pre-existing collateral because withholding a large percentage of pass-through purchase principal can make the underlying transaction impossible.

### 11.6 Provider-fault versus pool-only exposure

Not all claim types need to lock provider stake equally.

The policy model SHOULD distinguish:

- **provider-fault exposure**, potentially recoverable from provider stake;
- **pool-only/subjective exposure**, primarily borne by shared premium reserves;
- **external-party exposure**, potentially recoverable from merchant/carrier/provider proceeds.

This prevents subjective protection from unnecessarily locking provider collateral.

---

## 12. Policy model

### 12.1 Policy is versioned and immutable once referenced

Every coverage references a specific `policyId` and policy version/hash.

A provider may create a new policy version, but it MUST NOT alter the terms of already-open coverage.

### 12.2 Policy fields

Conceptual policy:

```text
policyId
providerId
version
status
validFrom
validUntil?
coverageClass
premiumBps
collateralBps / underwriting profile
maxCoveragePerCall
claimWindowSeconds
coverageDuration
subjectiveCoverageMode
objectiveFailureCodes[]
refundCaps
providerFaultShareRules
evidenceMode
evidenceRetentionClass
responseReceiptRequired
externalOutcomeRequirements?
policyDocumentHash
```

### 12.3 Coverage classes

Initial classes:

1. `DETERMINISTIC_API`
2. `GENERATED_OUTPUT`
3. `EXTERNAL_EXECUTION`
4. `COMMERCE_EXECUTION`
5. `LONG_LIVED_FULFILLMENT` - future/high-risk

### 12.4 Objective failures

Examples:

- timeout past promised deadline;
- no response;
- HTTP failure where policy promises success;
- invalid output schema;
- empty response;
- incorrect deterministic parameters;
- duplicate execution;
- external order not created when creation was promised;
- price above signed maximum;
- wrong SKU/date/quantity/seat class;
- promised cryptographic proof absent;
- required response receipt absent.

### 12.5 Subjective failures

Examples:

- AI answer not useful;
- search result perceived as poor;
- generated content not satisfactory despite meeting objective SLA.

Subjective coverage SHOULD be risk-budgeted and may be partial, history-dependent, or unavailable depending on policy.

The contract need not know the semantic reason taxonomy in detail; it needs the payout and fault-attribution outcome of finalized claims.

---

## 13. HTTP and x402 request flow

### 13.1 Initial request

Caller sends an ordinary HTTP request to the provider.

```text
Caller -> Provider Resource Server
```

### 13.2 Provider returns 402

The provider's assurance middleware emits an x402 `402 Payment Required` response containing normal AVM payment information and assurance metadata.

Conceptual assurance extension:

```json
{
  "assurance": {
    "version": "1",
    "providerId": "prov_...",
    "policyId": "pol_...",
    "grossAmount": "1000000",
    "premiumAmount": "5000",
    "stakeTopupAmount": "0",
    "providerNetAmount": "995000",
    "assuranceAppId": "...",
    "asset": "31566704",
    "coverageClass": "DETERMINISTIC_API",
    "claimWindowSeconds": 86400,
    "evidenceMode": "MANAGED_EVIDENCE",
    "receiptSigningKeyId": "key_..."
  }
}
```

The exact x402 extension schema is an LLD concern, but all economically material values MUST be explicit or deterministically derivable.

### 13.3 Client preflight

The assurance-aware client:

1. verifies supported network and asset;
2. checks local spending policy;
3. verifies gross price and premium disclosure;
4. computes request commitment;
5. obtains/derives a unique `coverageId` and nonce;
6. constructs the Atomic-Assured group;
7. signs its own transactions;
8. leaves facilitator-owned fee-payer transactions unsigned if fee abstraction is used.

### 13.4 Payment verification and settlement

The provider resource server forwards the x402 payment payload to the facilitator.

The facilitator validates the supported AVM payment profile and submits the transaction group.

The Assurance Core AppCall performs the on-chain assurance-specific validity checks.

Successful Algorand execution means both payment and coverage were accepted.

### 13.5 Provider executes business logic

Only after successful x402 settlement, the provider performs its normal application logic and returns the resource response.

The assurance protocol does not execute the provider's business action.

---

## 14. Request commitment design

### 14.1 Why request commitments exist

The protocol needs to prove what the caller actually requested without publishing the request.

For example, in commerce, a later dispute may be:

> caller requested quantity 1 but provider claims quantity 5 was requested.

The on-chain request commitment prevents retrospective substitution.

### 14.2 Request commitment envelope

The client constructs a versioned request commitment envelope containing assurance-relevant fields.

Recommended conceptual structure:

```text
RequestCommitmentV1 {
  version
  method
  canonicalResourceIdentifier
  selectedHeadersHash
  rawBodyHash
  intentHash?
  clientTimestamp?
}
```

The final `requestHash` is the hash of a deterministic canonical encoding of this envelope.

### 14.3 Raw body hash

`rawBodyHash` MUST hash the exact raw HTTP body bytes used for the request before any provider-side parsing or reserialization.

### 14.4 Canonical encoding

Structured commitment metadata MUST use one versioned deterministic encoding. Recommended candidates are:

- RFC 8785 JSON Canonicalization Scheme for JSON structures; or
- deterministic CBOR.

The implementation MUST NOT use language-dependent `JSON.stringify()` output as a cross-platform cryptographic specification unless canonicalization is explicitly guaranteed.

### 14.5 Headers

Only assurance-relevant headers should be committed.

Credential headers MUST NOT be retained as evidence by default, including:

- `Authorization`;
- cookies;
- API secrets;
- internal bearer tokens.

If a header is semantically necessary to a covered promise, its value may be committed or selectively retained according to policy.

### 14.6 Intent object for high-value actions

For bookings, purchases, transfers, and other economically meaningful actions, raw HTTP alone is not sufficient.

The provider policy SHOULD define a normalized `Intent` object.

Example:

```json
{
  "operation": "PURCHASE",
  "item": {
    "merchant": "merchant-id",
    "sku": "SKU-123",
    "quantity": 1
  },
  "constraints": {
    "maximumTotalPrice": "150.00",
    "currency": "USD",
    "latestFulfillmentDate": "2026-09-05"
  }
}
```

The `intentHash` becomes part of the request commitment and/or coverage state.

This allows claims to reason about the promised economic result rather than the accidental shape of a provider-specific HTTP API.

---

## 15. Response receipt design

### 15.1 Response cannot be committed in the original payment group

The provider response does not exist when the payment is signed. Therefore response evidence is created after settlement.

### 15.2 Provider receipt

The provider middleware computes a response hash and signs a versioned receipt.

Conceptual receipt:

```text
ProviderReceiptV1 {
  version
  coverageId
  providerId
  policyId
  requestHash
  responseHash
  httpStatus
  contentType
  servedAt
  latencyMs
  outcomeType?
  signingKeyId
}
```

The receipt is signed using the provider's registered assurance signing key.

### 15.3 Response hash

`responseHash` MUST bind the exact response body bytes. Assurance-relevant headers may be represented in a separate header hash or canonical response envelope.

### 15.4 Delivery

The signed receipt SHOULD be returned to the caller in a response header or x402 response extension and also submitted to the Evidence Service.

### 15.5 Client verification

The assurance-aware client SHOULD verify:

```text
hash(receivedResponseBytes) == receipt.responseHash
```

and verify the provider signature against the key version registered for that provider.

If verification fails, the client MUST surface the assurance failure distinctly from application-level response content.

### 15.6 Relationship to x402 signed receipts

The protocol SHOULD compose with x402's Signed Offers & Receipts extension where practical. Assurance-specific receipts add request/response commitments, coverage identity, policy identity, and service telemetry necessary for claims.

---

## 16. Evidence architecture

### 16.1 Design principle

The evidence layer separates:

- **public immutable commitments**, and
- **private underlying evidence**.

The blockchain proves that evidence has not been silently rewritten; encrypted off-chain storage provides the actual material needed for a dispute.

### 16.2 Evidence modes

Policies SHOULD select one of the following evidence modes.

#### `COMMITMENT_ONLY`

For very low-value deterministic calls.

Stores:

- on-chain request commitment;
- provider receipt;
- aggregate telemetry;
- minimal/no raw req/res retention.

Claim capability is limited to failures provable from retained metadata.

#### `MANAGED_EVIDENCE`

Default insured mode.

Stores encrypted:

- request body/envelope;
- response body/envelope;
- provider receipt;
- claim-relevant metadata.

#### `HIGH_VALUE_EVIDENCE`

For commerce or large transactions.

Additionally stores:

- normalized intent;
- external outcome events;
- invoices/receipts where available;
- booking/order confirmations;
- signed carrier/merchant evidence;
- longer retention;
- stricter evidence-completeness requirements.

### 16.3 MVP encryption model

The MVP uses application-layer envelope encryption backed by a managed KMS/HSM.

For each coverage:

1. generate a random 256-bit data-encryption key (DEK);
2. encrypt evidence objects with an authenticated cipher such as AES-256-GCM;
3. wrap the DEK using a KMS-held key-encryption key;
4. store only the wrapped DEK in the database;
5. record all decrypt operations in immutable audit logs.

Protocol operators technically retain controlled decryption capability in the MVP. This MUST be documented honestly.

### 16.4 Future privacy model

Future versions may use:

- caller/provider public-key envelope encryption;
- threshold decryption;
- multi-arbitrator key shares;
- trusted execution environments;
- zero-knowledge proofs for narrow evidence claims.

The MVP architecture MUST not depend on these future mechanisms.

### 16.5 Object storage

Encrypted evidence blobs are stored in durable object storage such as S3-compatible storage.

Requirements:

- private buckets;
- versioning;
- object integrity checks;
- WORM/retention controls for active dispute windows where supported;
- lifecycle deletion;
- replication/backups;
- application-layer encryption in addition to provider-side storage encryption.

Raw evidence SHOULD NOT be placed on permanently public content-addressed networks by default, especially where it may contain personal or purchase information.

### 16.6 Evidence manifest

Every coverage with retained evidence has a manifest.

Conceptual manifest:

```text
EvidenceManifestV1 {
  coverageId
  requestPlaintextHash
  requestCiphertextHash
  responsePlaintextHash
  responseCiphertextHash
  providerReceiptHash
  intentHash?
  outcomeEventHeadHash?
  attachmentHashes[]
  createdAt
  manifestVersion
}
```

The manifest itself is hashed.

### 16.7 Merkle anchoring

Evidence manifests and event heads are periodically batched into a Merkle tree.

The protocol submits an Algorand application call containing:

```text
epochId
merkleRoot
recordCount
epochStart
epochEnd
```

The Evidence Service retains each record's Merkle inclusion proof.

This gives post-response evidence an on-chain time/integrity anchor without requiring a new Algorand transaction for every response.

### 16.8 Append-only interaction event chain

Each coverage maintains an append-only event chain.

Example event types:

```text
COVERAGE_OPENED
PAYMENT_SETTLED
REQUEST_OBSERVED
RESPONSE_PRODUCED
RESPONSE_ACKNOWLEDGED
OUTCOME_REPORTED
CLAIM_OPENED
EVIDENCE_ADDED
CLAIM_AUTO_DECIDED
PROVIDER_CHALLENGED
CLAIM_FINALIZED
REFUND_PAID
COVERAGE_CLOSED
```

Each event includes a hash of the previous event so deletion or substitution is detectable in the evidence history.

### 16.9 Evidence retention

Retention is policy-class specific.

Example policy defaults for later underwriting tuning:

```text
micro API:              7-30 days
standard API:           30-90 days
commerce execution:     180+ days
long-lived fulfillment: fulfillment end + dispute window
```

On expiry:

- encrypted blobs are deleted according to policy;
- wrapped DEKs are deleted when cryptographic erasure is required;
- public commitments and aggregate statistics may remain indefinitely.

---

## 17. External action and commerce evidence

### 17.1 Protocol boundary

The assurance protocol does not perform the external purchase or booking.

A provider may itself offer an x402 service such as:

```text
"buy this product"
"book this flight"
"reserve this ticket"
```

The provider remains responsible for executing that action.

### 17.2 Outcome state machines

Policies may define expected outcome states.

Example purchase flow:

```text
REQUEST_ACCEPTED
 -> ORDER_CREATED
 -> SHIPPED
 -> DELIVERED
```

Possible alternate transitions:

```text
ORDER_CREATED -> CANCELLED -> MERCHANT_REFUND_ISSUED
```

Example booking flow:

```text
REQUEST_ACCEPTED
 -> BOOKING_CONFIRMED
 -> TICKET_ISSUED
 -> SERVICE_COMPLETED
```

### 17.3 Outcome event schema

Conceptual:

```text
OutcomeEventV1 {
  coverageId
  sequence
  type
  occurredAt
  externalReferenceHash?
  amount?
  evidenceHash?
  issuerType
  issuerId
  previousEventHash
  signature
}
```

### 17.4 Evidence strength classes

The Risk/Claims Engine SHOULD classify external evidence by source quality.

- **Tier 0: provider self-attested** - provider claims an outcome occurred.
- **Tier 1: externally signed** - merchant/carrier/booking-system signed webhook or receipt.
- **Tier 2: independently verified** - protocol independently verifies against merchant/carrier/blockchain/oracle source.

The policy may require a minimum evidence tier for high-value coverage.

### 17.5 Initial commerce scope

The MVP or first commerce extension SHOULD insure deterministic transaction execution before attempting broad subjective product satisfaction.

Examples that are relatively deterministic:

- order not created;
- wrong SKU;
- wrong quantity;
- price exceeded agreed maximum;
- duplicate booking/order;
- reservation missing;
- ticket not issued;
- merchant refund received by provider but not forwarded.

Broad conditions such as "I did not like the product" should be excluded or handled by separate higher-priced policies.

---

## 18. Claims and refund lifecycle

### 18.1 External endpoint semantics

The user-facing API may expose:

```http
POST /v1/refunds
```

or:

```http
POST /v1/claims
```

If `/refund` is used for UX, it still creates a claim rather than immediately issuing funds.

### 18.2 Claim identity

Preferred input is `coverageId`.

The API MAY accept a request ID, x402 payment ID, or Algorand transaction/group ID and resolve it to `coverageId`.

A bare predictable request ID MUST NOT be sufficient authorization.

### 18.3 Caller authentication

The caller proves control of the original payer account by signing a nonce/challenge that binds:

```text
coverageId
claim reason
claim request timestamp
protocol domain separator
nonce
```

### 18.4 Claim state machine

Suggested:

```text
OPEN
 -> AUTO_APPROVED
 -> AUTO_REJECTED
 -> NEEDS_EVIDENCE
 -> PROVIDER_REVIEW
 -> PROVIDER_CHALLENGED
 -> ARBITRATION
 -> FINAL_APPROVED
 -> FINAL_REJECTED
 -> REFUND_SUBMITTED
 -> REFUNDED
 -> CLOSED
```

Not every claim passes through every state.

### 18.5 Objective claim path

For objective failures, the engine SHOULD prefer deterministic rules over AI semantic review.

Examples:

- latency > policy threshold;
- signed response schema flag failed;
- response missing;
- required outcome deadline expired;
- intent says SKU A while signed external outcome says SKU B.

### 18.6 Subjective claim path

For subjective generated-output claims, the engine initially uses:

- caller historical approved-claim rate;
- caller spend/claim ratio;
- caller age and interaction count;
- provider historical claim/loss rate;
- amount;
- claim clustering;
- continued use of the provider after claiming dissatisfaction;
- available subjective refund budget;
- fraud/collusion signals.

The engine SHOULD avoid decrypting req/res for low-value claims unless escalation is needed.

### 18.7 Provider challenge

For material claims, a provider may be given a policy-defined challenge period and access to evidence relevant to its own interaction.

The provider cannot modify previously committed evidence.

### 18.8 Finalization on-chain

When a claim is finalized as payable, the claims authority submits a transaction to the Assurance Core Application.

Conceptual method:

```text
finalize_claim(
  claimId,
  coverageId,
  reasonCode,
  refundAmount,
  providerFaultAmount,
  poolAmount,
  decisionHash
)
```

The contract verifies:

- caller destination equals coverage payer;
- coverage exists;
- claim has not already been finalized/refunded;
- refund amount is within policy/coverage cap;
- provider-fault recovery does not exceed provider stake allocated to the claim;
- pool accounting remains valid;
- authorized claims authority threshold/signature is satisfied;
- state transition is legal.

It then executes the USDC refund using an inner asset transfer or other approved Algorand mechanism.

### 18.9 Funding waterfall

A policy may define the loss waterfall.

Default conceptual order for provider-fault claims:

```text
provider locked stake / deductible
 -> shared assurance pool
 -> optional external recovery / future reinsurance
```

Subjective courtesy claims may be pool-only.

Merchant-originated refunds received later may reimburse the pool according to policy.

### 18.10 Refund amount

The policy defines maximum payout. For a "full call refund" policy, maximum reimbursement is the gross caller payment for that covered service call, subject to explicit exclusions.

The premium is part of the gross call price under the default economic model; therefore a true full refund returns the caller's entire gross amount.

---

## 19. Coverage lifecycle

Suggested states:

```text
OPEN
RESPONDED
OUTCOME_PENDING
CLAIMABLE
CLAIM_OPEN
RESOLVED
EXPIRED
CLOSED
```

The precise state model may differ by policy class.

### 19.1 Coverage closure

When the claim window ends without unresolved liability, the protocol:

- closes the coverage;
- reduces provider open exposure;
- releases corresponding locked stake capacity;
- preserves statistical history;
- applies evidence-retention policy.

### 19.2 Long-lived coverage

For commerce/fulfillment policies, coverage duration may extend beyond HTTP response time. Provider open exposure remains until the policy-defined terminal condition or expiry.

This directly affects collateral requirements and MUST be reflected in underwriting.

---

## 20. On-chain state model

The following is a logical state model. Exact box layouts and ABI types belong in the contract LLD.

### 20.1 Global state

Suggested global fields:

```text
protocolVersion
networkConfigurationVersion
usdcAssetId
pausedNewCoverage
pausedClaimsPayouts
claimsAuthority
riskConfigVersion
poolAccountingTotals
providerCount
policyCount
coverageCount
evidenceEpochCounter
```

Large or unbounded collections MUST use boxes or indexed event projection rather than global state.

### 20.2 Provider box

Key: `providerId`

Logical fields:

```text
providerId
ownerWallet
payoutWallet
receiptSigningKey
receiptSigningKeyVersion
status
riskTier
stakeTotal
stakeLocked
openFaultExposure
openTotalExposure
createdRound
metadataHash
nonce/version
```

### 20.3 Policy box

Key: `policyId`

Logical fields:

```text
policyId
providerId
version
active
premiumBps
collateralProfile
maxCoveragePerCall
claimWindow
coverageDuration
coverageClass
subjectiveMode
evidenceMode
policyDocumentHash
validFrom
validUntil
```

### 20.4 Coverage box

Key: `coverageId`

Logical fields:

```text
coverageId
providerId
policyId
payer
assetId
grossAmount
providerNetAmount
premiumAmount
stakeTopupAmount
requestHash
intentHash?
openedRound
expiryRound/time
faultExposureAmount
totalExposureAmount
status
paymentReferenceHash
```

The contract MAY store only the minimal subset needed for enforcement and emit/index the rest if box MBR becomes excessive. This is a cost optimization to be determined by the contract LLD.

### 20.5 Claim box or claim commitment

Depending on cost, claim state may be stored in a box or minimally committed on-chain.

At minimum the chain must prevent duplicate final payouts and preserve finalized decision/payout identity.

### 20.6 Evidence epoch box/state

Stores or emits:

```text
epochId
merkleRoot
recordCount
epoch metadata hash
```

### 20.7 Box minimum-balance implications

Algorand boxes increase the application's minimum balance requirement according to box key/value size. The implementation MUST model MBR cost before deciding to store every coverage permanently in a dedicated box.

Possible optimizations:

- compact fixed-size binary structs;
- close and delete coverage boxes after retention/claim windows while preserving hashed event history;
- batch commitments;
- keep only active coverage on-chain and project historical data from events/indexer.

This is an explicit LLD and cost-modeling work item.

---

## 21. Financial accounting in the Assurance Core

### 21.1 Logical buckets

Even if held by one application account, the contract must maintain separate logical balances for:

```text
sharedPoolLiquidity
sum(providerStakeTotal)
protocolOperationalReserve?   (if any)
```

### 21.2 Reconciliation invariant

A conservative accounting invariant is:

```text
actual USDC balance of app account
>= sharedPoolLiquidity + sum(providerStakeTotal) + other restricted balances
```

Exact treatment of already-authorized pending refunds and recoveries belongs in the financial LLD.

### 21.3 Premium transfer

A premium transfer increases shared pool liquidity.

### 21.4 Stake deposit/top-up

A stake transfer increases `provider.stakeTotal`, not shared pool free liquidity.

### 21.5 Provider stake withdrawal

A valid withdrawal decreases the provider stake ledger and sends USDC to the provider's authorized withdrawal address.

### 21.6 Provider-fault payout

If a finalized claim attributes amount `X` to provider fault:

- provider stake ledger decreases by the recoverable provider amount;
- any remainder decreases shared pool liquidity;
- the actual USDC transfer goes to the original payer.

### 21.7 Subjective payout

Pool-only reimbursement decreases shared pool liquidity without reducing provider stake unless policy says otherwise.

---

## 22. Off-chain backend services

### 22.1 Provider Control Plane API

Responsibilities:

- provider account onboarding;
- wallet-verification workflows;
- endpoint registration;
- policy creation and versioning;
- SDK credentials;
- receipt-signing key registration/rotation;
- stake/capacity views;
- configuration validation;
- provider dashboard backend.

This service does not decide whether an on-chain coverage transaction is valid.

### 22.2 Evidence Ingestion Service

Responsibilities:

- accept provider/client evidence uploads;
- enforce payload size/type limits;
- strip/deny forbidden secret headers;
- encrypt at ingestion;
- produce object hashes;
- update evidence manifest;
- enqueue Merkle anchoring;
- expose scoped retrieval to Claims Engine.

### 22.3 Response Receipt Verification Service

May be a module of Evidence Ingestion or Claims Engine.

Validates:

- provider key version;
- receipt signature;
- request hash linkage;
- response hash linkage;
- timing and policy data.

### 22.4 Chain Observer / Indexer

Responsibilities:

- follow Assurance Core transactions;
- detect coverage openings;
- project provider/policy/stake/claim events;
- reconcile known x402 payment references;
- monitor pool assets;
- detect missed backend events;
- feed analytics.

### 22.5 Claims Service

Responsibilities:

- claim creation;
- payer signature verification;
- evidence collection;
- objective rule execution;
- risk-engine invocation;
- provider notification/challenge;
- manual/arbitration queue;
- final decision creation;
- claims-authority transaction submission;
- refund status tracking.

### 22.6 Risk and Underwriting Service

Responsibilities:

- provider risk snapshots;
- caller risk features;
- premium recommendations;
- collateral recommendations;
- concentration controls;
- certification tiers;
- claim-fraud signals;
- versioned model outputs.

The contract uses explicitly committed/configured parameters, not arbitrary real-time opaque model outputs, unless an oracle design is intentionally added later.

### 22.7 Analytics Pipeline

Consumes:

- on-chain events;
- provider telemetry;
- evidence-completeness events;
- claim events;
- refunds;
- stake events;
- service response metrics.

Produces:

- provider rankings;
- loss ratios;
- SLA compliance;
- latency distributions;
- insured volume;
- unique callers;
- claim frequency/severity;
- risk-tier history;
- certification signals.

### 22.8 Public API

Possible resources:

```text
GET /v1/public/providers
GET /v1/public/providers/{providerId}
GET /v1/public/providers/{providerId}/policies
GET /v1/public/providers/{providerId}/metrics
GET /v1/public/rankings
GET /v1/public/certifications/{providerId}
```

No raw evidence is exposed publicly.

### 22.9 Public risk-intelligence x402 endpoint

For the Algorand Global x402 Challenge, the protocol may expose a small paid x402 endpoint that returns machine-readable provider risk/certification intelligence. This is a native product of the protocol's analytics and does not make the protocol an orchestrator of provider requests.

Example:

```text
GET /v1/risk-report/{providerId}
```

This challenge-specific endpoint is separate from the core assurance payment path.

---

## 23. Data stores

### 23.1 PostgreSQL - operational database

Suggested entities:

```text
providers
provider_wallets
provider_signing_keys
provider_api_keys
endpoints
policies
policy_versions
coverages_projection
payment_references
provider_stake_projection
pool_projection
claims
claim_events
refunds
evidence_manifests
evidence_objects
outcome_events
risk_snapshots
certifications
audit_events
merkle_epochs
merkle_proofs
```

This database is a query projection and workflow store, not the final authority for on-chain financial state.

### 23.2 Object storage - encrypted evidence

Stores:

```text
request.enc
response.enc
intent.enc? or normalized intent where permitted
attachments/*.enc
external-receipts/*.enc
claim-evidence/*.enc
```

### 23.3 Analytics store

MVP may use PostgreSQL initially.

At scale, use an analytics-oriented store such as ClickHouse/BigQuery-class infrastructure for high-volume event aggregation.

### 23.4 Cache

Redis or equivalent MAY cache:

- provider public metadata;
- policy metadata;
- recent chain projections;
- rate-limit state;
- temporary claim challenges.

Cached state MUST NOT be treated as financial authority.

### 23.5 Queue/event bus

A durable queue SHOULD be used for:

- evidence processing;
- Merkle batching;
- chain-index events;
- analytics events;
- provider notifications;
- delayed claim deadlines;
- evidence retry uploads.

The system SHOULD use idempotency keys based on `coverageId`, event type, and sequence.

---

## 24. Canonical identifiers

### 24.1 `providerId`

Stable protocol identity for provider.

### 24.2 `policyId`

Immutable versioned assurance policy identity.

### 24.3 `coverageId`

Universal join key for one insured interaction.

Everything related to a covered call should be reconstructable from this identifier.

### 24.4 `paymentId`

Where supported, use x402's Payment Identifier extension for x402-level idempotency/reconciliation.

`paymentId` and `coverageId` are related but not identical concepts:

```text
paymentId  = logical x402 payment identity
coverageId = assurance liability identity
```

### 24.5 Algorand transaction/group references

Store:

- group ID where useful;
- provider payment transaction ID;
- coverage AppCall transaction ID;
- refund transaction ID;
- stake transaction IDs.

### 24.6 `requestId`

Provider/application request IDs are useful for debugging and external UX but MUST NOT be the only uniqueness or authorization mechanism.

---

## 25. Provider SDK architecture

### 25.1 Package goals

Provider integration should be near drop-in for existing x402 services.

Possible package family:

```text
@assured-x402/core
@assured-x402/avm
@assured-x402/express
@assured-x402/hono
@assured-x402/next
Python equivalents later
```

Names are placeholders.

### 25.2 Provider configuration

Conceptual:

```ts
insuredRoute({
  providerId,
  policyId,
  grossPrice: "$1.00",
  fallback: "uninsured" | "fail-closed"
})
```

### 25.3 Middleware responsibilities

- generate assurance-enhanced 402 requirements;
- resolve gross/net/premium allocation;
- expose policy hash/version;
- verify settlement result and obtain `coverageId` mapping;
- wrap response stream for hash calculation;
- generate provider receipt;
- submit evidence/telemetry asynchronously;
- handle evidence failures according to policy.

### 25.4 No protocol backend in business logic path

A provider MUST NOT need to proxy the service request through the assurance backend.

Where feasible, provider eligibility information is cached or derived from chain state. Even if the protocol backend is unavailable, the contract remains the final validator when payment is attempted.

### 25.5 Fail-open versus fail-closed

Policy/configuration must explicitly define provider behavior when assurance cannot be advertised.

- `fail-closed`: route does not accept payment without assurance.
- `uninsured-fallback`: provider may advertise an ordinary x402 payment option clearly marked as uninsured.

An uninsured fallback MUST NOT create a `coverageId` or count toward assured metrics.

---

## 26. Assurance Client SDK architecture

### 26.1 Why a client SDK is needed

Atomic-Assured requires callers to understand the assurance metadata and construct more than a simple one-leg asset transfer.

### 26.2 Responsibilities

- parse payment requirements;
- enforce caller-side spending/coverage preferences;
- compute request commitment;
- build and sign the Algorand group;
- support facilitator fee abstraction;
- resend HTTP request with x402 payment payload;
- verify settlement response;
- verify provider assurance receipt;
- return coverage metadata to the application;
- optionally support automatic claim creation on deterministic failures.

### 26.3 Compatibility

Providers MAY advertise both Atomic-Assured and ordinary x402 options. Non-assurance clients can use ordinary x402 if the provider chooses to offer it.

---

## 27. Evidence upload reliability

### 27.1 Evidence is not allowed to block every low-value response

For standard APIs, response delivery SHOULD NOT synchronously depend on a slow evidence upload to central storage.

The provider SDK should:

1. compute the response hash synchronously;
2. sign and return the receipt;
3. write evidence to a local durable spool/queue;
4. upload asynchronously with retry.

### 27.2 High-value mode

A `HIGH_VALUE_EVIDENCE` policy MAY require stronger durability before the provider considers the operation fully complete.

For example, the provider SDK can require successful encrypted evidence persistence or an acknowledged local durable write before emitting a success receipt.

### 27.3 Missing evidence

If policy-required evidence is not uploaded before an evidence deadline:

- provider evidence-completeness score is reduced;
- coverage may become easier to claim depending on policy;
- repeated failures may suspend new coverage.

The provider MUST NOT be able to improve its reputation by selectively omitting evidence for bad calls.

---

## 28. Ranking and certification

### 28.1 Data inputs

Provider ranking may include:

- assured call count;
- insured dollar volume;
- unique caller count;
- provider age;
- objective SLA success rate;
- approved claim count;
- gross and net loss ratio;
- provider-fault loss ratio;
- evidence completeness;
- latency distribution;
- outcome completion rate;
- stake/capacity health;
- performance consistency over time;
- confidence/sample size.

### 28.2 Confidence adjustment

A provider with two successful calls MUST NOT outrank a provider with tens of thousands of calls merely because the raw success percentage is 100%.

Public scores require confidence adjustment, minimum sample thresholds, or Bayesian priors.

### 28.3 Certification

A certification is a protocol statement backed by assured history, for example:

```text
Assured Provider
99.72% objective SLA compliance
0.19% approved claim rate
$X insured volume
Y covered calls
Z days observed
current stake/capacity status
```

Exact score formulas remain an underwriting/risk LLD concern.

### 28.4 Provider incentives

The preferred rewards for good performance are economically sustainable benefits:

- lower premium;
- lower collateral ratio;
- higher coverage limit;
- higher ranking;
- certification tier;
- faster stake release where safe;
- higher agent/client trust.

Cash/token rewards are optional and SHOULD NOT threaten pool solvency.

---

## 29. Security and abuse model

### 29.1 Fake claim by caller

Mitigations:

- payer wallet signature;
- on-chain coverage lookup;
- provider-signed response receipt;
- request/response hashes;
- one claim lifecycle per covered loss;
- caller risk history.

### 29.2 Provider rewrites history

Mitigations:

- request hash created before service fulfillment;
- response hash signed at response time;
- evidence manifests and Merkle anchoring;
- immutable event chain.

### 29.3 Provider selectively disables SDK

Result:

- call is uninsured;
- no valid coverage is created;
- call does not count toward assured ranking.

The protocol does not attempt to measure the provider's entire unobserved business.

### 29.4 Provider withdraws stake before a claim

Mitigation:

- required stake remains locked by open fault exposure;
- only free stake is withdrawable.

### 29.5 Capacity race

Mitigation:

- on-chain state transition is authoritative;
- second conflicting atomic group fails.

### 29.6 Caller/provider collusion

Threat:

Provider and caller could coordinate repeated claims to extract from the shared pool.

Mitigations:

- provider-fault claims consume provider stake first where applicable;
- caller/provider graph correlation;
- repeated counterparties and refund patterns;
- provider concentration limits;
- claim budgets;
- delayed/escalated high-value subjective claims;
- continued-use signals;
- public loss history affects provider economics.

### 29.7 Replay/double payment/double coverage

Mitigations:

- unique coverage ID;
- payment identifier;
- nonce;
- transaction validity windows;
- on-chain uniqueness checks;
- idempotent backend processing.

### 29.8 Malicious Algorand group

Mitigations:

- facilitator security checks;
- explicit contract validation of required group members;
- no dangerous rekey/close behavior;
- exact asset/receiver/amount validation;
- bounded group profile.

### 29.9 Claims authority compromise

Mitigations:

- multisig/threshold operational key;
- contract-enforced payout cap;
- contract-enforced original payer destination;
- per-coverage max payout;
- pause mechanism;
- audit logs;
- future optimistic/decentralized arbitration.

### 29.10 KMS compromise

Mitigations:

- KMS/HSM key isolation;
- per-coverage DEKs;
- least-privilege decrypt role;
- audited decrypt events;
- no DEKs in application logs;
- retention/deletion policy;
- future threshold encryption.

### 29.11 Evidence service compromise

Attacker may delete or replace ciphertext but cannot silently alter evidence without hash/Merkle mismatch. Replication and immutable retention reduce availability risk.

### 29.12 Database compromise

Off-chain DB compromise MUST NOT permit:

- provider stake theft;
- creation of valid on-chain coverage;
- bypass of contract payout limits.

### 29.13 Pool insolvency

Contract and underwriting policy MUST support:

- per-call limits;
- per-provider concentration limits;
- pool liquidity checks;
- provider collateral;
- pause of new coverage;
- policy-specific capacity.

Detailed solvency formulas are defined in a separate underwriting specification.

---

## 30. Privacy and data governance

### 30.1 Data minimization

Store only fields needed for:

- proving the covered interaction;
- resolving claims;
- fraud/risk modeling;
- required analytics;
- regulatory/operational obligations.

### 30.2 Secret-header deny list

Provider SDK MUST exclude common credentials by default.

### 30.3 PII separation

High-value commerce may include addresses, names, ticketing details, or other personal data. Such data remains encrypted off-chain and is not exposed in public ranking or on-chain state.

### 30.4 Decryption access

Every evidence decryption MUST have:

- authenticated operator/service identity;
- reason code;
- claim/coverage reference;
- audit record.

### 30.5 Cryptographic erasure

Where policy allows, deleting the wrapped DEK in addition to encrypted objects provides strong practical erasure of retained ciphertext.

---

## 31. Observability

### 31.1 Protocol metrics

Must include:

```text
insured_call_count
insured_volume_usdc
premium_collected_usdc
pool_liquidity_usdc
provider_stake_total_usdc
provider_open_exposure_usdc
claims_opened
claims_approved
refund_volume_usdc
provider_recoveries_usdc
net_loss_ratio
evidence_upload_success_rate
receipt_verification_failure_rate
coverage_open_failure_rate
facilitator_verify_latency
facilitator_settle_latency
```

### 31.2 Per-provider metrics

```text
insured volume
call count
objective failure rate
claim frequency
loss ratio
net loss ratio after provider recoveries
latency percentiles
evidence completeness
current stake
locked stake
free stake
current capacity
coverage utilization
unique callers
policy mix
```

### 31.3 Alerting

Critical alerts:

- app account balance/accounting mismatch;
- unexpected asset movement;
- claim payout spike;
- provider claim cluster;
- pool liquidity below threshold;
- chain index lag;
- Merkle anchoring lag;
- evidence ingestion failures;
- KMS decrypt anomaly;
- facilitator settlement failures;
- contract pause state changes;
- claims authority key use anomaly.

---

## 32. Failure handling

### 32.1 Assurance backend unavailable during 402 creation

Provider middleware SHOULD use cached policy/static config where safe. Final payment acceptance still depends on the on-chain AppCall.

If required assurance metadata cannot be produced, follow configured fail-closed or uninsured-fallback behavior.

### 32.2 Algorand unavailable or facilitator unavailable

Covered x402 settlement cannot complete. The caller is not charged if the atomic group does not settle.

### 32.3 Evidence upload unavailable after successful response

Provider SDK spools encrypted evidence and retries. Missing evidence becomes a protocol health event and may affect claims/provider ranking.

### 32.4 Claims backend unavailable

Existing coverage remains on-chain. Caller may retry claim submission later within policy rules; backend outage must not silently close coverage.

### 32.5 Analytics unavailable

Must not affect payment or claim correctness.

---

## 33. Upgrade and governance model

### 33.1 Contract upgrades

The first implementation SHOULD use an upgrade strategy appropriate for Algorand applications while minimizing unilateral trust.

Potential controls:

- governance multisig;
- timelocked configuration changes where feasible;
- explicit protocol versioning;
- policy version immutability;
- emergency pause for new coverage;
- separate pause for claims only if absolutely required.

### 33.2 Non-upgradeable historical terms

Even if code is upgradeable, already-open coverage terms MUST remain interpretable against the policy/version committed when coverage was created.

### 33.3 Configuration changes

High-risk parameters such as:

- claims authority;
- USDC asset ID;
- pool withdrawal permissions;
- premium/collateral bounds;
- protocol admin;

SHOULD require stronger governance controls than ordinary provider metadata changes.

---

## 34. Suggested service topology

```text
                         +------------------------+
                         | Public Rankings / API  |
                         +-----------+------------+
                                     |
                              Analytics Store
                                     ^
                                     |
+-----------+      +-----------------+------------------+
| Provider  |      |        Protocol Backend            |
| Dashboard +----->| Control Plane / Claims / Risk      |
+-----------+      | Evidence / Indexer / Analytics     |
                   +----+------------+------------+------+
                        |            |            |
                        |            |            |
                 PostgreSQL    Object Store   Queue/Event Bus
                        ^            ^
                        |            |
                        |      encrypted evidence
                        |
                  Chain projection
                        ^
                        |
                  Algorand Network
                        ^
                        |
   +--------------------+-----------------------------+
   |                    Atomic-Assured Group          |
   |                                                  |
Caller/Agent ----> Provider Resource Server            |
   |                 + Provider SDK                   |
   |                                                  |
   +-------> provider net ----------------> Provider  |
   +-------> premium/stake -------------> Core App    |
   +-------> open_coverage AppCall -----> Core App    |
```

The protocol backend is not in the caller-to-provider business-request path.

---

## 35. Primary end-to-end sequence

### 35.1 Provider onboarding

1. Provider creates dashboard account.
2. Provider proves control of owner wallet.
3. Protocol creates/registers `providerId` on-chain.
4. Provider registers payout wallet.
5. Provider generates dedicated assurance receipt-signing key and registers public key.
6. Provider defines endpoint and policy.
7. Policy is committed on-chain or its immutable hash/critical parameters are committed.
8. Provider optionally deposits initial stake or enables revenue-funded stake bootstrap.
9. Provider installs SDK and configures route.
10. Public provider profile becomes visible once activation requirements are met.

### 35.2 Covered request

1. Caller sends request to provider.
2. Provider returns 402 with Atomic-Assured metadata.
3. Client computes request commitment.
4. Client constructs transaction group.
5. Client signs caller-owned transactions.
6. Client resends request with x402 payment payload.
7. Provider forwards payment to facilitator.
8. Facilitator verifies payment group.
9. Group is submitted to Algorand.
10. Assurance Core validates provider state, policy, payment split, premium, request hash, uniqueness, and capacity.
11. Entire group settles atomically.
12. Provider executes service.
13. Provider middleware hashes response and signs assurance receipt.
14. Caller receives response + receipt and verifies it.
15. Provider SDK spools/uploads encrypted evidence and telemetry.
16. Evidence manifest enters next Merkle anchor epoch.
17. Indexer/analytics update provider metrics.

### 35.3 No-claim closure

1. Coverage claim/outcome window expires.
2. Closure job or on-chain transition marks coverage closed.
3. Provider open exposure decreases.
4. Corresponding stake becomes free.
5. Evidence retention lifecycle continues or expires according to policy.

### 35.4 Refund sequence

1. Caller submits refund/claim request with `coverageId` and signed challenge.
2. Claims Service verifies payer and coverage.
3. Objective rules run.
4. Risk engine runs where relevant.
5. Encrypted evidence is decrypted only if required.
6. Provider is notified/challenged according to policy.
7. Claim is finalized.
8. Claims authority submits finalized decision to Assurance Core.
9. Contract validates cap, uniqueness, destination, and accounting.
10. Contract transfers USDC to original payer.
11. Provider stake and/or pool ledgers are reduced according to fault allocation.
12. Refund transaction is indexed and public metrics update.

### 35.5 Provider stake withdrawal

1. Provider requests `withdraw_stake(W)` on-chain.
2. Contract calculates post-withdrawal required collateral.
3. If valid, USDC is transferred to provider and stake ledger decreases.
4. Future coverage capacity immediately reflects the lower stake.
5. If capacity reaches zero, new Atomic-Assured groups fail until capacity is restored.

---

## 36. Provider API surface - conceptual

### 36.1 Control plane

```text
POST   /v1/providers
POST   /v1/providers/{id}/wallet-verification
GET    /v1/providers/{id}
POST   /v1/providers/{id}/signing-keys
POST   /v1/providers/{id}/api-keys
POST   /v1/providers/{id}/endpoints
POST   /v1/providers/{id}/policies
GET    /v1/providers/{id}/capacity
GET    /v1/providers/{id}/claims
GET    /v1/providers/{id}/analytics
```

### 36.2 Evidence

```text
POST /v1/evidence/{coverageId}/request
POST /v1/evidence/{coverageId}/response
POST /v1/evidence/{coverageId}/outcomes
POST /v1/evidence/{coverageId}/attachments
GET  /v1/evidence/{coverageId}/status
```

Exact raw payload upload APIs should use streaming/object-upload patterns rather than large JSON blobs.

### 36.3 Claims/refunds

```text
POST /v1/refunds
GET  /v1/refunds/{claimId}
POST /v1/refunds/{claimId}/evidence
POST /v1/refunds/{claimId}/challenge
```

### 36.4 Public

```text
GET /v1/public/providers
GET /v1/public/providers/{providerId}
GET /v1/public/rankings
GET /v1/public/policies/{policyId}
GET /v1/public/certifications/{providerId}
```

All exact API schemas belong in an OpenAPI LLD.

---

## 37. Authentication and authorization

### 37.1 Provider dashboard

Use standard application authentication plus mandatory wallet proof for blockchain-sensitive ownership operations.

### 37.2 Provider SDK API keys

API keys:

- are scoped;
- are rotatable;
- are hash-stored server-side;
- are rate-limited;
- may ingest evidence/telemetry or query provider config;
- MUST NOT be sufficient to withdraw stake or change payout wallet without stronger authorization.

### 37.3 Caller claim authentication

Wallet signature over protocol-generated challenge.

### 37.4 Internal services

Use workload identity/mTLS or equivalent. Claims decryption and transaction submission require narrowly scoped identities.

---

## 38. Consistency model

### 38.1 On-chain authority

Authoritative:

- provider on-chain active state;
- stake;
- coverage existence;
- open exposure;
- premium receipts into contract;
- refunds;
- stake withdrawals;
- immutable policy/coverage commitments.

### 38.2 Off-chain projection

Eventually consistent:

- dashboard balances;
- public rankings;
- analytics;
- claim search indices.

### 38.3 Reconciliation

Periodic reconciliation jobs MUST compare:

- Algorand app asset balance;
- on-chain logical pool/stake totals;
- off-chain projections.

Any mismatch triggers a critical alert and may pause new coverage.

---

## 39. Idempotency rules

All off-chain mutation APIs MUST be idempotent.

Suggested keys:

```text
coverage creation projection: coverageId
evidence request upload:      coverageId + REQUEST + contentHash
evidence response upload:     coverageId + RESPONSE + receiptHash
outcome event:                coverageId + sequence
claim creation:               coverageId + claimDomain
refund projection:            on-chain refund txId
merkle entry:                 manifestHash
```

Retrying the same event MUST NOT double-increment analytics or create duplicate refunds.

---

## 40. Testing strategy

### 40.1 Smart contract unit tests

Must cover:

- valid group;
- incorrect provider receiver;
- incorrect premium;
- incorrect asset;
- duplicate coverage ID;
- inactive provider;
- inactive policy;
- insufficient capacity;
- same-group stake top-up;
- concurrent capacity boundary;
- stake withdrawal with open exposure;
- full withdrawal with no exposure;
- duplicate claim finalization;
- refund above cap;
- wrong refund destination;
- accounting reconciliation;
- paused states;
- malicious group fields.

### 40.2 Property/invariant tests

Examples:

```text
sum(value legs) == gross amount
stakeFree >= 0
stakeLocked <= stakeTotal
open exposure never negative
coverage uniqueness always holds
refund total per coverage <= policy maximum
provider withdrawal cannot invalidate existing collateral requirement
app USDC balance >= internally restricted balances
```

### 40.3 End-to-end TestNet tests

Must use real Algorand TestNet transaction groups and target facilitator behavior.

Test:

- standard payment;
- facilitator fee abstraction;
- additional premium/AppCall transactions;
- 402 retry behavior;
- settlement confirmation;
- receipt generation;
- evidence ingestion;
- refund payment.

### 40.4 Adversarial tests

- malicious caller modifies group;
- malicious provider claims wrong response;
- provider removes SDK;
- caller replays claim;
- colluding caller/provider pattern;
- KMS access denied;
- object missing but hash committed;
- indexer lags;
- protocol API outage;
- simultaneous final capacity use.

### 40.5 Load tests

Separate:

- payment-path load;
- evidence throughput;
- analytics throughput;
- claims throughput;
- Merkle batching.

The evidence path will likely dominate storage bandwidth; the contract path will dominate financial correctness concerns.

---

## 41. MVP deployment plan

### Phase 0 - PoC gating decisions

Before freezing wire protocol:

1. Build a minimal AVM x402 payment group with:
   - normal provider payment;
   - second USDC premium transfer;
   - Assurance Core AppCall;
   - facilitator fee payer if enabled.
2. Confirm GoPlausible facilitator accepts/verifies/settles this group safely.
3. Determine whether existing `exact` + assurance extension can cleanly construct the group.
4. If not, implement dedicated `assured-exact` scheme support.
5. Measure group size, fees, simulation behavior, and contract opcode/resource usage.

### Phase 1 - On-chain core

Implement:

- provider registration;
- policy registration;
- stake deposit/top-up/withdrawal;
- open coverage;
- coverage capacity;
- premium/pool accounting;
- claim finalization;
- refund transfer;
- pause controls;
- events/indexing support.

### Phase 2 - SDKs

Implement TypeScript first:

- provider core SDK;
- Express/Hono integration;
- assurance-aware x402 AVM client;
- response receipt signing/verification;
- request commitment implementation.

### Phase 3 - Backend

Implement:

- provider control plane;
- chain observer;
- PostgreSQL projection;
- evidence ingestion;
- KMS envelope encryption;
- object storage;
- claims service;
- simple deterministic risk rules.

### Phase 4 - Public product surfaces

Implement:

- provider dashboard;
- `/refund`/claims interface;
- public provider profiles;
- rankings;
- certification badge/API;
- x402-paid risk-report endpoint for challenge visibility if required.

### Phase 5 - High-value evidence demo

Implement one reference provider integration demonstrating a commerce-like deterministic intent/outcome flow without the protocol itself becoming the merchant/orchestrator.

---

## 42. Open architecture decisions

These items MUST be resolved in dedicated LLDs or PoCs.

### O-1. `exact` + extension versus custom scheme identifier

GoPlausible AVM documentation supports composable payment groups. Confirm whether the current exact client/facilitator APIs provide enough clean extensibility for Atomic-Assured without a new scheme.

### O-2. Single Assurance Core app versus modular apps

MVP recommendation is one app for simpler atomic enforcement. Benchmark box MBR, opcode/resource budget, auditability, and upgrade boundaries.

### O-3. Active coverage storage strategy

Decide which coverage fields stay in boxes and which are event/indexer-only. Model minimum balance cost under realistic volume.

### O-4. Claim finalization authority

Choose MVP operational key model: multisig, threshold signer, or other secure authority. Define emergency rotation.

### O-5. Exposure and collateral formulas

Requires underwriting document and simulation. Architecture only requires that formulas be versioned and contract-enforceable.

### O-6. Premium rounding

Define integer arithmetic and rounding direction for 6-decimal USDC, especially very small micro-payments where percentage premium may round to zero.

### O-7. Minimum premium

May be required for microtransactions. Underwriting model must determine if a floor such as one or more USDC atomic units is necessary.

### O-8. Coverage close mechanism

Choose between explicit close transaction, lazy close during later operations, keeper-driven close, or hybrid. Must release stake without unbounded scanning.

### O-9. Evidence availability guarantees

Define policy-specific behavior when provider or client evidence upload is missing.

### O-10. Privacy roadmap

MVP KMS-managed evidence versus timeline for threshold/dispute-only decryption.

### O-11. Subjective claim policy

Needs actuarial/risk simulation before coding fixed percentages.

### O-12. Long-lived commerce limits

Define which real-world events are insurable in v1 and maximum duration/concentration.

---

## 43. Architectural decisions that are already settled

The following SHOULD NOT be reopened casually during implementation:

1. The protocol is middleware integrated by providers, not an orchestrator proxy.
2. Providers continue to serve requests directly.
3. Provider net service revenue settles directly to provider in the primary flow.
4. The primary payment flow is an Algorand atomic transaction group.
5. Premium is taken from the provider's gross service revenue at transaction time; no premium prepayment is required.
6. Provider stake/collateral is separate from premium and may be accumulated from revenue.
7. Coverage eligibility is determined by on-chain contract state at execution time.
8. Providers may withdraw only unencumbered stake.
9. With no capacity, the contract rejects new covered calls; no centralized API-key ban is required for correctness.
10. Every covered call has a cryptographically bound coverage identity and request commitment.
11. Provider responses receive provider-signed receipts.
12. Raw request/response data is encrypted off-chain, not stored on-chain.
13. Evidence integrity is anchored with hashes/Merkle roots.
14. Claims may use off-chain risk/evidence adjudication, but final payouts remain contract-constrained and on-chain.
15. Public provider reputation is derived only from assured, verifiable interactions.
16. The protocol can support high-value commerce by insuring provider execution/outcomes; it does not perform those transactions itself.
17. Algorand is the first-class implementation target; chain abstraction is deferred.

---

## 44. Reference logical schemas

These are illustrative and are not final ABI/API definitions.

### 44.1 Provider

```ts
interface Provider {
  providerId: string;
  ownerWallet: string;
  payoutWallet: string;
  receiptSigningPublicKey: string;
  receiptSigningKeyVersion: number;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "EXITING" | "CLOSED";
  riskTier: string;
  metadataHash: string;
}
```

### 44.2 Policy

```ts
interface AssurancePolicy {
  policyId: string;
  providerId: string;
  version: number;
  coverageClass:
    | "DETERMINISTIC_API"
    | "GENERATED_OUTPUT"
    | "EXTERNAL_EXECUTION"
    | "COMMERCE_EXECUTION"
    | "LONG_LIVED_FULFILLMENT";
  premiumBps: number;
  collateralProfileId: string;
  maxCoverageAtomic: bigint;
  claimWindowSeconds: number;
  coverageDurationSeconds: number;
  evidenceMode: "COMMITMENT_ONLY" | "MANAGED_EVIDENCE" | "HIGH_VALUE_EVIDENCE";
  subjectiveCoverageMode: string;
  policyDocumentHash: string;
}
```

### 44.3 Coverage projection

```ts
interface Coverage {
  coverageId: string;
  providerId: string;
  policyId: string;
  payer: string;
  assetId: string;
  grossAmountAtomic: bigint;
  providerNetAmountAtomic: bigint;
  premiumAmountAtomic: bigint;
  stakeTopupAmountAtomic: bigint;
  requestHash: string;
  intentHash?: string;
  openedRound: bigint;
  expiresAt: string;
  status: string;
  algorandGroupId?: string;
  paymentTxId?: string;
  appCallTxId?: string;
}
```

### 44.4 Provider receipt

```ts
interface ProviderReceiptV1 {
  version: 1;
  coverageId: string;
  providerId: string;
  policyId: string;
  requestHash: string;
  responseHash: string;
  httpStatus: number;
  contentType?: string;
  servedAt: string;
  latencyMs: number;
  signingKeyVersion: number;
  signature: string;
}
```

### 44.5 Claim

```ts
interface Claim {
  claimId: string;
  coverageId: string;
  claimant: string;
  reasonCode: string;
  status: string;
  requestedAmountAtomic: bigint;
  approvedAmountAtomic?: bigint;
  providerFaultAmountAtomic?: bigint;
  poolAmountAtomic?: bigint;
  decisionHash?: string;
  refundTxId?: string;
}
```

---

## 45. Reference repository decomposition

A monorepo could begin as:

```text
/apps
  /dashboard
  /public-web
  /api-control-plane
  /api-claims
  /api-evidence
  /chain-indexer
  /worker-analytics
  /worker-merkle-anchor
  /worker-notifications

/packages
  /protocol-types
  /crypto-commitments
  /provider-sdk-core
  /provider-sdk-express
  /provider-sdk-hono
  /client-sdk-avm
  /receipt
  /risk-engine
  /database
  /observability

/contracts
  /assurance-core

/openapi
  provider.yaml
  claims.yaml
  public.yaml
  evidence.yaml

/docs
  architecture.md
  contract-lld.md
  atomic-assured-profile.md
  evidence-lld.md
  claims-lld.md
  underwriting.md
  threat-model.md
```

This is a recommendation, not a required language/framework decision.

---

## 46. Required follow-on design documents

This architecture should be decomposed into at least the following LLDs before autonomous coding begins in earnest:

1. **Atomic-Assured AVM Payment Profile Specification**
   - exact transaction ordering/roles;
   - x402 extension or scheme schema;
   - client signing;
   - facilitator behavior;
   - fee abstraction;
   - error codes.

2. **Assurance Core Smart Contract LLD**
   - ARC4 ABI;
   - box layouts;
   - state transitions;
   - arithmetic;
   - authorization;
   - resource references;
   - MBR funding;
   - invariants and tests.

3. **Evidence and Cryptography LLD**
   - canonical request/response encodings;
   - hash algorithms/domain separation;
   - receipt signature format;
   - KMS envelope encryption;
   - object naming;
   - Merkle tree format;
   - retention.

4. **Claims and Refund LLD**
   - claim state machine;
   - reason taxonomy;
   - objective adjudication rules;
   - claims authority signing;
   - provider challenge;
   - refund on-chain call.

5. **Provider SDK LLD**
   - middleware hooks;
   - streaming response capture;
   - retry/spool strategy;
   - config format;
   - API key scopes;
   - framework adapters.

6. **Client SDK LLD**
   - request commitment capture;
   - payment-group construction;
   - wallet integration;
   - receipt verification;
   - automatic refund UX.

7. **Control Plane and Data Model LLD**
   - PostgreSQL schema;
   - API schemas;
   - event bus;
   - indexer projection;
   - auth/RBAC.

8. **Risk and Underwriting Specification**
   - premium formula;
   - minimum premium;
   - collateral ratios;
   - loss waterfall;
   - pool reserve rules;
   - concentration;
   - subjective refund budgets;
   - profitability model.

9. **Threat Model / Security Review**
   - STRIDE-style component threats;
   - economic attacks;
   - contract attack surface;
   - facilitator interaction;
   - KMS and evidence access;
   - incident response.

10. **Deployment and Operations Runbook**
   - TestNet/MainNet config;
   - USDC opt-ins;
   - app account funding/MBR;
   - key custody;
   - monitoring;
   - pause/recovery procedures.

---

## 47. References and implementation baselines

The architecture is based on the following current documentation as of 2026-08-30. Implementers MUST re-check current package versions and protocol behavior before production deployment.

### R1. x402 Foundation - x402 repository and protocol specification

Key baseline concepts:

- client/resource-server/facilitator roles;
- facilitator verifies and settles according to scheme/network;
- exact scheme transfers a known amount;
- extensible payment architecture.

Source: `x402-foundation/x402` GitHub repository and x402 v2 specifications.

### R2. x402 documentation - HTTP 402 and seller quickstart

Key baseline concepts:

- resource server responds with machine-readable payment requirements;
- `exact` is the fixed-price scheme.

Source: x402 official documentation.

### R3. x402 extensions - Payment Identifier

Used as a candidate x402-level idempotency/reconciliation identifier.

Source: x402 official `Payment-Identifier (Idempotency)` extension documentation.

### R4. x402 extensions - Signed Offers & Receipts

Used as the conceptual baseline for cryptographically signed commercial receipts; assurance receipts add request/response and coverage commitments.

Source: x402 official `Signed Offers & Receipts` documentation.

### R5. GoPlausible - Algorand x402 AVM documentation

Key implementation facts:

- AVM x402 uses Algorand transaction groups;
- client payload contains `paymentGroup` and `paymentIndex`;
- fee abstraction can use a facilitator-owned fee-payer transaction;
- payment groups are documented as composable with additional transactions;
- MainNet/TestNet CAIP-2 identifiers;
- current USDC ASA identifiers.

Source: GoPlausible Algorand x402 documentation / x402 AVM implementation.

### R6. Algorand Developer Portal - Atomic Transaction Groups

Key baseline:

- up to 16 transactions can execute atomically;
- all transactions in a group succeed or all fail;
- different transaction types can be grouped.

Source: Algorand Developer Portal, `Atomic Transaction Groups` and transaction overview.

### R7. Algorand Developer Portal - AVM transaction access

Key baseline:

- smart contracts can inspect transactions in the same atomic group;
- application calls execute stateful contract logic.

Source: Algorand Developer Portal, smart-contract costs/constraints and TEAL/AVM documentation.

### R8. Algorand Developer Portal - Box storage

Key baseline:

- boxes provide application-controlled state storage;
- boxes increase the application account minimum balance requirement based on key/value size.

Source: Algorand Developer Portal, `Box Storage`.

### R9. Algorand Developer Portal - Applications / Inner Transactions

Key baseline:

- application accounts can hold assets;
- applications can issue inner transactions, including asset/payment transactions.

Source: Algorand Developer Portal, Applications and Inner Transactions.

### R10. Algorand Foundation - Global x402 Challenge

Challenge deployment baseline:

- paid API endpoint on Algorand MainNet;
- real usage through GoPlausible facilitator;
- USDC settlement to the project's `payTo` address for leaderboard attribution.

The protocol may expose a paid provider-risk intelligence endpoint for challenge participation without changing the core middleware architecture.

---

## 48. Final architecture summary

The first Algorand implementation consists of three cooperating planes.

### Payment and enforcement plane

```text
Caller
  -> Provider resource server
  -> x402 402 Atomic-Assured requirements
  -> signed Algorand atomic payment group
       -> provider net USDC directly to provider
       -> premium USDC to Assurance Core account
       -> optional provider stake top-up to Assurance Core account
       -> Assurance Core AppCall creates liability
  -> facilitator verifies/settles
  -> provider executes service
```

### Evidence and claims plane

```text
requestHash on-chain
responseHash + provider signature off-chain
req/res encrypted in evidence store
manifest/event hashes periodically Merkle-anchored on Algorand
claim -> deterministic/risk/human adjudication
approved decision -> contract-constrained on-chain refund
```

### Reputation and incentive plane

```text
assured calls + volume + SLA telemetry + claims + refunds + stake + evidence quality
  -> risk engine
  -> provider score / certification
  -> premium and collateral benefits
  -> public rankings and machine-readable risk intelligence
```

The central architectural property is that **the assurance backend may help observe and adjudicate the world, but it cannot manufacture valid coverage or bypass the contract's financial constraints**. New insured liabilities exist only when the Algorand Assurance Core application accepts them atomically with payment.

That property is the foundation on which the claims, evidence, analytics, reputation, and future agentic-commerce extensions are built.
