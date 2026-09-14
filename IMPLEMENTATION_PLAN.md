# AssurePay POC Implementation Plan

## Operating model

Implementation is sequential. Only one phase and one coding session should be active at a time. The phase order is fixed:

```text
P0 atomic-group spike
  -> P1 Assurance Core
  -> P2 provider/client path
  -> P3 evidence and claims backend
  -> P4 demo and TestNet hardening
```

Later phases may be prepared conceptually, but their code must not begin until the preceding gate passes. The orchestrator creates a self-contained work packet immediately before each phase.

## Status summary

| Phase | State | Active packet | Gate |
|---|---|---|---|
| P0 Atomic group spike | COMPLETE | `planning/P0_TESTNET_ACCEPTANCE.md` | TestNet accepted: assured-exact three-member settlement and actual atomic pool rejection proved |
| P1 Assurance Core | IN_PROGRESS | `planning/P1_GATE_D_LIFECYCLE.md` | Gate D REVIEW: safe withdrawals, expiry close, adjudicated claims, payer-bound refunds, and invariant state machine |
| P2 Provider/client path | BLOCKED_BY_P1 | Not created | Pending |
| P3 Evidence and claims backend | BLOCKED_BY_P2 | Not created | Pending |
| P4 Demo hardening | BLOCKED_BY_P3 | Not created | Pending |

Allowed states are `NOT_READY`, `READY`, `IN_PROGRESS`, `BLOCKED`, `REVIEW`, and `COMPLETE`.

## P0 — Atomic-group spike

Purpose: remove the largest protocol uncertainty before building the rest of the system.

The gate passes only when the intended x402 AVM settlement path can carry an Algorand atomic group containing provider revenue, assurance premium, and an Assurance Core application call, and a failing application call prevents both asset transfers. Facilitator fee abstraction must also be tested when the selected facilitator path requires it.

The final result must choose and justify one wire representation:

- extend the current AVM `exact` flow with the assurance transactions; or
- introduce a dedicated scheme identifier such as `assured-exact`.

TestNet execution evidence is required to mark P0 complete. A fully working LocalNet implementation without TestNet credentials or funds remains `BLOCKED`, with the exact external prerequisite recorded.

## P1 — Assurance Core

Purpose: implement the financial source of truth.

Expected scope includes provider registration, immutable policy versions, stake accounting, capacity and exposure, safe withdrawals, coverage creation, claim finalization, refunds to the bound payer, pause behavior, balance reconciliation, and the required invariant tests.

The P1 packet must incorporate the group representation and contract constraints learned in P0. Do not implement P1 from this summary alone.

## P2 — Provider/client path

Purpose: prove an assured x402 request from initial HTTP request through verified provider response.

Expected scope includes canonical request commitments, assurance metadata in the 402 response, client group construction, provider middleware, response commitments, signed receipts, and receipt verification.

The P2 packet must freeze the canonical encodings and receipt schema. Do not implement P2 from this summary alone.

## P3 — Evidence and claims backend

Purpose: persist verifiable encrypted evidence, project chain state, and drive the constrained POC claim flow.

Expected scope includes PostgreSQL, MinIO/S3-compatible storage, AES-256-GCM envelope encryption behind a replaceable key-wrapper interface, idempotent evidence ingestion, chain projection, payer-authorized claim creation, adjudicator actions, and refund confirmation.

The P3 packet must define the database projection and evidence formats. Do not implement P3 from this summary alone.

## P4 — Demo and TestNet hardening

Purpose: make the complete POC reproducible and visibly prove its required properties.

The final demonstrations are:

1. successful assured call;
2. insufficient provider capacity rejects the entire payment;
3. withdrawal safety and zero-capacity rejection;
4. approved provider-fault refund to the original payer;
5. visible failure when evidence is tampered with.

A clean checkout must be able to start local dependencies, deploy the contract, seed a provider and policy, execute the core flow, verify receipts and evidence, exercise capacity and withdrawal enforcement, approve a refund, and repeat the core flow on TestNet.

## Gate policy

The orchestrator marks a phase `COMPLETE` only when:

- every deliverable in its active packet exists;
- required automated tests pass;
- required live-network evidence is recorded;
- material decisions are recorded in `DECISIONS.md`;
- `SESSION_HANDOFF.md` contains no unresolved blocker for that phase; and
- the implementation has been reviewed against the packet rather than merely shown to compile.
