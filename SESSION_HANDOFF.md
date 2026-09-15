# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: IN_PROGRESS — Gates A through E ACCEPTED; the single authorized Gate F TestNet mutation was attempted and failed; a focused secret-safe execution-stage diagnostic now reports allowlisted stages and confirmed public progress, but Gate F remains unaccepted and the exact capacity-read failure/unconfirmed submission status remain unknown
- Branch: `main`
- Reviewed readiness checkpoint: current focused evidence-schema correction; readiness checks and TestNet preflight passed, but acceptance did not complete
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
- Applied only the focused correction: the public-safety validator allows the exact boolean `sameSignedBytes` while continuing to reject signatures and signed blobs. The representative full evidence-write fixture now includes every intended-rejection record and proves the complete writer path; a signed-material mutation is rejected before write.
- Reproduced typecheck, build, **47/47** tests, fresh LocalNet, and configuration-only preflight with no TestNet mutation and no evidence file.
- Sequential Gate F verification on 2026-09-15: typecheck, contract build, **47/47** tests, fresh real LocalNet, generated-artifact diff, and `git diff --check` all passed. The first sandboxed TestNet preflight was endpoint-blocked; the identical non-mutating preflight with network access passed for TestNet genesis `testnet-v1.0`, existing ASA **10458941** (`USDC`, 6 decimals), expected/derived payer `G5V2CFA6OELV6YN6RRABZUAJJAFRLUNG6VC3UHPKP2S3UVPHT64OV3BYYU`, **8,284,000** spendable microAlgos, and **19,999,900** payer ASA atomic units. The explicitly authorized mutating command `npm run testnet:p1` ran exactly once and returned only sanitized `phase=execution`, `code=TESTNET_EXECUTION_FAILED`; the failing sub-stage and whether any transaction confirmed are unknown. No public TestNet IDs were emitted and no `contracts/assurance-core/testnet-evidence.json` was created; this absence does not establish that no TestNet mutation occurred. The read-only verifier was not run because the mutation failed and incomplete evidence must not be verified. No retry is authorized without fresh user authorization.
- Read-only ledger confirmation for the failed attempt: application creation produced app **771803281** at round **67328911** through public transaction `6WJW4UEM46QTYTE7DXGZSLRJT75Y77TFXQ64J5MAVRPZVT45ELA`. The last confirmed payer-signed action was the unrelated deposit group at round **67328937**, application-call ID `F5ZKDLUVE6X6BFCQJ7TXNBM3AUBE4HQ6ZKRPPKDH6BSX7X2GVM4A` and ASA-transfer ID `WRKJA6ABSYUH4IPEVNPNKI6JW6HZCIRL5CUIBEKSBQCSM3R4E63Q`, group `o6WHRD/odyowK43SWKZvsDe71+J/i6HSAsCCxPz7SUI=`. No later confirmed payer-sent transaction was found. The next runner operation was the capacity read; its exact parameter/construction/signing/submission/confirmation/decoding failure point and any unconfirmed submission remain unknown.
- Implemented focused diagnostic checkpoint: the runner reports allowlisted stages `capacity-read.parameter-retrieval`, `capacity-read.construction-signing`, `capacity-read.submission`, `capacity-read.confirmation`, and `capacity-read.return-decoding`; unknown exceptions remain generic and partial failure may include only validated public transaction IDs/rounds/groups. Offline tests pass **48/48**; typecheck, contract build, real LocalNet at round **5905** with **95** rejected cases, generated-artifact diff, and `git diff --check` all pass. No TestNet command, endpoint query, preflight, verifier, evidence file, retry, or P2 work occurred in this session. This is diagnostic instrumentation only, not a functional fix.

## Exact next action

Review the focused diagnostic checkpoint and the recorded public partial
progress. The one authorized mutating run has been consumed; do not retry and
do not run the TestNet preflight, endpoint queries, or evidence verifier. The
orchestrator must determine the next action and provide fresh explicit
authorization before any further TestNet mutation. Do not create
`contracts/assurance-core/testnet-evidence.json` manually.

Do not start P2 or later work. Never access `/docs` or manually read a populated
`.env`.

## External prerequisites after remediation

- The TestNet configuration and funding preflight passed for ASA **10458941** and the expected/derived public payer address; no configuration deficit was identified.
- The mutation failed before any successful Gate F evidence was produced. Public ledger checks establish application creation at app **771803281**, round **67328911**, and progress through the unrelated deposit group at round **67328937**; no later confirmed payer-sent transaction was found. The exact capacity-read failure stage and whether an unconfirmed submission exists are unknown. Gate F evidence is unavailable; verifier execution is intentionally pending and any further TestNet action requires fresh user authorization.
- Do not start P2 or later work. Never access `/docs` or manually read a populated `.env`.
