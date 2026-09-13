# P1 Gate C Packet — Assured Coverage Opening

## Objective

Extend the accepted Gate B contract with coverage admission through the P0-proven, payer-funded `assured-exact` three-transaction group. Store the immutable coverage record, lock the exact collateral required by its policy, account for premium reserve and fault exposure, and prove atomic success and rollback on real LocalNet.

This packet is self-contained. Do not read `planning/P1_ASSURANCE_CORE.md`, earlier gate packets, or anything under `/docs`.

Implement Gate C only. Do not implement stake withdrawal, expiry closure, claims, refunds, TestNet execution, backend code, provider middleware, browser UI, or the general P2 client SDK.

## Starting point and allowed context

- Gate B closing commit: `d0582fa` or the committed orchestration successor.
- Gates A and B are accepted. Preserve their ABI, storage layouts, box prefixes, accounting fields, events, pause behavior, deposit profile, and capacity behavior.
- P0 is complete. Do not modify or import production code from `spikes/p0-atomic/**`.
- Reuse pinned toolchain and x402 versions; do not broadly upgrade dependencies.

Read only `AGENTS.md`, `SESSION_HANDOFF.md`, this packet, `DECISIONS.md`, `IMPLEMENTATION_PLAN.md`, `planning/P1_RESULTS.md`, and existing `contracts/assurance-core/**`.

## Frozen status values and ABI

Use these coverage status values and keep them stable for later gates:

```text
OPEN     = 1
REFUNDED = 2
CLOSED   = 3
```

Gate C implements only `OPEN`.

Add:

```text
openCoverage(coverageId, providerId, policyId, requestHash, grossAmount)
getCoverage(coverageId)
```

All IDs and `requestHash` are fixed `byte[32]`. `getCoverage` is read-only, returns the complete accepted `CoverageRecord`, and rejects a missing record clearly.

Use the existing coverage box key exactly:

```text
0x63 || coverageId   # 33-byte key, 193-byte value, 92,900 microAlgo MBR
```

The caller supplies provider, policy, and coverage box references. A missing/wrong reference fails without state changes. Coverage records are permanent tombstones; a coverage ID can never be reused.

## Production assured-exact profile

D-020 defines the P1 production binding while retaining P0's accepted scheme and group shape.

The group is exactly:

```text
index 0: payer -> stored provider payout address, accepted ASA, providerNet
index 1: same payer -> current application address, accepted ASA, premium
index 2: same payer calls openCoverage(...)
```

There is no fourth member, fee payer, same-group stake top-up, or provider signature. The payer signs and funds all three members. The application call must be `NoOp` at index 2.

Implement a minimal Gate C assured-exact adapter/harness under `contracts/assurance-core/**`; do not import from or change the spike. It must register with the real `@x402/core/facilitator` under scheme `assured-exact`, simulate, and submit the exact immutable signed bytes it verified.

Use x402 v2 requirements with:

```text
scheme: "assured-exact"
asset: canonical decimal accepted ASA ID
amount: canonical decimal grossAmount
extra.profile: "assurance-core-v1"
extra.provider: stored payout address
extra.applicationAddress: current application address
extra.applicationId: canonical decimal app ID
extra.providerNet: canonical decimal providerNet
extra.premium: canonical decimal premium
extra.coverageId: canonical base64 byte[32]
extra.providerId: canonical base64 byte[32]
extra.policyId: canonical base64 byte[32]
extra.requestCommitment: canonical base64 byte[32], equal to requestHash
```

Payload indices remain `providerIndex=0`, `premiumIndex=1`, and `applicationIndex=2`, with exactly three base64 signed transactions.

The adapter must reject before simulation/submission:

- malformed or non-canonical requirements/payload fields;
- wrong network, scheme, profile, indices, group size, role, ordering, or group ID;
- missing, malformed, multisig, logic-sig, wrong-key, or invalid signatures;
- unequal payer senders;
- wrong ASA, transfer receivers, amounts, app ID, selector, ABI arguments, or request hash;
- non-`NoOp` application call;
- any transfer `assetSender`, `assetCloseTo`, or rekey, and application-call rekey;
- `providerNet + premium != gross`.

Decode and bind the exact Gate C ABI selector and all five arguments. Treat the verified signed byte arrays as an immutable snapshot: simulation and submission must receive byte-for-byte identical arrays even if the caller later mutates its payload object. Keep stable error categories for payload, group, role, signature, binding, simulation, submission, and confirmation.

This adapter is a narrow Gate C integration seam, not the full P2 client SDK. Avoid unrelated HTTP or wallet abstractions.

## Contract validation

`openCoverage` must validate all of the following before writing:

1. protocol is unpaused and application ASA opt-in is complete;
2. application call has zero rekey, group size is exactly three, and call index is exactly two;
3. `coverageId`, `providerId`, `policyId`, and `requestHash` are non-zero;
4. coverage box is unused;
5. provider exists and is active;
6. policy exists, is active, and belongs to the supplied provider;
7. both ASA transfers and the app call have the same sender; that sender becomes the stored payer;
8. index 0 is an ASA transfer to the provider record's stored payout address;
9. index 1 is an ASA transfer to the current application address;
10. both transfers use the configured accepted ASA;
11. both transfers have zero asset sender/clawback, close-to, and rekey; the app call has zero rekey;
12. `grossAmount > 0` and `grossAmount <= policy.maxCoverageAmount`;
13. premium and provider net equal the policy-derived amounts below;
14. provider stake state is valid and has enough unencumbered stake for the exact coverage lock;
15. provider/global additions and expiry calculation cannot overflow;
16. after receiving the premium, `totalProviderStake + newPremiumReserve <= actual application ASA balance`.

Do not accept integer transaction indices as ABI arguments and do not add caller-supplied premium, provider net, payer, expiry, status, or collateral amounts. They are derived from the policy, transactions, sender, and confirmed timestamp.

## Overflow-safe arithmetic

Use AVM biguint arithmetic, not wrapping uint64 multiplication.

```text
rawPremium = floor(grossAmount * premiumBps / 10_000)
premium = max(1, rawPremium)
providerNet = grossAmount - premium

lockedStake = ceil(grossAmount * collateralRatioBps / 10_000)
            = floor((grossAmount * collateralRatioBps + 9_999) / 10_000)
```

Because `1 <= premiumBps <= 10_000`, premium never exceeds positive gross. A one-unit gross may therefore produce premium `1` and provider net `0`; the fixed provider transfer remains present with amount zero. Do not invent a higher minimum gross.

Because `1 <= collateralRatioBps <= 10_000`, locked stake is positive and no greater than gross. Require:

```text
stakeTotal >= stakeLocked
lockedStake <= stakeTotal - stakeLocked
```

Use checked uint64 additions for `stakeLocked`, provider `openFaultExposure`, global `totalOpenFaultExposure`, `premiumReserve`, and `openedAt + claimWindowSeconds`. Deterministic tests must cover floor premium, the one-unit minimum, ceiling collateral, maximum uint64 gross with representative bps, exact-capacity acceptance, and one-unit-insufficient rejection.

## Successful state transition

At confirmed `openedAt = Global.latestTimestamp`, compute checked `expiresAt = openedAt + claimWindowSeconds` and write exactly one `CoverageRecord`:

```text
providerId
policyId
payerAddress          = common group sender
grossAmount
providerNetAmount     = derived providerNet
premiumAmount         = derived premium
stakeTopupAmount      = 0
lockedStakeAmount     = derived lockedStake
requestHash
openedAt
expiresAt
status                = OPEN (1)
exposureReleased      = false
```

Then atomically:

- increase provider `stakeLocked` by `lockedStake`;
- increase provider `openFaultExposure` by `grossAmount`;
- increase global `totalOpenFaultExposure` by `grossAmount`;
- increase global `premiumReserve` by `premium`;
- leave provider/global total stake unchanged;
- emit the already-frozen event exactly:

```text
CoverageOpened(
  uint64 version,
  byte[32] coverageId,
  byte[32] providerId,
  byte[32] policyId,
  address payer,
  uint64 grossAmount,
  uint64 providerNet,
  uint64 premium,
  byte[32] requestHash,
  uint64 openedAt,
  uint64 expiresAt
)
```

Use event version `1`. The stored `lockedStakeAmount`, status, and `stakeTopupAmount=0` remain available from `getCoverage`; do not change the frozen event signature.

## Required deterministic tests

Preserve all Gate A/B tests. Add tests for:

- exact ABI, status constants, record construction, complete read, and event encoding/decoding;
- floor/minimum premium and ceiling lock arithmetic, including uint64 boundaries without wrap;
- successful state-model transition and accounting conservation;
- two successful coverages under policies with different collateral ratios, proving `stakeLocked` is the sum of their immutable per-coverage locks and capacity updates safely;
- duplicate/zero IDs, zero request hash, missing records/boxes, provider-policy mismatch, inactive provider/policy, paused state, pre-opt-in, max-coverage breach, invalid stake state, insufficient capacity, and every checked-overflow path;
- exact group size/order/index, common sender, receiver, ASA, derived amounts, `NoOp`, and all unsafe fields;
- canonical production-profile metadata and every ABI argument bound by the adapter;
- signed-byte rejection matrix for each group role and all three signatures;
- x402 registration, simulation-before-submission, immutable prepared bytes, and distinct simulation/submission/confirmation failures;
- every failure leaves balances, provider/policy/coverage boxes, and global accounting unchanged in the model.

Deterministic tests must not require LocalNet.

## Required real LocalNet proof

Extend `npm run localnet:p1` and keep prior Gate A/B behavior green. On real `dockernet-v1`:

1. create/configure/opt in the app, register a provider, create at least two active policies with different collateral ratios, and deposit stake;
2. explicitly fund the additional 92,900 microAlgo coverage-box MBR and verify the observed minimum-balance delta;
3. build and payer-sign the exact production `assured-exact` group;
4. settle the successful group through a real `x402Facilitator().register(...).settle(...)` call, not a direct SDK shortcut;
5. verify all three confirmed transaction IDs/group ID, exact payer/provider/application ASA deltas, stored coverage fields, decoded event, provider locked stake/exposure, global exposure, premium reserve, unchanged total stake, and updated capacity;
6. open a second coverage under the other ratio and prove mixed-policy lock summation;
7. construct a distinct validly signed group that fails specifically for one-unit-insufficient capacity; show x402 simulation rejection and no facilitator submission;
8. separately submit those same signed bytes to the real transaction pool, require the intended application assertion failure, and prove atomic rollback: payer/provider/application ASA and ALGO balances, all relevant boxes, and all accounting remain unchanged;
9. exercise representative on-chain negatives for duplicate ID, wrong payout/amount/ASA/sender/order/group size, zero request hash, inactive provider/policy, paused, unsafe fields, and missing box references. Identify the intended assertion where practical rather than accepting any generic error.

LocalNet output must be compact public evidence only: network/genesis, IDs, group/transaction IDs, MBR and balance/state deltas, named rejection results, and counts. Never print signed blobs, secret keys, mnemonics, tokens, or full pending/simulation responses.

## Commands and records

All must pass:

```text
npm run typecheck:p1
npm run build:contract:p1
npm run test:p1
npm run localnet:p1
```

Update `planning/P1_RESULTS.md` Gate C with the ABI/profile, arithmetic evidence, observed coverage MBR, public chain IDs, exact state/balance deltas, mixed-policy locks, x402 settlement evidence, actual-pool rollback evidence, commands, and deviations.

If an implementation discovery changes the frozen ABI/profile or an accepted decision, stop and record the conflict; do not silently improvise.

Rewrite `SESSION_HANDOFF.md` with Gate C in `REVIEW` and the exact next action. Do not mark Gate D ready and do not begin it.

## Allowed modifications

```text
contracts/assurance-core/**
planning/P1_RESULTS.md
SESSION_HANDOFF.md
DECISIONS.md                    # implementation facts only; no silent decision changes
IMPLEMENTATION_PLAN.md          # P1 status cell only
package.json
package-lock.json
.gitignore                      # necessary entries only
```

Do not modify P0, earlier P1 packets, `/docs`, `/apps`, `/packages`, or `/infra`.

## Exit condition

Gate C passes only when the exact production assured-exact group opens correct immutable coverage, wide arithmetic and mixed-policy locking are proved, all accounting invariants hold, the real x402-registered LocalNet success path works, a real pool rejection proves atomic rollback, Gates A/B remain green, records are current, commits are focused, and the worktree is clean.

Stop after Gate C even if time remains.
