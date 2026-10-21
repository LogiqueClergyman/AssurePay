# M5 — combined-stack public MVP acceptance

State: IN_PROGRESS (Stage A PREPARED; Stage B approval pending). M4 accepted EVM-026; interfaces
EVM-027/028. Read AGENTS.md, SESSION_HANDOFF.md, DECISIONS.md, IMPLEMENTATION_PLAN.md,
planning/EVM_M4_RESULTS.md and this packet. No `/docs` access.

## Scope and stage gates

Write packages/evm-acceptance/**, this packet, planning/EVM_M5_RESULTS.md and
focused decisions/plan/handoff. Existing M1/M2/M3/M4 code/contracts are read-only.
Read their package README/package/lock/toolchain files, packages/{evm-core,
x402-assurance,claims-backend}/{src,test,contracts}, M2 results and
packages/evm-core/evidence/local-execution.json. M1 allowed reads: src/scripts,
package/lock/toolchain, checked-in .env.example templates and public evidence.
Compiler's existing faithful M1 fixture imports are allowed read-only. Installed
pinned dependency API types may be inspected. Never manually inspect populated
environments/private wallet files or completed private journals.

A: implement/rehearse isolated pinned campaign runner, bounded sender/journal,
public-only manifest, independent signer-free verifier, check-only CLI and
read-only public preflight. Pass local actual M2/HTTP/x402/M4 integration and
adversarial recovery tests. B: present exact roles/funding/transaction/budget
scope for public approval after A. C: only then execute one approved campaign,
reconcile unknown hashes, independently verify native USDC evidence and costs.
M5 is NOT accepted until C passes. No public mutation currently authorized.
M1 approval/normalization is completed and cannot be reused as M5 allowance.

No new contracts, policy/economic changes, production hosting/UI, external
commerce, subjective adjudication, multiple chains/assets, mainnet, role rotation
or distributed deployment. Existing source changes require a recorded scoped need.

## Frozen campaign

Chain84532. Public token fixed native USDC
0x036cbd53842c5426634e7929541ec2318f3dcf7e. Local rehearsal uses the faithful
ERC3009 fixture and reports LOCAL_REHEARSAL only. Four distinct EOA roles:
relayer=Core deployer/admin; payer=USDC sponsor and claim filer; provider=owner/
payout/receipt signer; adjudicator=separate configured resolution EOA. Existing
M1 payer/relayer/provider may be loaded through runtime environment only; prepare
a fresh ignored mode0600 adjudicator/result-encryption config if needed. Do not
modify/reuse the completed M1 journal as a fresh run. Generating local config
is reversible preparation; funding/transfers/public txs require Stage B approval.

One actual M2 Core, one immutable provider and policy. Policy: premium777bps,
stake3500bps, withholding2200bps, duration3600seconds, poolOnlyAllowed=true.
Per purchase gross10003 atomic, P777/W2029/net7197/L3502/Q10003. Payer approves
exact23508 native-USDC units, donates stake3502 and pool20006, then pays two
gross purchases (20006 total). Maximum initial USDC allocation43514atomic
(0.043514 test USDC). No arbitrary spender approval/USDC transfer.

PurchaseA: fixed synthetic byte handler returns200; actual registered x402 client/
server/facilitator upfront settlement; repeat/restart response matches encrypted
result without another payment/signature/handler. Upload synthetic evidence via
M4 auth; payer fileClaim; separate adjudicator explicitly prepares ProviderFault
refund3100 to stored payer. PurchaseB: handler throws and returns signed500;
M4 evidence/claim and explicit PoolOnly full refund10003. These are predefined
acceptance fixtures, not an evidence classifier or service-quality judgment.
Finally admin pauses, then sends a third independently valid receive-authorization
Core settlement intent: included reverted receipt, unused nonce, no coverage or
USDC/ledger change. This is a distinct negative case, never a replacement payment.
No unpause needed; existing claims/refunds are already resolved.

Exactly14 protocol steps, ordered (actor/gas caps):
deploy(relayer/3200000),provider(relayer/150000),policy(relayer/200000),
approve(payer/100000),stake(payer/170000),pool(payer/110000),
purchaseA(relayer/800000),claimA(payer/100000),resolveA(adjudicator/220000),
purchaseB(relayer/800000),claimB(payer/100000),resolveB(adjudicator/220000),
pause(relayer/80000),revert(relayer/800000).
Gas caps sum7050000. maxFee100000000wei, priority1000000wei. Aggregate L2 execution
allowance705000000000000wei plus auxiliary L1/operator reserve200000000000000wei
=905000000000000wei (0.000905 test ETH). Per-role targets: relayer703000000000000,
payer108000000000000, adjudicator94000000000000wei. These are allowances/funding
targets, not spend estimates. Public preflight must measure actual balances and
fee feasibility before any proposed vault shortfall top-up. Up to3 funding
transfers may be proposed separately:21000gas each with same fees, aggregate
aux reserve3000000000000wei, maximum funding-fee allowance9300000000000wei.
Maximum campaign+funding allowance914300000000000wei (0.0009143 test ETH).
No actual transfer is approved yet. Account insufficiency/fee change stops;
no fee escalation, replacement or automatic retry/top-up.

Base has separate L2 execution and L1 publication fees; maxFeePerGas does not cap
L1 fee. Preserve measured auxiliary fields only after matching raw receipt identity,
report unavailable fields honestly. Funds-only safety needs no concurrent incoming
funding/account use. Rehearsal/preflight must validate caps and exact target sums.
Official references checked2026-10-21:
https://developers.circle.com/stablecoins/usdc-contract-addresses and
https://docs.base.org/specifications/transactions/network-fees.

## Models and component boundaries

Parent-owned src/types.ts defines RunConfig, Roles, StepKind, StepSpec,
TransactionRecord, CampaignManifest and report types. Amounts/nonces/gas/fees/
blocks decimal strings; addresses/hashes canonical lowercase; strict bounded
schemas. RunConfig holds version1, mode local|public, chain84532, token, roles,
runId/providerId/policyId/serviceId, resourceUrl and frozen fee settings. IDs
nonzero bytes32. ResourceURL is configured canonical localhost POST route;
request IDs deterministic from runId/case; exact synthetic bodies source fixtures.
No private bodies or payment/header signatures in manifest/journal/artifacts.

plan.ts exports STEP_ORDER/GAS_CAPS, budgetSummary(config), validateConfig,
stepActor(kind), expected economic constants. Sender receives exact StepSpec
{kind,actor,to:address|null,data:Hex}; data exists only in memory and is never
journaled. Orchestrator generates expected target/calldata from compiled M2 ABI
and pinned amounts/IDs/prepared M4 actions. No public CLI arbitrary calldata input.
Sender enforces order/actor/target/value0/gas/fees/signature-from and exact supplied
calldata, fresh current=pending nonce, and configured cumulative allowance.

await createCampaignSender({config,client,wallet,accounts,journalPath,polls?,delay?})
returns prepare(spec):Promise<Hex>, broadcast(kind,raw):Promise<Hex>,
submit(spec):Promise<TransactionRecord>, observe(kind):Promise<TransactionRecord>,
read():CampaignManifest. wallet.signTransaction is opaque; accounts
mapped by actor. prepare derives hash locally, validates parsed signed tx fields
and recovered sender, fsyncs immutable public identity before returning raw bytes.
broadcast fsyncs attempted=true before exactly one send, verifies raw hash/identity;
unknown response never means failure. Existing records only reconcile; prepare
must not sign an existing kind or any later kind while previous is unresolved.
Record {kind,transaction,from,to,nonce,calldataHash,gas,maxFeePerGas,
maxPriorityFeePerGas,value:'0',attempted,blockNumber?,blockHash?,status?}.
Manifest {version:1,config,core:address|null,transactions:TransactionRecord[]}.
Deployment core address derived from relayer nonce; no external core supplied.
Atomic public JSON journal with strict context/schema/immutable record identity,
nofollow/regular-file checks, fsync, no replace. A prepared-but-unbroadcast record
is stranded; read-only recovery never broadcasts or generates another payment.

M3 engine wallet/client adapters use sender.prepare/broadcast for purchase steps,
plus its existing separate payment journal; both identities precede submission.
The frozen orchestrator validates engine's transaction request against exact
prepared call/settings. Setup/claims/decisions/pause/revert use sender.submit.
No direct unjournaled public mutation. Known record recovery is read-only.

Independent verifyCampaign({client,manifest,artifact,allowLocalFixture?:boolean})
fetches each tx/receipt/block itself, validates all14 ordered actor/target/input/
nonce/gas/fee/status identities and canonical hashes, creation bytecode+constructor
args/deployed Core immutables, exact provider/policy hash/economics/seed amounts.
It reconstructs settlement call/receive signature from public tx calldata IN MEMORY
and uses actual M3 verifier; never serializes signature/calldata/raw transactions.
Verify receipt logs and canonical per-step token/ledger/coverage state including
claim pins/refund waterfall/pool-only/revert unchanged state. Compare current/final
solvency, aggregate ledgers, one-time statuses and unused negative nonce. Strict
complete manifest; local mode cannot produce a public proof result. Preserve an
independent canonicality re-read of all inclusion anchors at verification end.
Public output only hash/address/atomic amounts, calldata hash/bytes, fee/status/
block metadata. One canonical inclusion, not finality or traced revert cause.

HTTP/results/encryption/handler counts are measured by runner with real wrappers
and opaque signatures in memory; independent chain verifier cannot prove private
HTTP bytes, execution count, evidence truth or encryption from chain alone.
Separate local/observed transport checks from independently public financial facts.
Public settlement calldata inherently exposes its signature; guarantee only that
our artifacts/journals/logs do not duplicate it. No post-receive M2 rollback claim:
paused admission reverts before USDC receive; M2 local failure tests remain distinct.

## Scripts, environment and recovery

New package pinned existing Node/npm/viem/TS/tsx versions; @x402/core2.28 for HTTP
codec/test only as needed. Reuse M2 compiler read-only, never redeploy M1 fixture
publicly. Runtime --env-file permitted for explicit read-only config/balance checks
through new scripts; never cat/parse populated env files manually. Default scripts
must be check/reconcile; public run needs --execute and a new exact M5 scope value
plus Stage B approval recorded. Existing M1 scope cannot authorize anything.

Funding has a distinct `m5-fund-campaign-roles-once` scope in addition to the
campaign scope. buildFundingPlan reads canonical balances/nonces and proposes
exact role shortfalls; fundCampaign signs only explicitly permitted missing
steps and persists public identities before a single broadcast. reconcileFunding
uses only the stored plan/known hashes without keys or new transfers. Actual
included fee/balance measurements, never preflight estimates or gas allowances,
explain vault balance changes before another step. No funding journal is reused
from M1. Public mutation and journal-reconciliation CLIs share an exclusive
run.lock before journal initialization; stale locks fail closed, no takeover.

Provide local rehearsal CLI using isolated Anvil/temp dirs, actual14-step campaign,
HTTP receipts/durable restart/M4 operations/invariants and independent verification.
Provide check-only public preflight with public addresses/chain/token/domain/balances/
fees/shortfalls; no signer/file creation/transactions by default. Execution/recovery
entry points must be concrete/reviewable before Stage B. Existing M1 private
journals remain untouched. New fresh journal paths only; output fixed codes and
public metadata, never raw exceptions/signatures/signed blobs/keys/endpoints.

## Stage A verification and stopping rule

Compile/typecheck + npm test in packages/evm-acceptance. Actual local M2 execution
of complete14-step runner, correct quotes/balances/locks/reservations/refunds,
signed500/200+durable restart counters, independent verifier success. Meaningful
negative tests: manifest tamper/unknown fields, wrongroles/chain/token/config,
wrong to/data/nonce/value/gas/fee/signer, repeated/out-of-order steps, missing hash/
receipt/RPC/canonical mismatch, immutable journal context/schema/symlink/conflict,
lost broadcast, prepared-no-broadcast crash, signer-free read-only recovery with
no signing/broadcast, verifier rejects incomplete/reverted-success/refund/fee/
state/log mismatches. No evidence file includes sensitive fields. Primary verification
and independent scoped review. Report exact tests/rehearsal gas/budget and remaining
public-proof limits in M5 results. Commit/push verified checkpoints to main.

After Stage A stop before public mutations, present exact Stage B request. Stage C
remains pending until approval/funding/public execution/independent proof. No M5
acceptance from local rehearsal, mockUSDC, read-only state or code review alone.
