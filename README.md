# AssurePay

Assurance for x402 services on EVM. Providers serve callers directly; covered
payments fund provider revenue, assurance premium and optional collateral, with
payment and coverage created atomically. Receipts and private evidence support
contract-constrained refunds to the original payer.

The project is at the design/feasibility stage. Initial target: Base Sepolia and
native test USDC. No EVM contract or application has been implemented yet.

## Design

- [Technical architecture proposal](docs/evm_x402_assurance_technical_architecture_v0.2.md)
- [First MVP specification](docs/evm_x402_assurance_mvp_spec_v0.2.md)
- [Design rationale and alternatives](docs/evm_design_rationale_v0.2.md)

Mechanisms are evaluated for EVM and remain replaceable until proven. Product
invariants take priority over any candidate payment scheme or contract interface.

## Implementation

Read [repository instructions](AGENTS.md) and [current handoff](SESSION_HANDOFF.md).
The next task is [M1 settlement feasibility](planning/EVM_M1_SETTLEMENT_SPIKE.md).
[Decisions](DECISIONS.md) and the [implementation plan](IMPLEMENTATION_PLAN.md)
identify what is accepted, proposed and pending. Phase packets are self-contained.

The root package intentionally has no dependencies or runnable application
commands. M1 pins tooling and dependencies when the implementation starts.
Historical recovery information is recorded in EVM-006 in the decision log.
