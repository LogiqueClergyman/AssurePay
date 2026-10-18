# Session handoff

Date: 2026-10-19. Branch: `evm/restart`.
Current phase: M1 settlement feasibility — IN_PROGRESS.
Active packet: `planning/EVM_M1_SETTLEMENT_SPIKE.md`.
Results: `planning/EVM_M1_RESULTS.md`.
Gate A commit: `5126ccf`. Gate B commit: `07957e5`.
Gate C local registration/execution: PASS. Public proof: PENDING.

## Current state

The isolated `spikes/evm-m1/` package compiles unchanged pinned Solidity and
passes strict typechecking plus 78 tests. Actual SDK client/resource server/
self-hosted facilitator executes on Anvil before service. Receipt and public
proof readers check canonical transaction/event/state, pre/post balances and
rollback. Signed bytes and payer signatures remain in memory. The public
configuration parser and exclusive/fsynced public journal are implemented.
The original Gate A rejecting facilitator remains only a negative fixture.

Primary verified delegated Luna(high) work, corrected SDK spend-control and
JSON-wire issues, and reproduced actual EVM results. No public transaction or
full financial core/provider/stake/pool/claim system exists yet. This is a
scoped spike review, not a production security audit.

## Exact next action

Finish and verify `src/public-runner.ts`, `scripts/public-run.ts` and
`scripts/verify-public.ts` with bounded execution and read-only restart recovery.
The assigned Luna agent is implementing those paths; preserve its in-progress
work. Then update results/handoff and commit the verified preparation checkpoint.

Runtime funded payer/relayer and explicit bounded public execution scope remain
prerequisites. Do not manually inspect populated envs/private backups. Follow
EVM-009/010: four fixed transactions, locally derived hashes durably recorded
before broadcast, existing sessions recovery-only, exact total funding of a
dedicated relayer and no concurrent use/funding. Auxiliary fees are not capped
by EIP-1559. Default commands must remain non-mutating.

User authorizes verified checkpoint commits and sequential Luna(high)
delegation; no push or history amendment. No `/docs` access is needed. Do not
start M2 until native public USDC evidence satisfies M1.
