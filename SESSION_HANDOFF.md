# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: IN_PROGRESS — Gates A through E ACCEPTED; Gate F needs one evidence-schema correction before TestNet mutation
- Branch: `main`
- Reviewed readiness checkpoint: `c72195e`
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
- Implemented the narrowed readiness correction: the compact schema validates the complete result before an injected writer; exact POC money flow and terminal observations fail closed; rollback/failure matching remains strict; verifier network/ASA/application/group/tombstone/accounting/refund checks are bounded to POC scope; and targeted coverage was added.
- Reproduced typecheck/build with unchanged artifacts, all `47/47` tests, a fresh real LocalNet lifecycle at round `5311` with 95 rejections, and configuration-only preflight. No TestNet mutation, evidence file, populated environment inspection, or later-phase work occurred.
- Orchestrator independently reproduced typecheck/build, **47/47** tests, fresh LocalNet ASA **7388**/app **7389**/round **5509** with 95 intended rejections, and the safe configuration-only preflight. Direct execution found `publicEvidenceSafe({sameSignedBytes: true}) === false`; actual compact rejection records emit that public boolean, so the full evidence write would abort. The representative evidence test omitted rejection records.

## Exact next action

Make one narrow correction in `contracts/assurance-core/scripts/run-testnet.mjs`
and `contracts/assurance-core/test/gate-f.test.mjs`: allow only the exact public
boolean `sameSignedBytes`, continue rejecting signatures/signed blobs, and test
the full representative evidence-write path with all intended-rejection fields
present. Run the existing offline/LocalNet/preflight checks and return a clean
checkpoint for orchestrator review. Do not run the default mutating TestNet
command or evidence verifier, and do not create
`contracts/assurance-core/testnet-evidence.json`.

Do not start P2 or later work. Never access `/docs` or manually read a populated
`.env`.

## External prerequisites after remediation

- The P1 TestNet mnemonic, expected derived Pera address, existing ASA ID, and reachable TestNet Algod endpoint must be available to the corrected preflight through the process environment or ignored P1 `.env`.
- A mutating TestNet acceptance run and evidence verification remain unauthorized until the orchestrator accepts this readiness checkpoint.
