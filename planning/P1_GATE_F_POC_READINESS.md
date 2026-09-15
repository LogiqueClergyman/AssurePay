# P1 Gate F — POC TestNet Readiness Correction

## Goal and stopping point

At clean code checkpoint `4237d18`, the Gate F runner has a fatal evidence-path
bug and a few checks that record outcomes without asserting them. Fix those
before the first real TestNet run. This is a **POC readiness pass**, not a
production security audit or an exhaustive archival-verifier build.

Do not run the mutating TestNet command in this session. Return one clean,
reviewable checkpoint after offline/LocalNet checks and non-mutating preflight.

## Instructions and boundaries

Read `AGENTS.md`, this packet, then the parent
`planning/P1_GATE_F_TESTNET_ACCEPTANCE.md`, D-010 through D-021 in
`DECISIONS.md`, and the Gate F section of `planning/P1_RESULTS.md`.

This packet narrows the previous audit wish-list to the minimum evidence needed
for the POC. Preserve the parent's actual TestNet exit condition: real x402
three-member settlement, intended simulation and pool rejection using identical
signed bytes with rollback, stake-plus-pool refund to stored payer, final chain
accounting, and a secret-free read-only verifier. Keep its secret and mutation
safety rules.

Never access `/docs` or manually read a populated `.env`. Never print or commit
mnemonics, keys, tokens, signatures, signed bytes, raw pending/simulation data,
or environment objects. Do not alter the accepted contract, adapter, signer,
builder, artifacts, LocalNet runner, P0, package dependencies, or later phases.

Allowed edits:

```text
contracts/assurance-core/scripts/run-testnet.mjs
contracts/assurance-core/test/gate-f.test.mjs
planning/P1_RESULTS.md
SESSION_HANDOFF.md
IMPLEMENTATION_PLAN.md                    # P1 status cell only
```

## Must fix before TestNet

1. **Evidence can actually be written safely.** The current validator rejects
   the runner's own compact `simulationReason` and
   `simulationResponsesNotRecorded` fields. Make one explicit compact public
   evidence schema and a validator that accepts an exact representative result
   while rejecting raw simulations/pending responses, secrets, signatures,
   signed blobs, binary arrays, and known runtime mnemonic/token values under
   innocent keys. Validate the complete result *before* file write. Test this
   exact path with a write stub or injected seam; a mere unit test of isolated
   key names is insufficient.

2. **Assert the POC money flow.** Fail closed if observed TestNet data differs
   from the planned scenario: pre-coverage capacity `164`; exactly one real
   x402 submission/confirmation; successful ASA deltas payer `−100`, provider
   `+50`, app `+50`; provider lock/exposure `+75/+100`; reserve/exposure
   `+50/+100`; open coverage stores the configured IDs, payer, gross/net/
   premium/lock and status. After claim, assert a finalized provider-fault
   tombstone, exactly one inner refund of `100` to the stored payer, stake/pool
   debits `75/25`, and unchanged unrelated-provider collateral `10/0/0`.
   After withdrawing `48`, assert primary provider `0/0/0`, a fresh capacity
   read of `0`, and final globals/app ASA `10/25/0/35`. Include the added
   capacity-read fee in preflight. Require refunded coverage release, both
   tombstones present, and rejected coverage boxes absent. Do not hard-code
   final invariant flags. Tighten the current `terminalReleaseFlags`,
   `permanentIds`, and `storedPayerRefunds` predicates to use those observations.

3. **Keep rejection evidence strict.** Preserve the current signed-byte,
   deployed-app/defined-PC, simulation+pool, and full rollback checks for
   insufficient capacity, locked withdrawal, authorization, and zero capacity.
   Endpoint, rate-limit, stale-round, resource, overspend, signature, and
   minimum-balance errors must not be classified as intended rejections. Add
   targeted fake-client tests for an undefined PC, wrong app, differing PC,
   endpoint failure, and changed box/MBR/balance rollback snapshot.

4. **Make the read-only verifier credible, not encyclopedic.** Verify expected
   Algorand TestNet CAIP-2/genesis, existing ASA metadata, app address/schema/
   committed approval identity, the three successful x402 member IDs in one
   exact group/round, creation and claim application-call IDs/rounds, current
   two provider boxes, coverage/claim tombstones, app holding, globals, and
   final liability sum. Verify the claim inner refund if publicly available;
   distinguish a precise `PUBLIC_EVIDENCE_REFUND_UNAVAILABLE` from a mismatch
   when endpoint history is pruned. Keep pending lookup and historical-block
   fallback for the successful group, binding the *specific* transaction ID
   to its group. Label pool rejection/rollback as acceptance-time evidence.
   Do not require verification of every setup/funding transaction or build a
   universal archival decoder for this POC.

5. **Targeted tests only.** Keep all 43 current P1 tests green. Add tests for
   the complete evidence-write path, each monetary/terminal predicate above,
   one full fake-client happy verifier path plus wrong group/round, refund
   mismatch/unavailable, and non-mutating preflight/verifier modes. Do not grow
   an exhaustive permutation matrix merely to increase the test count.

## Verification and handoff

Run:

```text
npm run typecheck:p1
npm run build:contract:p1
npm run test:p1
npm run localnet:p1
npm run testnet:p1 -- --preflight
git diff --exit-code -- contracts/assurance-core/artifacts
git diff --check
```

Preflight may stop at missing user configuration. Do not run
`npm run testnet:p1`, do not create `testnet-evidence.json`, and do not claim
real TestNet proof. Update `planning/P1_RESULTS.md` and `SESSION_HANDOFF.md`.
Use focused commits because the user's Luna-session prompt explicitly requests
them. Report HEAD, changed paths, commands, preflight result, and clean status.
Stop at readiness `REVIEW`; only the orchestrator can authorize the one real
TestNet attempt and accept P1.
