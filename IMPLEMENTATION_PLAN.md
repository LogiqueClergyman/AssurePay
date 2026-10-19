# AssurePay EVM implementation plan

Updated 2026-10-18. Target: Base Sepolia, native test USDC, EOA first.

| Phase | State | Work packet | Gate |
|---|---|---|---|
| Baseline cleanup | COMPLETE | `planning/EVM_BASELINE_CLEANUP.md` | EVM-only active tree; archive preserved; results in `planning/EVM_BASELINE_RESULTS.md` |
| M1 Settlement feasibility | IN_PROGRESS | `planning/EVM_M1_SETTLEMENT_SPIKE.md` | Gates A/B complete; Gate C local x402 + bounded runner/recovery pass (105 tests); public attempt and vault normalization approved; native USDC acceptance pending |
| M2 Solidity financial core | NOT_READY | Prepare after M1 acceptance | Registration/policies/stake, pool funding/reservations, withdrawals, claims/expiry and execution invariants |
| M3 Client/provider flow | NOT_READY | Prepare after M2 acceptance | Canonical request encoding, response receipt and real HTTP flow |
| M4 Evidence and claims backend | NOT_READY | Prepare after M3 acceptance | Encrypted evidence, payer workflow, canonical/reorg-safe projection |
| M5 Public MVP acceptance | NOT_READY | Prepare after M4 acceptance | Reproducible scenarios, measured costs and signer-free independent verifier |

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
