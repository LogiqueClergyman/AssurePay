# M4 encrypted results, evidence and claims backend results

Date:2026-10-20. Active branch:`main`. State: REVIEW.
Packet:`planning/EVM_M4_EVIDENCE_CLAIMS.md`. Decisions:EVM-022..025.

## Delivered

`packages/claims-backend` is a pinned programmatic backend. It provides immutable
AES256GCM encrypted objects, a durable M3 result adapter, bounded full canonical
coverage projection, service-scoped EIP712 operation authentication with durable
replay prevention, payer evidence upload/read, and unsigned claim/adjudicator
call preparation. There is no HTTP claims service, transaction sender, automatic
adjudication, new contract or change to policy/refund economics.

M3's optional ResultStore persists encrypted response bytes/receipt before the
completed journal marker. Restart recovers exact responses, including after
coverage expiry or interruption between result persistence and completed marker.
Read-only engine.reconcile validates only an existing known transaction identity;
missing payment journal cannot enter a signing/submission path. Archived retrieval
checks receipt owner/request/coverage/body/status and exact canonical payment
block anchor, including when an in-memory response exists. Orphans and uncertain
reads fail closed. Without resultStore, existing M3 semantics remain unchanged.

The projection pins chain/Core/token/adjudicator, scans CoverageOpened from the
configured deployment range, binds each canonical opening to current coverage
state at one head and atomically replaces a public checkpoint. Full rebuild
removes orphaned claim/refund/coverage state. Evidence is separately encrypted and
binds its exact opening anchor, so a replacement opening of the same coverage ID
cannot inherit old evidence. Default limits:5000blocks/1000coverages; no stale
checkpoint authorization on failed RPC/canonicality/range checks.

One salted opaque evidence bundle<=65536bytes is selected for a proposed claim.
Payer authority is the stored payer. Configured adjudicator access requires the
exact canonically included claim evidence; explicit outcomes/refund amounts and
reason form an encrypted salted decision commitment. Only unsigned Core calldata
is returned; actual payer/adjudicator submits directly. Evidence truth and service
quality are not inferred. M2 remains the final role/state/refund boundary.

## Verification

Node24.18.0/npm11.16.0, Anvil1.7.1, viem2.57.7, TS5.9.3, tsx4.20.6 and M3
x4022.28.0. M4 locks viem and the test HTTP codec; actual execution reuses M2's
pinned Solidity0.8.30/Cancun/viaIR compiler and faithful signed ERC3009 fixture.
Runtime keys and EOAs are ephemeral. Required local HTTP/Anvil socket commands
ran through managed escalation. An earlier command was blocked by an approval-
review usage limit; subsequent authorized runs completed normally.

- `packages/claims-backend`: `npm run typecheck` PASS; `npm test` PASS,
  **16tests**, no failures/skips/cancellations. Eleven compose actual EVM
  execution; five focus on encrypted storage/result schema behavior.
- `packages/x402-assurance`: `npm run typecheck` PASS; `npm test` PASS,
  **28tests**, no failures/skips/cancellations. Legacy default behavior retained.
- Staged `git diff --check`: PASS at checkpoint preparation.
- No M1/M2 contract/package/evidence changes or public wallet/RPC operations.

Executed M4 cases:

- Paid registered-x402 HTTP → canonical settlement → encrypted result → provider
  restart after expiry → identical body/status/receipt; one payer signature,
  relayer signature, broadcast and handler. No plaintext evidence, reason or
  receipt signature in encrypted-object files.
- Saved encrypted result with failed completion marker recovers without handler;
  failed encrypted persistence remains started/indeterminate. Reorged payment
  cannot release a result from memory or disk. Deleted payment journal while a
  signing wallet is available returns unavailable without replacement signing.
- Full actual HTTP purchase → authenticated encrypted payer evidence → direct
  on-chain fileClaim → backend restart → authorized adjudicator read → explicit
  partial refund; exact payer balance, evidence/decision commitments, terminal
  status and collateral invariants. Durable original result remains retrievable
  after refund without another payment/handler.
- Canonical projection restart and actual Anvil rollback/replacement branches
  remove orphaned coverage, claims and decisions. Reorged ClaimFiled removes
  adjudicator authority. Reopening the same intent on a different canonical
  opening rejects its previous encrypted evidence. RPC/canonical/range/context/
  malformed-checkpoint failures preserve the committed checkpoint.
- Reject, partial/full ProviderFault and permitted PoolOnly calls execute actual
  M2 transitions with exact refund balances and solvency/isolation invariants.
  Wrong payer/adjudicator calls are rejected by backend and included M2 reverts.
  Reject-with-refund, zero/over-gross refund, unknown outcome and disallowed
  PoolOnly fail. Active filing at expiry fails; timely ClaimPending remains
  pinned beyond expiry and can be explicitly adjudicated afterward.
- EIP712 body/operation/coverage/Core/serviceId/actor/deadline substitutions and
  replay, including backend restart, fail. Upload snapshots body/authorization
  before awaiting chain I/O; caller mutation cannot change authorized bytes.
- Vault wrong key/context/object identity, ciphertext alteration, symlink,
  truncation, oversized payload, inconsistent result hash and immutable overwrite
  fail closed. Runtime-generated keys/signature-shaped fixture bytes are not
  checked in. Financial gates use actual contracts, not these component cases.

## Scoped review and corrections

Three Luna(high) agents implemented storage, projection and auth/claims. Agents
cross-reviewed components they did not implement; primary reviewed integration
and all relevant source deltas. Review closed mutable authorization/configuration
capture, out-of-range log acceptance and real viem representation mismatches
(event filtering API, number log indices/enums and prefixed byte encoding).
EVM-024 adds a specific no-signing recovery boundary beyond the original sketch.
Final scoped reviewers report no remaining blocker. This is development review,
not a production security audit.

## Limits and next action

Single backend/provider instance per respective local journals; trusted durable
filesystem/RPC, injected-key custody, no authenticated rollback-proof backup.
AES objects use fresh IVs and context-bound AAD; losing the runtime key loses
access. No key rotation/KMS, deletion/retention guarantee or distributed failover.
Replay journal caps10000 used entries and consumes before side effects; an
interrupted operation may require a new nonfinancial authorization. It never
creates another blockchain payment. Direct Core claims without local evidence
remain valid on chain but may be unavailable to this backend.

Projection performs bounded full rebuilds and checks one canonical inclusion,
not finality. Prepared calls can become stale before inclusion; callers must
inspect and submit themselves. Signed receipts and timestamps remain provider
assertions. Public native USDC combined-stack acceptance and measured public
costs belong to M5; no public funds were moved in M4.

Stop at M4 REVIEW. Exact protocol next action: record acceptance, then create a
self-contained M5 public MVP packet with concrete scenarios/deployment identities,
cost bounds, durable transaction recovery and independent verification before
any public mutation. Branch publishing is a separate repository operation: local
main replaces EVM restart, old head remains archived. The user explicitly approved configured GitHub main/archive publication on
2026-10-21. Atomic non-force push published checkpoint1f6566a to main and
958f650 to archive/algorand-p1; the previous approval-review blocker is resolved.
No push occurred during the original checkpoint preparation on2026-10-20.
