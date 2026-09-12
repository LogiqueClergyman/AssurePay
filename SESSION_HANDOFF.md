# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: READY
- Branch: `main`
- Starting checkpoint: `886a08d2daf808d2e6e6b303afe4cf8a515d6fb2`
- Active packet: `planning/P1_GATE_A_STORAGE.md`
- Results: `planning/P1_RESULTS.md`

P0 is complete with real TestNet success and rollback evidence. Its production constraints are recorded in D-010, D-016, D-017, D-018, and D-019. Do not reopen P0 or modify `spikes/p0-atomic/**` during P1 without an orchestrator-approved shared-code extraction.

## P1 scope and gate

The phase-level P1 packet fixes the complete contract model and gates. The active Luna-sized Gate A packet is self-contained; an implementation session must not read the phase-level packet or `/docs`.

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

Start a fresh P1 implementation session:

1. Read `AGENTS.md`, this handoff, `planning/P1_GATE_A_STORAGE.md`, `DECISIONS.md`, and `IMPLEMENTATION_PLAN.md`. Do not read the phase-level P1 packet.
2. Confirm branch, HEAD, and worktree without modifying unrelated work.
3. Implement Gate A only: production contract scaffold, typed storage namespaces, creation/ASA opt-in, event encoding, compiled layout, exact box MBR calculations, and Gate A tests.
4. Update `planning/P1_RESULTS.md` and this handoff before proceeding or stopping.

Do not access `/docs`. Do not start P2.

## Planning worktree

The orchestrator created the P1 packet and handoff after the P0 closing commit. Confirm whether these planning changes are committed before starting implementation. Create commits only when the user's implementation prompt explicitly requests them.
