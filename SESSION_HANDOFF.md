# Session handoff

Date: 2026-10-20. Branch: `evm/restart`.
M1: ACCEPTED under EVM-015. M2: ACCEPTED under EVM-018.
Active packet: `planning/EVM_M3_HTTP_FLOW.md`. M3: REVIEW; implementation,
primary verification and independent scoped review complete. Results:
`planning/EVM_M3_RESULTS.md`. No M4 implementation has started.

M3 delivered `packages/x402-assurance`: registered x402 2.28.0 custom v2 profile,
canonical POST/body/request commitment, immutable policy/USDC domain reader,
restricted durable settlement engine and signer-free known-hash recovery,
HTTP client/provider wrappers, owner-signed response receipts and reserved /
started / completed service journal. EVM-020 requires current live coverage
before a new handler; EVM-021 binds one payment before charging a request.

Final `npm run typecheck` and `npm test` pass: 28 tests, including 14 actual
local-EVM/HTTP tests, collateral invariants, included reverted settlement,
pending/lost-response/signer-free restart, authorization/coverage expiry,
concurrency, invalid signatures/terms/transport/receipts and journal negatives.
Primary fixed viem nonce-number comparison and omitted decoded zero value;
regressions are exercised by actual success/revert tests. Independent Luna(high)
review verified closure of reservation-race, receipt coverage binding, event
schema and journal identity findings; final delta review has no remaining blocker.

Bounded local composition only: full M2/M3 stack has no public native-USDC proof
or production audit. Local response bodies/signatures are memory-only; completed
restart unavailable, started restart indeterminate, neither reruns the handler.
One provider/engine instance per journal/relayer. Preserve journals: an ambiguous
known hash is never replaced/rebroadcast; a pre-broadcast crash may strand it.
Stale exclusive locks need operator inspection. Production transport and encrypted
durable evidence/result storage/reorg projection are later work.

Exact next action: review `planning/EVM_M3_RESULTS.md`, record M3 acceptance,
then prepare a self-contained M4 evidence/claims backend packet before writing
M4 code. The M3 packet explicitly stops at REVIEW. No implementation blocker
remains for M3; M4 is gated by acceptance and its missing work packet.

M1 public proof remains unchanged: actual Base Sepolia native USDC settlement
and included valid-signature admission rollback, independent signer-free recovery
PUBLIC_RUN_RECONCILED. Evidence:
`spikes/evm-m1/evidence/public-native-usdc-{proof,verification}.json`.
Core: `0x35e6a35b68869bbe8548d41ac75ddd8e4bf6cfce`.
One canonical inclusion; no finality claim. M1 compile/typecheck and 105 tests,
M2 compile/typecheck and 15 actual-EVM scenarios were accepted previously.

Managed vault: `0x7a776d8F819B33F50ef85d37EFFcB5BDD2714756`, last recorded balance
99154640689918186 wei. Relayer 400519981996929 wei after M1 proof; payer native
USDC 19999900 atomic; M1 Core 7, provider 93. Values were not refreshed in M3.
Vault normalization and public protocol proof are complete; do not run either as
a fresh attempt or top up without a recorded next purpose. Funding evidence:
`spikes/evm-m1/evidence/vault-normalization.json`.

Preserve ignored mode0600 `.env.local` and `.env.vault.local` and completed
`.local-public-run`/`.local-vault-funding` journals under the M1 spike. Never
manually read populated environments or print keys/signatures/raw signed blobs.
M3 used ephemeral local signers and made no public mutations or wallet accesses.
M1/M2 contracts, public evidence and private configuration remain unchanged.

User authorizes Luna(high) delegation, gated continuation and checkpoint commits.
This session closes with a verified M3 checkpoint commit. No push, history
amendment or `/docs` access. Preserve archive/main at their existing heads.
