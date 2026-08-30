# Session Handoff

## Current state

- Phase: P0 — Atomic-group spike
- State: READY
- Branch: `main`
- Reviewed implementation commit: `abec4d2`
- Active packet: `planning/P0_ASSURED_EXACT_CONTINUATION.md`
- Prior spike results: `planning/P0_RESULTS.md`
- Orchestrator review: `planning/P0_REVIEW.md`

The current `@x402/avm` 2.24.0 `exact` facilitator rejects the required signed application-call group before simulation or submission. D-010 therefore selects a dedicated `assured-exact` scheme. That finding is useful but does not complete P0.

## Next action

Execute the continuation packet. Implement the smallest local `assured-exact` client/facilitator path that validates, simulates, and submits the complete assurance group without patching `node_modules`. Harden the disposable contract, repair the canonical test command, and produce real LocalNet atomicity evidence if a LocalNet endpoint can be started.

Do not start P1 or build the production Assurance Core, provider SDK, claims backend, database, evidence system, or UI.

## Review findings that must be addressed

1. `npm run test:p0` references a missing Vitest configuration and currently fails.
2. Nine of the ten current tests exercise only the JavaScript mirror validator.
3. No LocalNet deployment, success transaction, or atomic rollback has occurred.
4. The contract accepts any non-empty commitment instead of a 32-byte SHA-256 commitment.
5. The contract does not yet bind the application-call sender to the asset-transfer payer or reject an application-call rekey.
6. The three-transaction fixed layout does not specify how optional facilitator fee abstraction changes indices.

## Environment notes

- Docker CLI is installed, but its configured daemon was not running during orchestration review.
- AlgoKit CLI was not installed or available on `PATH` during review.
- TestNet execution will eventually require funded and opted-in accounts, a selected POC ASA, a funded/deployed application opted into that ASA, and an accessible facilitator/network endpoint.
- Never record secret keys or mnemonics in the repository.

## Required reading for the next session

Read only:

1. `AGENTS.md`
2. `SESSION_HANDOFF.md`
3. `planning/P0_ASSURED_EXACT_CONTINUATION.md`
4. `planning/P0_REVIEW.md`
5. `planning/P0_RESULTS.md`
6. `DECISIONS.md`
7. `IMPLEMENTATION_PLAN.md`

Do not access `/docs`.

## End-of-session requirement

Update the result, decision, plan, and handoff files named by the active packet. Record commands and actual outputs, distinguish mocked integration from chain execution, and state the exact next action or external prerequisite.
