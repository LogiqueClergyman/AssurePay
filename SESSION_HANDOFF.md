# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: IN_PROGRESS — Gates A through E ACCEPTED; Gate F READY
- Branch: `main`
- Starting checkpoint: `5a50f95` (clean accepted Gate E checkpoint)
- Active packet: `planning/P1_GATE_F_TESTNET_ACCEPTANCE.md`
- Results: `planning/P1_RESULTS.md`

P0 remains complete. Do not modify or import from `spikes/p0-atomic/**`.

## Accepted baseline

Gates A–E are accepted. The production contract, `assurance-core-v1` adapter, deterministic financial state machine, and canonical LocalNet lifecycle are green. Gate E's public result accurately maps approved refunds to their claim-call inner ASA transfers, reconciles all five application ALGO funding payments, and reconstructs global stake from all provider deposits, withdrawals, and claim debits.

Independent Gate E acceptance reproduced 26/26 tests, a clean build/artifact diff, and consecutive `dockernet-v1` runs at ASA/app/round `6214/6215/4519` and `6331/6332/4618`. Both produced 95 intended rejections, final accounting `198/29/100/227`, and all ten invariants.

## Gate F assignment

Implement only `planning/P1_GATE_F_TESTNET_ACCEPTANCE.md`: P1-owned opaque Pera signer, non-mutating preflight, one explicit real TestNet acceptance lifecycle, compact checked-in public evidence, and read-only evidence verification.

Do not read populated `.env` files manually or expose secrets. Do not start P2, backend, UI, governance, MainNet, or infrastructure. Do not change the accepted contract, adapter, artifacts, or LocalNet runner.

## Exact next action

Start a fresh Luna/high implementation session from the committed orchestration successor to `5a50f95`. Implement the active packet through safe preflight. Run the mutating TestNet command only if preflight passes. Create focused commits only when the user prompt explicitly requests them, then stop with Gate F accurately `REVIEW`, `BLOCKED`, or `IN_PROGRESS`.

## Open decisions or blockers

Gate F's mutating path requires the user's ignored P1 TestNet environment, funded Pera address, existing ASA holding, and reachable TestNet endpoint. The runner must discover and report these through preflight without exposing them.
