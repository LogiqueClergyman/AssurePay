# M3 HTTP/x402 composition results

Date: 2026-10-20. Branch: `evm/restart`. State: REVIEW.
Packet: `planning/EVM_M3_HTTP_FLOW.md`. Decisions: EVM-019..021.

## Delivered behavior

`packages/x402-assurance` provides an isolated pinned TypeScript package using
actual x402 2.28.0 client, resource-server and facilitator registrations.
`assured-exact` / `assurepay-evm-v2` negotiates the M2 policy-backed quote and
settles upfront before a protected POST handler. There are no new contracts or
changes to M1/M2 contracts, economics, public evidence or wallet configuration.

The client independently checks its configured Core/token/provider/policy,
atomic spend cap, canonical route/body/request ID, immutable policy and USDC
signing domain. It creates one authorization per purchase and reuses it on
retry. The provider verifies canonical payment inclusion and current live
coverage before starting a handler. Owner-signed response receipts bind exact
response bytes, request, coverage and HTTP status. Handler failures return a
signed 500 with paid coverage retained.

The restricted engine validates the exact Core call and signed EIP-1559
transaction, derives its hash locally, fsyncs public identity before one
broadcast, and reconciles known hashes without a signer after restart. A service
reservation precedes payment; a durable start precedes handler entry. Duplicate
requests coalesce and cache the same result. A different intent for an already
reserved request cannot create another charge. Started/completed restart states
never rerun the handler.

## Primary verification

Environment: Node 24.18.0, npm 11.16.0, Anvil 1.7.1. Dependencies pinned by the
new package lockfile: x402 core/evm 2.28.0, viem 2.57.7, TS 5.9.3, tsx 4.20.6.
Local EVM tests reuse M2's pinned Solidity 0.8.30/Cancun/viaIR compilation and
faithful signed ERC3009 fixture. Accounts are ephemeral in memory. Loopback
execution required the managed test-command sandbox escalation.

Final commands in `packages/x402-assurance`:

- `npm run typecheck` — PASS.
- `npm test` — PASS, 28 tests, zero skipped/cancelled/failed.
- `git diff --check` — PASS at checkpoint preparation.

Fourteen tests compose actual local EVM execution and HTTP, with four separate
admission-failure scenarios in one of those tests. Remaining tests exercise
schemas, chain-reader/verifier negative cases, journals, registered SDK and HTTP
wrappers. Stubbed component cases are supplemental and do not supply financial
execution evidence.

Executed scenarios include:

- Dynamic gross 10003, premium 777, withholding 2029, provider net 7197, stake
  lock 3502, pool reservation 10003; exact payer/Core/provider token deltas,
  coverage and ledger invariants, owner receipt, one signature/broadcast/handler
  across send/retry/concurrent identical requests.
- Lost broadcast response with hidden receipt: pending without handler, followed
  by signer-free engine/provider restart recovery after token authorization
  expiry while coverage remains live. Original hash only; no second signing or
  broadcast. Recovery after coverage expiry refuses a new handler.
- Lost paid HTTP response returns cached bytes/receipt on retry. Completed
  provider restart reports response unavailable. Interrupted started handler
  restart returns indeterminate with the original transaction. No re-execution.
- Signed handler-failure 500; paused admission, insufficient pool, insufficient
  stake and expired new authorization; no unauthorized service/token nonce use.
- Actual successful simulation followed by a mined pause before settlement
  submission: the settlement has a canonical included reverted receipt. Retry
  reconciles the same hash; no USDC/ledger changes or handler, nonce unused,
  collateral solvency/isolation invariants pass.
- Concurrent distinct purchases use serialized relayer nonces. Two raw identical
  paid requests coalesce; a duplicate arriving after durable start shares the
  live response. Concurrent different intents for one request charge only one.
- Unpaid, invalid signature, modified body/gross/policy/profile, wrong content
  type/path and oversized request rejection. Response bytes/status/coverage,
  foreign receipt signer, unsupported profile, over-cap challenge and redirect
  policy negative cases. Journal context/identity/transition/symlink/tampered
  reserved-record rejection.

Primary composed testing caught two viem decoding assumptions before any local
broadcast succeeded: transaction counts use number while parsed nonce comparison
used bigint, and canonical decoding omits zero native value. Comparisons now
normalize nonce and interpret omitted value as zero; the actual successful and
included-revert tests exercise both paths. No RPC errors, signatures or raw
signed transactions are retained as evidence.

## Independent scoped review

Luna(high) agents implemented protocol, chain/engine and HTTP/store components.
A separate read-only Luna(high) review identified and verified closure of:
reservation-race double charging, response receipt missing payment coverage
binding, a nonexistent event openedAt field, and a malformed reserved journal
identity. Temporary development logging was removed. Primary review additionally
fixed the signing comparisons and required in-flight duplicates to precede the
persisted-start restart branch. Focused regression tests cover these cases.
This is scoped development review, not a production security audit.

## Limits and exact next action

This gate proves local composition. It does not prove native public USDC use by
the combined M2/M3 stack, public gas costs, finality, production TLS/deployment,
distributed failover, evidence validity or service quality. One canonical
inclusion is required. Response timestamps remain provider assertions.

Run one provider/engine instance per journal and relayer. Journals contain public
metadata only and assume trusted durable local storage. A crash after preparing
but before broadcasting can strand a known hash; fail closed, preserve the
journal and never replace the payment. A stale exclusive payment lock after a
process crash needs operator inspection. There is no automatic lock stealing,
signed-byte persistence, rebroadcast or reorg-driven journal rewriting.

Response bodies and receipt signatures are memory-only. Started restart remains
indeterminate; completed restart without cache remains unavailable. M4 must
supply an explicit encrypted durable evidence/result design and reorg-safe
projection before broader recovery claims are made. No exactly-once external
side-effect guarantee is asserted.

No public transaction, vault movement, populated environment access, `/docs`
access, push or history amendment occurred in M3. M1/M2 remain accepted and
unchanged. Stop at M3 REVIEW as the packet requires. Exact next action: review
this result, record M3 acceptance, then prepare a self-contained M4 packet before
implementing evidence/claims backend behavior. No M4 implementation is started.
