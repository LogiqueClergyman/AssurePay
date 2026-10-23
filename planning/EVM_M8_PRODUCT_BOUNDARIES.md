# M8 — local product boundaries and phased execution

Date:2026-10-23. State: ACCEPTED under EVM-044; results: planning/EVM_M8_RESULTS.md.

## User direction and gate

The user explicitly requested a provider SDK, client SDK/agent/skill, protocol
UI for providers/admin/operators and a separate client-consuming demo app, split
into smaller phases and implemented. Retain local-only execution. This phase
freezes product responsibilities and gates; it does not claim those surfaces
are already delivered or start their dependent implementations.

Deliver planning/EVM_PRODUCT_ROADMAP.md with the component/runtime boundary,
actual role/action authority, explicit consent and recovery rules, initial demo
journey, phase sequence and measurable exit gates. Audit accepted code rather
than importing old design requirements. Independent Luna(high) reviews plus
primary source/reference/consistency checks must close contradictions. Record
M8 outcome in planning/EVM_M8_RESULTS.md and exact next action in handoff.

## References and allowed paths

Read AGENTS.md, SESSION_HANDOFF.md, DECISIONS.md, IMPLEMENTATION_PLAN.md,
planning/EVM_M6_DEVELOPER_PILOT.md, EVM_M6_RESULTS.md,
EVM_M7_EXTERNAL_PILOT.md and EVM_M7_RESULTS.md (all under planning), and
packages/developer-pilot/{README.md,package.json,src},
packages/{x402-assurance,claims-backend}/{README.md,package.json,src},
packages/evm-core/contracts/AssuranceCore.sol. No /docs, populated environment,
wallet or existing runtime-journal access. No historical campaign execution.

Write this packet, planning/EVM_PRODUCT_ROADMAP.md, planning/EVM_M8_RESULTS.md,
DECISIONS.md, IMPLEMENTATION_PLAN.md and SESSION_HANDOFF.md only. No runtime
code, dependency, contract, financial rule, public mutation or hosting change.
Later packets must define their own paths before dependent implementation.

## Evidence and non-goals

M8 acceptance is a reviewed product contract, not a financial/runtime proof.
Do not rerun or relabel M1–M7 tests as M8 execution evidence. Confirm branch and
scope, validate referenced paths and phase/role consistency, and run diff checks.
Source-grounded gaps include private monorepo-only exports, signing inside
buyer.prepare, missing dashboard list/summary API, restricted claim-only sender,
and current runtime admin/relayer coupling. Record these as implementation work,
not failures of the accepted M1–M7 gates.

Local console/demo UI and Node integration packaging are now in product scope
through the roadmap; production UI/hosting, browser-native wallet custody,
public npm publishing, new testnet campaigns, governance, actuarial models and
subjective adjudication are not. ETHGlobal eligibility/event-built work remains
separate from accepting the technical roadmap. Preserve the pre-event baseline
and disclose reused/AI-assisted work in future presentation material.
