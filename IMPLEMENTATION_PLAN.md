# AssurePay EVM implementation plan

Updated 2026-10-22. Target: Base Sepolia, native test USDC, EOA first.

| Phase | State | Work packet | Gate |
|---|---|---|---|
| Baseline cleanup | COMPLETE | `planning/EVM_BASELINE_CLEANUP.md` | EVM-only active tree; archive preserved; results in `planning/EVM_BASELINE_RESULTS.md` |
| M1 Settlement feasibility | ACCEPTED | `planning/EVM_M1_SETTLEMENT_SPIKE.md` | All gates pass: native public USDC settlement/rollback, independent signer-free recovery, compile/typecheck and105 tests |
| M2 Solidity financial core | ACCEPTED | `planning/EVM_M2_FINANCIAL_CORE.md` | Implemented; pinned compile/typecheck, 15 actual-EVM scenarios, solvency/isolation invariants and independent scoped review pass; results in `planning/EVM_M2_RESULTS.md` |
| M3 Client/provider flow | ACCEPTED | `planning/EVM_M3_HTTP_FLOW.md` | Typecheck and 28 tests pass, including actual local EVM/HTTP recovery, receipt and failure cases; results in `planning/EVM_M3_RESULTS.md` |
| M4 Evidence and claims backend | ACCEPTED | `planning/EVM_M4_EVIDENCE_CLAIMS.md` | Encrypted results/evidence, authenticated claim/decision prep and canonical/reorg-safe projection; 16 backend + 28 M3 regression tests pass; results in `planning/EVM_M4_RESULTS.md` |
| M5 Public MVP acceptance | ACCEPTED under EVM-037 | `planning/EVM_M5_PUBLIC_ACCEPTANCE.md` | Second native-USDC campaign completes14steps; signer-free financial proof/costs, both refunds, paused included revert and48tests pass. First partial run preserved; `planning/EVM_M5_RESULTS.md` |

Only one phase is active. The baseline design has been reviewed with the user;
its mechanism candidates still require feasibility evidence. M1 may choose a
better EVM mechanism and update decisions before freezing schemas or starting
dependent code. No previous technical implementation constrains this choice.

A phase is accepted only when its deliverables, required tests and live proofs
exist, material decisions are recorded, and the handoff states the exact next
action and any unresolved blocker. Simulation, a model or a local fixture does
not substitute for a gate that explicitly requires actual public settlement.

Do not add production UI, governance, risk/actuarial models, subjective AI
adjudication, commerce execution, multiple chains/assets or mainnet deployment.

M1–M5 core MVP gates are complete. No dependent phase is active. Define any next
phase from explicit product requirements in a self-contained packet before
implementation; existing campaign approvals are consumed and authorize no further
public mutation. Production hosting/UI and other excluded work remain outside scope.
