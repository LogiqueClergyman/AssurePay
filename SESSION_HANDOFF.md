# Session Handoff

## Current phase

- Phase: P1 — On-chain Assurance Core
- State: READY
- Branch: `main`
- Starting checkpoint: `d133edc4a055163fa8e5dd3904bb4e57f9c45072`
- Active packet: `planning/P1_ASSURANCE_CORE.md`
- Results: `planning/P1_RESULTS.md`

P0 is complete with real TestNet success and rollback evidence. Its production constraints are recorded in D-010, D-016, D-017, D-018, and D-019. Do not reopen P0 or modify `spikes/p0-atomic/**` during P1 without an orchestrator-approved shared-code extraction.

## P1 scope and gate

The P1 packet is self-contained and fixes the contract model, P0-compatible coverage group, premium arithmetic, separate stake bootstrap, explicit expiry closure, payer-bound refund, safe provider-first loss waterfall, accounting rules, event requirements, negative tests, and LocalNet/TestNet acceptance.

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

1. Read `AGENTS.md`, this handoff, `planning/P1_ASSURANCE_CORE.md`, `DECISIONS.md`, and `IMPLEMENTATION_PLAN.md`.
2. Confirm branch, HEAD, and worktree without modifying unrelated work.
3. Implement Gate A only: production contract scaffold, typed storage namespaces, creation/ASA opt-in, event encoding, compiled layout, exact box MBR calculations, and Gate A tests.
4. Update `planning/P1_RESULTS.md` and this handoff before proceeding or stopping.

Do not access `/docs`. Do not start P2.

## Planning worktree

The orchestrator created the P1 packet and handoff after the P0 closing commit. Confirm whether these planning changes are committed before starting implementation. Create commits only when the user's implementation prompt explicitly requests them.
