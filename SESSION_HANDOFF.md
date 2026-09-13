# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: IN_PROGRESS — Gates A and B ACCEPTED; Gate C READY; Gates D–F NOT_STARTED
- Branch: `main`
- Starting checkpoint: `d0582fa`
- Active packet: `planning/P1_GATE_C_COVERAGE.md`
- Results: `planning/P1_RESULTS.md`

P0 is complete with real TestNet success and rollback evidence. Do not reopen P0 or modify `spikes/p0-atomic/**`. D-020 defines the production Gate C ABI/metadata binding while preserving the P0-proven `assured-exact` three-member order and payer-paid fees.

## Accepted baseline

Gate A storage/configuration/ASA opt-in and Gate B provider/policy/pause/stake/capacity behavior are accepted. The orchestrator reproduced all required commands, including 13/13 deterministic tests and a fresh real LocalNet Gate B run with 48 rejected rollback cases. There is no unresolved Gate B blocker.

Preserve the fixed records and box namespaces, especially the 193-byte coverage value at `0x63 || coverageId`, and do not change accepted ABI or events. Keep provider collateral safe across mixed policies by storing and aggregating each coverage's exact ceiling-rounded `lockedStakeAmount`.

## Gate C assignment

Implement only `planning/P1_GATE_C_COVERAGE.md`. The gate adds the production `openCoverage`/`getCoverage` path, a narrowly scoped `assurance-core-v1` adapter registered through real `@x402/core`, overflow-safe premium/collateral arithmetic, immutable coverage storage, premium/exposure/lock accounting, comprehensive failures, and real LocalNet x402 success plus actual-pool rollback.

Do not implement Gate D withdrawals, closure, claims, or refunds. Do not implement TestNet, P2 SDK/middleware, UI, backend, or infrastructure.

## Exact next action

Start a fresh Luna/high implementation session from this handoff. Read only the files permitted by the active packet, confirm clean `main` at the committed orchestration successor to `d0582fa`, implement Gate C, run all four required P1 commands, update the named records, make focused commits as explicitly requested, and stop with Gate C in `REVIEW`.
