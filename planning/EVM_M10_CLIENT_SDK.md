# M10 — local client SDK, approval and agent integration

Date:2026-10-23; accepted2026-10-24 under EVM-048, implemented under EVM-047
after accepted M9 at51ad845. Results: planning/EVM_M10_RESULTS.md.
User authorizes continuation, Luna(high), verification and checkpoint commit/
non-force push to main. Local only; no public chain, publishing, UI or hosting.

## Gate and scope

Deliver private/packable @assurepay/client-sdk0.1.0 Node ESM, clean root JS/types,
a framework-neutral agent adapter in that package, a packaged portable skill,
a separate plain Node consumer example and outside-repository actual-EVM proof.
Preview/denied approval signs nothing. Approved authorization revalidates the
same quote/identity, reserves persistent session budget before signing, encrypts
the original payment before exposing one send, and survives process restart
through signer-free original-request retrieval. Include payer evidence/claims
and canonical coverage/outcome/token-balance reads. No adjudicator capability.

Read AGENTS/handoff/decisions/plan; planning/EVM_PRODUCT_ROADMAP.md and accepted
M6/M7/M8/M9 packets/results; packages/{developer-pilot,x402-assurance,
claims-backend,evm-core,provider-sdk}/{src,test,scripts,contracts,README.md,
package.json,package-lock.json,tsconfig.json,toolchain.json} as applicable;
examples/data-profile-service/** excluding environments/state/dependencies;
only evm-acceptance/src/{read-queue,log-chunks,run-lock}.ts; imported M1 faithful
fixture; root .gitignore; installed pinned dependency types/source. The primary
has read skill-creator/SKILL.md; its validator may be read/run for the portable
artifact. No /docs, populated environments, existing wallets/private journals.

Write packages/client-sdk/**, examples/assured-client/**, this packet,
planning/EVM_M10_RESULTS.md, DECISIONS.md, IMPLEMENTATION_PLAN.md and
SESSION_HANDOFF.md. Narrow compatibility changes only:
packages/x402-assurance/src/http-client.ts and focused test/preview.test.ts;
packages/developer-pilot/src/buyer.ts and focused test/preview.test.ts.
Do not change settlement/contracts/economics/receipt/hash formats, existing CLI,
M4/M5 logic, M9 sources or previous evidence. Build/test outputs are ignored.

## Underlying compatibility changes

Factor M3's existing challenge/requirements/trusted-terms validation into
createPurchasePreview (no signer). An internal unsigned preview contains the
same request ID/hash, copied URL/body/trust/cap/payer and validated Terms.
authorizePurchase copies/validates that preview, fetches a fresh unpaid challenge
with the SAME ID/body, rereads trusted terms and compares the complete binding/
quote before signing. Any change rejects PREVIEW_STALE. Existing createPurchase
retains its one-challenge behavior using the same internal validator/session
constructor; do not introduce a second challenge into legacy callers.

Extend M6 Buyer with preview(body) and authorize(requestId). Keep unsigned
previews private/in-memory, return isolated copies, consume once before awaits;
authorization uses the new M3 revalidation, then the existing encrypted snapshot
and fresh-send persistence path. Keep legacy prepare behavior, send attempted
marker and strict retrieve behavior compatible. No signer is needed to preview
or retrieve. Closing drains operations and clears volatile capabilities.

## Package/public API

Reuse M9 build strategy: pinned esbuild0.25.12, whole-source tsc checking and
TypeScript5.9.3 transpileDeclaration on explicit SDK-owned index/types. Exact
runtime viem2.57.7/@x402/core2.28.0; dev @types/node24.10.1/tsx4.20.6.
Node>=24.18.0, private:true, root-only exports dist/index.js/index.d.ts;
files allowlist dist, README.md and skill. Emitted dist exactly index.js,
index.d.ts,types.d.ts, no sibling imports/maps/fixtures/campaign/compiler/state.
Portable skill path: skill/assurepay-client/SKILL.md (inside this package).
No new license grant, registry publication, global skill install or install hook.

Root functions (explicit SDK-owned types; no generic client/wallet injection):
validateClientConfig(unknown), readClientConfig(path), createClient(options),
clientErrorCode(unknown), createAgentTools(options). Safe errors use fixed
allowlisted codes or CLIENT_OPERATION_FAILED, never arbitrary exceptions.
ClientConfig preserves M6's exact v1 local/84532 public schema and URL/native-
USDC rejection; config.roles.payer binds all client authority. Retain role
coupling explicitly; M11 role decoupling is separate.

ClientOptions={config,maxGross:string,budget:{maxTotalGross:string,
maxPayments:number},storage:{directory,key:Uint8Array},payerAccount?:LocalAccount}.
Amounts are canonical atomic uint256 decimal strings, maxGross>=2 and <=total;
maxPayments integer1..64. Copy config/key and bind account methods before awaits.
The optional account must match configured payer. No key-string/environment
loader in SDK. Absence enables preview/read/recovery only, not new authorization,
evidence auth or claim submission. Claims recovery must pass no wallet/account.

Client methods:
- preview(body:Uint8Array):Promise<ClientPreview>. Max65536 bytes, max32 volatile
  previews. Public preview exposes requestId/requestHash/bodyHash, canonical URL,
  payer/service ID, maxGross, complete relevant Terms and expiresAt (120seconds
  from chain clock). It contains no raw body, signature, payment or calldata.
- authorize(requestId,approval:{approved:true}):Promise<AuthorizedRequest>.
  Literal explicit approval is required; never call from preview/read. Consume
  the private preview, verify freshness/revalidate quote before signing. Return
  only requestId/requestHash/coverageId after encrypted persistence.
- send(requestId):Promise<ClientResult>. One new paid attempt from this process.
  Persist attempted state before M6's fsynced attempted marker and HTTP boundary.
- retrieve(requestId):Promise<ClientResult>. Existing encrypted identity only;
  never authorize/send a new payment, including after expired authorization.
- readState(coverageId?:Hex):Promise<ClientState>. One numbered canonical head
  binds Core token/adjudicator context, configured payer token balance and
  optional own service/policy coverage. Recheck that numbered head. Return
  decimal atomic values/status/outcome/refund/expiry and {number,hash,timestamp};
  exclude private evidence/reason/decision data. Reject foreign/missing coverage
  or RPC/reorg/context failures; no invented cached state.
- uploadEvidence(coverageId,body), readEvidence(coverageId,evidenceHash): fixed
  payer-only existing backend operations, bounded65536bytes; auth stays internal.
- fileClaim(coverageId,evidenceHash,approval:{approved:true}): payer-only, active/
  unexpired own coverage, fixed fileClaim selector/arguments. Reuse M6 auth,
  private prepareClaim and restricted sender (gas100000/maxFee100000000/priority
  1000000wei). No arbitrary PreparedAction/operation/actor/call surface.
- reconcileClaims(): known original hashes only, signer-free; no replacement.
- close(): drains operations and releases SDK/buyer/sender locks, idempotent.

ClientResult is confirmed with public IDs, status, body bytes, transaction,
paymentBlock{number,hash}, safe receipt message and receiptFingerprint; or
retrieval-required with original IDs and no success inference. Fingerprint is
keccak256(UTF8 JSON tuple [chainId,core,coverageId,requestHash,responseHash,status,
completedAt,signature]); return the hash, never the signature. Pending/timeout/
invalid proof retains the original identity and blocks another new payment.
Claim results expose only coverage/evidence IDs, original transaction, status
and inclusion anchor, with no calldata/signature/private paths.

## Persistent budget and uncertainty

SDK owns one private directory with lifetime exclusive lock and a bounded0600
atomic/fsynced session.json. Header binds full config, payer, per-request cap,
total cap and maxPayments by namespace hash. Reopening with changed limits or
context, malformed data, symlinks or missing existing state must fail closed;
no automatic reset/stale-lock takeover. Buyer state is in its own subdirectory.
Limits apply per configured persistent directory/session, not globally across
accounts or arbitrary new host-created sessions. Agent tools cannot choose one.

Immediately before forwarding the payment signTypedData call, persist a reserved
record with requestId/hash, gross and coverageId from the validated authorization
nonce. This happens after fresh challenge/terms validation and before signing.
Serialize authorization; count reserved/authorized/attempted/confirmed records
against both limits. No automatic budget release after the signer boundary.
Mark authorized after encrypted snapshot, attempted before send, confirmed only
after verified result. Any unresolved record blocks new authorization. On
uncertain retrieval preserve the identity and closed admission. Crashes between
reserve/sign/persist/send may strand availability; no re-sign or replacement.
Rechecking a confirmed result first durably marks attempted before retrieving;
a failed guard write stops before the read. Uncertainty leaves that guard intact.
The genuine original result may close an unresolved record through retrieval.
Denial/stale quote/expired preview before signing reserves nothing. Reopening
with missing buyer state must never permit reauthorization of a reserved ID.

## Agent tools, skill and example

Single package createAgentTools({client,approvePayment}) returns fixed JSON
schemas plus invoke(name,args). Host callback receives the immutable public
preview and must return literal true per new payment. Tools accept no approval,
signer, cap, actor, endpoint, generic operation or transaction fields. Exact
runtime argument validation matches schemas (additionalProperties:false):
assurepay_preview({bodyBase64}), assurepay_pay({requestId}),
assurepay_retrieve({requestId}), assurepay_state({coverageId?}).
Only a preview made through this adapter may be paid; consume it before awaits.
Denial signs/sends nothing. Changed quote needs fresh preview and host approval.
Session bounds are enforced by the real SDK's persisted budget. Tool output is
JSON-safe IDs/amounts/anchors/status and bounded bodyBase64/safe receipt metadata,
never payment headers, signatures, calldata, keys or private paths. No claim or
decision tool; payer claims are explicit SDK app methods, adjudication separate.

The portable skill documents these real tools, required host setup, review and
approval, original-ID recovery and untrusted service output. It grants no funds,
endpoint discovery, claim decision or shell/private-file authority. Validate
frontmatter and independently rehearse the skill/tool workflow on local fixtures.
No global skill configuration is changed.

examples/assured-client is plain Node ESM using only SDK root/declared viem
helpers and runtime environment. It demonstrates one explicit host-approved
payment, denial/preview, recovery without payer key, state and payer claims.
No deployment/funding or adjudicator key. Empty env template; no secret flags/
outputs. An explicit host --approve flag may authorize that one CLI invocation;
it is not a model/tool argument or permission for later new payments.

## Required verification

1. Primary typecheck/build/new unit suites; M3 full suite, M6 full pilot and M9
   full SDK regression. Legacy challenge count/behavior remains compatible.
2. Actual tarballs installed outside repo, no source aliases/runtime symlinks/
   tsx in provider/client processes. Root JS/types work; deep imports blocked;
   positive/negative TS API cases; exact six-file package allowlist including
   skill; example syntax/checkJs. No publication.
3. Actual local M2/faithful ERC3009: unsigned preview and denied host approval
   0signatures/settlements; changed quote/expiry rejects before signing; approved
   same-ID purchase with exact calldata/coverage/token deltas/solvency.
4. Persisted limits and concurrency prevent overspend before signatures. Lost
   paid response leads only to original retrieval after fresh CLIENT OS-process
   restart without payer signer, with same body/receipt/transaction and no extra
   payer/relayer signatures, broadcasts or handler work. Unknown blocks new pay;
   corrupt/missing state, cap/context changes and RPC/reorg fail closed.
5. Separate signed500, payer evidence + approved claim on actual EVM, wrong-role
   and premature/duplicate claim rejection/reconciliation. An external test-only
   adjudicator explicitly refunds; SDK anchored state/balance matches actual
   refund and preserves the other coverage locks. No adjudication SDK export.
6. Agent cannot mint approval/bypass callback/caps or select arbitrary calls.
   Independent skill forward-test uses real tools/public exports, observes
   denied/approved/uncertain paths without private tool outputs. Primary reviews
   and closes independent Luna findings. Standalone npm run demo and public-only
   evidence, results/handoff, scoped secret/diff checks, commit/nonforce push.

Fresh isolated local actors only; runtime fixtures deleted. Existing public
budgets remain consumed. Canonical local inclusion is not native-USDC proof,
finality, backup integrity, production custody or M11–M14 acceptance.
