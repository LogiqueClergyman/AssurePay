# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: IN_PROGRESS — Gate A ACCEPTED; Gate B READY
- Branch: `main`
- Starting checkpoint: `cd6f036`
- Active packet: `planning/P1_GATE_B_PROVIDER_POLICY_STAKE.md`
- Results: `planning/P1_RESULTS.md`

P0 is complete with real TestNet success and rollback evidence. Its production constraints are recorded in D-010, D-016, D-017, D-018, and D-019. Do not reopen P0 or modify `spikes/p0-atomic/**` during P1 without an orchestrator-approved shared-code extraction.

## P1 scope and gate

Gate A is accepted. The active Luna-sized Gate B packet is self-contained; an implementation session must not read the phase-level packet, the completed Gate A packet, or `/docs`.

P1 proceeds sequentially:

```text
Gate A storage/skeleton
  -> Gate B provider/policy/stake
  -> Gate C coverage profile
  -> Gate D withdrawal/close/claims/refunds
  -> Gate E real LocalNet lifecycle
  -> Gate F real TestNet acceptance
```

P1 is complete only after all six gates pass. A missing user-controlled TestNet action makes the phase `BLOCKED`, not complete.

## Exact next action

Start a fresh Luna session for Gate B only. Read `AGENTS.md`, this handoff, `planning/P1_GATE_B_PROVIDER_POLICY_STAKE.md`, and only the additional files named by that packet. Complete every Gate B exit condition, update results/handoff, and stop before Gate C.

Do not access `/docs`. Do not start P2.

## Gate A review evidence

The orchestrator reproduced `npm run typecheck:p1`, `npm run build:contract:p1`, and `npm run test:p1` (7/7) at `cd6f036` with a clean worktree. Gate A storage sizes, MBR arithmetic, ABI surface, event encoding, authorization, atomic opt-in behavior, and LocalNet evidence satisfy its packet.
