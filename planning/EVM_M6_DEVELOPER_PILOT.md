# M6 — runnable local developer pilot

State: ACCEPTED under EVM-039; results: planning/EVM_M6_RESULTS.md. User approved the proposed developer pilot and continued on
2026-10-22. M1–M5 accepted; EVM-038 freezes this packet before dependent code.

## Purpose and gate

A developer can start from clean configuration and complete a paid request,
provider/buyer process restart and retrieval, authenticated evidence, direct
claim and explicit adjudicator refund without editing internal source. Deliver
one reusable provider composition, durable buyer SDK/CLI, claims HTTP API,
restricted action sender and operator CLI, plus a reproducible local example.
Reuse M2 economics/contracts, M3 x402/receipts and M4 encrypted backend. This is
local composition acceptance. M5 native public proof stays preserved; no new
public experiment, funding or production deployment is authorized.

## Scope and references

Read AGENTS.md, SESSION_HANDOFF.md, DECISIONS.md, IMPLEMENTATION_PLAN.md,
planning/EVM_M5_RESULTS.md, packages/{x402-assurance,claims-backend,evm-core,
evm-acceptance}/{README.md,package.json,package-lock.json,tsconfig.json,src,test,
contracts} as applicable. M1 only its faithful fixture/compiler imports and
src/base-receipt-fees.ts. Installed pinned dependency types may be read. No /docs,
populated environments, private wallet files or existing private journals.

Write packages/developer-pilot/**, this packet, planning/EVM_M6_RESULTS.md,
DECISIONS.md, IMPLEMENTATION_PLAN.md and SESSION_HANDOFF.md. Narrow M3 write scope:
src/http-client.ts, src/http-provider.ts and focused test/retrieval.test.ts for
strict restore/retrieval-only support; preserve all existing behavior when absent.
M1/M2/M4/M5 contracts/source/evidence remain read-only. No UI/hosting, contract or
economic changes, automatic adjudication, external commerce, multiple assets/
chains, production key custody, distributed deployment or public transactions.

## Runtime and public configuration

New pinned Node24.18.0/npm11.16.0 package @assurepay/developer-pilot, same TS/tsx/
viem/x402 versions and existing toolchain. PilotConfig is exact version1/mode
local/chainId84532, rpcUrl, core/token, providerId/policyId/serviceId, roles
{relayer,payer,provider,adjudicator}, resourceUrl/claimsUrl, deploymentBlock and
gross (atomic decimal). Four distinct nonzero EOAs. RPC and HTTP listeners are
explicit http://127.0.0.1 numeric-port URLs; native public USDC is rejected in
local config. No public-mode CLI exists in M6. Trusted local RPC is assumed.

Reuse M5 pure withReadQueue/withLogChunks helpers by composition, not campaign
CLIs or wallets. HTTP transport retryCount0; only allowlisted reads retry, <=100
block log chunks; M4 projection maxBlocks25000/maxCoverages1000. New runtime
stores/journals live in caller directories, with no symlink roots. One process
owns provider+claims replay/service/payment state via a lifetime directory lock
and relayer-account lock; no stale-lock takeover. No plaintext key/signature/raw
transaction/evidence logs or public reports. Runtime keys only injected; empty
.env.example placeholders. New ephemeral local demo keys may be generated in
memory or exclusive ignored mode0600 files; existing files are never read/reused.

## Buyer and strict retrieval interface

M3 adds PurchaseSnapshot {version:1,url,bodyHex,trust,maxGross,payer,terms,
requestId,payment}; signatures exist only in memory or encrypted buyer storage.
export restorePurchase({snapshot, url, trust, maxGross, payer, readTerms, now,
verifyPayment, fetch?}) -> Promise<PurchaseSession>. Strict exact schema, binding,
request/body/terms/cap/payment verification; allow expired original authorization
for retrieval. Share existing paid-response/receipt/chain verification. Restore
has no signer or createPayment path; its send/retry always carry exactly
assurepay-retrieve-only:1 and the original payment header/body/requestId.

Provider validates that header (duplicates/other values reject). Its early
retrieval branch precedes reserve/settle/handler: only an existing verified
archived/cached result may return, with exact canonical engine.reconcile proof.
Missing service/payment journal or archive, started/no-result, reorg, wrong key
or RPC failure never falls through to new settlement/handler. A valid archived
result may be recovered without a service marker only if original payment
journal reconciliation proves its exact transaction/block. Keep M3 default
send/retry semantics unchanged.

M6 createBuyer({binding:{url,trust,maxGross,payer},directory,key,client,relayer,
payerSigner?,fetch?}) -> Promise<{prepare(body),send(requestId),retrieve(requestId),
close()}>. prepare returns {requestId,requestHash,coverageId}; persist the exact
snapshot encrypted before exposing it for a paid send. Original paid send is
allowed only from the fresh in-memory session, with an exclusive public attempted
marker fsynced BEFORE the HTTP attempt. Repeated send fails; a new process can
only retrieve. Crash-before-send/after-marker can strand availability; never
silently create/re-sign/retry a payment. No signer needed for retrieve. Buyer
sessions bind independent URL/trust/cap/payer, use a separate encryption namespace
and fail on ciphertext/identity substitution. CLI outputs only public IDs/hashes/
status; body output needs an explicit new file and mode0600, never overwrite.

## Claims HTTP interface (no transaction sender)

startClaimsServer({url,backend,projection}) -> {url,server,close}.
createClaimsClient({url,fetch?}) -> status/uploadEvidence/readEvidence/prepareClaim/
prepareDecision matching existing M4 arguments/results. Fixed loopback POST routes:
- /v1/coverage/status {coverageId}: allowlisted {coverageId,payer,status,gross,
  refundAmount,outcome,expiresAt,observedBlock:{number,hash}} only.
- /v1/evidence/upload {coverageId,bodyHex,authorization}: {evidenceHash}.
- /v1/evidence/read {coverageId,evidenceHash,authorization}: exact binary bytes.
- /v1/claims/prepare {coverageId,evidenceHash,authorization}: PreparedAction.
- /v1/decisions/prepare {coverageId,decision,authorization}: {action,decisionHash}.

Every envelope is exact-schema; auth uses existing M4 EIP712 operation/context/
actor/payload/nonce/deadline and replay checks. Preserve role separation and
opaque evidence. JSON requests/responses <=143360bytes, evidence <=65536bytes;
stream-count bodies before parse. Require one exact application/json header,
identity encoding, exact Host, no redirects/CORS or request logging. Fixed
bounded error codes/statuses; never echo raw exceptions/signatures/private bytes.
Public status never serializes evidenceHash/decisionHash or private objects.
HTTP library owns no blockchain signer/key, and prepares unsigned calls only.

## Restricted claim action sender

createActionSender({context:BackendContext,actor,client,wallet?,account?,journalPath,
polls?,delay?}) -> Promise<{submit(action),reconcile(),close()}>; exported
acquireActorLock(actor) shares the chain84532/actor exclusive OS temporary lock
with provider composition. No cross-directory concurrent actor use; other apps
using these accounts remain outside the lock assumption. Journal context pins
actor/chain/Core/token/adjudicator/serviceId. Read-only reconciliation requires
existing journal and no signer; first fresh submit initializes it safely.

Only fileClaim/finalizeClaim selectors are allowed. Verify exact action schema,
coverage/actor/Core/value0, original observation block canonicality and fresh
coverage/Core token/adjudicator/state via simulation pinned to a numbered head,
then re-read canonical head. Payer files its coverage; configured adjudicator
resolves explicit outcomes/refunds. Fixed gas100000/220000, maxFee100000000wei,
priority1000000wei; no fee escalation or arbitrary-call interface. latest=pending
nonce; opaque signed EIP1559 fields/recovered actor must exactly match request.

Fsync strict public identity {kind,coverageId,transaction,from,to,nonce,calldataHash,
gas,maxFeePerGas,maxPriorityFeePerGas,value:'0',attempted,blockNumber?,blockHash?,
status?} BEFORE one send and attempted=true BEFORE broadcast. No calldata/raw
signature persistence. One action per kind/coverage. Known identities only
reconcile; unresolved/prepared-unsent blocks later submission. Reconcile tx/
receipt/block and every recorded field; uncertain/reorged data fails closed,
never replacement/rebroadcast/new payment. Atomic canonical writes, bounded
journal, nofollow/symlink/context/unknown-field checks and lifetime locks.

## CLI and example

Runtime CLI commands check/provider/purchase/retrieve/status/evidence/claim/
decision/reconcile use --config and explicit --data where needed. Financial
purchase/claim/decision require literal --execute. No secret flags; load relevant
role key/data key through runtime environment, and sign claims API auth in memory.
Decision requires explicit outcome0|1|2, integer refund and reason file. The
service never auto-submits claims or decides outcomes. Reconcile/retrieve need
no transaction signer. Local demo/bootstrap deploys actual M2 plus faithful
ERC3009 fixture on isolated Anvil, seeds ephemeral roles and public config; never
reads existing env or journals. npm run demo executes real CLI/server processes
with provider restart, buyer-process retrieval, claim and refund, prints a
public-only LOCAL_PILOT report and exits. A sandbox entry may keep this isolated
local environment running for manual use with generated ignored role env files.
No local result is described as new native public proof.

## Required verification and acceptance

Primary package typecheck/npm test/npm run demo; M3 typecheck/full regression
suite after narrow changes. Meaningful local EVM/HTTP tests cover actual success
and signed500, independent canonical payment/financial assertions, original
request retrieval across process restart with zero new payer/relayer signatures,
broadcasts/handler, missing journals/archive/reorg/RPC/ciphertext failures, strict
HTTP/auth/role/replay/body/filter errors, action sender signature/nonce/fee/call
substitution, uncertainty/lost-send signer-free reconciliation, prepared-unsent,
terminal duplicate/context/schema/symlink/lock conflicts. No source-string or
model-only financial gate. Primary review plus independent Luna cross-review;
fix blockers before acceptance. Record exact results/limits, update handoff/plan,
commit and non-force push verified main under existing user authorization.
