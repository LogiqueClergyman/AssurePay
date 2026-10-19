# M2 financial-core requirements — accepted baseline

Status: ACCEPTED under EVM-016; user chose the proposed baseline. Exact
implementation interfaces and local execution gate are in EVM-017 and
planning/EVM_M2_FINANCIAL_CORE.md.

## Current work boundary

The user selected the proposed baseline on2026-10-19 (EVM-016). This accepted
requirements record is refined into the active implementation packet
`planning/EVM_M2_FINANCIAL_CORE.md` (EVM-017). Its paths, interfaces and gates
control implementation. No `/docs` material is in scope. Historical proposal
wording below describes the accepted baseline; remaining implementation details
are fixed in the new packet before dependent code.

## Purpose and proposed scope

Define a single non-upgradeable Solidity Core for Base Sepolia and native test
USDC, with EOA users. Limit the first implementation to provider and immutable
policy registration, atomic settlement/coverage creation, provider stake,
donated pool funds and reservations, controlled withdrawals, claims, expiry,
and pause behavior. Reuse M1's proven payment boundary only after its accepted
interfaces are identified in the M2 implementation packet. This is a test
financial core, not a production deployment or a second chain/asset design.

The user accepted the conservative formulas and state rules below.

## Proposed policy and settlement terms

Each policy is immutable after creation and supplies `premiumBps`, `stakeBps`,
`withholdingBps`, `duration`, and `poolOnlyAllowed`. A coverage snapshots those
terms and its gross `G`. BPS uses denominator 10,000. Require `G >= 2`,
`0 <= premiumBps, withholdingBps < 10,000`, and `0 <= stakeBps <= 10,000`.
The one-unit premium minimum applies even when premiumBps is zero; there is no
free-premium policy in this proposal. Duration must be positive and expiry
arithmetic must be representable.

Proposed calculations use integer atomic units only:

- Premium `P = max(1, floor(G * premiumBps / 10,000))`, and require `P < G`.
- Stake lock `L = ceil(G * stakeBps / 10,000)`, and require `L <= G` and
  sufficient provider free stake after crediting this settlement’s withholding.
- Withholding `W = floor((G - P) * withholdingBps / 10,000)`, credited to that
  provider's stake in settlement. Require provider net `N = G - P - W > 0`.
- Reserve `G` pool units when `poolOnlyAllowed`; otherwise reserve `G - L`.

Settlement should atomically receive `G`, create the exact coverage, credit
`P`, `W`, and `L` to their separate ledgers, reserve the permitted pool amount,
and pay `N`. Premium `P` becomes pool-owned assets, with the same donation/no-
withdrawal rights as seeded pool funds; it is not a separate fee-owner liability.
Pool-only eligibility deliberately reserves `G` in addition to provider lock
`L`, so either permitted refund source can pay its maximum. Any failed check or transfer reverts the full transition. No
floating-point arithmetic or untracked balance accounting is proposed.

## Proposed funding, locks, and withdrawals

Provider stake is tracked by provider as free and locked amounts. Settlement
locks `L`; coverage terminal resolution releases its remaining lock. Withheld
revenue `W` increases only that provider's free stake. Pool deposits are
donations without shares, redemption rights, or withdrawals. Pool reservations
are per live coverage and aggregate reserves may not exceed pool balance.

Proposed safe withdrawals allow a provider to withdraw only its own free stake;
withdrawal must preserve every live lock. Pool withdrawals are disabled. Pool
deposits and provider deposits remain available while paused. Exact withdrawal
authorization, reentrancy protections, and balance-delta checks belong in the
implementation packet after these terms are decided.

## Proposed claims and resolution

The payer stored in coverage may register a claim before that coverage's
expiry. A pending claim keeps its stake and pool reservations locked. One
authorized adjudicator may finalize exactly one terminal outcome: rejection,
or a partial/full refund `R` where `0 < R <= G`. Refunds go only to the stored
original payer. No automatic decision or payout occurs at a timeout; an
adjudicator outage may keep a pending claim locked.

Refund outcomes explicitly identify `providerFault` or `poolOnly`; the
adjudicator chooses an allowed type and amount. For a provider-fault refund,
propose funding recovery in this order: release
and consume the coverage's remaining `L`, then consume the same provider's
free stake, then pay the remainder from the pool. Never consume another
provider's locked or free stake. A pool-only refund outcome is available only
when `poolOnlyAllowed` is true; its reservation is `G`. Otherwise reserve
`G - L` and use the coverage stake portion before pool funds. Any amount not
needed for an approved refund is released to its originating ledger. A
rejection releases all remaining locks and pays no refund.

For provider-fault amount `R`, snapshot pre-resolution free stake `F` excluding
this coverage's lock. Consume `a = min(R,L)` from its lock,
`b = min(R-a,F)` from this provider's free stake, and `c = R-a-b` from pool
assets. Release unused lock `L-a` back to that provider's free stake. Decrease
aggregate locked stake by `L` and total provider stake by `a+b`; decrease pool
assets by `c`. Release this coverage's entire pool reservation once the
resolution is terminal. For pool-only refund, consume `R` pool assets and
release all `L` to provider free stake. Rejection or unclaimed expiry consumes
no assets and releases the coverage's complete stake/pool reservations.
Free stake is withdrawable and never counted toward the guaranteed refund
budget; the locked `L` and reserved pool contribution provide that guarantee.

Propose expiry as `coverageStart + duration`. An unclaimed coverage may be
closed at or after expiry, releasing its remaining locks. A timely pending
claim prevents expiry closure until adjudication. No claim can be registered
at or after expiry. Reorg/finality policy for off-chain projections is outside
this contract requirements packet.

## Proposed authority and pause behavior

One explicitly configured administrator controls provider/policy registration
and a global pause. The proposed pause blocks new provider/policy registration
and new settlement/coverage admission only. It does not block provider/pool
funding, safe provider withdrawals, timely claim registration, adjudication,
or unclaimed expiry closure. Start with one adjudicator address; the constructor configures it and this phase has no replacement function. No upgrade, recovery key, or production role
rotation is proposed in this phase.

## Safety requirements independent of the refund-model choice

Use overflow-safe integer multiply/divide with explicit round-up for stake,
checked additions/subtractions for ledger totals, and checked expiry arithmetic.
At every completed operation require actual Core USDC balance to cover
`poolAssets + totalProviderStake`, where stake includes free and locked portions,
and require `poolAssets >= totalPoolReserved`. Unsolicited token surplus grants
no withdrawal rights. Coverages cannot borrow other providers' stake or another
coverage's locks/reservations.

Require exact token balance deltas for every deposit, settlement, withdrawal
and refund; reject zero/self recipients that break the intended independent
accounting. Bind immutable policy economics to signed intent and snapshot the
coverage terms. Apply authorization, reentrancy protection and state transitions
around token calls so a coverage has exactly one terminal transition and cannot
refund or release twice. Pending timely claims block expiry closure. These
properties need actual EVM success/failure/invariant tests in the coding packet.

## Decision closure

The user accepted the proposed model as a whole. EVM-016 records the economic
and product rules; EVM-017 and the active implementation packet fix constructor
role selection, immutable registry ownership, canonical hashes, withdrawal
recipients, refund enum semantics, equations and actual-EVM acceptance tests.
No economic requirements remain unanswered for this M2 local implementation.
