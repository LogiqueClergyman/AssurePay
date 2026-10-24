# M11 — local protocol application API

Date:2026-10-24; accepted2026-10-25 under EVM-050. Implemented under EVM-049 after M10 acceptance EVM-048 at
b772e67. User authorizes continuation, Luna(high), primary verification and
checkpoint commits/nonforce pushes. Local-only; no public transactions, funding,
hosting, publication, browser UI or changes to contracts/economics/receipts.

## Goal and source boundary

Deliver the local Node API for M12's provider/admin/operator/adjudicator console:
canonical summary/provider/policy/coverage reads, explicit host-created actor
sessions, fixed preview/confirm actions and durable original-hash reconciliation.
Demonstrate admin/relayer separation through the existing settlement mechanism.
Do not create a generic wallet/transaction proxy or replacement payment path.

Read AGENTS/handoff/decisions/plan, planning/EVM_PRODUCT_ROADMAP.md and completed
M6–M10 packets/results. Inspect packages/{evm-core,claims-backend,developer-pilot,
x402-assurance,provider-sdk,client-sdk}/{src,test,scripts,contracts,README.md,
package.json,package-lock.json,tsconfig.json,toolchain.json} as relevant; examples/
{data-profile-service,assured-client} source/metadata/templates; only
 evm-acceptance/src/{read-queue,log-chunks,run-lock}.ts; imported M1 fixture and
pinned installed dependency types/source. No /docs, populated environments,
existing wallets/private journals. Exclude dependencies/generated runtime state
from recursive searches. Prior public/private campaigns and evidence are read-only.

Write packages/protocol-app/**, this packet, planning/EVM_M11_RESULTS.md,
DECISIONS.md, IMPLEMENTATION_PLAN.md and SESSION_HANDOFF.md. Narrow compatibility
writes: developer-pilot/src/provider.ts and focused test/product-provider.test.ts.
No other existing runtime/SDK/test/evidence change. New package is a private Node
ESM application, not a distributable SDK: source execution via pinned tsx4.20.6,
TypeScript5.9.3/@types/node24.10.1 and exact viem2.57.7. No frontend/dependency
framework, package publication or new license grant. Runtime may use accepted
sibling sources; no public package artifact claim is needed for M11.

## Source findings and composition

Core already has immutable admin/adjudicator, owner-only free-stake withdrawal,
permissionless positive stake/pool funding, write-once provider/policy IDs,
permissionless expiry closure and public events/getters. M6 checkPilot pins Core
admin to roles.relayer and provider owner=payout=roles.provider. Those are local
composition rules, not Core constraints. M4 projection covers CoverageOpened
only; it validates complete coverage count, numbered canonical state and bounds.

New ProtocolConfig={version:1,pilot:PilotConfig,admin:Address,apiUrl:string}.
The nested exact existing local v1 PilotConfig remains unchanged; the admin is
nonzero and distinct from its four actors. apiUrl is an exact loopback HTTP
origin with explicit port, distinct from RPC/resource/claims origins. Reject
native public USDC and all public URLs via existing validator. Primary service
owner=payout coupling remains explicit this phase; registry reads can represent
other registered owners/payouts. Payer remains M10's separate consumer actor.

Add optional expectedAdmin to internal checkPilot/startPilotProvider only;
default is the existing relayer. Copy/validate it before awaiting; check actual
Core admin against it. New startProtocolProvider wrapper always passes config.admin;
settlement engine/actor lock still uses only config.pilot.roles.relayer. Existing
M6/M9 callers and public SDK schemas/behavior remain unchanged. A later explicit
SDK extension is needed before using separated composition through provider-sdk.
No admin account is passed to the online provider. Prove paid HTTP and key-free
retrieval through this internal product composition on a fresh local Core.

## Node interfaces and common rules

Public types live in new src/types.ts before dependent implementation. Config,
keys, account methods and operation arguments are captured/copied before awaits.
All money/time/block quantities use canonical decimal strings; IDs are lowercase
nonzero bytes32, addresses normalized lowercase. Exact argument objects reject
extra/hidden/accessor fields. Fixed allowlisted errors exclude RPC text, secrets,
signed bytes and private paths. Storage is a new private0700 directory with
lifetime exclusive app lock; journals0600, bounded/no symlinks, atomic/fsynced.
No automatic missing-state reset, stale-lock takeover or rollback integrity claim.

createProtocolRuntime({config,storage:{directory,key:Uint8Array32},accounts?:{
admin?:LocalAccount,provider?:LocalAccount,adjudicator?:LocalAccount},limits:{
maxActionAmount:string,maxActions:number}}) returns a private Node runtime.
maxActionAmount is a positive uint256 string; maxActions integer1..256 per actor.
Account addresses must match configured roles; capture signing functions before
awaits. Operator has no signing account. Missing accounts allow read/reconciliation
but not confirmations requiring that actor. Limits bind persisted sender context
and cannot change on reopening. All operations count against the actor journal;
financial amounts are capped per action. This is a local host limit, not a global
production budget. There is no payer/admin role inferred from a UI selection.
The app storage key contributes a fingerprint to configuration identity only;
it does not encrypt or authenticate protocol journals. Those contain public
transaction metadata/commitments, not private evidence or reason bodies. M4's
separate existing vault retains private payload encryption. No cryptographic
journal/backup integrity claim is made.

Runtime methods: snapshot(), preview(role,operation), confirm(role,previewId,
{approved:true}), reconcile(role), readEvidence(role,coverageId), close(). These
are trusted Node host methods; HTTP derives role from session and never forwards
a caller role. snapshot returns sanitized read model; preview returns safe review
metadata; confirm returns operation status/original transaction only. readEvidence
is adjudicator-only, fixed to that coverage's filed evidence through existing
M4 auth/backend. No payer private read through this protocol app (M10 owns it).

## Canonical read model

Reuse M4 createProjection (maxBlocks25000/maxCoverages1000) in the new private
app namespace. Serialize refreshes. Take its numbered head, then perform every
additional Core/token/registry read at that same head and recheck its hash.
Validate chain84532, code, token, admin, adjudicator and primary service identities.
No stale-success/cache fallback on RPC, context, reorg, limit or storage failure.

Registry discovery scans ProviderRegistered and PolicyRegistered from deployment
through that head in <=100block chunks; cap100providers/100policies. Validate
canonical log block hashes, unique IDs/order and event/mapping tuple agreement.
Require configured provider/policy and every projected coverage's provider/policy
to be indexed. The RPC remains trusted for unreferenced registry completeness:
Core has no registry count, so no stronger completeness claim is made.

ReadSnapshot={anchor:{number,hash,timestamp},summary,providers,policies,coverages}.
summary: paused, tokenBalanceAtomic, poolAssets, poolReserved, providerStake,
lockedStake, coverageCount, activeCoverageCount; solvency booleans balance>=
stake+pool, stake>=locks, pool>=reservations. Direct token donations mean equality
is not required by the read model; fixture tests require exact expected equality.
providers rows: providerId,owner,payout,freeStake,lockedStake,payoutBalanceAtomic,
cumulativeNetPaidAtomic (sum gross-premium-withheld, not current earnings/profit),
coverageCountsByStatus. policies: policyId,providerId,policyHash, premiumBps,
stakeBps,withholdingBps,duration,poolOnlyAllowed; recompute policy hash using the
accepted canonical type/encoding and current immutable owner/payout.
coverages: coverageId,payer,providerId,policyId,gross,premium,withheld,stakeLock,
poolReservation,openedAt,expiresAt,poolOnlyAllowed,status and hasEvidence; include
outcome/refundAmount only when finalized (status3/4). Omit request/evidence/
decision hashes, body, reason, signature, private paths and raw projection.

HTTP summary and list responses carry the same explicit anchor. Provider sessions
see their own provider's coverages/actions; other roles see sanitized global data.
Lists are stable by ID, page size1..100. Cursor binds a bounded in-memory snapshot
ID, session, kind/filter and offset; snapshots expire after120wall-clock seconds,
max8 per session. Recheck the stored numbered hash on every page; never silently
mix heads. Missing/expired/reorged cursor fails and requires a new first page.
Details use a fresh anchored snapshot. No stale balances in error responses.

## Fixed operation union and approval

Operation arguments are exact; actor comes solely from the host-bound role:
- admin: registerProvider({providerId,owner,payout}); registerPolicy({policyId,
  providerId,premiumBps,stakeBps,withholdingBps,duration,poolOnlyAllowed});
  setPaused({paused}); fundPool({amount}); approveCore({amount}).
- provider: depositStake({providerId,amount}), withdrawStake({providerId,amount})
  only for configured primary provider/actual owner; approveCore({amount}).
- adjudicator: finalizeClaim({coverageId,outcome:0|1|2,refundAmount,reason}).
- operator: reconciliation only; no preview or financial action.

approveCore targets the configured token, fixed spender Core and exact bounded
amount, never an unlimited approval. Funding/deposit needs actual sufficient
allowance; approval and funding are separate explicitly confirmed operations.
Core permits anyone to fund; the app deliberately narrows pool funding to admin
and primary stake controls to provider owner. No edit/delete registry, arbitrary
actor/recipient/target/calldata, payer claim/payment, expiry closure or process
shell/control endpoint is added. Those controls are not represented as available.

Preview validates role/args/cap/context/state, simulates the fixed call at one
numbered head and rechecks it. It performs no signing or broadcast. Store max32
volatile previews per role,120chain-second expiry, immutable actor/operation/
normalized args/context/anchor; return random previewId, role/actor, operation,
review fields, context, observed anchor, expiry and fixed gas/fee ceiling. Full
reason remains private; review may return reasonHash rather than plaintext.
For finalize preview, simulate with a nonzero internal placeholder decision hash;
actual private salted M4 decision commitment is created only after confirmation.
The approval binds exact coverage/outcome/refund/reason, not an arbitrary hash.

Confirm accepts only previewId and literal approval. Consume preview before any
await, serialize per actor, recheck original anchor canonicality, role/context,
expiry, latest/pending nonce, state and simulation at a fresh numbered head.
A changed relevant state/terms rejects stale, requiring new preview/approval.
New unrelated blocks alone do not invalidate a valid still-canonical preview.
Persist actor operation reservation before any signing. For finalize, only after
approval use existing authorize/claims client prepareDecision; decode the returned
fixed action against frozen inputs and returned commitment. No new adjudication
mechanism, evidence trust judgment or decision inference is introduced.

## Durable sender and reconciliation

Implement a separate typed sender; do not widen M6's two-selector sender. Reuse
M6 actor locks and accepted fsync/signed-transaction verification pattern. One
context/actor journal max256records/max2MiB; limits/context bound and strict on
reopening. Known operation IDs are internal preview IDs. No browser-supplied
PreparedAction, transaction hash or actor is accepted. Unknown/stranded prior
work blocks a new actor operation; other actors remain independent.

Fixed EIP1559 maxFee100000000/priority1000000wei; gas caps: registerProvider150000,
registerPolicy250000,setPaused60000,approveCore70000,depositStake140000,
withdrawStake140000,fundPool120000,finalizeClaim220000. No fee escalation, gas
estimation fallback, replacement or rebroadcast. Preflight native balance covers
gas ceiling; validate serialized type/chain/from/to/value0/nonce/data hash/gas/
fees and recovered actor. Derive original hash locally; fsync reservation, then
known hash and attempted marker before the sole sendRawTransaction boundary.
Never persist or return raw signed bytes/signatures; prepared-unsent may strand.

Reconcile only existing known original hashes, with no wallet/account signing.
Verify tx fields/calldata hash, receipt status/block identity and canonical
inclusion; verify expected fixed event and relevant terminal mapping state on
success. Included revert is terminal reverted. RPC timeout/missing receipt is
unknown, never inferred failure. Return safe id/operation/actor/status/transaction/
inclusion; no calldata, payload/reason, private paths or signatures. Operator
may reconcile all managed actor journals; other sessions only their own. This
covers protocol actions, not provider settlement journals or arbitrary hashes.

## HTTP session and browser boundary

startProtocolServer({runtime}) binds only config.apiUrl's127.0.0.1 port and exposes
host-only issueBootstrap(role) plus close(). Bootstrap credentials are generated
random256bit, one-use, max16,60wall-second expiry and never logged/printed. Role
is selected by the trusted Node host, not an HTTP argument. They enable M12 host
integration; secure browser provisioning/launcher is a later packet requirement,
not a production login claim. HTTP POST /v1/session accepts only bootstrapToken;
it consumes the host capability, sets a random HttpOnly SameSite=Strict cookie
(Path=/v1; no Domain; Secure omitted for this explicit loopback HTTP mode) and
returns session role/address/capabilities plus random session-bound CSRF token.
Sessions expire after30wall minutes, max16; no key or signer capability returned.

Every route checks exact single Host, no forwarded identity, rejects cross-site
Fetch Metadata. POST requires exact Origin apiUrl, application/json, no content
encoding except identity, bounded streamed JSON and no duplicate/unknown fields.
Except bootstrap, require session cookie and matching x-assurepay-csrf on POST.
GET with Origin requires same origin; credentials are always required. No CORS,
redirect, state-changing GET or caller origin/RPC configuration. Responses set
Cache-Control:no-store and fixed safe errors; no raw backend/RPC logs.

Routes: POST /v1/session, POST /v1/logout; GET /v1/session, GET /v1/summary;
GET /v1/providers, /v1/policies, /v1/coverages with exact limit/cursor/filter
query schema (providerId/status filter only for coverages); GET details by ID;
POST /v1/actions/preview {operation}; POST /v1/actions/confirm {previewId};
POST /v1/actions/reconcile {}; POST /v1/evidence/read {coverageId} (adjudicator
only; binary bounded65536bytes through existing backend). Confirm's route is the
explicit app approval boundary; no model tooling can call it with a role label.
Private evidence read signs only the existing fixed backend authorization and
is a POST because that backend consumes a replay nonce. JSON max32768bytes.
No UI/static asset routes yet. API sessions/action tokens/cursors never enter
checked-in evidence; M12 must consume these host interfaces without exposing keys.

## Verification and exit gate

1. Typecheck and all new suites; exact config/capability/argument failures,
   canonical registry/coverage/accounting reads, pagination/anchor/limit errors,
   role-filter/private-field omission and safe errors. Actual EVM Core/faithful
   ERC3009, no model-only financial gate.
2. Every supported operation has actual-EVM authorized execution plus wrong-role,
   denied/absent approval, stale/expired/replayed/concurrent confirm failures
   before signing. Test allowance/exact approve, free-stake withdrawal bounds,
   immutable registrations, pause and explicit claim rejection/refund semantics.
   Preview is signature-free, executed call/event matches normalized approval.
3. Unknown broadcast response persists original hash; restart without signing
   accounts and reconcile original inclusion with zero extra sends/signatures.
   Corrupt/missing/context/limit-changed state, lock collision and prepared-unsent
   stay fail-closed. Assert solvency/reservation isolation after financial actions.
4. Actual HTTP security tests for bootstrap/session authority, Host/Origin/CSRF/
   Fetch-Metadata, duplicate/extra fields, cookies, methods/media/body bounds,
   one-use tokens, session/preview expiry, private evidence and pagination.
5. Separate admin/relayer composition executes real HTTP purchase and key-free
   original retrieval using accepted M10 client; relayer cannot register/pause
   or adjudicate. Default M6/M9 behavior remains; full pilot/provider/client
   regressions pass after the narrow seam, plus new focused composition test.
6. Standalone npm run demo creates only fresh local actors/chain and exercises
   API reads/admin/provider/adjudicator/operator, including evidence/claim
   through accepted client SDK, explicit refund, isolated other locks, unknown
   response/restart reconciliation. Public-only evidence + results/handoff,
   primary and independent Luna review, scope/secret checks, checkpoint commit/
   nonforce push. Clean up temporary actors/runtime/chain; no existing key use.

M11 acceptance does not accept M12 UI, M13 consumer app, M14 presentation,
production auth/custody, authenticated backup rollback, finality or native-USDC
public deployment. All M5 allowances remain consumed; no public mutation implied.

All exit checks pass; primary verification, limits and evidence are recorded in
planning/EVM_M11_RESULTS.md. M12 requires a separate frozen implementation packet.
