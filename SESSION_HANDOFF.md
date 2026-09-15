# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: IN_PROGRESS — Gates A through E ACCEPTED; Gate F requires a focused POC readiness correction before TestNet mutation
- Branch: `main`
- Reviewed remediation checkpoint: `4237d18`
- Active packet: `planning/P1_GATE_F_POC_READINESS.md`
- Parent packet: `planning/P1_GATE_F_TESTNET_ACCEPTANCE.md`
- Results: `planning/P1_RESULTS.md`

P0 remains complete. Do not modify or import from `spikes/p0-atomic/**`.

## Orchestrator audit

- Confirmed the Gate F commit touched only its approved P1 runner, signer, builder, tests, configuration example/ignore, package command, and records.
- Confirmed no populated `.env` or secret file is tracked.
- Reproduced `npm run typecheck:p1`, `npm run build:contract:p1`, and all `36/36` deterministic tests; generated artifacts stayed unchanged.
- Reproduced a fresh accepted `npm run localnet:p1` lifecycle at ASA `6566`, app `6567`, round `4816`, with 95 intended rejections and all accepted LocalNet invariants.
- Reproduced the non-mutating P1 preflight stopping at configuration before network access.
- Reviewed the first remediation implementation at `4237d18`. R1–R5 materially improved the exact budgets/funding, authorization rejection, rollback snapshots, and independent collateral fixture.
- Reproduced typecheck/build with unchanged artifacts, all `43/43` tests, a fresh real LocalNet lifecycle at ASA `7035`, app `7036`, round `5212` with 95 rejections, and the safe configuration-only preflight.
- Directly reproduced a fatal evidence-path mismatch: `publicEvidenceSafe()` returns false for the runner's own `simulationReason` and `simulationResponsesNotRecorded` fields, so a successful TestNet run would abort before writing evidence.
- Found remaining evidence-path and POC outcome-assertion gaps. The active packet now narrows the correction to executable evidence safety, exact money/terminal checks, strict intended rejection, a credible read-only verifier, and targeted tests. Exhaustive setup-transaction verification and production-style archival decoding are deferred beyond POC scope.

## Exact next action

Implement `planning/P1_GATE_F_POC_READINESS.md` from clean checkpoint
`4237d18`. Run its full offline, build, deterministic, LocalNet, and
configuration-only preflight verification. Do not run the default mutating
TestNet command or the evidence verifier; return the clean POC-readiness
checkpoint for orchestrator review first.

Do not start P2 or later work. Never access `/docs` or manually read a populated
`.env`.

## External prerequisites after remediation

- The P1 TestNet mnemonic, expected derived Pera address, existing ASA ID, and reachable TestNet Algod endpoint must be available to the corrected preflight through the process environment or ignored P1 `.env`.
- A mutating TestNet acceptance run remains unauthorized until the orchestrator accepts the remediation checkpoint.
