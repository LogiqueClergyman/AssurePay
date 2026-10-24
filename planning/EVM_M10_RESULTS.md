# M10 client SDK and agent integration results

Date:2026-10-24. ACCEPTED under EVM-048; implemented under EVM-047. Scope:
planning/EVM_M10_CLIENT_SDK.md. Local fixtures only; no public transaction,
funding, hosting, registry publication or global skill installation.

## Delivered behavior

Private/packable @assurepay/client-sdk0.1.0 exposes five root functions and
SDK-owned public types. The facade provides unsigned preview, explicit approval,
fresh quote revalidation, durable authorization, one paid send, original-ID
retrieval, anchored payer balance/coverage and fixed payer evidence/claim methods.
No generic transaction, actor, endpoint injection or adjudication API is exposed.

The session journal binds config, payer, per-request/total caps and payment count
to one private directory. Reservation is fsynced before forwarding the payer
signature; all reserved/authorized/attempted/confirmed records consume limits.
Unresolved work blocks a new payment. Rechecking a confirmed result persists the
attempted guard before proof reads. Missing/corrupt/changed state fails closed;
there is no reset, replacement payment or automatic stale-lock takeover.

M3 and M6 gain unsigned preview/authorization while legacy createPurchase retains
one challenge. Existing contracts, economics, receipt formats, M4/M5 logic,
M9 sources and historical public/private campaign state remain unchanged.

Four framework-neutral agent tools enforce a host approval callback for each
new payment. Model arguments cannot approve or change authority/caps. Explicit
output fields exclude signatures, payment payloads, raw transactions and private
paths. The portable skill documents setup, review, denial/staleness and original
request recovery. A separate plain Node client example consumes only the SDK
root and declared viem helpers.

The six-file tarball contains package.json, README.md, dist/index.js,
dist/index.d.ts, dist/types.d.ts and skill/assurepay-client/SKILL.md. Esbuild
bundles the accepted runtime; exact viem2.57.7/@x402/core2.28.0 remain external.
TypeScript5.9.3 checks the whole closure and emits SDK-owned root declarations.
No source aliases, sibling declarations, fixtures, state or install hooks ship.
The package remains private; no new license grant or publication is implied.

## Verification

Node24.18.0/npm11.16.0 and Anvil1.7.1. Primary final typechecks/builds and
complete suites pass without failures, skips or cancellations:

| Package | Tests | Verification |
|---|---:|---|
| client-sdk | 23 | Public package/types, approval/budget/claims/reads, hostile arguments/output isolation, actual EVM client/skill and packed external process gate |
| x402-assurance | 37 | Full payment/receipt/HTTP/recovery regression; preview/fresh revalidation and legacy one-challenge behavior |
| developer-pilot | 25 | Full actual EVM/HTTP/CLI/claims/refund/TLS/sandbox regression; isolated bounded previews |
| provider-sdk | 7 | Full SDK/package and outside-repository actual EVM provider process regression |

These suites contain92tests. M9 sources and prior evidence remain unchanged.

Primary actual client tests2/2 pass after the durable retrieval-guard refinement:
denial signs nothing; concurrent approval signs once; lost response blocks a
new purchase; original recovery has no new payer signature or relayer nonce;
persistent limits and changed/missing/corrupt journals fail closed. A filesystem
fault prevents retrieval before HTTP; later uncertainty survives restart until
the original result is verified. Preview expiry rejects before signing.

The official skill-creator quick_validate.py passes in a disposable temporary
environment with pinned PyYAML6.0.3; that environment is removed. An independent
Luna(high) forward rehearsal follows the skill through actual local EVM denial,
explicit approval, uncertain response and signer-free original-ID recovery.

The outside consumer installs actual provider/client tarballs in a temporary
project. Exact root JS/declarations, positive/negative TypeScript calls, blocked
deep imports and strict checkJs on the real separate client example pass. The
runtime processes use plain Node and SDK roots, with no tsx, monorepo aliases or
runtime symlinks. Only the disposable fixture coordinator uses in-repo helpers.
Pinned installed dependency trees are copied with dereferencing before the
offline tarball install; no dependency network fetch is required by the gate.

Actual isolated M2/faithful ERC3009 execution proves:

- Preview and denied host approval have0signatures and0settlements. Concurrent
  authorization creates one payment signature; a deliberately lost paid response
  leaves the original request unresolved. A fresh client OS process omits its
  payer key and retrieves the same status/body/transaction/receipt fingerprint.
- The provider also restarts in retrieval-only mode with provider/relayer keys
  omitted. Its receipt/handler capabilities throw if called. Original receipt
  and bytes return, relayer nonce stays unchanged and settlement broadcasts stay1.
- Independent request hashing, decoded settleAssured calldata, hashIntent,
  CoverageOpened, stored coverage, receipt and canonical block bind payment1.
  Payer debit10003/provider credit7197/Core increase2806 match actual balances.
  Core62806=stake12029+pool50777; locked3502/reserved10003, active/count1.
- Two later explicit new purchases exercise controlled signed500 and a separate
  success, reaching the configured3payment/30009atomic cap. They are independent
  requests, never replacement payments for the interrupted original.
- Payer evidence round-trips, and its explicit approved claim executes on EVM.
  Independent decoding proves exact fileClaim arguments, payer/Core/chain/value,
  gas100000/maxFee100000000/priority1000000wei, included status2/evidence hash
  and canonical receipt block. Repeating the same evidence or reconciling without
  a signer returns the original claim hash with no new broadcast. Changed-evidence
  duplicates and missing/unopened coverage claims fail before authorization;
  wrong-role account startup is rejected.
- A test-coordinator adjudicator explicitly submits PoolOnly refund10003atomic
  units. No adjudicator capability is exported by the client. Anchored SDK state
  shows status3/outcome2/refund10003 and matches actual payer balance119994.
  Core58415=stake16087+pool42328; the other2coverages remain active with aggregate
  stake locks7004/pool reservations20006. All solvency and reservation bounds hold.
- The fourth new purchase fails before a signature, and reopening under changed
  caps fails. Unit/integration failures also cover malformed/missing journals,
  symlinks, namespace changes, RPC failure/reorg/context drift, expired previews,
  unapproved/foreign calls and hostile tool accessors/private output fields.

Independent Luna(high) review closed snapshot capture, checksum handling,
signer-free sender reopening, declaration closure, adapter output/catch safety,
durable retrieval guard and exact financial/report proof findings. No scoped
blocker remains. The final public root wrapper also sanitizes adapter constructor
failures; its hostile-getter regression passes in the final23test SDK suite.

Primary standalone npm run demo PASS returned LOCAL_CLIENT_SDK_VERIFIED. Report:
packages/client-sdk/evidence/m10-consumer-gate.json. It contains only public
hashes/addresses, anchored accounting and safe observations. Sensitive-field,
integer accounting, pinned-lock, allowed-path and whitespace checks pass.
Fresh chains, consumer projects, generated actors and private state are deleted.
No blocker remains within the local M10 packet.

## Limits

Local Node/faithful ERC3009 fixture evidence is separate from historical M5
native-USDC proof. No finality, public/HTTPS deployment, production custody,
global account spending limits or authenticated backup rollback is claimed.
Trusted local RPC/filesystem and host custody remain assumptions. M6 role
couplings and fee bounds remain; M11 must separate admin and relayer composition
before the protocol console can present distinct controls.
