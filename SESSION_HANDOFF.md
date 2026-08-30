# Session Handoff

## Current state

- Phase: P0 — Atomic-group spike
- State: IN_PROGRESS
- Branch: `main`
- Code checkpoint: `9ef5308` (`test: complete P0 signed-byte rejection matrix`).
- Active packet: `planning/P0_CHAIN_READINESS_FIXES.md`
- Results: `planning/P0_RESULTS.md`
- Review record: `planning/P0_REVIEW.md`

Gate E is complete. The `assured-exact` suite has direct signed-byte negative coverage for every case listed in the `ca4f664` review section. All pre-settlement failures assert a stable error reason, simulation count, and zero submission count. Mocked facilitator tests remain explicitly non-chain evidence.

## Verified commands

```text
npm run test:p0              PASS, 52/52
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
```

## LocalNet evidence

- Official AlgoKit CLI verified: `algokit, version 2.10.2`.
- The current official recommended installer URL served `404: Not Found`; the official supported pipx fallback installed the CLI.
- `algokit doctor` reports Docker 29.4.0 and Docker Compose 5.1.2.
- `algokit localnet start` was attempted and failed: `Container engine isn't running; please start it.` No LocalNet deployment, transaction, balance, success, or rollback evidence exists.
- No TestNet attempt or evidence exists.

## Exact next action

Start the Docker container engine, then rerun `algokit localnet start` using `/Users/adi/Library/Application Support/pipx/venvs/algokit/bin/algokit`. Once LocalNet is live, execute the remaining P0 packet’s genuine deployment, accepted-group, rejected-group, transaction-ID, and balance/rollback checks. Do not claim mocked tests as chain evidence and do not begin P1.

## Fee abstraction

D-016 and D-017 remain accepted: P0 is a fixed caller-paid `[provider axfer, premium axfer, appl]` group and rejects an explicit fourth member.

## Required reading

Read only:

1. `AGENTS.md`
2. `SESSION_HANDOFF.md`
3. `planning/P0_CHAIN_READINESS_FIXES.md`
4. `planning/P0_REVIEW.md`
5. `planning/P0_RESULTS.md`
6. `DECISIONS.md`
7. `IMPLEMENTATION_PLAN.md`

Do not access `/docs`.
