# P1 Gate D Packet — Withdrawal, Closure, Claims, and Refunds

## Objective

Complete the Assurance Core financial state machine: safe provider stake withdrawal, permissionless expiry closure, adjudicator-only claim finalization, payer-bound refunds, and the provider-fault loss waterfall. Prove every transition preserves mixed-policy collateral and aggregate accounting.

This packet is self-contained. Do not read `planning/P1_ASSURANCE_CORE.md`, earlier gate packets, or anything under `/docs`.

Implement Gate D only. Do not start the Gate E consolidated demo, TestNet, P2 SDK/middleware, backend claim submission/evidence, UI, governance, key rotation, or infrastructure.

## Starting point and allowed context

- Gate C closing commit: `911b0af` or the committed orchestration successor.
- Gates A–C are accepted. Preserve their ABI, storage layouts, box prefixes, status values, assured-exact profile, accounting semantics, and events.
- Do not modify `spikes/p0-atomic/**` or the accepted Gate C adapter unless a deterministic regression test exposes a real Gate D integration defect.
- Reuse pinned dependencies and toolchain; do not broadly upgrade them.

Read only `AGENTS.md`, `SESSION_HANDOFF.md`, this packet, `DECISIONS.md`, `IMPLEMENTATION_PLAN.md`, `planning/P1_RESULTS.md`, and existing `contracts/assurance-core/**`.

## Frozen records, keys, and statuses

Keep the accepted coverage statuses:

```text
OPEN     = 1
REFUNDED = 2
CLOSED   = 3
```

Use the existing records without adding/reordering fields:

```text
ProviderRecord:
  ownerAddress, payoutAddress, receiptSigningPublicKey, active,
  stakeTotal, stakeLocked, openFaultExposure, createdAt

CoverageRecord:
  providerId, policyId, payerAddress, grossAmount, providerNetAmount,
  premiumAmount, stakeTopupAmount, lockedStakeAmount, requestHash,
  openedAt, expiresAt, status, exposureReleased

FinalizedClaimRecord:
  coverageId, approved, approvedAmount, providerFault, resolutionCode,
  stakeDebit, poolDebit, resolvedAt
```

Box keys and MBR remain:

```text
provider: 0x70 || providerId   # 67,300 microAlgos
policy:   0x6c || policyId     # 44,900 microAlgos
coverage: 0x63 || coverageId   # 92,900 microAlgos
claim:    0x66 || claimId      # 45,300 microAlgos
```

Coverage and finalized-claim boxes are permanent tombstones. Never delete them or permit ID reuse. Callers supply every required box/account/asset reference; missing or incorrect resources fail atomically.

## Required ABI

Add exactly:

```text
withdrawStake(providerId, amount)
closeCoverage(coverageId)
finalizeClaim(claimId, coverageId, approved, approvedAmount,
              providerFault, resolutionCode)
getClaim(claimId)
```

`getClaim` is read-only and returns the complete accepted finalized-claim record. No method accepts a refund receiver, owner, payout address, collateral amount, debit split, status, or exposure-release flag from the caller.

Every state-changing call rejects non-zero application rekey. Withdrawal is blocked while paused. Expiry closure and claim finalization remain available while paused.

## Stake withdrawal

Only the stored provider owner may withdraw attributed stake. Do not require the provider to be active; an inactive provider must still be able to recover unencumbered funds.

Validate:

1. protocol unpaused and application ASA opt-in complete;
2. provider exists and caller equals stored owner;
3. `amount > 0`;
4. `stakeTotal >= amount`;
5. `postWithdrawalStake = stakeTotal - amount` satisfies `postWithdrawalStake >= stakeLocked`;
6. global `totalProviderStake >= amount`;
7. actual application ASA holding is at least `amount`;
8. after the withdrawal, `newTotalProviderStake + premiumReserve` cannot overflow and is no greater than the physical post-transfer ASA balance;
9. the outer call pools the inner transaction fee correctly.

On success:

- decrement provider `stakeTotal` and global `totalProviderStake` by exactly `amount`;
- leave `stakeLocked`, exposure, coverage, and premium reserve unchanged;
- send one inner transfer of the configured ASA to the stored **owner address**;
- use zero inner fee with safe implicit optional fields;
- emit `StakeWithdrawn(uint64,byte[32],uint64,uint64)` as version, provider ID, amount, new provider stake.

Any failure must produce no inner transfer or accounting change. When all exposure is released, full withdrawal is permitted; subsequent coverage admission with zero capacity must fail atomically.

## Single exposure-release transition

Implement one internal release operation used by both expiry closure and claim finalization. Before release require:

```text
coverage.status == OPEN
coverage.exposureReleased == false
provider.stakeLocked >= coverage.lockedStakeAmount
provider.openFaultExposure >= coverage.grossAmount
totalOpenFaultExposure >= coverage.grossAmount
```

Release exactly:

```text
provider.stakeLocked          -= coverage.lockedStakeAmount
provider.openFaultExposure    -= coverage.grossAmount
totalOpenFaultExposure        -= coverage.grossAmount
coverage.exposureReleased      = true
```

No terminal path may release twice. Preserve every immutable coverage field.

## Permissionless expiry closure

`closeCoverage(coverageId)`:

- is callable by any address, including while paused;
- requires the coverage to exist, remain `OPEN`, and not be released;
- requires `Global.latestTimestamp >= expiresAt`; equality is accepted;
- loads the stored provider and performs the single release transition;
- sets coverage status to `CLOSED`;
- transfers no ASA and changes neither provider stake total nor premium reserve;
- emits `CoverageClosed(uint64,byte[32],uint64,bool)` with version `1`, coverage ID, confirmed close timestamp, and `expired=true`.

Early closure, duplicate closure, closure of refunded coverage, missing boxes, and unsafe rekey fail without changes.

## Claim finalization

Implement:

```text
finalizeClaim(claimId, coverageId, approved, approvedAmount,
              providerFault, resolutionCode)
```

Validate before mutation:

1. caller is the configured adjudicator; admin alone has no authority unless it is the same configured address;
2. application rekey is zero;
3. non-zero claim and coverage IDs;
4. claim box is unused and remains a permanent tombstone after success;
5. coverage exists, is `OPEN`, and has not released exposure;
6. stored provider exists and matches the coverage;
7. `resolutionCode > 0`;
8. `approvedAmount <= coverage.grossAmount`;
9. rejected claim: `approved=false`, `approvedAmount=0`, `providerFault=false`;
10. approved claim: `approved=true`, `approvedAmount>0`; `providerFault` may be true or false;
11. all provider/global/reserve debits are available and cannot underflow;
12. any approved refund has sufficient actual application ASA balance and correctly pooled inner fee;
13. the complete post-refund `newTotalProviderStake + newPremiumReserve` is no greater than the physical post-transfer application ASA balance.

Claim finalization is allowed before or after expiry while the record is still `OPEN`. Expiry close and finalization race safely: the first confirmed terminal transition succeeds and the other fails.

### Rejected claim

For `approved=false`:

- `stakeDebit=0`, `poolDebit=0`;
- write the finalized claim record;
- perform the single exposure release;
- set coverage status `CLOSED`;
- transfer nothing;
- emit `ClaimFinalized(...)` and `CoverageClosed(..., expired=false)`.

### Approved non-provider-fault claim

For `approved=true, providerFault=false`:

```text
stakeDebit = 0
poolDebit  = approvedAmount
```

Require `premiumReserve >= poolDebit`.

### Approved provider-fault claim

For `approved=true, providerFault=true`, protect every other open coverage:

```text
remainingLockedStake = provider.stakeLocked - coverage.lockedStakeAmount
stakeAvailableForThisClaim = provider.stakeTotal - remainingLockedStake
stakeDebit = min(approvedAmount, stakeAvailableForThisClaim)
poolDebit = approvedAmount - stakeDebit
```

Require `premiumReserve >= poolDebit`. This may consume the finalized coverage's released lock and additional unencumbered stake, but never stake locked for another coverage. Never debit another provider.

### Approved success transition

For either approved branch:

- perform the single exposure release;
- decrement provider `stakeTotal` and global `totalProviderStake` by `stakeDebit`;
- decrement `premiumReserve` by `poolDebit`;
- require `stakeDebit + poolDebit == approvedAmount` without overflow;
- set coverage status to `REFUNDED`;
- write the finalized claim record with the exact split and confirmed timestamp;
- send exactly one inner configured-ASA transfer for `approvedAmount` to the coverage's **stored payer address**;
- emit both events below; do not emit `CoverageClosed` for a refunded status.

The refund destination must be derived from storage. The ABI must contain no receiver argument.

## Frozen events

Use version `1` and these exact signatures:

```text
StakeWithdrawn(uint64,byte[32],uint64,uint64)
CoverageClosed(uint64,byte[32],uint64,bool)
ClaimFinalized(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)
RefundPaid(uint64,byte[32],byte[32],address,uint64)
```

Interpretation:

- `StakeWithdrawn`: version, providerId, amount, newProviderStake;
- `CoverageClosed`: version, coverageId, closedAt, expired;
- `ClaimFinalized`: version, claimId, coverageId, approved, approvedAmount, providerFault, resolutionCode, resolvedAt;
- `RefundPaid`: version, claimId, coverageId, stored payer, approvedAmount.

The claim record contains `stakeDebit` and `poolDebit`; do not change the frozen event to duplicate them.

## Accounting invariants

Use checked integer arithmetic throughout. After every successful transition, the deterministic model and LocalNet assertions must establish:

1. every provider has `stakeLocked <= stakeTotal`;
2. each provider's `stakeLocked` equals the sum of locked amounts for its unreleased open coverages;
3. each provider's `openFaultExposure` equals the sum of gross amounts for its unreleased open coverages;
4. global `totalProviderStake` equals the sum of provider `stakeTotal` values;
5. global `totalOpenFaultExposure` equals the sum of provider open exposures;
6. `totalProviderStake + premiumReserve <= actual application ASA balance`;
7. `OPEN` implies unreleased, while `CLOSED`/`REFUNDED` imply released, for all Gate D-produced states;
8. coverage and claim IDs are never reused and every claim record matches its terminal coverage;
9. rejected claims have zero debits, and approved claims have `stakeDebit + poolDebit == approvedAmount`;
10. every refund goes only to the stored payer and changes physical/tracked balances by the recorded exact amount.

Unsolicited ASA may make physical balance greater than tracked liabilities; equality is not universally required.

## Required deterministic tests

Preserve all 21 Gate A–C tests. Add focused unit/model/property coverage for:

- exact ABI, read-only claim read, record layout, event signatures/prefixes, and status transitions;
- withdrawal authorization, inactive-provider withdrawal, pause blocking, zero/over/locked withdrawal, full post-release withdrawal, pooled fee, actual-balance bound, and all underflows;
- early/equal/late expiry, permissionless close, close while paused, duplicate/terminal close, missing resources, and one-time release;
- adjudicator-only claims, admin/non-adjudicator rejection, duplicate/zero IDs, invalid boolean/amount combinations, zero resolution, amount above gross, and finalized-claim reads;
- rejected claim with zero transfer/debits and `CLOSED` status;
- approved non-provider-fault pool-only refund;
- provider-fault stake-only and stake-plus-pool waterfalls;
- another provider and another open mixed-ratio coverage remain untouched/collateralized;
- insufficient reserve, actual balance, fee, and resource availability roll back all state;
- stored-payer binding and absence of any refund receiver ABI argument;
- pause permits close/finalize but blocks withdrawal;
- expiry-close versus claim-finalize race and every duplicate-release path;
- a deterministic seeded state-machine sequence covering deposits, mixed-policy opens, partial/full withdrawals, expiry closes, rejected claims, both approved claim branches, and failures. Assert invariants 1–10 after every successful transition, not only at the end.

Deterministic tests must not require LocalNet. Avoid shallow source-regex assertions where an executable model/artifact decode is practical.

## Required real LocalNet proof

Extend `npm run localnet:p1`, keeping Gates A–C green. Use real transactions and compact public evidence to prove:

1. over-withdrawal and withdrawal that would cross `stakeLocked` reject with complete rollback;
2. a valid unencumbered withdrawal succeeds, transfers exact ASA to stored owner, updates provider/global stake, emits/decodes `StakeWithdrawn`, and preserves locks/exposure/reserve;
3. early close rejects; permissionless close at/after expiry succeeds even while paused and releases the exact lock/exposure once; duplicate close rejects;
4. a rejected adjudicated claim writes/reads the claim tombstone, transfers nothing, closes/releases coverage, and emits/decodes both required events;
5. an approved non-provider-fault claim refunds the stored payer from premium reserve only;
6. an approved provider-fault claim exercises a genuine stake-plus-pool split while another mixed-policy coverage remains open and fully collateralized;
7. another provider's stake/record is unchanged throughout that loss;
8. insufficient pool and insufficient actual-balance attempts fail for the intended assertion with payer/provider/application ALGO+ASA, MBR, boxes, records, and global accounting unchanged;
9. non-adjudicator, duplicate claim, invalid outcome fields, amount above gross, zero resolution, unsafe rekey, missing resource, and insufficient fee cases reject with complete rollback;
10. full withdrawal succeeds after all exposure for a chosen provider is released, capacity becomes zero, and a later valid assured-exact coverage group fails atomically for zero capacity;
11. final on-chain state satisfies invariants 1–10 and `totalProviderStake + premiumReserve <= actual ASA balance`.

For expiry, advance LocalNet deterministically with bounded transactions/polling; do not use a long sleep. For intended application failures, match the deployed app and assertion PC/message rather than accepting unrelated endpoint, validity-round, or resource errors.

Explicitly fund each 45,300-microAlgo claim box and verify observed MBR deltas. If the compiled approval requires a different `extraPages` value, record the exact byte size and add a new decision; do not silently revise D-021.

Output only compact public evidence: network, ASA/app IDs, public transaction/group IDs, timestamps, MBR/balance/accounting deltas, waterfall split, stored refund destination, named/countable rejections, and invariant results. Never print signed blobs, private keys, mnemonics, tokens, or full pending/simulation objects.

## Commands and records

All must pass:

```text
npm run typecheck:p1
npm run build:contract:p1
npm run test:p1
npm run localnet:p1
```

Update `planning/P1_RESULTS.md` Gate D with ABI/events, arithmetic/waterfall behavior, exact compiled size/pages, claim MBR, public LocalNet IDs, balance/state deltas, rollback evidence, invariant/state-machine results, commands, and deviations.

Rewrite `SESSION_HANDOFF.md` with Gate D in `REVIEW` and the exact next action. Do not mark Gate E ready and do not begin it.

If a compiler/protocol constraint conflicts with a frozen record, event, ABI, or accepted decision, record the exact conflict and stop rather than improvising.

## Allowed modifications

```text
contracts/assurance-core/**
planning/P1_RESULTS.md
SESSION_HANDOFF.md
DECISIONS.md                    # implementation facts only
IMPLEMENTATION_PLAN.md          # P1 status cell only
package.json
package-lock.json
.gitignore                      # necessary entries only
```

Do not modify P0, earlier P1 packets, `/docs`, `/apps`, `/packages`, or `/infra`.

## Exit condition

Gate D passes only when withdrawal, expiry closure, all claim branches, payer-bound refunds, loss isolation, one-time release, permanent claim tombstones, full rollback, and invariants 1–10 pass deterministic/state-machine tests and real LocalNet proof; Gates A–C remain green; records are accurate; commits are focused; and the worktree is clean.

Stop after Gate D even if time remains.
