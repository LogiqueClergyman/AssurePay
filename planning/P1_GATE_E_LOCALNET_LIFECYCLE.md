# P1 Gate E Packet — Reproducible LocalNet Lifecycle

## Objective

Turn the already accepted Gates A–D behavior into one coherent, reproducible LocalNet acceptance run. Gate E is an evidence-consolidation gate: it must make the complete financial lifecycle easy to run, inspect, and repeat without changing the accepted contract, ABI, storage, events, or `assurance-core-v1` group profile.

Gate D is accepted at clean commit `1a4260a`. Its independent orchestrator verification passed 26 deterministic tests and a fresh real `dockernet-v1` run with ASA `5350`, app `5351`, 95 intended rejections, matched simulation/pool application identity and PCs, correct claim/withdrawal accounting, and a clean worktree.

## Scope

Implement Gate E only. Do not start Gate F/TestNet, P2, backend, UI, governance, key rotation, fee sponsorship, or infrastructure work.

The current `npm run localnet:p1` runner already proves the component behaviors. Reuse and consolidate it. Do not create a second competing lifecycle runner and do not replay or import the disposable P0 implementation.

## Authority and accepted baseline

Follow, in order:

1. `AGENTS.md`;
2. this packet;
3. accepted decisions D-010 through D-021 in `DECISIONS.md`;
4. the accepted Gate D record and Gate E section in `planning/P1_RESULTS.md`;
5. the P1 status cell in `IMPLEMENTATION_PLAN.md`.

Do not access `/docs`. Do not modify `spikes/p0-atomic/**`.

Preserve all accepted behavior:

- scheme `assured-exact`, profile `assurance-core-v1`;
- exactly `[provider ASA transfer, premium ASA transfer, application call]`;
- payer-signed and payer-funded three-member groups with no fourth member;
- immutable signed bytes between verification, simulation, and submission;
- configured ASA only and integer atomic-unit accounting;
- stored provider owner/payout and stored payer destinations;
- one-time exposure release and permanent coverage/claim tombstones;
- provider-fault stake/pool waterfall without touching other providers or other locked coverage;
- `extraPages=1` while the compiled approval remains between 2,049 and 4,096 bytes.

## Required Gate E lifecycle

One invocation of `npm run localnet:p1` must deploy fresh state and prove, in a clearly identified `gateE` result object, this ordered lifecycle:

1. create the application with the configured development adjudicator;
2. fund its ALGO minimum-balance needs and opt it into the freshly created ASA;
3. register the selected provider and create the immutable policy or policies used by the lifecycle;
4. deposit provider stake through the real two-member atomic deposit group;
5. read and record the resulting provider stake, locked stake, exposure, and policy capacity;
6. open coverage through a successful real `@x402/core` `assured-exact` group;
7. prove an otherwise-valid insufficient-capacity group fails in simulation, is never submitted by the facilitator, is rejected when the identical signed bytes are sent to the real pool, and rolls back every transfer and state mutation;
8. prove an over-withdrawal or lock-crossing withdrawal rejects with complete rollback;
9. approve a genuine provider-fault claim, apply a non-trivial stake/pool waterfall, and refund exactly the stored original payer while preserving unrelated collateral;
10. release exposure through the accepted terminal transition and perform a permitted withdrawal;
11. fully withdraw a chosen released provider to zero capacity, then prove a later otherwise-valid assured coverage group rejects atomically;
12. reconcile all final provider boxes, open coverage boxes, global accounting, and the physical application ASA holding.

Existing Gate A–D setup and scenarios may supply these steps. Gate E does not require forcing every step through one provider if the accepted runner uses isolated providers to prove conflicting states. The `gateE` summary must identify which provider/coverage supplies each step so the composition is honest and reviewable.

## Canonical public evidence

Add one compact top-level `gateE` object to the runner output. It must contain only public data and must map the twelve steps above without requiring a reviewer to reconstruct them from the older `gateC` and `gateD` objects.

At minimum include:

- network/genesis ID, final round, ASA ID, application ID/address, approval byte length, and `extraPages`;
- application creation, funding, ASA opt-in, provider registration, policy creation, and stake-deposit transaction IDs;
- provider/policy/coverage IDs used by the consolidated lifecycle;
- capacity before coverage, after coverage, and after the final full withdrawal;
- successful assured group ID, all three member transaction IDs, confirmation round, and exact payer/provider/application ASA deltas;
- exact provider/global lock, exposure, stake, and premium-reserve deltas for the successful coverage;
- insufficient-capacity simulation reason, facilitator submission count, simulation/pool application IDs and PCs, same-signed-bytes assertion, and complete rollback result;
- rejected withdrawal classification, simulation/pool application IDs and PCs, and complete rollback result;
- claim and refund transaction IDs, stored payer, approved amount, stake debit, pool debit, payer/application ASA deltas, and protected unrelated-provider/coverage result;
- terminal release and permitted/full-withdrawal transaction IDs and exact state/balance deltas;
- zero-capacity simulation/pool application IDs and PCs, facilitator submission count, same-signed-bytes assertion, and complete rollback result;
- final `totalProviderStake`, `premiumReserve`, `totalOpenFaultExposure`, physical application ASA balance, provider-sum reconciliation, exposure-sum reconciliation, and invariant flags 1–10.

Do not hard-code ephemeral ASA IDs, application IDs, rounds, transaction IDs, timestamps, group IDs, or assertion PCs. Extract them from the current run. Assertion PCs are fingerprints for a compiled run, not permanent protocol constants.

Never print signed transaction blobs, signatures, secret keys, mnemonics, tokens, KMD exports, populated environment values, full simulation objects, or full pending-transaction objects.

## Evidence strength

For every intended application rejection:

- construct fresh valid-round transactions;
- simulate the exact signed bytes that will be submitted;
- require the simulation to identify the deployed application and intended assertion PC/message;
- require zero facilitator submissions for simulation rejection;
- submit the identical signed bytes directly to the real LocalNet pool;
- require the pool error to identify the same deployed application and assertion PC/message;
- reject transport, endpoint, malformed-request, unrelated resource, and validity-round errors;
- compare complete before/after snapshots.

For an intentionally resource-shaped failure, match its exact resource class plus deployed application/PC and use the same signed bytes.

A complete rollback snapshot must cover all relevant payer/provider/application ALGO and ASA balances, application minimum balance, provider/policy/coverage/claim boxes, global state, and any newly addressed box that must remain absent.

## Reproducibility requirement

Run `npm run localnet:p1` twice consecutively against the same running LocalNet without resetting or deleting prior chain state between runs.

Both runs must pass and independently create fresh ASA/application IDs. The second run must not depend on IDs, rounds, timestamps, boxes, or balances emitted by the first. Record compact run-one and run-two identity summaries in `planning/P1_RESULTS.md`; the detailed Gate E evidence may use the second/final run.

If LocalNet is unavailable, start it using the already established repository/AlgoKit workflow when safe. Do not redesign infrastructure. If the container engine itself is unavailable, record the exact external blocker and leave Gate E `BLOCKED`.

## Deterministic regression

Preserve all 26 accepted Gate A–D tests. Add narrowly scoped deterministic tests only if needed for new Gate E evidence-shaping or extraction logic. Do not duplicate the accepted financial state-machine suite merely to increase the test count.

The build must reproduce committed artifacts exactly. Gate E should not change:

```text
contracts/assurance-core/contract/assurance-core.algo.ts
contracts/assurance-core/adapter/assured-exact.mjs
contracts/assurance-core/artifacts/**
```

If consolidation exposes a real defect requiring one of those changes, document the exact defect in `SESSION_HANDOFF.md` and stop for orchestrator review rather than silently reopening an accepted gate.

## Required commands

Run in this order:

```text
npm run typecheck:p1
npm run build:contract:p1
npm run test:p1
npm run localnet:p1
npm run localnet:p1
```

After the build, require a clean diff for generated artifacts.

## Records and status

Update `planning/P1_RESULTS.md`:

- change Gate E from `NOT_STARTED` to `REVIEW` only after both consecutive real LocalNet runs pass;
- record both run identities and the final run's compact lifecycle evidence;
- distinguish real chain evidence from deterministic/model evidence;
- record any deviation precisely without revising an accepted decision silently.

Rewrite `SESSION_HANDOFF.md` with Gate E in `REVIEW` and the exact next action: orchestrator review. Do not mark Gate F ready and do not create or run a TestNet path.

## Allowed modifications

```text
contracts/assurance-core/scripts/run-localnet.mjs
contracts/assurance-core/test/**          # only if evidence helper tests are needed
planning/P1_RESULTS.md
SESSION_HANDOFF.md
IMPLEMENTATION_PLAN.md                    # P1 status cell only
package.json                              # only if the canonical command genuinely needs correction
package-lock.json                         # only if package.json requires it; no dependency upgrades
```

Do not modify the accepted contract, adapter, generated artifacts, earlier P1 packets, P0, `/docs`, `/apps`, `/packages`, or `/infra`.

## Exit condition

Gate E passes only when one canonical real-LocalNet command exposes the complete lifecycle in a compact `gateE` object; every success and rejection is tied to current-run public evidence; final accounting and invariants reconcile; two consecutive runs pass without reset or stale-state dependence; Gates A–D remain green; generated artifacts remain unchanged; records are accurate; commits are focused; and the worktree is clean.

Stop after Gate E even if time remains.
