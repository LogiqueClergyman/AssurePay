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

## Open decisions

| ID | Decision | Target phase | Status |
|---|---|---|---|
| D-010 | Existing AVM `exact` extension vs dedicated `assured-exact` scheme | P0 | OPEN |
| D-011 | Exact on-chain coverage storage layout and minimum-balance implications | P1 | OPEN |
| D-012 | Premium rounding and minimum premium atomic unit | P1 | OPEN |
| D-013 | Explicit coverage close vs lazy/keeper close | P1 | OPEN; explicit close is acceptable for POC |
| D-014 | Single development claims key vs multisig | P1/P3 | OPEN; single secured development key is acceptable for POC |
| D-015 | Same-group provider stake bootstrap | P0/P1 | OPEN; initial pre-deposit is acceptable if bootstrap complicates P0 |

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
