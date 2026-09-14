# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: BLOCKED — Gates A through E ACCEPTED; Gate F implementation is complete but its non-mutating preflight is blocked by missing user-controlled configuration
- Branch: `main`
- Starting checkpoint: `5a50f95` (clean accepted Gate E checkpoint)
- Implementation checkpoint: `f239d2b` (`feat(p1): add secret-safe TestNet acceptance runner`)
- Active packet: `planning/P1_GATE_F_TESTNET_ACCEPTANCE.md`
- Results: `planning/P1_RESULTS.md`

P0 remains complete. Do not modify or import from `spikes/p0-atomic/**`.

## Gate F implementation

- Added the P1-owned opaque Peikert Pera signer under `contracts/assurance-core/src/`; it exposes only an address, transaction signing, disposal, and JSON-safe public identity.
- Added the exact `assured-exact` / `assurance-core-v1` three-member builder, secret-empty P1 environment example, ignored P1 `.env`, TestNet runner, compact evidence writer, historical-fallback public verifier, and deterministic Gate F tests.
- The accepted contract, adapter, generated artifacts, LocalNet runner, and P0 were not modified.

## Verification

- `npm run typecheck:p1` — passed.
- `npm run build:contract:p1` — passed; generated-artifact diff remained empty.
- `npm run test:p1` — passed, `36/36`.
- `npm run localnet:p1` — passed against LocalNet; final observed run remained consistent with accepted lifecycle evidence (`3517` approval bytes, `extraPages=1`, `95` rejected cases, all ten invariants true).
- `npm run testnet:p1 -- --preflight` — safely returned `ok: false`, `phase: configuration`; missing `TESTNET_PAYER_HD_MNEMONIC`, `TESTNET_PAYER_ADDRESS`, `TESTNET_ASA_ID`, and `TESTNET_ALGOD_SERVER`.
- The mutating TestNet command and evidence verifier were not run. No TestNet evidence file was produced.

## Exact next action

Supply the four missing variables through the process environment or ignored `contracts/assurance-core/.env` without exposing them, then rerun `npm run testnet:p1 -- --preflight`. If and only if it passes, run `npm run testnet:p1` once, review its compact public evidence, and run `npm run testnet:p1 -- --verify-evidence` once. Update Gate F records to `REVIEW` only if both real acceptance and read-only verification pass; otherwise retain `BLOCKED` for missing user-controlled prerequisites or `IN_PROGRESS` for an implementation defect.

Do not start P2 or later work. Do not rerun the mutating TestNet command without explicit direction.

## Open blockers

- The P1 TestNet mnemonic, expected derived Pera address, existing ASA ID, and reachable TestNet Algod endpoint are not available to the safe preflight in this session. The preflight did not inspect balances or mutate the network because configuration validation failed first.
