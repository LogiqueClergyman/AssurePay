# Session Handoff

## Current state

- Phase: P0 — Atomic-group spike
- State: IN_PROGRESS
- Branch: `main`
- Reviewed continuation HEAD: `1305e95`
- Active packet: `planning/P0_CHAIN_READINESS_FIXES.md`
- Results: `planning/P0_RESULTS.md`
- Review record: `planning/P0_REVIEW.md`

The local `assured-exact` scaffold is registered through `@x402/core`, and all currently declared commands pass. It is not yet safe or chain-ready, and no LocalNet/TestNet evidence exists.

## Verified commands

```text
npm run test:p0              PASS, 17/17
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
```

These results cover unit and mocked-network integration only.

## Exact next action

Execute `planning/P0_CHAIN_READINESS_FIXES.md` in the same Terra implementation chat. Correct signature verification, ABI transaction construction, transaction-ID handling, prepared-group immutability, structured malformed-input handling, dependency declaration, and the missing negative tests before attempting LocalNet deployment.

After the correctness gate passes, install the official AlgoKit CLI using a supported distribution, start LocalNet, and obtain genuine success/rollback balance evidence. Do not use the nonexistent `@algorandfoundation/algokit-cli` npm package again.

## Fee abstraction

D-016 defines a fee-paying three-transaction base profile and excludes a fee-payer member. D-017 remains open: determine whether the actual POC facilitator path requires fee abstraction. If it does, D-016 must be superseded and the contract/client/facilitator profile updated together. Do not defer an actually required fee path to a later phase.

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
