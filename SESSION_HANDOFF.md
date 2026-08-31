# Session Handoff

## Current state

- Phase: P0 — Atomic-group spike
- State: BLOCKED (TestNet external prerequisites only)
- Branch: `main`
- LocalNet implementation checkpoint: `03182e6` (`feat: add reproducible P0 LocalNet proof`).
- Active packet: `planning/P0_CHAIN_READINESS_FIXES.md`
- Results: `planning/P0_RESULTS.md`

Gates A–G local work is complete. Gate E remains mocked-facilitator evidence only; Gate G has genuine LocalNet deployment, success, and rollback evidence. No TestNet work was attempted.

## Verification

```text
npm run test:p0              PASS, 52/52
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
npm run localnet:p0          PASS (real LocalNet evidence)
```

## LocalNet public evidence

- AlgoKit `2.10.2`; Docker `29.4.0`; LocalNet genesis `dockernet-v1`.
- Disposable ASA `1045`; app `1046`; app address `QVP5TVUA6ISFQQAXICQMMQM3G7XCA2X7LQXXRM7VMPCSXT7WSXJ62YY6E4`.
- Confirmed successful `assured-exact` provider member: `6AY6OFQ6IFO43CEBCEWELA5PJMWAYVMWMBSLHTWFWENGLKGQ7QZA`; ASA payer/provider/app `1000/0/0 -> 900/93/7`; marker `opened: 0 -> 1`.
- Deliberately rejected ABI-valid group: `swX5Mc8vAZvkZfX6iik3tmY5tCM4sYwiJyeQ9JswOSM=`; app-call `DD7QBMKJXWWMJ37OTRSQLU2FVYCHEI35JAJ4KIC4GIPILDCEYPTA` rejected by actual LocalNet submission with `TransactionPool.Remember` / assertion failure. ASA balances and marker remained `900/93/7` and `1`.

The mock facilitator simulation-rejection test is not chain evidence. The rejected-group result above is distinct: it was simulated against LocalNet, then submitted to its real transaction pool and rejected; unchanged state proves rollback.

## Exact next action

Obtain TestNet-specific external prerequisites without committing secrets: a funded payer holding the selected ASA, opted-in provider and application, a deployed disposable app opted into that ASA, and endpoint/credential configuration supplied via environment variables. Then run the same profile on TestNet and record public identifiers. Do not begin P1.

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
