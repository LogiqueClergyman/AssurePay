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

### D-011 — Typed box records with permanent tombstones

- Status: ACCEPTED
- Date: 2026-09-13
- Phase: P1
- Decision: Store provider, policy, coverage, and finalized-claim records in type-prefixed boxes keyed by fixed 32-byte IDs. Keep protocol configuration and aggregate accounting in global state. Preserve finalized coverage/claim records so IDs cannot be reused.
- Evidence: P1 needs multiple independently addressed records, immutable coverage facts, uniqueness after finalization, and later event-driven projection. Boxes provide the bounded POC representation without exhausting global-state slots.
- Consequences: Gate A must record compiled value sizes and exact application minimum-balance requirements. Deployment explicitly funds box MBR; authoritative tombstones are not deleted for reclamation. Gate A compiles the records as fixed ARC-4 tuples with one-byte boolean fields and uses literal one-byte `BoxMap` prefixes plus `StaticBytes<32>` IDs. AVM v13 rejects explicitly reading the zero address for optional inner account fields as an unavailable resource, so safe zero defaults are left implicit on the pooled opt-in transfer.
- Supersedes: none

### D-012 — Floor premium with one-unit minimum

- Status: ACCEPTED
- Date: 2026-09-13
- Phase: P1
- Decision: Compute `floor(gross * premiumBps / 10_000)` in atomic units and require a minimum premium of one atomic unit when gross and premium bps are positive.
- Evidence: This preserves revenue-funded integer arithmetic while preventing a positive-rate policy from silently producing zero premium on small payments.
- Consequences: Gate C must use an overflow-safe wide-ratio operation or prove/enforce safe input bounds. `providerNet = gross - premium`, and P1 stake top-up is zero.
- Supersedes: none

### D-013 — Explicit permissionless expiry close

- Status: ACCEPTED
- Date: 2026-09-13
- Phase: P1
- Decision: An open coverage is explicitly closed by a transaction after its stored expiry. Any caller may trigger the close; exposure and locked stake are released exactly once.
- Evidence: Explicit close is the smallest deterministic POC mechanism and avoids keeper/lazy-close complexity inside coverage admission.
- Consequences: Early close and every duplicate release fail. Claim finalization also terminally closes/refunds coverage and shares the same single-release invariant.
- Supersedes: none

### D-014 — Single configured development adjudicator

- Status: ACCEPTED
- Date: 2026-09-13
- Phase: P1/P3
- Decision: Configure one adjudicator address at application creation for POC claim finalization. Keep it distinct from the admin field even when one development account fills both roles.
- Evidence: Centralized POC adjudication is explicitly allowed; multisig, governance, and production custody are non-goals.
- Consequences: Only the adjudicator may finalize a claim, while the contract derives the refund destination from stored coverage and constrains all financial effects.
- Supersedes: none

### D-015 — Pre-deposited stake for the fixed coverage profile

- Status: ACCEPTED
- Date: 2026-09-13
- Phase: P1
- Decision: Providers deposit stake in a separate atomic deposit operation before accepting coverage. P1 fixes `stakeTopupAmount = 0` for the P0 three-member coverage group.
- Evidence: P0 proved `[provider axfer, premium axfer, appl]` with fixed indices and explicitly excluded a fourth member.
- Consequences: P1 must not add same-group stake bootstrap or fee sponsorship silently. Either requires a separately versioned wire-profile decision.
- Supersedes: none

### D-016 — P0 assured-exact fixed profile

- Status: ACCEPTED
- Date: 2026-08-30
- Phase: P0
- Decision: Requirements use `scheme: assured-exact`, canonical decimal-string `asset` and `amount` (gross), and `extra` fields `provider`, `applicationAddress`, `applicationId`, `providerNet`, `premium`, and base64 32-byte `requestCommitment`. Payload uses base64 signed `paymentGroup` and fixed indices `providerIndex: 0`, `premiumIndex: 1`, `applicationIndex: 2`.
- Evidence: The local scheme is registered through `@x402/core` and requires exact three-member ordering, one group ID, equal payer addresses, providerNet + premium = gross, and bound `openCoverage(gross,premium,commitment)` arguments.
- Consequences: P0 deliberately excludes fee abstraction: no fee-payer member or unexpected extra transaction is allowed. Payer signs all three members; provider does not sign. A later fee-enabled profile must supersede this decision and change the contract/facilitator indices together.
- Supersedes: none

### D-017 — Caller-paid fees for the P0 path

- Status: ACCEPTED
- Date: 2026-08-31
- Phase: P0
- Decision: The P0 assured-exact profile uses payer-funded transaction fees and retains the three-member group. No facilitator fee-payer member is required.
- Evidence: Installed `@x402/avm` 2.24.0 creates its optional fee-payer transaction only when `requirements.extra.feePayer` is present; without it, the caller pays transaction fees. The local assured-exact client likewise constructs ordinary payer-funded transactions.
- Consequences: D-016 remains in force. Any later sponsored-fee profile must supersede D-016 and specify a fourth member and contract/facilitator indices.
- Supersedes: none

### D-018 — Pera HD signer boundary for P0 TestNet

- Status: ACCEPTED
- Date: 2026-09-12
- Phase: P0
- Decision: The headless TestNet runner accepts only a 24-word Pera BIP-39 phrase through environment/ignored `.env`, derives `m/44'/283'/account'/0/addressIndex` with ARC-52 Peikert derivation, and requires the configured public address to match before any network action. The signer is opaque: it exposes its public address and a transaction-signing method, never `{ addr, sk }` or derived private material.
- Evidence: Pera's public iOS HD wallet source defaults to `.peikert`, account/change/key defaults `0/0/0`, and passes the transaction's prefixed bytes to ARC-52 signing. The Foundation `xHD-Wallet-API-ts` source identifies Peikert as its default and supplies the ARC-52 vector used by the deterministic suite. The suite independently verifies all three signed P0 group members with their `bytesToSign()` values.
- Consequences: TestNet configuration replaces `TESTNET_PAYER_MNEMONIC` with `TESTNET_PAYER_HD_MNEMONIC`, `TESTNET_PAYER_ADDRESS`, `TESTNET_PAYER_ACCOUNT_INDEX`, and `TESTNET_PAYER_ADDRESS_INDEX`. Legacy Algo25 is deliberately unsupported by this P0 runner; Pera mnemonic/seed/root/private key material is not logged or serialized.
- Supersedes: none

### D-019 — P0 TestNet acceptance conclusion

- Status: ACCEPTED
- Date: 2026-09-13
- Phase: P0
- Decision: Close P0 with the dedicated `assured-exact` profile and caller-paid fees fixed by D-010, D-016, and D-017.
- Evidence: On Algorand TestNet, ASA `10458941` / app `771586806`, the three-member successful group `P/UeimX9rfN7M9bX+GVkRLVn3w8Ch0LmcnxtVVnm5/0=` confirmed at round `67235792` with the required −100/+93/+7 ASA deltas and marker `0 -> 1`. The distinct ABI-valid group `2kqU7jR+J/+R/u0IhVfrPSJVylJHi1XB24UAKoAmBgc=` was rejected by the real transaction pool for the intended app assertion, with rejected-case ALGO/ASA balances unchanged and marker `1 -> 1`. The configured endpoint independently confirmed the network, asset, application, successful group members, and current marker.
- Consequences: P1 must retain the P0 wire constraint `[provider axfer, premium axfer, appl]`, bind and verify the whole ordered signed group before simulation/submission, and keep fee sponsorship as an explicit later-profile change rather than adding a fourth member silently.
- Supersedes: none

### D-020 — P1 production assured-exact binding

- Status: ACCEPTED
- Date: 2026-09-13
- Phase: P1/P2
- Decision: Retain scheme `assured-exact` and the P0-fixed three-member order, and identify the production contract binding with `extra.profile: assurance-core-v1`. In addition to P0's canonical asset, gross, receiver, app, split, and request-commitment fields, bind canonical base64 `coverageId`, `providerId`, and `policyId`. The application member calls `openCoverage(byte[32],byte[32],byte[32],byte[32],uint64)` with those IDs, the request commitment as `requestHash`, and gross amount.
- Evidence: The production contract must persist caller-chosen unique IDs and immutable provider/policy associations, while P0's spike ABI intentionally proved only the uncertain transaction-group mechanism. Keeping the accepted group roles and indices preserves P0's chain evidence; an explicit profile prevents the richer ABI from being confused with the spike payload.
- Consequences: Gate C implements and tests a production-local adapter registered through real `@x402/core`, binding all signed members and all five ABI arguments before simulation/submission. P2 must consume this exact profile. There is still no fourth member, fee sponsorship, same-group stake top-up, or provider signature.
- Supersedes: D-016 only for the production application ABI and added metadata; D-016's scheme, canonical numeric fields, three-member group, role indices, payer signatures, and fee exclusions remain accepted.

### D-021 — Gate C approval program page

- Status: ACCEPTED
- Date: 2026-09-13
- Phase: P1/Gate C
- Decision: Gate C deployment transactions allocate one additional approval-program page (`extraPages = 1`); the ABI, storage schema, group profile, and accounting interfaces remain unchanged.
- Evidence: The compiled Gate C approval program is 2,329 bytes, above the one-page 2,048-byte limit and below the two-page 4,096-byte limit. Real LocalNet deployment and coverage settlement pass with the additional page.
- Consequences: Gate C application minimum-balance evidence is reported separately from the unchanged record MBR values. Later gates must preserve this deployment parameter unless a smaller program is compiled.
- Supersedes: none

## Open implementation facts

- D-011 Gate A evidence recorded compiled box sizes and exact application minimum-balance funding.
- D-012 Gate C evidence must record the verified overflow-safe arithmetic primitive and boundary behavior.
- These are implementation facts, not open product decisions. Any incompatible discovery requires a superseding decision.

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
