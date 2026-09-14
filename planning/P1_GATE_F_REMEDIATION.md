# P1 Gate F Remediation — TestNet Acceptance Runner

## Objective

Remediate the Gate F implementation at clean checkpoint `05542f9` before any
TestNet mutation. The initial implementation is secret-safe and its
configuration-first stop was correct, but an orchestrator audit found scenario,
funding, rejection-proof, invariant, verifier, and deterministic-test gaps.

Gate F remains `IN_PROGRESS`. Do not run the default mutating TestNet command in
this remediation session. Stop after the corrected non-mutating preflight and
all offline/LocalNet verification pass.

## Authority and boundaries

Follow, in order:

1. `AGENTS.md`;
2. this packet;
3. `planning/P1_GATE_F_TESTNET_ACCEPTANCE.md`;
4. D-010 through D-021 in `DECISIONS.md`;
5. the Gate F section of `planning/P1_RESULTS.md`.

Never access `/docs`. Never manually read a populated `.env`; the runner may
load it only through normal runtime configuration. Never print or commit a
mnemonic, key, signature, signed bytes, token, header, raw environment, pending
response, or simulation response.

Do not modify the accepted contract, adapter, generated artifacts, LocalNet
runner, P0, or later phases. Preserve the three-member `assured-exact` /
`assurance-core-v1` profile and the P1-owned opaque Pera signer boundary.

## Audit findings that must be fixed

### R1 — Exact scenario ASA budget

The current preflight reports only `gross 100 + margin 10 = 110` ASA units, but
the payer must hold the scenario's stake deposit(s) plus the successful coverage
gross before any later refund or withdrawal returns ASA.

Derive `requiredAsaUnits` from named scenario components. For the current primary
path it is at least `primary stake 123 + successful gross 100 + margin 10`, and
it must also include any unrelated-provider collateral added for R5. Report the
complete equation in compact preflight output and test every term.

### R2 — Exact ALGO funding and fee budget

The current run sends an initial `450,400` microAlgo application payment that
already includes all four box MBRs, then sends another `92,900` and `45,300` for
coverage and claim boxes. This creates `138,200` unexplained excess funding and
makes the preflight underestimate the actual run.

Fund each obligation exactly once and immediately before it is required. A
clear acceptable shape is:

- application base plus ASA holding: `200,000`;
- each provider box: `67,300`;
- policy box: `44,900`;
- coverage box: `92,900`;
- claim box: `45,300`.

If R5 adds an unrelated provider box, include its exact `67,300` MBR. The
application funding total, actual payments, evidence reconciliation, and
preflight budget must be identical. Do not rely on the conservative margin to
hide a missing line item.

Derive transaction fees from a named planned-transaction table, including every
explicit `2,000` pooled-fee application call. Avoid counting fees twice inside
ephemeral funding and a separate payer budget. Report payer-paid transaction
fees, ephemeral-account funding, margin, and the final conservative spendable
requirement as a checkable equation.

### R3 — Authorization-negative account and proof

The authorization-negative account currently receives `101,000` microAlgos but
signs a `2,000`-fee transaction. That can fail minimum-balance validation before
the contract's `provider owner only` assertion.

Fund it sufficiently for its retained `100,000` minimum balance and the exact
fee. Simulate and directly submit the same signed bytes. Require both failures
to be application assertions for the current deployed application with the same
defined PC. Snapshot complete relevant public state before/after and prove
rollback. Do not label an arbitrary pool rejection as `authorization`.

### R4 — Strict rejection classification and rollback

For insufficient-capacity, withdrawal, zero-capacity, and authorization
negatives, require all of the following before accepting evidence:

- simulation and pool classifications are `application-assertion`;
- both application IDs equal the deployed app;
- both PCs are defined and equal;
- the exact same signed byte arrays are used for simulation and pool submission;
- all relevant ALGO/ASA balances, app global state, provider/policy/coverage/
  claim boxes, application MBR, and expected absence of rejected boxes are
  unchanged.

Endpoint, timeout, rate-limit, stale-round, malformed, signature, overspend,
minimum-balance, and unrelated-resource errors must fail the runner with a
sanitized stable public code.

### R5 — Genuine unrelated-collateral proof

The current scenario has only one provider and one successful coverage, so its
provider-fault claim cannot prove that unrelated collateral is preserved.

Add the smallest real independent collateral fixture. Prefer a second provider
record owned by the payer with a small real stake deposit and no unnecessary
policy/coverage. Snapshot its box and physical/global contribution across the
primary provider-fault claim and assert it is unchanged. Include its box MBR,
stake ASA, transactions, and final accounting in preflight and evidence. The
primary provider must still be fully withdrawable after its claimed coverage is
released, and its later otherwise-valid zero-capacity group must still fail.

### R6 — Computed lifecycle assertions and evidence safety

Do not write ten invariant flags as literal `true`. Calculate and assert the
required success deltas, capacity, locks/exposure/reserve, claim waterfall,
stored-payer refund, unrelated collateral, release, withdrawal, box states,
global sums, physical ASA liability, tombstones, and final zero capacity from
observed chain data. Abort with a sanitized stable code if any expected value or
invariant fails.

Run `publicEvidenceSafe(evidence)` before writing `testnet-evidence.json`. Expand
evidence validation beyond forbidden key names so tests prove that secret or
signed material cannot survive in ordinary-looking serializable fields. Keep
the checked-in artifact compact and public-only.

### R7 — Read-only verifier completeness

Strengthen the verifier so it cannot accept internally inconsistent evidence:

- pending proofs must require the exact recorded confirmation round;
- historical fallback must associate each recorded transaction ID itself with
  the expected group, rather than finding an unrelated group in the same block;
- prove all three successful group members share the recorded group and round;
- verify recorded application calls and other essential successful transaction
  IDs/rounds, not only the coverage group;
- require deployed schema and approval-program identity instead of skipping a
  missing program field;
- verify terminal provider records (including unrelated collateral), coverage
  and claim tombstones, globals, app ASA holding, and recorded reconciliation;
- verify the claim inner refund through pending data or historical block payset
  when available, and return a precise unavailable code when neither source can
  prove it;
- retain explicit acceptance-time-only labeling for rejected transactions that
  never entered a block.

The verifier remains mnemonic-free, read-only, and driven solely by the single
checked-in evidence file plus endpoint configuration.

### R8 — Deterministic test matrix

The ten new Gate F tests do not cover the packet's required branches. Add
deterministic, non-mutating tests for:

- every budget component/equation and exact funding schedule;
- missing/invalid config, mnemonic/address mismatch before network access;
- wrong network, unreachable endpoint, absent ASA, missing opt-in, insufficient
  spendable ALGO, insufficient ASA, and approval-size/page mismatch;
- environment precedence without exposing values;
- strict application/PC rejection matching and rejection of undefined PCs,
  endpoint/rate-limit/stale-round/overspend/unrelated-resource failures;
- complete rollback snapshots including box absence/presence and application
  minimum balance;
- computed invariants and failure-before-evidence-write behavior;
- compact evidence schema and secret/signed/private value exclusion;
- verifier success, exact-round mismatch, wrong-group-on-same-block, program/
  schema/ASA/app/box/accounting/refund mismatch, and historical fallback;
- proof that `npm run test:p1`, `--preflight`, and `--verify-evidence` cannot call
  a mutating entry point.

Use exported pure helpers and injected fakes where needed. Do not weaken the 26
accepted tests or merely assert source-code strings.

## Allowed modifications

```text
contracts/assurance-core/scripts/run-testnet.mjs
contracts/assurance-core/src/assured-exact.mjs
contracts/assurance-core/src/pera-hd-signer.mjs
contracts/assurance-core/test/gate-f.test.mjs
contracts/assurance-core/.env.example
planning/P1_RESULTS.md
SESSION_HANDOFF.md
IMPLEMENTATION_PLAN.md                    # P1 status cell only
package.json                              # only if the existing Gate F command needs correction
package-lock.json                         # only if package.json genuinely requires it
.gitignore                                # P1 .env entry only
```

Do not create `testnet-evidence.json` without a successful real TestNet run.

## Required verification and stopping point

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

The preflight may load the ignored P1 `.env` normally. Do not display its
contents. Regardless of whether it passes after remediation, do **not** run
`npm run testnet:p1` in this session. The orchestrator must review the corrected
checkpoint before authorizing the one mutating TestNet acceptance run.

Update `planning/P1_RESULTS.md` and `SESSION_HANDOFF.md` accurately. Leave Gate F
`REVIEW` only for the remediation implementation itself, not for TestNet
acceptance; P1 remains incomplete. Create focused commits because the user's
session prompt explicitly requests them, report final HEAD/commits/verification/
preflight status/changed paths/Git status, and stop without starting P2.
