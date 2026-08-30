# Session Handoff

## Current state

- Phase: P0 — Atomic-group spike
- State: IN_PROGRESS
- Branch: `main`
- Reviewed continuation HEAD: `1305e95`
- Active packet: `planning/P0_CHAIN_READINESS_FIXES.md`
- Results: `planning/P0_RESULTS.md`
- Review record: `planning/P0_REVIEW.md`

The local `assured-exact` path is registered through `@x402/core`, uses canonical Algorand SDK ABI transactions, and cryptographically verifies all three payer signatures. No LocalNet/TestNet evidence exists.

## Verified commands

```text
npm run test:p0              PASS, 18/18
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
```

These results cover unit and mocked-network integration only.

## Exact next action

Complete the remaining Gate E negative-test matrix, then install AlgoKit using its official uv installer (`curl -fsSL https://cli.algokit.io/install.sh | bash`) and attempt LocalNet. Do not claim mocked tests as chain evidence.

After the correctness gate passes, install the official AlgoKit CLI using a supported distribution, start LocalNet, and obtain genuine success/rollback balance evidence. Do not use the nonexistent `@algorandfoundation/algokit-cli` npm package again.

## Fee abstraction

D-016 remains the caller-paid three-transaction base profile. D-017 is accepted: the installed AVM path uses an optional fee payer only when `extra.feePayer` is supplied.

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

## External prerequisites

- Docker CLI is installed and the implementation session reported the daemon available.
- AlgoKit CLI is not installed.
- TestNet still requires funded/opted-in accounts, a selected POC ASA, a funded/deployed application opted into that ASA, and credentials supplied only through environment variables.

Do not mark P0 blocked until every safe local correctness and LocalNet task has been exhausted.
