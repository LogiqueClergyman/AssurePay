# M4 — encrypted results, evidence and claims backend

State: REVIEW. Implementation/typecheck/16 backend tests and 28 M3 regression
tests pass; results: planning/EVM_M4_RESULTS.md. M3 accepted under EVM-022.
Interfaces frozen by EVM-023/024.
Read AGENTS.md, SESSION_HANDOFF.md, EVM-016..024 in DECISIONS.md,
IMPLEMENTATION_PLAN.md, planning/EVM_M2_FINANCIAL_CORE.md and
planning/EVM_M3_RESULTS.md. This packet is self-contained. No `/docs` access.

## Scope and exit condition

Write packages/claims-backend/**, this packet/results and focused decisions,
plan/handoff. Narrow M3 writes: src/{types,engine,http-provider}.ts and
 test/helpers/integration.ts for an optional durable-result store; preserve
memory-only default behavior and all existing tests. Read-only M2 contracts,
src/tests/package/lock/README; M3 src/tests/package/lock/README and installed
pinned dependency APIs. No populated environments or public wallet operations.

Deliver an isolated pinned library backend, AES-256-GCM immutable encrypted
objects, optional provider durable-result integration, canonical bounded chain
projection, operation-authenticated payer evidence and unsigned claim/decision
preparation, actual local-EVM/HTTP/restart/reorg/failure tests and independent
scoped review. No new contracts, economic/role changes, HTTP claims server,
production UI/TLS/hosting, distributed failover, subjective/automated adjudication,
multiple chains/assets or public mutation. Public combined-stack native USDC
acceptance remains M5. Stop at M4 REVIEW.

## Configuration and shared objects

Use Node24.18/npm11.16, viem2.57.7, TS5.9.3, tsx4.20.6, existing pinned M2
Solidity/Anvil test tooling. Use runtime-injected 32-byte key and bounded keyId;
never persist plaintext keys, signatures, signed transactions or populated envs.
Receipt signatures may be persisted only inside encrypted objects. No logs of
sensitive data or raw RPC errors; fixed uppercase error codes.

BackendContext: {chainId:84532,core,token,adjudicator,serviceId:nonzero bytes32}.
Canonical JSON uses sorted object keys recursively, arrays retain order; reject
non-JSON types, unsafe numbers, unknown fields at public schemas. IDs/hashes are
nonzero lowercase bytes32; addresses canonical lowercase. Atomic uint amounts
are canonical decimal strings, no float money. One configured backend instance,
trusted local durable storage and RPC; no authenticated backup/rollback defense.

OpeningAnchor: {transaction,blockNumber:decimal,blockHash,logIndex:decimal}.
CoverageView: {coverageId,payer,providerId,policyId,policyHash,requestHash,gross,
premium,withheld,stakeLock,poolReservation,openedAt,expiresAt,poolOnlyAllowed,
status:number,evidenceHash,decisionHash,refundAmount,outcome:number,opening}.
Snapshot: {version:1,context,fromBlock,head:{number,hash,timestamp},coverages}.
PreparedAction: {chainId:84532,to,from,data,value:'0',coverageId,
observedBlock:{number,hash}}. This is an unsigned, simulation-ready proposal;
on-chain roles/state and the caller's own wallet remain final.

## Encrypted object store

EncryptedVault({directory,namespace:64 lowercase hex,keyId,key:Uint8Array})
exposes put(kind:'result'|'evidence'|'decision',id:bytes32,value:JSON):Promise<void>
and get(kind,id):Promise<JSON|undefined>. Bound serialized plaintext to262144
bytes. Snapshot input before awaits. AES256GCM with fresh random12-byte IV and
16-byte tag. AAD binds version1/namespace/keyId/kind/id. Strict bounded envelope
contains only that public identity, IV/tag/ciphertext. Use nofollow regular-file
checks, mode0600, exclusive creation and fsync file/parent; serialize put conflicts.
Objects immutable: same validated content may be idempotent, different content
under same identity fails. Wrong key/id/context/AAD/tamper/truncation fail closed;
never silently treat corruption as missing. Key rotation, deletion/retention and
KMS are outside this local phase. Losing the injected key loses decryption.

## Durable HTTP result integration

M3 defines DurableServiceResult {coverageId,requestHash,transaction,blockNumber,
blockHash,status,body:Uint8Array,receipt:SignedReceipt} and ResultStore
{put(context:string,result):Promise<void>,get(context,coverageId,requestHash):
Promise<DurableServiceResult|undefined>}. ProviderOptions.resultStore is optional.
Backend createResultStore(vault) implements this interface, stores bounded body
as encoded bytes with signature encrypted, binds service context in the object.
No payment authorization/calldata/signed transaction is retained.

Order: reserve -> canonical settle -> live coverage -> fsynced started -> handler
-> signed bounded result -> encrypted immutable result fsync -> completed marker
fsync -> cache/HTTP. A crash between encrypted result and completed marker leaves
a started row with recoverable result; verify before completing it. Started
without result remains indeterminate. Completed without result remains unavailable.
Never execute handler or create a payment during result recovery.

On configured durable retrieval, including in-memory cache retries, independently
reconcile the original payment through engine.reconcile(call) (read-only, no
new signing/submission, required when resultStore is configured), require its canonical
confirmed transaction/block anchor to equal the archived identity, verify exact
receipt owner/body/status/request/coverage and journal metadata. A reorged opening
or RPC uncertainty cannot release a stored response. Retrieval does not require
coverage still Active/unexpired. Preserve the legacy no-store semantics.

## Canonical projection

createProjection({client,context,journalPath,fromBlock:bigint,maxBlocks?:number,
maxCoverages?:number}) returns {refresh():Promise<Snapshot>}. Default caps5000
blocks/1000coverages; bounded overrides only. Latest-head canonical inclusion,
not finality. Each refresh fully rebuilds from configured deployment scan start:
verify chain/Core/token/adjudicator and code at one pinned head; enumerate actual
CoverageOpened events, reject duplicate/conflicting/removed/noncanonical logs,
bind event identity/open time/economics to coverages at head. CoverageCount must
equal discovered IDs, so a scan start omitting earlier coverage fails closed.
Read all mutable claim status/evidence/decision/refund fields at that same head.
Check each opening block hash and recheck head after reads. Persist namespace,
scan start and fresh snapshot atomically (temp fsync/rename/parent fsync). Existing
malformed/cross-context checkpoints fail closed; a valid old orphaned checkpoint
is rebuilt, not used as authorization. RPC/range/state mismatch leaves committed
snapshot intact and returns failure. No stale snapshot getter for authorization.
Full rebuild removes orphaned claims/refunds/coverage after same-height or deeper
Anvil reorg; encrypted objects remain but their opening anchor no longer grants
access or claim preparation. Reopening the same coverage ID on a different
canonical opening must not inherit the old evidence/result.

## Authentication and evidence/claim APIs

Programmatic library, no new claims HTTP transport or backend transaction sender.
Signed Authorization {actor,operation,coverageId,payloadHash,nonce,deadline,
signature}; runtime signature only. Domain {name:'AssurePayBackend',version:'1',
chainId:84532,verifyingContract:Core,salt:serviceId}. Primary BackendOperationV1:
actor(address),operation(string),coverageId(bytes32),payloadHash(bytes32),
nonce(bytes32),deadline(uint256). Operations exactly uploadEvidence/readEvidence/
prepareClaim/prepareDecision. payloadHash=keccak256(canonical JSON of exact
operation payload); upload payload uses exact bodyHex bytes. Strict schemas.
Verify EOA recovery, operation/coverage/payload/context, exclusive deadline>fresh
chain time and deadline<=time+300. Durable serial replay journal consumes
keccak(actor,nonce) before operation side effects. Same nonce is never accepted
again; interruption may consume an operation without returning it. Retrying reads
or preparation uses a new authorization; this creates no blockchain transaction.
No server challenge endpoint needed: random client nonces plus durable used-set
supply bounded single-process replay protection. Cap used entries10000; fail closed
at cap. No signatures/payload hashes/private evidence in replay metadata.

createClaimsBackend({context,projection,vault,replayPath}) exposes:
- uploadEvidence(coverageId,body:Uint8Array,auth) -> evidenceHash. Payer only,
  Active and before expiry; one opaque nonempty bundle<=65536 bytes. Commit one
  record {version:1,kind:'evidence',context,coverageId,opening,payer,requestHash,
  salt:random bytes32,bodyHex}. evidenceHash=keccak(canonical record). The random
  secret salt is stored only encrypted to prevent public hash dictionary guesses.
  Vault stores record under that digest; verify digest on every read. Multiple
  uploads allowed; preparing a claim chooses exactly one immutable bundle.
- readEvidence(coverageId,evidenceHash,auth) -> bytes. Stored payer may read their
  matching canonical coverage; configured adjudicator may read only ClaimPending
  or Refunded/Rejected with the exact on-chain evidenceHash. Match full opening.
- prepareClaim(coverageId,evidenceHash,auth) -> PreparedAction. Exact stored payer,
  Active, now<expiresAt; encrypted evidence/context/opening/digest must match.
  Encode fileClaim(id,evidenceHash); backend never submits or signs a transaction.
- prepareDecision(coverageId,{outcome:0|1|2,refundAmount:string,reason:string},auth)
  -> {action:PreparedAction,decisionHash}. Configured adjudicator, ClaimPending,
  existing exact encrypted claim evidence required. Explicit nonempty reason
  <=8192 UTF8 bytes, canonical integer refund. Reject requires0; refund outcomes
  require0<R<=gross; PoolOnly requires stored flag. Encrypt salted immutable
  decision record binding context/opening/payer/evidenceHash/outcome/refund/reason.
  decisionHash commits that record, then encode finalizeClaim. No outcome selected
  by backend. Contract transaction from adjudicator attests selected commitment;
  backend signature checks do not prove evidence truth or independent reason review.

Payloads respectively {bodyHex}, {evidenceHash}, {evidenceHash}, and
{outcome,refundAmount,reason}. Export operationTypedData and operationPayloadHash
helpers for opaque callers. Snapshot all mutable inputs before asynchronous work.
Every API refreshes canonical projection before checking role/state/time; stale
checkpoint and reorged ClaimFiled never authorize adjudicator access/decisions.
A prepared call may become stale before inclusion; no backend submission/retry
logic is inferred. Users may bypass backend and call Core directly; absent local
evidence then fails backend access/preparation without changing on-chain rights.

## Required gate

Run npm run typecheck and npm test in both packages/claims-backend and
packages/x402-assurance. Actual local-EVM execution and invariants required for
payer fileClaim and configured adjudicator reject/partial/full provider-fault /
allowed pool-only outcomes; invalid roles/state/amounts and disallowed pool-only
must fail without financial mutation. Test claim pending beyond expiry unchanged.

Required negatives: auth replay, cross operation/body/coverage/Core/serviceId,
wrong actor, expired/far-future deadlines; wrong key/ciphertext/tag/AAD/object ID,
missing/truncated/oversized object and symlink; immutable replacement/conflicts;
restart durable decrypt and replay prevention; no plaintext result/evidence/
receipt signatures on disk; storage failure never reruns a handler.

Compose real M3 HTTP, registered x402 and M2 EVM with encrypted results. Restart
recovers exact response/status/receipt without payer/relayer signing/broadcast or
handler again; no-archive started remains indeterminate. Simulate encrypted-result
written before complete marker and recover without handler. Orphaned payment/result
must not serve. Default M3 regression suite must remain green.

Projection tests use actual Anvil snapshot/revert/replacement branches: remove
coverage/claim/decision after rollback, recover across backend process-style
restart, reject stale evidence for reopened ID/different opening, wrong context,
scan bound, RPC and canonical mismatch; committed checkpoint remains unchanged
on failed refresh. Compare exact refund/payer balances and collateral invariants.
Independent scoped review + primary verification. Record counts/limits/changed
paths and exact next action in planning/EVM_M4_RESULTS.md; stop at M4 REVIEW.
