# P1 Gate B Packet — Provider, Policy, Stake, and Capacity

## Objective

Extend the accepted Gate A contract with provider registration/status, immutable policy creation/status, pause control, provider stake deposits, and mixed-policy-safe capacity reads.

This packet is self-contained. Do not read `planning/P1_ASSURANCE_CORE.md`, the completed Gate A packet, or anything under `/docs`.

Implement Gate B only. Do not implement coverage opening, withdrawals, closure, claims, refunds, TestNet runners, backend code, or SDKs.

## Starting point and allowed context

- Gate A closing commit: `cd6f036` or the committed orchestration successor.
- Gate A storage layouts, prefixes, global schema, creation, ASA opt-in, reads, and events are accepted and must remain compatible.
- Do not modify `spikes/p0-atomic/**`.
- Reuse pinned toolchain versions; do not broadly upgrade dependencies.

Read only `AGENTS.md`, `SESSION_HANDOFF.md`, this packet, `DECISIONS.md`, `IMPLEMENTATION_PLAN.md`, `planning/P1_RESULTS.md`, and existing `contracts/assurance-core/**`.

## IDs, boxes, and mutation rules

All IDs are non-zero `byte[32]`. Use the accepted keys exactly:

```text
provider: 0x70 || providerId   # 33 bytes
policy:   0x6c || policyId     # 33 bytes
```

Required box references must be supplied by callers. Missing/wrong references fail without state changes. Do not scan boxes or add dynamic IDs.

Every state-changing application call in Gate B must reject non-zero `rekeyTo`. Every rejected operation must leave boxes, accounting, ALGO, and ASA balances unchanged.

## Pause control

Implement `setPaused(paused: bool)`:

- admin only;
- reject rekey;
- require requested state differs from current state;
- emit `ProtocolPauseChanged(uint64,bool)`, version `1`;
- while paused, reject registration, policy creation/status, provider status, and deposits;
- pausing itself changes no entity/accounting state.

Do not add admin rotation.

## Providers

Implement:

```text
registerProvider(providerId, payoutAddress, receiptSigningPublicKey)
setProviderStatus(providerId, active)
getProvider(providerId)
```

Registration requires:

1. not paused and no rekey;
2. non-zero provider ID and unused provider box;
3. owner derived from `Txn.sender`, never an argument;
4. non-zero payout address;
5. exactly 32-byte, non-zero receipt signing public key;
6. `active=true`, `stakeTotal=0`, `stakeLocked=0`, `openFaultExposure=0`;
7. `createdAt` from confirmed block timestamp;
8. exactly one `ProviderRecord` write;
9. `ProviderRegistered(uint64,byte[32],address,address,byte[32],uint64)` containing version, ID, owner, payout, receipt key, timestamp.

`setProviderStatus` is admin-only, requires not paused, existing provider, and a real change. It changes only `active` and emits `ProviderStatusChanged(uint64,byte[32],bool)`. Deactivation must not alter stake or policies.

`getProvider` is read-only and returns the complete fixed record; missing provider fails clearly.

## Policies

Implement:

```text
createPolicy(policyId, providerId, premiumBps, collateralRatioBps,
             maxCoverageAmount, claimWindowSeconds)
setPolicyStatus(policyId, active)
getPolicy(policyId)
```

Creation requires:

1. not paused and no rekey;
2. non-zero policy/provider IDs;
3. provider exists, is active, and caller is stored owner;
4. unused policy ID;
5. `1 <= premiumBps <= 10_000`;
6. `1 <= collateralRatioBps <= 10_000`;
7. positive maximum coverage and claim window;
8. `active=true` and current timestamp;
9. `PolicyCreated(uint64,byte[32],byte[32],uint64,uint64,uint64,uint64,uint64)` in the accepted field order.

Do not impose invented global maxima. Gate C performs overflow-safe arithmetic.

Only stored provider owner may change policy status. Require not paused, both records, and a real change. Change only `active`, keep economic terms immutable, and emit `PolicyStatusChanged(uint64,byte[32],bool)`.

`getPolicy` returns the complete fixed record; missing policy fails clearly.

## Stake deposit

Use exactly this two-member atomic profile, preferably through a typed ABI ASA-transfer transaction argument:

```text
index 0: provider owner -> application, accepted ASA, positive amount
index 1: same owner calls depositStake(providerId, transfer reference)
```

Do not accept only an ordinary integer transfer index or amount.

Validate:

1. not paused; application ASA opt-in complete;
2. exact group size/order;
3. provider exists, active, and caller is owner;
4. transfer sender equals owner and application caller;
5. receiver is current application address;
6. asset equals stored accepted ASA;
7. amount is positive;
8. zero asset sender/clawback, asset close-to, and transfer rekey-to;
9. zero application-call rekey-to;
10. provider/global additions cannot overflow;
11. increase provider `stakeTotal` and global `totalProviderStake` by exactly the transfer amount;
12. leave `stakeLocked` and `openFaultExposure` unchanged;
13. tracked total provider stake remains no greater than actual application ASA balance after receipt;
14. emit `StakeDeposited(uint64,byte[32],uint64,uint64)` with version, provider ID, amount, and new provider stake.

Any failure rolls back transfer and accounting. Do not implement withdrawal.

## Capacity

Implement `getAvailableCapacity(providerId, policyId) -> uint64`.

Require both records and policy-provider ownership. It may report arithmetic capacity while inactive/paused; Gate C separately checks eligibility.

```text
unencumberedStake = stakeTotal - stakeLocked
availableCapacity = floor(unencumberedStake * 10_000 / collateralRatioBps)
```

Never wrap. Use verified wide arithmetic. If the mathematical result exceeds uint64, return max uint64. Document the primitive and saturation behavior.

Gate B does not create locked stake. Test non-zero locked stake with a pure/model helper or non-production fixture; do not add a production mutation that fabricates it.

## Box MBR evidence

Extend LocalNet proof to create one provider and two policies. Explicitly fund the application for box MBR and verify observed minimum-balance increases:

```text
provider: 67,300 microAlgos
policy:   44,900 microAlgos each
```

Keep funding visible and distinguish balance from minimum balance.

## Required tests

Preserve Gate A tests and add deterministic plus real LocalNet coverage.

### Pause

- admin pause/unpause and decoded event;
- non-admin and no-op rejected;
- all Gate B mutations blocked while paused without changes.

### Provider

- registration/read/event/observed MBR;
- duplicate/zero ID and zero payout/key rejected;
- owner derived from sender;
- unauthorized status rejected;
- deactivate/reactivate changes only status;
- missing/wrong box references fail safely.

### Policy

- create/read/event/observed MBR;
- duplicate/zero ID and missing provider rejected;
- non-owner and inactive provider rejected;
- bps `0` and `10_001`, zero maximum, and zero window rejected;
- owner status changes preserve terms;
- policy/provider binding and box references enforced.

### Deposit and capacity

- valid deposit changes application ASA balance, provider stake, and global stake equally;
- decoded event and duplicate-group replay rejection;
- wrong group size/order, sender, receiver, ASA, zero amount, asset sender, close-to, transfer rekey, and app rekey rejected;
- failures preserve balances and accounting;
- inactive/missing provider, non-owner, paused, and pre-opt-in deposit rejected;
- capacity covers representative ratios, rounding, non-zero locked model, zero unencumbered, and uint64 saturation;
- provider/policy mismatch rejected;
- tracked stake never exceeds actual application ASA balance.

Negative chain tests should identify the intended assertion where practical, not accept any generic pool error.

## Commands and evidence

All must pass:

```text
npm run typecheck:p1
npm run build:contract:p1
npm run test:p1
npm run localnet:p1
```

Deterministic tests must not require LocalNet. LocalNet output must be compact public evidence only—no secrets, signed blobs, or full pending responses.

Update `planning/P1_RESULTS.md` Gate B with ABI/events, arithmetic, observed MBR, public chain IDs, stake/capacity deltas, rollback evidence, commands, and deviations.

Rewrite `SESSION_HANDOFF.md` with Gate B in `REVIEW` and the exact next action. Do not mark Gate C ready.

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

Gate B passes only when provider, policy, pause, deposit, capacity, negative cases, and rollback pass deterministic tests and a real reproducible LocalNet run. Gate A remains green, records are current, commits are focused, and worktree is clean.

Stop after Gate B even if time remains.
