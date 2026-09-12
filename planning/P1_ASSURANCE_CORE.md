# P1 Work Packet — On-Chain Assurance Core

## Mission

Implement the POC's financial source of truth as an Algorand TypeScript smart contract. P1 must prove provider registration, immutable/versioned policy terms, stake accounting, capacity and withdrawal enforcement, coverage creation through the P0 `assured-exact` group, explicit exposure release, contract-constrained claim finalization, and refunds to the original payer.

This packet is self-contained. Do not consult `/docs`.

P1 is contract-focused. Do not build the provider HTTP middleware, assurance-aware client SDK, evidence store, PostgreSQL projection, claims API, or production UI; those begin in P2/P3.

## Authority and inherited decisions

Follow, in order:

1. `AGENTS.md`
2. this packet
3. `DECISIONS.md`
4. `IMPLEMENTATION_PLAN.md`

P0 is complete. Preserve these accepted constraints:

- D-010: the wire scheme is distinct `assured-exact`, not AVM `exact`.
- D-016: the accepted coverage group has exactly three ordered members: `[provider axfer, premium axfer, application call]`.
- D-017: the payer pays all three transaction fees; there is no fee-sponsor member.
- D-018: TestNet automation uses the opaque Pera ARC-52 signer and an expected-address check; secrets stay in ignored environment files.
- D-019: the complete ordered signed group is bound and verified before simulation/submission.

The disposable P0 contract is evidence and a reference, not the production P1 contract. Do not evolve it in place.

## Fixed P1 decisions

### Storage and identifiers — resolves D-011

- Create the production contract under `contracts/assurance-core/`.
- Use fixed 32-byte identifiers for `providerId`, `policyId`, `coverageId`, and `claimId`. Human-readable identifiers are hashed off-chain before use.
- Store providers, policies, coverages, and finalized claims in boxes keyed by a type prefix plus the 32-byte identifier. A record type must never share a key namespace with another type.
- Keep only protocol-wide configuration and aggregate accounting in global state.
- Preserve coverage and claim tombstones after finalization so IDs cannot be reused. Do not delete authoritative records merely to reclaim minimum balance.
- Calculate and document exact box key/value sizes and minimum-balance funding requirements from the compiled layout. Deployment scripts must fund the application account explicitly; tests must not depend on unexplained prefunding.
- Emit stable ABI-decodable logs/events for every authoritative transition needed by the later chain projection.

Minimum provider state:

```text
providerId
ownerAddress
payoutAddress
receiptSigningPublicKey       # exactly 32 bytes
active
stakeTotal
stakeLocked                   # aggregate collateral required by open coverages
openFaultExposure
createdAt
```

Minimum policy state:

```text
policyId
providerId
active
premiumBps
collateralRatioBps
maxCoverageAmount
claimWindowSeconds
createdAt
```

Minimum coverage state:

```text
coverageId
providerId
policyId
payerAddress
grossAmount
providerNetAmount
premiumAmount
stakeTopupAmount              # fixed to zero in the P1 profile
lockedStakeAmount             # immutable per-coverage collateral requirement
requestHash                   # exactly 32 bytes
openedAt
expiresAt
status                        # OPEN, REFUNDED, or CLOSED
exposureReleased
```

Minimum finalized claim state:

```text
claimId
coverageId
approved
approvedAmount
providerFault
resolutionCode
stakeDebit
poolDebit
resolvedAt
```

### Premium arithmetic — resolves D-012

Use integer atomic asset units only:

```text
rawPremium = floor(grossAmount * premiumBps / 10_000)
premium = max(1, rawPremium) when grossAmount > 0 and premiumBps > 0
providerNet = grossAmount - premium
stakeTopup = 0
```

Reject a policy or coverage if these operations cannot be performed without overflow/underflow. Prefer a verified wide-ratio primitive. If the selected compiler API lacks one, constrain policy values so multiplication is provably safe and test the boundary.

### Coverage closure — resolves D-013

- Use explicit `closeCoverage(coverageId)` for P1.
- Anyone may close an `OPEN` coverage only after `expiresAt`.
- Closing releases its exposure and locked stake exactly once and changes status to `CLOSED`.
- Re-closing, closing a refunded coverage, or otherwise releasing exposure twice must fail.
- A finalized approved or rejected claim ends the coverage and releases exposure/locked stake exactly once. Approved claims produce `REFUNDED`; rejected claims produce `CLOSED`.

### Claims authority — resolves D-014

- Use one development adjudicator address configured at application creation.
- Only that address may call `finalizeClaim`.
- The contract, not the adjudicator argument list, chooses the refund receiver from the stored coverage payer.
- Admin and adjudicator may be the same address for the POC, but model them as distinct configured fields.
- Key rotation, multisig, governance, and production custody are out of scope.

### Stake bootstrap — resolves D-015

- P1 uses a separate provider stake deposit before opening coverage.
- `stakeTopupAmount` is fixed to zero in the three-member P0/P1 `assured-exact` coverage profile.
- Do not add a fourth coverage-group member or silently change P0 indices.
- A future sponsored-fee or same-group stake profile must be a separately versioned decision.

## Roles and authorization

- Application creation sets `admin`, `adjudicator`, and the accepted ASA ID. Derive `admin` from the creation sender; validate the adjudicator and ASA configuration.
- `registerProvider` derives `ownerAddress` from the caller. Do not accept an arbitrary owner argument.
- Provider IDs are unique. Registration starts active.
- Only the provider owner may create policies for that provider, deposit attributed stake, withdraw stake, or change its policy status.
- Only admin may pause/unpause the protocol or change provider active status.
- Pausing blocks new provider registration, policy creation, stake deposits, withdrawals, and new coverage. It must not block claim finalization/refunds or safe expiry closure.

## Required contract surface

Exact language-level types may follow Algorand TypeScript constraints, but functionality must map to:

```text
create(acceptedAssetId, adjudicatorAddress)
optInAsset(assetId)

registerProvider(providerId, payoutAddress, receiptSigningPublicKey)
setProviderStatus(providerId, active)

createPolicy(
  policyId,
  providerId,
  premiumBps,
  collateralRatioBps,
  maxCoverageAmount,
  claimWindowSeconds
)
setPolicyStatus(policyId, active)

depositStake(providerId, stakeTransfer)
withdrawStake(providerId, amount)

openCoverage(coverageId, providerId, policyId, requestHash, grossAmount)
closeCoverage(coverageId)

finalizeClaim(
  claimId,
  coverageId,
  approved,
  approvedAmount,
  providerFault,
  resolutionCode
)

setPaused(paused)
```

Add read-only methods needed to test and later integrate without decoding raw boxes manually:

```text
getProvider(providerId)
getPolicy(policyId)
getCoverage(coverageId)
getClaim(claimId)
getAvailableCapacity(providerId, policyId)
getAccounting()
```

If a read-only ABI method is impractical with the compiler, provide a narrowly documented typed-client/query helper instead. Do not create a backend database in P1.

## Stake, collateral, and capacity

### Deposit

Use a two-member atomic group containing an ASA transfer and the application call, or an ABI transaction argument that compiles to the equivalent. Validate:

- caller is the provider owner;
- configured ASA ID;
- sender is the provider owner;
- receiver is the application address;
- amount is positive;
- no asset close, rekey, or unexpected control field;
- the deposit is counted exactly once.

Increase both provider `stakeTotal` and protocol `totalProviderStake`.

### Mixed-policy-safe capacity

For a new coverage under its immutable policy:

```text
coverageLockedStake = ceil(grossAmount * collateralRatioBps / 10_000)
unencumberedStake = stakeTotal - stakeLocked
availableCapacity = floor(unencumberedStake * 10_000 / collateralRatioBps)
```

Require `1 <= collateralRatioBps <= 10_000`, compute without overflow, and require `coverageLockedStake <= unencumberedStake`. Increase `stakeLocked` by the exact per-coverage amount and treat the full gross amount as fault exposure.

This per-coverage lock is deliberately conservative and safe across policies with different collateral ratios. When every coverage uses one ratio, it is equivalent to the POC capacity formula apart from intentional ceiling at the atomic-unit boundary.

### Withdrawal

Only the provider owner may withdraw. Require:

```text
amount > 0
postWithdrawalStake >= stakeLocked
```

Transfer the configured ASA from the application to the stored owner using an inner transaction. Use fee pooling correctly and reject over-balance withdrawals. Update accounting exactly once.

When exposure/locked stake is zero, all provider stake may be withdrawn. With zero resulting capacity, future `openCoverage` calls must fail.

## Coverage group and validation

`openCoverage` must accept only the P0-fixed three-member group:

```text
index 0: payer -> registered provider payout address, providerNet ASA units
index 1: payer -> application address, premium ASA units
index 2: payer calls openCoverage(...)
```

All three transactions are payer-signed and payer-funded. The application call must be at index 2, and group size must be exactly 3.

Derive and validate rather than trusting duplicated arguments:

1. protocol is not paused;
2. provider exists and is active;
3. policy exists, belongs to provider, and is active;
4. coverage ID is unused;
5. both transfers and application call have the same payer/sender;
6. both transfers use the configured ASA;
7. provider receiver equals registered payout address;
8. premium receiver equals application address;
9. no asset close, rekey, or unexpected control fields are present;
10. `grossAmount > 0` and does not exceed policy maximum;
11. premium equals the fixed overflow-safe policy calculation;
12. provider net equals `grossAmount - premium`;
13. provider net plus premium equals gross amount;
14. request hash is exactly 32 bytes and non-zero;
15. provider has capacity for the computed `coverageLockedStake`;
16. expiry is derived from current timestamp plus policy claim window without overflow;
17. stake top-up is recorded as zero.

On success:

- create the coverage record;
- increase provider `openFaultExposure` by gross amount;
- increase provider `stakeLocked` by `coverageLockedStake`;
- increase protocol `totalOpenFaultExposure` by gross amount;
- increase `premiumReserve` by received premium;
- emit a coverage-opened event with projection-critical fields.

The contract validates chain semantics. The P0/P2 `assured-exact` facilitator additionally binds and validates the exact signed group bytes.

## Claim finalization and loss waterfall

`finalizeClaim` must require:

- caller is configured adjudicator;
- claim ID is unused;
- coverage exists and is `OPEN`;
- `approvedAmount <= coverage.grossAmount`;
- rejected claims use `approvedAmount == 0` and `providerFault == false`;
- approved claims use a positive amount;
- `resolutionCode` is a non-zero `uint64` enum value suitable for a fixed record and ABI event.

For every finalization, release the coverage gross exposure and exact `lockedStakeAmount` once.

For an approved non-provider-fault claim:

```text
stakeDebit = 0
poolDebit = approvedAmount
```

For an approved provider-fault claim, consume provider stake first without touching stake still locked for other coverage:

```text
remainingLockedStake = provider.stakeLocked - coverage.lockedStakeAmount
stakeAvailableForThisClaim = provider.stakeTotal - remainingLockedStake
stakeDebit = min(approvedAmount, stakeAvailableForThisClaim)
poolDebit = approvedAmount - stakeDebit
```

Require sufficient tracked pool reserve for `poolDebit` and sufficient actual application ASA balance for the full refund. Decrease provider stake, total provider stake, and pool reserve by their debits. Send one inner ASA transfer for `approvedAmount` to the coverage's stored payer.

Never accept a refund address argument. Another provider's stake must never be attributed to the loss.

For rejected claims, transfer nothing, write the finalized claim, set coverage `CLOSED`, and release exposure/locked stake.

## Accounting invariants

Maintain at minimum:

```text
totalProviderStake
premiumReserve
totalOpenFaultExposure
```

After every financial transition:

```text
provider.stakeLocked <= provider.stakeTotal
sum(open coverage lockedStakeAmount for provider) == provider.stakeLocked
sum(open coverage grossAmount for provider) == provider.openFaultExposure
totalProviderStake + premiumReserve <= actual application ASA balance
```

The physical application balance may exceed tracked liabilities because unsolicited transfers cannot necessarily be prevented; it must never be lower.

## Required events

Emit stable, versioned, ABI-decodable events/logs for at least:

- provider registered/status changed;
- policy created/status changed;
- stake deposited/withdrawn;
- coverage opened/closed;
- claim finalized;
- refund paid;
- protocol pause changed.

Each event must include primary and related IDs, amounts/status, and projection-critical timing. Document exact event signatures in `planning/P1_RESULTS.md`.

## Required tests

Tests must exercise success and failure behavior.

### Provider and policy

- valid and duplicate provider registration;
- invalid payout or receipt key rejection;
- unauthorized provider status change;
- policy owner/provider binding and duplicate rejection;
- invalid bps, maximum, or claim window rejection;
- policy term immutability and status authorization.

### Stake, capacity, and withdrawals

- correct deposit accounting;
- wrong ASA/sender/receiver and unsafe controls rejected;
- capacity boundaries and overflow safety;
- over-withdrawal rejected and valid unencumbered withdrawal succeeds;
- full withdrawal succeeds after exposure release;
- zero capacity rejects later coverage;
- different policy ratios lock and release the correct collateral.

### Coverage and P0 profile

- valid exact three-member group and stored coverage;
- payer/provider/premium deltas;
- premium floor/minimum behavior;
- wrong order or group size rejected;
- wrong payer, receiver, ASA, amount, arithmetic, or app index rejected;
- missing/zero/malformed request commitment rejected;
- duplicate coverage rejected;
- inactive provider/policy and paused protocol rejected;
- rekey and asset-close controls rejected;
- failed app call rolls back both transfers and accounting.

### Closure, claims, and refunds

- closure before expiry rejected;
- expiry closure releases exposure/lock once;
- duplicate release rejected;
- unauthorized adjudicator and duplicate claim rejected;
- rejected claim transfers nothing and closes coverage;
- approved amount cannot exceed gross;
- refund always goes to stored payer;
- non-provider-fault refund uses pool only;
- provider-fault waterfall uses unlocked/released provider stake first and pool remainder;
- other providers' stake is untouched;
- remaining mixed-policy coverage stays collateralized;
- insufficient pool/application balance rejects atomically;
- accounting remains bounded by actual ASA balance;
- pause still permits finalization and expiry closure.

### Property/state-machine coverage

Add deterministic property or state-machine tests for sequences of deposits, coverage opens, withdrawals, closures, and claims. Assert INV-1 through INV-10 after every successful transition, not only at the end.

## Implementation gates

Work sequentially and leave a resumable checkpoint after each gate.

### Gate A — Contract skeleton and storage

- production project compiles;
- typed records/box namespaces/global state exist;
- creation and ASA opt-in work;
- exact storage sizes and MBR are recorded;
- event encoding approach is fixed.

### Gate B — Provider, policy, and stake

- registration/status/policy/deposit methods work;
- capacity reads correctly;
- authorization and negative tests pass.

### Gate C — Coverage profile

- exact P0 three-member group opens stored coverage;
- substitutions and unsafe controls reject;
- capacity and premium rules pass;
- rollback is proven on a real LocalNet group.

### Gate D — Withdrawal, close, claims, and refunds

- withdrawal safety and explicit close work;
- loss waterfall and payer-bound refunds work;
- invariant/state-machine suite passes.

### Gate E — Reproducible LocalNet lifecycle

A script must deploy and prove on a real LocalNet:

1. app funding and ASA opt-in;
2. provider registration and policy creation;
3. stake deposit and reported capacity;
4. successful assured coverage group;
5. insufficient-capacity group rollback;
6. over-withdrawal rejection;
7. approved provider-fault refund to original payer;
8. exposure release and permitted withdrawal;
9. zero-capacity future coverage rejection;
10. final accounting reconciliation.

Record public IDs, balance/state deltas, and intended assertion failures. Mocked tests are not Gate E evidence.

### Gate F — Secret-safe TestNet acceptance

Provide a preflight, mutating runner, compact public result, and read-only evidence verifier. Reuse or extract the P0 Pera ARC-52 signer without copying secrets. Never make the production contract depend on a disposable P0 script.

TestNet must prove the Gate E financial lifecycle using the configured existing TestNet ASA. One user-controlled Pera development account may fill admin/adjudicator/provider/payer roles where separation is immaterial; authorization-negative tests must still use distinct accounts.

P1 is `COMPLETE` only after Gates A–F pass, including real TestNet evidence. If user-controlled TestNet configuration/action is the only missing item, mark P1 `BLOCKED`, not complete.

## Verification commands

Create canonical root commands, with exact names recorded in results:

```text
npm run test:p1
npm run typecheck:p1
npm run build:contract:p1
npm run localnet:p1
npm run testnet:p1 -- --preflight
npm run testnet:p1
npm run testnet:p1 -- --verify-evidence
```

The default test command must never mutate TestNet.

## Deliverables and allowed paths

P1 may create or modify:

```text
contracts/assurance-core/**
planning/P1_RESULTS.md
DECISIONS.md
IMPLEMENTATION_PLAN.md          # status cells only
SESSION_HANDOFF.md
package.json
package-lock.json
.gitignore                      # secret/build-output entries only
```

P1 may read P0 code/results to preserve verified group/signing behavior, but must not modify `spikes/p0-atomic/**` without orchestrator approval for a narrowly documented shared-code extraction.

Do not create `/apps`, `/packages`, backend/database/MinIO infrastructure, provider middleware, evidence encryption, claim REST APIs, or UI in P1.

## Session and commit protocol

At session start, confirm branch, HEAD, and worktree. Do not overwrite unrelated changes.

Before every checkpoint:

1. run verification available for the completed gate;
2. update `planning/P1_RESULTS.md` honestly;
3. update `SESSION_HANDOFF.md` with exact next gate/action;
4. record decisions before depending on them;
5. report changed paths and Git status;
6. commit only when the user's prompt explicitly requests commits.

Never claim mocked, compiler-only, or LocalNet evidence as TestNet evidence.
