# AssurePay: EVM technical architecture

Version: 0.2. Date: 2026-10-18.
Status: proposed EVM design, subject to feasibility evidence.
Target: Base Sepolia first, one chain and native USDC. Base accepted by user.
Protocol mechanisms remain subject to M1 feasibility; no EVM implementation exists yet.

Choose technical mechanisms for EVM on their merits. M1 compares supported
x402 settlement options before selecting a profile. The receive-authorization
and custom-scheme design below is the leading candidate, not a requirement to
preserve a scheme, call type, contract interface or storage pattern. Record a
better demonstrated alternative before dependent code is written.

## 1. Product and trust boundaries

AssurePay supplies assurance middleware for independently operated x402 resource
providers. Callers communicate directly with providers. One gross service price
funds provider net revenue, premium, and optional provider-owned stake top-up.
The contract accepts the liability in the same transaction as those allocations.

Preserve the longer-term objective of verifiable service history supporting
claims, reputation, and better provider incentives. The first MVP implements
financial enforcement, request/response linkage, encrypted evidence, and one
constrained claim lifecycle. It excludes rankings, risk models, subjective AI
judgment, governance, commerce fulfillment, multiple chains/assets, and production UI.

Trust is explicit:

- Core enforces authorization, accounting, admission, withdrawals, and refund caps.
- A POC adjudicator decides the validity and fault attribution of claims.
- A relayer pays gas and can censor/delay; it cannot change signed economics.
- The provider performs the service and signs service receipts.
- Storage operators can impair evidence availability; commitments expose alteration.
- USDC retains issuer-controlled behavior; the selected chain has its own finality model.

The backend is never authoritative for balances or coverage existence. An API
key cannot spend stake or alter the original payer. Contract code cannot prove
HTTP delivery or independently judge arbitrary response quality.

## 2. Deployment shape

Use one non-upgradeable `AssuranceCore` Solidity contract for the first MVP.
Separate authorization, arithmetic, and commitment helpers into libraries as
needed, without creating a custody/router deployment graph. Core holds tracked
stake and pool liquidity. It routes provider net within settlement and keeps
no withdrawable provider-revenue ledger.

Constructor freezes token, admin, and adjudicator addresses. The exact compiler,
OpenZeppelin release, optimizer/EVM target, ABI, and x402 dependency versions
must be pinned during M1. No proxy, delegatecall, arbitrary external-call target,
admin transfer of accepted token, or discretionary withdrawal of pool funds.

Provider owner and payout are immutable in MVP. Register a separate immutable
secp256k1 receipt signer, keeping treasury private keys off the HTTP server.
Key rotation and migration of active liabilities require a future design.

New provider registration derives owner from `msg.sender`. Provider owners
create immutable policies; admin explicitly activates policies allowed to use
shared pool capital. Disabling a provider/policy affects new coverage only.

## 3. Atomic settlement

```text
caller -> provider: HTTP request
provider -> caller: 402 assured requirements
caller: verify terms, compute request commitment, sign USDC receive authorization
provider -> compatible facilitator: verify / settle
relayer -> Core.settleAssured(intent, signature)
  Core validates intent, policy, capacity, pool reservation
  Core -> USDC.receiveWithAuthorization(payer, Core, gross, ...)
  Core records coverage and reserves stake/pool liquidity
  Core -> USDC.transfer(providerPayout, providerNet)
  Core checks token-balance/accounting postconditions and emits CoverageOpened
provider: verify confirmed coverage, execute service, sign response receipt
```

Core receives gross only to make the split and liability atomic; net revenue is
paid during that transaction. No claim of EVM atomicity extends to the later
HTTP action. An application revert must propagate through all nested calls.
Never catch a failed token transfer and continue with successful coverage.

Use `SafeERC20` for ordinary transfers, a typed interface for receive
authorization, checks/effects/interactions discipline, and a reentrancy guard
across financial entry points. Snapshot actual token balances and require exact
received/sent deltas for the supported token. Never infer new revenue from
previous unsolicited transfers. Fee-on-transfer and rebasing tokens are unsupported.
[OpenZeppelin ERC20 utilities](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20)

## 4. Intent-bound token authorization

This profile is a proposed AssurePay construction, not standard x402 `exact`.
M1 must prove it against actual token behavior and the registered x402 handlers.

Define a fixed intent type. All IDs and hashes are `bytes32`; addresses are
20-byte EVM addresses; amounts/time bounds use explicit unsigned integer types.
The initial hash preimage uses `uint256` for all numeric fields:

```text
AssuredIntentV1(
  uint256 chainId,
  address core,
  address token,
  address payer,
  bytes32 providerId,
  bytes32 policyId,
  bytes32 policyHash,
  bytes32 requestHash,
  uint256 gross,
  bytes32 payerSalt,
  uint256 validAfter,
  uint256 validBefore
)

intentHash = keccak256(abi.encode(INTENT_TYPEHASH, fields in the order above))
authorizationNonce = intentHash
coverageId = intentHash
```

`INTENT_TYPEHASH` is the keccak256 of this exact single-line UTF-8 literal:

```text
AssuredIntentV1(uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore)
```

M1 must publish byte-level TypeScript/Solidity test vectors before this interface
is frozen. This is an ABI-encoded struct hash used as a nonce, not an additional
Core-domain signed EIP-712 message.

The client generates a fresh cryptographically random `payerSalt` for every new
purchase. Retries reuse the same intent. No independent arbitrary coverage ID
or nonce is accepted. Domain/type separation prevents use as a stake deposit.

The caller signs the token's EIP-712 `ReceiveWithAuthorization` message:

```text
from        = intent.payer
to          = Core
value       = intent.gross
validAfter  = intent.validAfter
validBefore = intent.validBefore
nonce       = intentHash
```

Core recomputes the hash, validates chain/core/token, loads the exact immutable
policy and hash, and calls the token with those same values. The USDC signature
authenticates the payer, not the submitting relayer. The token's typed-data
domain is its actual deployed name/version/chain/address, not the Core domain.
The client must independently recompute policy and intent hashes before signing.
[EIP-712](https://eips.ethereum.org/EIPS/eip-712)

No second payment signature is required in this candidate. Security depends on
the client committing all terms and Core enforcing the commitment. The opaque
nonce may be poorly explained by generic wallet UI; assurance-aware client
review is necessary. This UX limitation must be measured alongside gas savings.

`receiveWithAuthorization` requires the receiver to be the token-call sender.
An observer therefore cannot extract the signature and transfer funds to Core
without entering Core's settlement function. Do not substitute a transfer
authorization signature or expose a generic authorization-consuming function.
[ERC-3009](https://eips.ethereum.org/EIPS/eip-3009)

Require the supported token's exact validity semantics (`now > validAfter` and
`now < validBefore` for the investigated Circle implementation), a bounded
authorization duration configured at deployment, and unused token nonce plus
unused coverage ID. A revert restores token authorization usage as well as Core
state. Cancellation/expiry invalidates unsettled authorizations; confirmed
coverage is not cancelled by later token authorization changes.
[Circle EIP3009 implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol)

MVP supports EOAs and the deployed token's v/r/s receive ABI. Do not promise
ERC-1271 or undeployed smart-wallet support. Token versions with bytes-signature
overloads and wallet alternatives require separate compatibility tests.

## 5. x402 wire contract and facilitator

Proposed identity: `scheme: assured-exact`, `extra.profile: assurepay-evm-v1`.
Use x402 v2 headers and registration interfaces; retain one gross amount as a
canonical decimal string. `network` is `eip155:<chainId>`, `asset` is the exact
token address, and `payTo` is Core, the authorization receiver. Advertise the
provider payout separately; it is not the token authorization's receiver.

Required assurance metadata:

```text
profile, core, providerId, providerPayout, receiptSigner,
policyId, policyHash, requestHash, premium, stakeTopup, providerNet,
claimWindowSeconds, allowPoolOnly, authorizationKind=receiveWithAuthorization
```

The payload carries the complete intent and token signature. Hashes/signatures
are canonical hex, monetary values canonical decimal strings, network matches
chain ID, and the signature length/format is bounded. Reject unrecognized
profiles, malformed fields, wrong policies, unsigned substitutions, and unknown
financial entry points. Freeze exact JSON schemas in M1; never accept
unvalidated extension objects as authorization.

The facilitator registers the custom `(scheme, network, profile)`, independently
validates requirements against intent/state, simulates the exact Core call,
then submits that same immutable call. Simulation is advisory: capacity may
change before inclusion. Re-read/re-simulate if the submission is delayed.
Use a self-hosted compatible facilitator first; hosted support is unverified.

Ordinary upstream `exact` sends a token transfer or uses its specified proxy;
it does not automatically execute our assurance contract. Off-chain lifecycle
hooks do not make an independent coverage call atomic with that transfer.
[Upstream EVM exact](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)

On broadcast/receipt timeout, report pending/unknown with the public hash when
known. Query receipt, coverage ID, and token authorization state before any
resubmission. Never create a new salt/payment because an RPC timed out. A
confirmed duplicate is reconciled to existing coverage, not charged again.

Provider verifies Core address, canonical successful receipt, matching coverage
event/state and request before executing business logic. Persist idempotency
by coverage ID. Blockchain atomicity cannot give exactly-once HTTP side effects:
crashes between external execution and response persistence remain a provider
application concern. Never re-run a non-idempotent action on blind HTTP retry.

## 6. Immutable policies and arithmetic

MVP policy fields:

```text
providerId, premiumBps, stakeTopupBps, collateralBps,
maxGross, claimWindowSeconds, allowPoolOnly,
objectiveFailureRulesHash, evidenceRulesHash, policyDocumentHash
```

Active status is mutable separately and excluded from immutable `policyHash`.
Policy ID is unique per Core. Publish a versioned ABI-encoded hash committing
every immutable field. A provider cannot unilaterally activate access to pool
capital; activation is an admin action in the POC.

Let `G` be gross atomic token units, `P` premium, `T` stake top-up, `N` net,
and `L` required provider stake:

```text
P = max(1, floor(G * premiumBps / 10_000))
T = floor(G * stakeTopupBps / 10_000)
N = G - P - T
L = ceil(G * collateralBps / 10_000)
```

Require `G > 0`, positive premium rate, `1 <= collateralBps <= 10_000`,
nonnegative top-up rate, rates totaling at most 10,000, and `P + T <= G`.
Use checked `uint256` accounting and full-precision `mulDiv` with explicit
rounding. Cast packed fields only after checking their bounds. An estimate
cannot promise capacity for a gross amount above policy maximum.

On admission, if provider stake/lock are `S/K`, require:

```text
K + L <= S + T
```

Top-up belongs to the provider and may support this coverage immediately.
Separate owner deposits remain available. Tiny payments can yield `T = 0`,
so revenue withholding is not a guarantee of zero-capital onboarding.
The exact `canOpenCoverage` check is authoritative; a displayed capacity
estimate must include top-up and pool constraints or label its limits.

## 7. Shared-pool reservation

Track `poolLiquidity` separately from `totalProviderStake`, even though both
are physically held by Core. Add `poolReserved` for all nonterminal coverage.

Reserve for each coverage:

```text
R = G                    if policy permits any pool-only approved refund
R = G - L                if only provider-fault approved refunds are permitted
poolReserved + R <= poolLiquidity + P
```

Premium from this settlement may contribute to admission. Pool-only refunds
must be prohibited on-chain when `allowPoolOnly` is false. Pool funding is an
explicit `fundPool(amount)` donation with no withdrawal/share-token rights in
MVP; premiums and these donations are the only ways to credit pool liquidity.
Unsolicited transfers remain untracked surplus.

This fully funds maximum allowed nominal refunds across simultaneously open
coverages. It is conservative and capital-intensive; it is not a claim that
premium rates alone fund the product, or that issuer/chain risks disappear.
The pool may need seeded test capital. Do not weaken this rule silently to
recreate the previous leveraged demo.

The proposed provider-fault waterfall can recover available provider stake
beyond this coverage's minimum lock. For refund `A <= G`:

```text
remainingLocked = K - L
stakeAvailable = S - remainingLocked
stakeDebit = min(A, stakeAvailable)       # provider-fault only
poolDebit = A - stakeDebit
```

Pool-only: `stakeDebit = 0`, `poolDebit = A`. Since `S >= K`, provider-fault
`stakeAvailable >= L`; therefore `poolDebit <= G-L`. This proves the reserved
`R` covers either permitted path, even after free stake is withdrawn. Other
providers' stake and other coverages' locked stake are never consumed.

Finalization releases the current coverage's `L/R`, debits the ledgers, then
pays the stored payer. Failed transfer reverts everything. Rejection and
unclaimed expiry release `L/R` without token movement. A partial refund is
terminal: no second claim for the remaining amount in MVP.

## 8. Claims, expiry, and pause

```text
OPEN -> CLAIM_PENDING -> REFUNDED
                     -> CLOSED       # adjudicator rejection
OPEN -> CLOSED                       # unclaimed expiry
```

One claim per coverage. Claim ID is derived from coverage identity and a
versioned claim domain, not an arbitrary reusable user ID. `registerClaim`
requires the stored payer to call before `expiresAt`; the POC direct path
costs caller gas. A later relayed claim variant must verify a separate
Core-domain EIP-712 claim signature, nonce, deadline, reason and evidence hash.
It must not reuse the token payment authorization.

The API may stage evidence or accept a signed workflow request, but must not
report a financially protected pending claim until registration is canonical
on-chain. At `block.timestamp == expiresAt`, registration fails and unclaimed
closure may succeed. A timely pending claim cannot expire underneath adjudication.

Only adjudicator finalizes a registered pending claim. It supplies approval,
amount, fault flag, resolution code and decision hash; Core derives payer,
policy limits, stake/pool debit and terminal status. Rejection requires zero
amount and no fault. Approval requires `0 < amount <= gross` and policy-permitted
fault attribution. No refund-address or arbitrary debit arguments.

Pending claims keep reservations until finalization. Adjudicator unavailability
can lock them indefinitely in this POC. This is an explicit liveness limit;
there is no silent timeout release, forced rejection, or automatic payout.
A production adjudication deadline/appeal/recovery mechanism needs a separate
design before production, not an improvised keeper rule.

`closeCoverage` is permissionless, operates on one expired `OPEN` coverage,
and cannot touch `CLAIM_PENDING`. No scan over all provider coverages. Later
bounded batch closure may optimize keeper costs without changing semantics.

Pause blocks new registrations, policies, and settlements. Allow funding,
stake deposits, safe withdrawals, claim registration/finalization, and expiry
closure while paused. This avoids blocking claims near their deadline.
No separate payout pause in MVP.

## 9. Storage, events, and invariants

Use mappings for provider, policy, coverage, and claim records. Store only facts
required for admission, refund authorization, replay protection and direct reads:

| Record | Minimum authoritative facts |
|---|---|
| Provider | owner, payout, receipt signer, active, stake total/locked, gross exposure |
| Policy | immutable economic/evidence terms and hash, provider binding, active flag |
| Coverage | payer, provider/policy IDs, request hash, gross, exact `L/R`, expiry, status |
| Claim | coverage binding, terminal outcome identity/hash and amounts; pending marker |
| Global | immutable token/roles, pause, total stake, pool liquidity/reserved, exposure |

Net/premium/top-up can be derived from immutable policy and gross and emitted
without redundant permanent fields. Keep persistent terminal identity/status
so no coverage can be recreated after closure. Exact slot packing is an M2
measurement, not a promised gas number. No on-chain enumeration or deletion
without a separately proven replay-protection strategy.

Events include registration/status, immutable policy creation/activation,
pool funding, stake deposit/withdrawal, coverage open/close, claim registration,
claim finalization/refund and pause changes. Emit projection-critical IDs,
amounts, term hashes and timestamps. Freeze exact ABI signatures before SDKs.

Required invariant set:

```text
N + P + T == G
provider.stakeLocked <= provider.stakeTotal
sum(nonterminal coverage L for provider) == provider.stakeLocked
sum(nonterminal coverage R) == poolReserved
poolReserved <= poolLiquidity
totalProviderStake + poolLiquidity <= token.balanceOf(Core)
sum(provider.stakeTotal) == totalProviderStake
sum(nonterminal gross) == totalOpenExposure
refund <= gross; refund recipient == coverage.payer
coverage/payment/claim uniqueness; terminal release happens exactly once
```

Test aggregate sums off-chain/in invariant harnesses, not through unbounded
loops in production. Pending claims count as nonterminal exposure. A direct
token donation must not change recorded stake or pool liquidity automatically.

## 10. Commitments, receipts, and evidence

The client and provider compute the same deterministic versioned request
envelope before signing. Commit method, canonical resource, selected headers,
exact body hash and a private random evidence salt. Use deterministic encoding
with length delimiters; freeze URL/query, duplicate-header, empty-body, charset
and compression behavior in M3 with cross-language vectors.

Use keccak256 for EVM intent/policy hashes and typed signatures. SHA-256 remains
appropriate for large off-chain payload/object hashes; hashes have algorithm
identifiers and separate domains. EVM migration does not require replacing
every existing cryptographic primitive with an EVM opcode.

Exclude authentication secrets before evidence/commitment capture according to
the declared schema. Never silently hash full bytes, discard them through
redaction, and claim later exact reconstruction. Credentials embedded inside
body fields require a specified sanitization policy or route exclusion.

Proposed `AssurePayReceiptV1` binds chain ID/Core via its EIP-712 domain, coverage,
provider, policy, request hash, response body hash, selected response-header hash,
HTTP status, served time, latency and signer version. Dedicated receipt key
signs; caller verifies against the signer committed for that coverage. No
on-chain response write or signature verification per successful request.

MVP limits to bounded buffered HTTP responses. Streaming, trailers, partial
responses and external fulfillment require a separate response-finalization
specification. A provider-signed receipt is evidence of an assertion, not proof
of delivery, truth, or quality.

Store AES-256-GCM ciphertext off-chain with a per-coverage DEK, a unique nonce
per object, authenticated metadata binding chain/Core/coverage/object kind, and
a wrapped DEK behind `KeyWrapper`. Use an environment-backed dev KEK locally;
production KMS is deferred. Encrypted spool retries are idempotent. Verify
AEAD, ciphertext/plaintext hashes and receipt linkage during retrieval.

MVP has no Merkle anchor contract or service. Later batching can strengthen
time/integrity anchoring of post-response evidence. Clearly distinguish
provider-signature timing assertions from independently anchored timestamps.
Missing evidence changes evidence health and adjudication inputs, never erases
existing coverage. Operators retain controlled decryption capability in MVP.

## 11. Projection, network and operations

Identify on-chain records by `(chainId, coreAddress, coverageId)`, transactions
by hash, and events by transaction hash plus log index and canonical block hash.
Store amounts as bigint/canonical decimal or sufficiently wide database numeric
integers; never JavaScript floating point.

Observer follows block parents, rolls back orphaned projections, and reconciles
against Core at a consistent block. Evidence is retained across reorgs but marked
unanchored if its coverage disappears. A payment receipt and current unrelated
state read are not a historical proof of a successful liability transition.

Base Sepolia uses chain ID 84532; Base mainnet 8453. Token addresses must come
from Circle's network-specific native USDC registry and be rechecked in
preflight, including code, decimals, domain and receive ABI. Do not guess a
token deployment from its ticker or use a bridged asset as equivalent.
[Base chain IDs](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId),
[Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

Distinguish sequencer inclusion from safe/finalized chain state. The integration
gate must specify a configurable provider service-release policy and separately
record the finality level of public acceptance evidence. Do not equate the L1
withdrawal challenge period with every L2 transaction's execution confirmation.
[Base derivation and finality](https://docs.base.org/base-chain/specs/protocol/consensus/derivation)

No deployment keys, signatures, populated environments, or raw RPC blobs enter
public evidence. Compact results include chain/token/Core identity, code/build
configuration, public transaction/block hashes, events/deltas, gas and observed
invariants. A read-only verifier must not request a signer.

## 12. Efficiency gates and evolution

Measure before optimization: settlement gas for new/reused provider/policy,
calldata bytes, signature/token calls, failed settlement gas, claim and closure
gas, storage growth, RPC latency, receipt confirmation and L1 data fees. Compare
with an ordinary USDC x402 payment using identical chain/fee conditions.
Gas sponsorship shifts cost; it does not eliminate it.

Permit2 witness is a future token-general alternative, not part of the first
USDC profile. Smart accounts and sponsored claim registration are independent
UX extensions. Batch settlement or commitment-only coverage requires a new
proof of capacity reservation and claim availability before per-call state is
removed. Avoid premature vault share tokens, NFTs, diamonds or cross-chain
messaging.

The next gate is the bounded authorization/atomicity spike in
`planning/EVM_M1_SETTLEMENT_SPIKE.md`. All new interfaces in this document are
proposals until that gate produces reproducible evidence. Product invariants
govern mechanism selection; past technical patterns do not constrain it.
