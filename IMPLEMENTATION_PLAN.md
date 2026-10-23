# AssurePay EVM implementation plan

Updated 2026-10-23. Target: Base Sepolia, native test USDC, EOA first.

| Phase | State | Work packet | Gate |
|---|---|---|---|
| Baseline cleanup | COMPLETE | `planning/EVM_BASELINE_CLEANUP.md` | EVM-only active tree; archive preserved; results in `planning/EVM_BASELINE_RESULTS.md` |
| M1 Settlement feasibility | ACCEPTED | `planning/EVM_M1_SETTLEMENT_SPIKE.md` | All gates pass: native public USDC settlement/rollback, independent signer-free recovery, compile/typecheck and105 tests |
| M2 Solidity financial core | ACCEPTED | `planning/EVM_M2_FINANCIAL_CORE.md` | Implemented; pinned compile/typecheck, 15 actual-EVM scenarios, solvency/isolation invariants and independent scoped review pass; results in `planning/EVM_M2_RESULTS.md` |
| M3 Client/provider flow | ACCEPTED | `planning/EVM_M3_HTTP_FLOW.md` | Typecheck and 28 tests pass, including actual local EVM/HTTP recovery, receipt and failure cases; results in `planning/EVM_M3_RESULTS.md` |
| M4 Evidence and claims backend | ACCEPTED | `planning/EVM_M4_EVIDENCE_CLAIMS.md` | Encrypted results/evidence, authenticated claim/decision prep and canonical/reorg-safe projection; 16 backend + 28 M3 regression tests pass; results in `planning/EVM_M4_RESULTS.md` |
| M5 Public MVP acceptance | ACCEPTED under EVM-037 | `planning/EVM_M5_PUBLIC_ACCEPTANCE.md` | Second native-USDC campaign completes14steps; signer-free financial proof/costs, both refunds, paused included revert and48tests pass. First partial run preserved; `planning/EVM_M5_RESULTS.md` |
| M6 Developer pilot | ACCEPTED under EVM-039 | `planning/EVM_M6_DEVELOPER_PILOT.md` | Clean configuration → purchase → process restart/retrieval → authenticated claim → explicit refund through reusable SDK/CLI and loopback claims API, actual local EVM proof, 21 pilot tests and 96 regression tests; `planning/EVM_M6_RESULTS.md` |
| M7 Transport preparation | ACCEPTED under EVM-042 | `planning/EVM_M7_EXTERNAL_PILOT.md` | Local HTTPS/actual-EVM purchase → provider restart → exact signer-free retrieval, unchanged local mode and adversarial transport checks; 33 M3 +24 pilot tests and standalone demo pass; `planning/EVM_M7_RESULTS.md` |
| M8 Product boundaries | ACCEPTED under EVM-044 | `planning/EVM_M8_PRODUCT_BOUNDARIES.md` | Reviewed component/role/runtime contracts and phased local product roadmap |
| M9 Provider integration | PLANNED, after M8 | Detailed packet pending | Outside-repo packed provider SDK + actual local EVM example service |
| M10 Client + agent integration | PLANNED, after M9 | Detailed packet pending | Unsigned preview/explicit approval, packed client, thin tool adapter and signer-free recovery |
| M11 Protocol API | PLANNED, after M10 | Detailed packet pending | Canonical dashboard read models and operation-specific, role-checked local controls |
| M12 Protocol console | PLANNED, after M11 | Detailed packet pending | Provider/admin/operator/adjudicator views with real financial state and gated actions |
| M13 Consumer demo app | PLANNED, after M12 | Detailed packet pending | Separate application using public client SDK and provider service, full success/failure/refund/retrieval journey |
| M14 Presentation rehearsal | PLANNED, after M13 | Detailed packet pending | Repeatable local demo, SDK examples, architecture, proof and submission materials |

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

M1–M8 gates are complete. M8 accepts local product definitions under the
user's explicit request; the roadmap is planning/EVM_PRODUCT_ROADMAP.md.
Later rows are ordered implementation intentions, not accepted gates. Freeze a
self-contained packet before each dependent implementation. Local protocol
console/demo UI is in scope through that roadmap; production hosting/UI,
browser-native custody and public publishing are not. Existing M5 campaign
approvals stay consumed; no additional public mutation is authorized.
