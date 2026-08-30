# POC Decision Log

This file records implementation decisions that affect later phases. Keep entries concise and evidence-based. Do not silently revise an accepted decision; add a superseding entry.

## Accepted decisions

### D-001 — Sequential implementation

- Status: ACCEPTED
- Decision: Use one active coding session and one implementation phase at a time.
- Reason: The POC is tightly coupled, and coordination overhead would exceed the benefit of parallel implementation at its current size.

### D-002 — Documentation isolation

- Status: ACCEPTED
- Decision: Neither implementation sessions nor orchestration access `/docs` unless the user explicitly changes that boundary. The orchestrator supplies self-contained phase packets under `/planning`.
- Reason: The larger architecture material is unnecessary for the current POC phase and consumes excessive context. Questions not answered by a packet are returned to the orchestrator.

### D-003 — P0 before production implementation

- Status: ACCEPTED
- Decision: Resolve the x402 AVM atomic-group representation before implementing the production contract, SDKs, or backend.
- Reason: This is the largest cross-component uncertainty and determines later interfaces.

### D-010 — Dedicated assured-exact scheme

- Status: ACCEPTED
- Date: 2026-08-30
- Phase: P0
- Decision: Use a distinct `assured-exact` scheme; do not extend current AVM `exact`.
- Evidence: `@x402/avm` 2.24.0 uses one payment index and checks only that selected ASA transfer. Its real `ExactAvmScheme.settle()` rejects the signed P0 app-call group before simulation; the automated harness confirms no submission.
- Consequences: Bind the whole ordered assurance group before simulation and submit those exact bytes. P1 retains contract-level validation.
- Supersedes: none

### D-016 — P0 assured-exact fixed profile

- Status: ACCEPTED
- Date: 2026-08-30
- Phase: P0
- Decision: Requirements use `scheme: assured-exact`, canonical decimal-string `asset` and `amount` (gross), and `extra` fields `provider`, `applicationAddress`, `applicationId`, `providerNet`, `premium`, and base64 32-byte `requestCommitment`. Payload uses base64 signed `paymentGroup` and fixed indices `providerIndex: 0`, `premiumIndex: 1`, `applicationIndex: 2`.
- Evidence: The local scheme is registered through `@x402/core` and requires exact three-member ordering, one group ID, equal payer addresses, providerNet + premium = gross, and bound `openCoverage(gross,premium,commitment)` arguments.
- Consequences: P0 deliberately excludes fee abstraction: no fee-payer member or unexpected extra transaction is allowed. Payer signs all three members; provider does not sign. A later fee-enabled profile must supersede this decision and change the contract/facilitator indices together.
- Supersedes: none

## Open decisions

| ID | Decision | Target phase | Status |
|---|---|---|---|
| D-011 | Exact on-chain coverage storage layout and minimum-balance implications | P1 | OPEN |
| D-012 | Premium rounding and minimum premium atomic unit | P1 | OPEN |
| D-013 | Explicit coverage close vs lazy/keeper close | P1 | OPEN; explicit close is acceptable for POC |
| D-014 | Single development claims key vs multisig | P1/P3 | OPEN; single secured development key is acceptable for POC |
| D-015 | Same-group provider stake bootstrap | P0/P1 | OPEN; initial pre-deposit is acceptable if bootstrap complicates P0 |
| D-017 | Whether the selected POC facilitator path requires fee abstraction; if required, supersede D-016 with an explicit fee-payer role and indices | P0 | OPEN |

## Entry template

```md
### D-NNN — Short title

- Status: PROPOSED | ACCEPTED | SUPERSEDED
- Date:
- Phase:
- Decision:
- Evidence:
- Consequences:
- Supersedes: none
```
