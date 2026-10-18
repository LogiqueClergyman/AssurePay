# EVM decision log

Date: 2026-10-18. Record evidence and consequences before code depends on a
choice. Proposed mechanisms remain replaceable until their phase gate passes.

## EVM-001 — Product direction and initial chain

Status: ACCEPTED. Source: user instruction and Base selection.

Build provider-integrated assurance for x402 services on EVM, initially Base
Sepolia with native test USDC. Retain the product objectives: one gross price,
atomic payment/coverage, collateral-constrained admission, verifiable evidence
and approved refunds to the original payer. No multiple-chain abstraction or
mainnet deployment in the first MVP.

## EVM-002 — Independent technical design

Status: ACCEPTED. Source: explicit user instruction.

Technical choices are evaluated for this EVM implementation. The payment scheme,
x402 call type, token authorization, settlement composition, contract shape,
storage, evidence and claims mechanisms may change when an alternative better
serves the protocol. Reusing a name or pattern is not evidence for choosing it.
Compare compatible standard mechanisms before freezing a custom profile.

The architecture/MVP are a reviewed starting proposal, not an immutable ABI or
proof of compatibility. M1 investigates and records the actual supported path
before dependent financial-core/SDK code is written.

## EVM-003 — Intent-bound receive authorization candidate

Status: PROPOSED. Phase: M1.

Candidate: one relayed Core call uses native USDC receive authorization with a
nonce committing the complete assurance intent, creates coverage and pays
provider net atomically. Bind chain, Core, token, payer, provider, immutable
policy/hash, request/hash, gross, random salt and validity bounds. EOA first.
Candidate wire identity is `assured-exact` / `assurepay-evm-v1`; use a different
safe supported scheme if Gate A demonstrates a better fit.

Prove deployed token ABI/domain, term binding, signature-extraction resistance,
nested rollback and real registered x402 integration. Ordinary token transfer
followed by independent coverage creation fails the product invariant.
Permit2 witnesses, wallet execution and other x402 modes remain alternatives;
compare approval/gas, atomicity, liability timing and operational dependencies.

## EVM-004 — Funding and collateral baseline

Status: PROPOSED. Phase: M2.

Use integer premium floor with a one-unit minimum and per-coverage ceiling stake
locks. Allow immutable policy revenue withholding into provider-owned stake in
the settlement call. Reserve the maximum permitted pool contribution for each
live coverage: gross when pool-only refunds are allowed; gross minus its exact
stake lock otherwise. Keep stake and pool ledgers separate. Explicit pool
funding is a donation in MVP, with no share token or withdrawal right.

This conservative funding rule requires seeded capital when premiums alone
are insufficient. Changing it is an economic design decision, not merely a gas
optimization. Provider-fault recovery may consume that provider's free/released
stake while protecting other coverage locks and unrelated providers' stake.

## EVM-005 — Claims, expiry and MVP trust boundary

Status: PROPOSED. Phase: M2.

A payer registers a claim on-chain before expiry. Pending claims preserve
stake/pool locks until one adjudicator finalizes a terminal resolution. Refund
is capped by stored coverage and paid only to stored payer. Direct filing costs
payer gas in the first profile; adjudicator outage can lock pending collateral.
No automatic timeout release/rejection/payout is assumed.

Pause blocks new admission and registration but allows funding, deposits, safe
withdrawals, timely claims, finalization and unclaimed expiry closure. Start
with one non-upgradeable Core; production recovery/rotation is separate work.

## EVM-006 — Fresh working baseline and recovery

Status: ACCEPTED. Source: user's branch/archive and cleanup requests.

`evm/restart` is the active implementation branch. The historical checkpoint is
recoverable from `archive/algorand-p1` at
`958f65002d6afd97e8cbb86bae63ecabe5abb024`; leave that ref and `main` unchanged.
Remove previous implementation, specs, artifacts, dependency tree and planning
history from the active tree. Preserve local ignored configuration privately
outside the repository without reading credentials. Create one new cleanup
commit; do not rewrite old commits or push.

Keep only current EVM requirements, rationale, packets and concise state. No
EVM code, dependency compatibility, gas performance or public acceptance is
claimed by this cleanup.
