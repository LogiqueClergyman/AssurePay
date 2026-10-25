# EVM decision log

Date: 2026-10-18. Record evidence and consequences before code depends on a
choice. Proposed mechanisms remain replaceable until their phase gate passes.

## EVM-001 — Product direction and initial chain

Status: ACCEPTED. Source: user instruction and Base selection.

Build provider-integrated assurance for x402 services on EVM, initially Base
Sepolia with native test USDC. Retain the product objectives: one gross price,
atomic payment/coverage, collateral-constrained admission, verifiable evidence
and approved refunds to the original payer. No multiple-chain abstraction or
mainnet deployment in the first MVP.

## EVM-002 — Independent technical design

Status: ACCEPTED. Source: explicit user instruction.

Technical choices are evaluated for this EVM implementation. The payment scheme,
x402 call type, token authorization, settlement composition, contract shape,
storage, evidence and claims mechanisms may change when an alternative better
serves the protocol. Reusing a name or pattern is not evidence for choosing it.
Compare compatible standard mechanisms before freezing a custom profile.

The architecture/MVP are a reviewed starting proposal, not an immutable ABI or
proof of compatibility. M1 investigates and records the actual supported path
before dependent financial-core/SDK code is written.

## EVM-003 — Intent-bound receive authorization candidate

Status: PROPOSED. Phase: M1.

Candidate: one relayed Core call uses native USDC receive authorization with a
nonce committing the complete assurance intent, creates coverage and pays
provider net atomically. Bind chain, Core, token, payer, provider, immutable
policy/hash, request/hash, gross, random salt and validity bounds. EOA first.
Candidate wire identity is `assured-exact` / `assurepay-evm-v1`; use a different
safe supported scheme if Gate A demonstrates a better fit.

Prove deployed token ABI/domain, term binding, signature-extraction resistance,
nested rollback and real registered x402 integration. Ordinary token transfer
followed by independent coverage creation fails the product invariant.
Permit2 witnesses, wallet execution and other x402 modes remain alternatives;
compare approval/gas, atomicity, liability timing and operational dependencies.

## EVM-004 — Funding and collateral baseline

Status: PROPOSED. Phase: M2.

Use integer premium floor with a one-unit minimum and per-coverage ceiling stake
locks. Allow immutable policy revenue withholding into provider-owned stake in
the settlement call. Reserve the maximum permitted pool contribution for each
live coverage: gross when pool-only refunds are allowed; gross minus its exact
stake lock otherwise. Keep stake and pool ledgers separate. Explicit pool
funding is a donation in MVP, with no share token or withdrawal right.

This conservative funding rule requires seeded capital when premiums alone
are insufficient. Changing it is an economic design decision, not merely a gas
optimization. Provider-fault recovery may consume that provider's free/released
stake while protecting other coverage locks and unrelated providers' stake.

## EVM-005 — Claims, expiry and MVP trust boundary

Status: PROPOSED. Phase: M2.

A payer registers a claim on-chain before expiry. Pending claims preserve
stake/pool locks until one adjudicator finalizes a terminal resolution. Refund
is capped by stored coverage and paid only to stored payer. Direct filing costs
payer gas in the first profile; adjudicator outage can lock pending collateral.
No automatic timeout release/rejection/payout is assumed.

Pause blocks new admission and registration but allows funding, deposits, safe
withdrawals, timely claims, finalization and unclaimed expiry closure. Start
with one non-upgradeable Core; production recovery/rotation is separate work.

## EVM-006 — Fresh working baseline and recovery

Status: ACCEPTED. Source: user's branch/archive and cleanup requests.

`evm/restart` is the active implementation branch. The historical checkpoint is
recoverable from `archive/algorand-p1` at
`958f65002d6afd97e8cbb86bae63ecabe5abb024`; leave that ref and `main` unchanged.
Remove previous implementation, specs, artifacts, dependency tree and planning
history from the active tree. Preserve local ignored configuration privately
outside the repository without reading credentials. Create one new cleanup
commit; do not rewrite old commits or push.

Keep only current EVM requirements, rationale, packets and concise state. No
EVM code, dependency compatibility, gas performance or public acceptance is
claimed by this cleanup.

## EVM-007 — M1 experimental wire profile and execution order

Status: ACCEPTED for the M1 spike only. Date: 2026-10-18.

After inspecting pinned `@x402/core` and `@x402/evm` 2.28.0, select custom
`assured-exact` / `assurepay-evm-v1`, with
`extra.assetTransferMethod=assured-eip3009-receive` and
`extra.paymentFlow=upfront`. Server declares upfront as its only supported flow;
ordinary authorization/post-handler settlement is rejected. Core must accept
liability before the provider executes the paid service.

Installed exact client/facilitator implementations sign/execute token
`TransferWithAuthorization`; an arbitrary ATM label does not replace that path
with a receive-authorization Core call. Exact's Permit2 witness commits only
receiver/validAfter beyond standard transfer parameters. Up-to and batch paths
introduce variable/deferred charge and different admission semantics. Direct
wallet execution adds payer gas. For this fixed-gross USDC/EOA spike, the custom
receive path is the smallest candidate meeting the intended boundaries.

Custom scheme registration and payment-flow negotiation are supported by the
installed core interfaces. That is SDK extensibility evidence, not a claim that
our Core execution or facilitator settlement is already proven. Gate B/C must
validate actual binding, nested rollback and registered settlement. This choice
may be superseded if execution evidence demonstrates a better alternative.

Research reference: upstream commit `faa1c694c66a3732aaabbce93bdae140e521a67d`.
Installed release identities, integrity digests and inspected source hashes are
recorded in `spikes/evm-m1/toolchain.json` and its package lockfile.

## EVM-008 — Minimal Gate B execution boundary

Status: ACCEPTED for the M1 spike only. Date: 2026-10-18.

Freeze `AssuranceCoreSpike` constructor as `(token, providerPayout, providerId,
policyId, policyHash)`. Token/payout and demo provider/policy/hash are immutable;
deployer is the fixture administrator. Require deployed token code, nonzero
addresses/IDs and a payout distinct from Core and the token. No provider registry or full
financial core is introduced here.

`settleAssured(intent, v, r, s)` uses the Gate A twelve-field tuple, checks
chain/Core/token and immutable demo terms, positive payer/request/salt, gross
100 and the exclusive 300-second window, then calls token receive authorization
with nonce equal to `hashIntent(intent)`. Reject payer equal to Core or payout
so exact independent payer/Core/provider balance deltas remain meaningful.
Store `coverages[id] = (payer, requestHash, gross)`, increase `coverageCount` and
`premiumReserve`, and pay provider net93. Require exact received/final deltas
and propagate any failure. Non-reentrant; no arbitrary external target or refund.

For this disposable spike, only deployer may toggle `admissionEnabled` and
`failAfterTransfer`. The latter deliberately reverts after nested receive,
coverage writes and provider transfer to prove full rollback. These are explicit
test fixtures, not production control features. Emit `CoverageOpened` with
coverage/payer/provider/policy/request and gross/net/premium facts.

Use a separate faithfully signed ERC-3009 ERC20 fixture (USDC/2, six decimals)
with standard receive/transfer authorization and signed cancellation. Its mint,
failure/fee/reentry controls are test-only. Compile with the pinned solc-js
0.8.30/Cancun/optimizer200 and execute on an isolated Anvil chain84532. Ephemeral
test wallets are generated in memory and never serialized. This fixture cannot
substitute for Gate C native public USDC evidence.

## EVM-009 — Gate C adapter and verification boundary

Status: ACCEPTED for the M1 spike only. Date: 2026-10-19.

Use the pinned actual x402 client/resource-server/facilitator classes with a
self-hosted `assured-exact` scheme adapter. Upfront negotiation skips the SDK's
facilitator verify step during resource-server verify; exercise facilitator
verify explicitly as a separate read-only check, then settle through the
resource-server's before-handler path. Service admission requires confirmed
settlement, not merely `verifyPayment` success.

The facilitator freezes configured terms, validates/revalidates the exact Core
call, and delegates transaction preparation to an opaque signer returning only
`{hash,broadcast}`. Derive the hash before broadcasting; signed bytes remain in
memory. Reconcile known hashes after ambiguous submission, including after the
authorization expires; never silently sign a replacement purchase. The spike's
relay cache is process-local. A public runner must persist public hashes before
broadcast and refuse automatic replacement after restart.

A signer-free verifier binds successful receipt and transaction to Core,
relayer and calldata; checks canonical block identity, exact Core coverage event,
two token transfer logs, authorization-used event, nonce and coverage state at
that receipt block. Report observed inclusion/confirmation policy, not finality
that was not checked. Local fixture integration remains distinct from native
public USDC acceptance. No public mutation is authorized by this decision.

## EVM-010 — Public spike budget and wire normalization

Status: ACCEPTED for M1 only. Date: 2026-10-19.

The installed SDK creates optional own properties with `undefined` values.
Model the actual JSON wire boundary in the no-HTTP harness before strict payload
validation; do not permit unnegotiated extension contents. Configure the custom
client's explicit asset allowlist with the fixed 100-unit atomic cap instead
of disabling its spend controls.

A bounded public run contains at most four relayer transactions: Core creation,
registered successful purchase, admission-disable fixture, valid-signature
included revert. Per-transaction gas caps are 2,000,000/500,000/100,000/500,000
(3,100,000 total) with configured EIP-1559 fee caps and zero native value.
Base also charges L1 publication fees; OP Stack transaction format cannot cap
that component with `maxFeePerGas`. Treat `MAX_L1_FEE_WEI` as a total auxiliary
fee reserve, not an enforceable L1 fee ceiling. The total native-spend ceiling
is `MAX_TOTAL_GAS * MAX_FEE_PER_GAS_ATOMIC + MAX_L1_FEE_WEI`.

Require a dedicated relayer funded to exactly that ceiling before execution;
reject excess funds. Recheck its balance and account nonce before each new
preparation, stop on unrelated funding/use, and never auto-top-up or replace.
This funds-only bound assumes no concurrent use/incoming funds during the run.
Account insufficiency may stop the run if auxiliary fees exceed the reserve.
No public run is authorized until the user approves concrete scope/budget and
provides funded opaque runtime signers. No acceptance or fee measurement is
inferred from this preparation.

Sources checked 2026-10-19: Base network fees
(https://docs.base.org/specifications/transactions/network-fees), and OP Stack
fees (https://docs.optimism.io/op-stack/transactions/fees). These establish the
separate fee components and transaction-format limitation; actual network costs
must be measured during the authorized run.


## EVM-011 — Approved public attempt and local test-wallet setup

Status: ACCEPTED. Date: 2026-10-19. Source: user confirmation after the proposed
four-transaction Base Sepolia attempt and 0.00041 test ETH budget.

The user approves the EVM-010 public attempt and continued implementation in
phase order, with Luna(high) delegation and primary verification/checkpoint
commits. Do not ask again for the same attempt's approval. Runtime wallet
configuration/funding remains necessary; approval alone is not execution proof
and does not bypass M1's gate before M2.

Prepare fresh dedicated test EOAs locally so the user need only fund the public
payer/relayer addresses. Persist keys only in an exclusive, mode0600 ignored
runtime environment file; never print keys or manually inspect its contents.
Use Node's runtime env-file loading for address/config checks and execution.
Keep the public transaction journal in a persistent ignored local directory.
Do not overwrite an existing wallet file or reuse a journal as a new attempt.

Approved values remain max fee100000000 wei, priority1000000 wei, total gas
3100000 and auxiliary reserve100000000000000 wei: relayer starts with exactly
410000000000000 wei; payer has at least200 atomic native test USDC. Provider
payout is a distinct test address. No mainnet transaction or broader public
spending budget is inferred from continued phase authorization.


## EVM-012 — Managed Base Sepolia test-fund vault

Status: ACCEPTED. Date: 2026-10-19. Source: user explicitly authorizes creating
and managing a vault account for excess funds and retrieving funds when needed.

Use one locally generated test-only EOA vault, with an exclusive mode0600 ignored
runtime file and public-only durable funding journal. Keep existing payer,
provider payout and relayer identities/configuration. This is test-wallet
operations, not a protocol treasury contract or production custody design.

Normalize the currently overfunded relayer with two ordinary ETH transfers:
(1) relayer sends its canonical balance minus410000000000000 wei to the new
vault; its own funding fee leaves it below that target; (2) vault sends the
measured shortfall back, so the receiving relayer holds exactly the approved
410000000000000 wei. Excess remains in the vault. Funding operations are
separate from the already-approved four protocol-test transactions. They may
move only funds among these recorded local test accounts on chain84532.

Bound each funding transaction to21000 gas, max fee100000000 wei and priority
1000000 wei, zero calldata, and the exact measured value/destination. Preflight
an auxiliary L1 fee estimate against100000000000000 wei per transfer; this is
an estimate guard, not a transaction-format L1 fee cap. Record actual fee/balance
outcomes. No automatic fee escalation or same-purpose replacement is allowed.

Derive/sign in memory, durably record transaction hash/nonce/value/addresses
and fee/gas bounds before broadcasting once. Existing funding journals allow
read-only recovery; an ambiguous transaction must be reconciled by hash before
any next step. Never repeat the excess transfer or create a fresh purchase to
recover a response. If the first transfer is confirmed, one uniquely journaled
shortfall top-up may continue without repeating it. Reject concurrent wallet
use, unknown nonces, nonempty account code, wrong chain or changed balances.

The user authorizes managing/retrieving test funds as needed for implementation;
keep each later operation's purpose/value/fee scope explicit and recorded.
Current concrete scope is the two normalization transfers then the existing
M1 proof. No mainnet funds or external recipient transfer is inferred.

## EVM-013 — Allowlisted Base receipt fee enrichment

Status: ACCEPTED for M1 evidence. Date: 2026-10-19.

The pinned viem Base Sepolia chain uses the standard receipt formatter, which
omits raw OP Stack L1 fee fields. Preserve standard receipt validation, then
read the same public receipt through `eth_getTransactionReceipt` and attach
only strictly parsed fee quantities after matching transaction/block identity.
Never output or persist raw receipts or calldata. Missing/unsupported fee fields
remain explicitly unavailable; do not guess an operator-fee formula. Wire this
read-only enrichment into public run/recovery so measured L1 publication fees
are retained without changing settlement or signing behavior.

## EVM-014 — Bounded read-only reconciliation inside the public attempt

Status: ACCEPTED for M1. Date: 2026-10-19.

The real vault transfers demonstrated temporary disagreement between receipt
availability and transaction/state reads: immediate proof failed, then the same
recorded hash verified without replacement. During the authorized protocol run,
allow bounded read-only proof retries after inclusion and registered settlement
retries only for the identical payload with an existing transaction hash. Reuse
the configured receipt poll count/delay; no new signature, salt, broadcast or
replacement is permitted to recover a submitted payment. Exhaustion preserves
the journal and stops the run for signer-free reconciliation.


## EVM-015 — M1 mechanism acceptance

Status: ACCEPTED for feasibility. Date: 2026-10-19.

Actual Base Sepolia native USDC settlement through the registered self-hosted
x402 flow proves receive-authorization nonce commitment, atomic payment/coverage
and100/93/7 split. A second valid-signature included revert proves unchanged
financial state and unused nonce with admission disabled. Independent signer-free
recovery reconciles all four bounded transactions. Primary accepts Gates A/B/C.
EVM-003's candidate is now demonstrated for this EOA/USDC profile; fixed demo
terms and fixtures do not define M2 collateral or refund economics.

Evidence and exact hashes/costs are in M1 results and public-native-usdc evidence
JSON. One canonical inclusion, no finality claim, no traced revert cause and no
production audit. M2 may now be prepared; unresolved requirements in proposed
EVM-004/005 must be recorded before dependent financial implementation.

## EVM-016 — Accepted M2 collateral and refund baseline

Status: ACCEPTED. Date:2026-10-19. Source: user selected “Use this proposed
baseline” for the concrete M2 requirements/refund-model question.

Accept the baseline in planning/EVM_M2_REQUIREMENTS.md: immutable configurable
policy economics; minimum-one floor premium credited to pool; ceiling stake
locks and optional revenue withholding into provider stake; conservative pool
reservation G for pool-only eligibility, otherwise G-L. Provider-fault refunds
use own coverage lock, same-provider free stake, then pool. Optional pool-only
refunds consume pool funds only. Protect every other coverage/provider lock.
One configured adjudicator may reject or approve partial/full refunds <=gross,
paid to stored payer. Timely payer claims pin collateral without timeout;
unclaimed expiry releases locks. Donations have no pool withdrawal/share right.
Pause blocks admission/registration, not funding or existing obligations.
EVM-004/005 are accepted as refined by this decision and the M2 packet.

## EVM-017 — M2 local implementation boundary and fixed interfaces

Status: ACCEPTED for implementation. Date:2026-10-19.

Use isolated packages/evm-core, non-upgradeable Core with constructor-fixed admin
and adjudicator, admin-controlled immutable provider/policy registration, and
owner-only free stake withdrawal paid to stored owner. Constructor selects the
single resolver; no replacement/role rotation in this phase. A resolver submits
approved decisions; evidence evaluation itself belongs to later backend work.

planning/EVM_M2_FINANCIAL_CORE.md freezes function/enum/storage semantics,
canonical policy hash, unchanged twelve-field intent hash and atomic receive
boundary, rounding/refund transitions and execution invariants before components
depend on them. Pin Solidity0.8.30/Cancun/optimizer200 with viaIR for this new
package, OZ5.6.1 and existing viem/TS tool versions. Existing M1 contracts/tooling
remain unchanged. M2 requires local actual EVM execution; no new public mutation
is included. This is implementation design, not proven solvency/security yet.

## EVM-018 — M2 local gate acceptance

Status: ACCEPTED. Date:2026-10-19. Source: recorded primary verification,
independent scoped review and user authorization to proceed with M3.

Accept M2's local gate: pinned compile/typecheck, 15 actual Anvil execution
scenarios, deterministic solvency/isolation invariants, gas evidence and scoped
independent accounting review pass. planning/EVM_M2_RESULTS.md records exact
limits. The new Core has not been publicly deployed or production-audited.
M3 may depend on its frozen ABI/economics without changing M1/M2 contracts.

## EVM-019 — M3 HTTP profile and recovery boundary

Status: ACCEPTED for local implementation. Date:2026-10-19.

Use a separate packages/x402-assurance package with pinned x4022.28.0/viem2.57.7.
The new wire profile is assurepay-evm-v2 under custom assured-exact, ATM
assured-eip3009-receive-v2, upfront-only; M1's experimental fixed-term v1 wire is
not silently reinterpreted. Retain unchanged twelve-field AssuredIntentV1 and
native-token receive authorization nonce commitment. Read and verify immutable
M2 policy/provider terms and token signing domain at canonical chain state;
client independently checks its trusted Core/token/provider/policy and spend cap.

The self-contained M3 packet freezes request hashing, response receipt signing,
transport constraints and component interfaces before they are used. Bind exact
POST body bytes, canonical configured URL, fixed content type and client request
ID. Owner-signed EIP712 response receipt binds coverage/request/status/body hash.
This attests provider assertions, not evidence validity or service quality.

Separate public-only payment and service journals: derive/persist transaction
identity before one broadcast; known hashes are only reconciled on retry/restart.
Persist service execution-start before handler entry. A handler interrupted at
that boundary is indeterminate and never automatically rerun. Completed response
bytes/signatures may be cached only in memory for this phase; after process
restart report response unavailable rather than fabricate/rerun. Encrypted
persistent evidence/result storage belongs to M4. This is bounded single-process
service idempotency, not exactly-once external effects or distributed failover.

No public mutations, vault operations, role/economic changes or claims backend
are included in M3. Real HTTP + registered x402 + actual local M2 Core execution
is required; local ERC3009 fixtures do not substitute for later public acceptance.

## EVM-020 — New service execution requires live coverage

Status: ACCEPTED implementation safeguard. Date:2026-10-19.

Historical payment inclusion remains verifiable after authorization/coverage
expiry. It must not alone authorize starting a previously unexecuted handler
after coverage has expired or become terminal/claim-pending. Before creating the
service-start record, use a canonical current-state admission read requiring
matching Active coverage and now<stored expiresAt. RPC uncertainty fails closed.
Cached results may still be returned after expiry without rerunning anything.
Add chain isServiceAdmissible(client,terms,call):Promise<boolean> and a required
provider canServe(call) callback; this does not change on-chain policy/economics.
Tests for expired token authorization recovery use a longer coverage duration,
so recovery demonstrates live liability rather than serving after it ended.

## EVM-021 — Bind one payment intent before settling a service request

Status: ACCEPTED implementation refinement. Date:2026-10-20.

A duplicate request must be rejected before a second charge, including when a
provider restarts between payment confirmation and handler entry. Extend the
public service journal with a reserved identity (coverageId/requestHash) before
settlement, then started/completed transitions. The same identity may reconcile
and proceed; a different payment intent for that request hash cannot settle.
Reservation is not execution: a restarted reserved job can still confirm its
known payment and start once, whereas a started job remains indeterminate.
A new explicit purchase may use a new request ID; clients never do so to recover
a response. This adds no new on-chain mechanism or economic rule.

## EVM-022 — M3 local composition acceptance

Status: ACCEPTED. Date:2026-10-20. Source: primary verified results and user
instruction to proceed after reviewing the M3 checkpoint summary.

Accept M3 at commit 975bd76: strict typecheck, 28 tests including actual local
HTTP/registered x402/M2 EVM execution, same-hash recovery, service idempotency,
receipt verification, negative cases and closed independent review findings.
Results and limitations are in planning/EVM_M3_RESULTS.md. This is local
composition acceptance, not public native-USDC acceptance of the combined stack.
M4 may now be specified before implementation; preserve M1/M2 contracts and
M3 default behavior except explicitly scoped durable-result integration.

## EVM-023 — M4 local backend interfaces and privacy boundary

Status: ACCEPTED for implementation. Date:2026-10-20.

Freeze planning/EVM_M4_EVIDENCE_CLAIMS.md before dependent code. Use an isolated
programmatic claims-backend library: immutable AES256GCM objects with runtime
key injection; optional M3 ResultStore, written before public completed marker;
strict canonical receipt/payment-anchor verification on retrieval; bounded full
canonical chain projection rebuilds instead of incremental rollback machinery.
No contracts or economics change. Preserve M3's memory-only default.

Backend authentication uses service-scoped EIP712 operation/coverage/payload/
actor/nonce/deadline binding and durable nonce consumption. One opaque evidence
bundle per proposed claim, with salted encrypted commitment to exact bytes and
canonical opening. Prepare unsigned payer claim and explicit configured-
adjudicator decision calls only; no transaction sender or evidence classifier.
The caller's on-chain role/state remains final. Backend signatures are not
persisted, and response signatures persist only encrypted. Missing artifacts
for direct on-chain claims fail backend preparation without altering Core rights.

Single process, trusted local durable filesystem/RPC and runtime key custody.
Crash between result persistence and completed marker recovers only verified
archived bytes; interrupted start without result never reruns. Replay consumes
before side effects and may require a new nonfinancial authorization after a
lost response. Key rotation/KMS, retention, distributed failover, public deployment
and native USDC combined-stack acceptance remain outside this local gate.

## EVM-024 — Durable result recovery is read-only at the engine boundary

Status: ACCEPTED implementation safeguard. Date:2026-10-20.

Add optional SettlementEngine.reconcile(call), implemented by the real engine
without any signing/submission path. Configuring a durable result store requires
this capability. Retrieval must not call settle(): if a payment journal were
missing, settle could prepare a transaction. Reconcile only validates the same
call, loads an existing matching journal identity and verifies its known hash.
Missing identity fails closed. M3 no-store adapters remain compatible. Extend
M4's narrow write scope to src/engine.ts and exercise journal-loss recovery.

## EVM-025 — Active main branch and checkpoint publishing

Status: ACCEPTED local branch policy. Date:2026-10-20. Source: user explicitly
requests renaming the EVM branch to main, deleting old main already archived,
and publishing subsequent checkpoints to main.

Old local main and archive/algorand-p1 both pointed to
958f65002d6afd97e8cbb86bae63ecabe5abb024; it is an ancestor of the EVM head.
Delete that local main reference and rename evm/restart to main, preserving
working changes and the archive. Future verified checkpoint commits use main.
No force push or history amendment is necessary. The configured remote is
https://github.com/LogiqueClergyman/AssurePay. The user explicitly approved
"Push main and archive" on2026-10-21 after automatic review requested a specific
destination/branch authorization. An atomic non-force push published main at
1f6566ac2339ac5e2b6f3889ed3ad59cb286ddf1 and archive/algorand-p1 at the old
main head958f65002d6afd97e8cbb86bae63ecabe5abb024. main now tracks origin/main;
future verified checkpoint commits may be pushed there under the user instruction.
Keep existing remote evm/restart unless separately instructed.

## EVM-026 — M4 local backend acceptance

Status: ACCEPTED. Date:2026-10-21. Source: verified M4 results, closed independent
cross-component reviews and user instruction to continue to the next phase.

Accept M4 checkpoint1f6566a: backend typecheck/16tests and M3 typecheck/28tests,
actual local EVM financial transitions, canonical reorg tests, durable response
recovery, encrypted evidence and role-bound unsigned claim/decision preparation.
M4 results record single-process/storage/RPC/key assumptions and scope limits.
No production audit or combined-stack public native-USDC proof is inferred.
M5 preparation may proceed; public execution requires its own concrete scope
and spending approval after local preparation/rehearsal gates.

## EVM-027 — M5 bounded campaign and independent proof boundary

Status: ACCEPTED for local preparation only. Date:2026-10-21.

Freeze planning/EVM_M5_PUBLIC_ACCEPTANCE.md: two actual HTTP purchases on one new
M2 Core/policy, encrypted result recovery, ProviderFault partial3100 and PoolOnly
full10003 explicit refunds, then paused admission included revert. Four distinct
EOAs; relayer also admin, separate provider/payer/adjudicator.14 protocol txs,
7050000 gas caps,100000000wei max fee,200000000000000wei auxiliary allowance.
Protocol funding targets total905000000000000wei; optional three separately
approved vault transfers add at most9300000000000wei fee allowance.43514 atomic
test USDC allocated. No public execution or transfer is authorized by this design.

New isolated evm-acceptance package composes unchanged M2/M3/M4; strict one-attempt
public journal before broadcast, exact role/nonce/call/fee binding, no replacement
on uncertain RPC. Independent signer-free verifier reconstructs signatures only
in memory from public calldata; artifacts omit them. It proves on-chain financial
facts/canonical anchors, not private HTTP/evidence truth or encryption. Rehearsed
transport observations are recorded separately. Paused revert is before receive;
no claim of deterministic post-receive native-USDC rollback in M2. Stage A local
rehearsal/review and concrete public budget precede Stage B approval; Stage C
native public proof remains mandatory for M5 acceptance.
Persist public transport counters/hashes after each successful repeat/restart
check, before later financial steps or final chain verification. A later RPC
failure must not erase already observed HTTP evidence; it cannot turn that
evidence into independently proven chain facts.

## EVM-028 — M5 vault funding and signer-free recovery interface

Status: ACCEPTED for local preparation only. Date:2026-10-21.

The isolated funding component proposes at most three exact shortfall transfers
from the recorded managed vault to the relayer, payer and adjudicator targets.
Public execution requires the campaign scope plus the separate literal
`m5-fund-campaign-roles-once`. A canonical public plan precedes signing; each
transfer's hash, nonce, value and destination are durably recorded before its
single broadcast. Reconciliation reads only known identities without a signer;
it never fills missing steps or rebroadcasts. A later explicitly authorized
execution may continue only unprepared funding steps after known hashes reconcile.

Use measured included execution/auxiliary fees to reconcile vault balance changes;
gas caps and preflight L1 estimates are allowances, not actual expenditure.
When public receipt fee components are unavailable, an anchored vault balance
delta may measure aggregate auxiliary expenditure: prior measured balance minus
exact value minus included execution fee minus new balance. Preserve unavailable
component fields honestly and label the aggregate balance-delta observation.
Require a nonnegative residual at least as large as exposed components and no
larger than the fixed reserve. This depends on the explicit no-concurrent-use/
incoming-funds assumption, distinct from receipt-based fee attribution. Missing
or inconsistent measurements stop funding; an estimate never becomes an actual
fee. No public transfer is authorized by this interface.

Public mutation CLIs acquire one exclusive campaign-directory run lock before
journal initialization. Funding and protocol execution share that lock. Concurrent
starts fail closed; stale locks require explicit local inspection, never automatic
takeover. Programmatic adapters retain the single-instance-per-journal assumption.

## EVM-029 — Approved M5 public campaign

Status: ACCEPTED execution authorization. Date:2026-10-21.
Source: user selected "Approve M5 funding and execution" for checkpoint922947f
and the concrete funding/transaction scope in planning/EVM_M5_RESULTS.md.

Approve three exact managed-vault top-ups:302480018003071wei to relayer,
108000000000000wei to payer and94000000000000wei to adjudicator, then the frozen
fourteen Base Sepolia/native-USDC protocol transactions. Maximum initial USDC
allocation43514atomic; campaign plus funding fee allowance914300000000000wei;
maximum additional vault outflow513780018003071wei including funding fees at
the approved snapshot. Fixed per-step gas/fee settings and auxiliary reserves
remain unchanged. No mainnet, external recipients or larger scope is authorized.

Refresh read-only balances/nonces/fees before execution. Changed amounts or
uncertain hashes stop and reconcile without replacement, fee escalation or
fresh purchase. Approval is not execution proof; M5 acceptance still requires
the complete public campaign and independent signer-free verification.

For reproducible read-only cost reporting, compare each protocol role's native
balance immediately before deployment and at the final included revert. Validate
canonical anchors and initial funding targets; native-value-zero campaign calls
make the difference aggregate gas expenditure under no concurrent account use.
Keep measured aggregate fees distinct from independently identity-matched receipt
components; do not attribute an unavailable operator component from a residual.

## EVM-030 — Canonical projection anchor and bounded campaign continuation

Status: ACCEPTED scoped M5 correction. Date:2026-10-21.

The approved campaign included its first seven transactions, including purchaseA,
then stopped before claimA with PROJECTION_UNAVAILABLE. Signer-free reconciliation
confirmed all seven hashes. A read-only public diagnostic reproduced the precise
PROJECTION_HEAD_CHANGED cause: Base advanced from48418450 to48418451 while
refreshing. The old final latest-tip equality rejects ordinary chain progress.
All projection reads are already pinned to the initial numbered head. Replace
only its final check with a canonical re-read of that same numbered block/hash;
retain opening-anchor checks, pinned state, range limits and reorg rejection.
Allow the narrow change to claims-backend/src/projection.ts and its tests under
M5; this changes neither financial rules nor contract/role interfaces.

Continue only the exact seven-confirmed-step prefix of the same campaign/Core,
after verifying existing call identities and the original successful settlement.
Reuse its persisted public HTTP counters/hashes and encrypted backend storage;
never sign/broadcast or execute the purchaseA handler again. A distinct explicit
continuation scope may submit only the seven remaining EVM-029 transactions:
claimA/resolveA/purchaseB/claimB/resolveB/pause/revert. The original fourteen-step
total, approved values/roles, gas/fee caps and run identity remain unchanged.
Read-only reconciliation stays incapable of signing; continuation is a separate
explicit execution action, with actual local failure/continuation tests before
public use. Other prefixes and another completed campaign must fail closed.

## EVM-031 — Expired first campaign and isolated second proposal

Status: ACCEPTED local preparation; new public execution NOT AUTHORIZED.
Date:2026-10-22.

Canonical read-only coverage evidence shows the first campaign's purchaseA
opened1792605100 and expired1792608700 (2026-10-22 00:21:40 IST); at observed
timestamp1792644642 it remained Active with refund0 and could no longer file a
timely claim. Do not backdate, modify policy, submit a doomed claim or represent
this partial campaign as M5 acceptance. The original paid HTTP result remains
valid; the first seven transactions and all journals must remain preserved.

Prepare a distinct proposed second experiment: fresh public run/provider/policy/
service IDs and Core, separate `.local-m5-r2/` journals/data, same four test EOAs
and unchanged fourteen-step policy/economics. Existing runtime data key may be
reused with the new Core namespace and fresh encryption IVs; never overwrite
or manually read the populated original runtime environment. Runtime original
config stays intact; checked-in public proposal overrides only public IDs.

Read-only planning fixes the new exact shortfalls, role nonces, vault and fee
allowances before approval. A separate guarded second-attempt CLI defaults to
check-only; funding/reconciliation/execution operate only on the new journal.
It pins the proposal's config/roles/top-up values, fails on changed nonce/balance/
fee conditions, and keeps same-hash recovery separate from missing-step execution.
No automatic second payment/new campaign follows an interruption or failed test.
New public approval is required because the original fourteen-transaction scope
cannot be completed after expiry; EVM-029 does not authorize this extra campaign.
The proposal reuses the funding component's strict derived-plan validator via a
public detached/frozen validation wrapper; do not maintain weaker economic or
unknown-field validation in the new CLI. IDs must equal the runtime derivation
from the approved fresh runId, not merely differ from the first campaign.

## EVM-032 — Approved isolated second M5 campaign

Status: ACCEPTED execution authorization. Date:2026-10-22.
Source: user selected "Approve second campaign" for checkpoint689703e and
the exact second-attempt proposal recorded under EVM-031.

Authorize managed-vault top-ups19674564006637wei to the recorded relayer and
1701102000276wei to payer, then fourteen new Base Sepolia/native-USDC protocol
transactions with fresh runId0x28daab42bd847baae99a50c2ac97666cc9f2117add83540527b0815e8a37e58b
and separate .local-m5-r2 journals/data. Same four EOAs and frozen economics.
Initial USDC allocation43514atomic; protocol/funding fee allowance911200000000000wei;
maximum additional vault outflow27575666006913wei including funding fees.
Fixed per-step gas/fee/auxiliary limits remain unchanged. No old-Core cleanup,
policy change, larger budget, replacement payment or third campaign is authorized.

Refresh read-only proposal/nonce/balance/fee checks, reconcile uncertain hashes
before progressing, and independently verify the complete native public result.
Approval alone is not M5 acceptance. Preserve all first-campaign state/evidence.

## EVM-033 — Bounded read-only RPC scheduling

Status: ACCEPTED M5 execution safeguard. Date:2026-10-22.

The approved second preflight has intermittent RPC read failures while successful
reads still match the frozen plan. Allow a bounded single-flight queue and limited
retries for an explicit allowlist of idempotent public reads only. Preserve all
existing anchor/state/identity checks; retries do not imply canonicality or success.
Never retry sendRawTransaction, a signing call, unknown methods or arbitrary RPC
requests. A transaction submission error still reconciles the recorded hash.
This changes no call, nonce, value, role, fee cap, allowance or transaction count;
it is not a new public attempt authorization. Verify read retry/serialization and
exactly-one send delegation before using the adapter.

## EVM-034 — Same-campaign second-run continuation routing

Status: ACCEPTED scoped recovery interface. Date:2026-10-22.

The EVM-032 campaign stopped with PROJECTION_UNAVAILABLE after exactly seven
successful included steps through purchaseA; signer-free reconciliation preserved
all seven original hashes. Extend the isolated second-attempt CLI with an explicit
--continue mode under the same second-campaign scope. It invokes the existing
actual-EVM-tested exact-seven-prefix continuation, only for .local-m5-r2 and the
approved proposal/runtime identity. Check canonical prefix, current fees, payer
USDC and live claim eligibility before any new transaction. Recover the original
A call/result without another payment, signature, broadcast or handler execution;
submit only the seven remaining EVM-032 steps with unchanged caps and budgets.
Starting funding targets/nonces cannot be reapplied after spending. Existing
sender per-step nonce/budget checks remain mandatory. No third campaign, extra
funding, old-Core cleanup or retry of a submitted transaction is authorized.
Projection diagnosis and any correction must precede continuation; do not weaken
canonical/state checks or claim M5 acceptance from a partial run.

## EVM-035 — Preserve projection ranges through smaller RPC log requests

Status: ACCEPTED scoped M5 transport correction. Date:2026-10-22.

Second-campaign diagnostics identify getLogs RPC error-32614 as range-related.
Read-only probes of the same Core/from-block reject500blocks while100,10 and1
succeed. This demonstrates a usable100-block request, not the network's exact
maximum or a financial failure. Add an M5-only client adapter that partitions
explicit numeric getLogs ranges into contiguous, non-overlapping requests of at
most100blocks and concatenates unchanged logs. Keep the original complete range,
filters, projection event-count/state/hash/limit checks and fail if any chunk
fails. Never shorten the scan, swallow a failed chunk or retry a transaction.
The adapter delegates other methods unchanged and preserves queued bounded reads.
Use actual-EVM log equivalence plus boundary/filter/failure tests before binding
the approved continuation. M4 source and all financial rules stay unchanged.

## EVM-036 — Explicit bounded M5 public projection horizon

Status: ACCEPTED scoped M5 configuration. Date:2026-10-22.

The campaign projection's implicit5000-block default can be exhausted during a
still-live one-hour public claim, independently of its financial expiry. Configure
M5's projection and diagnosis with maxBlocks25000, within the existing backend
100000-block hard cap. Scan from the same deployment anchor to one pinned head;
retain maxCoverages1000, canonical/log/state checks and explicit range rejection.
EVM-035 retains at-most100-block RPC chunks. This widens only the finite historical
read horizon; it cannot extend claim expiry, authorize another transaction or
accept incomplete logs. M4 source/contracts and campaign economics remain fixed.

## EVM-037 — M5 native public combined-stack acceptance

Status: ACCEPTED. Date:2026-10-22.

Accept the EVM-032 second campaign on Base Sepolia/native test USDC, Core
0x36e4f1080719a12af93e2d7a33940e81671af3b1. Exactly14 protocol transactions
are included (13successes and the expected revert); separate signer-free
reconciliation and verification pass. Actual HTTP200/500 observations preserve
one payment/broadcast/handler per case across retry/restart. Both explicit
refunds3100/10003 reached the stored payer. Final Core16017atomic USDC equals
4460stake+11557pool, with zero locks/reservations/active coverages, allowance0,
paused admission and unused negative authorization. All canonical anchors and
per-step financial invariants pass. Public reports are under
packages/evm-acceptance/evidence/second-public-*.json and second-final-state.json.

Primary typecheck/48actual-EVM/HTTP and adversarial tests pass; scoped independent
review finds no remaining blocker. Measured protocol/funding fees27730062008778wei
are within911200000000000wei allowance. Unavailable operator components remain
unavailable; aggregate cost attribution retains the no-concurrent-use assumption.
No duplicate A payment, extra funding, replacement, third campaign or old-Core
cleanup occurred. Preserve the first partial/expired campaign and both namespaces.

This accepts the bounded core MVP gate, not finality, private evidence truth,
post-receive M2 rollback, production security or hosting/UI. M1–M5 implementation
gates are complete. Further product work requires its own scoped packet; this
record authorizes no additional public mutation or broader production phase.

## EVM-038 — Local developer pilot and retrieval-only recovery boundary

Status: ACCEPTED for implementation. Date:2026-10-22.
Source: user approved the proposed M6 developer pilot and asked to continue.

Freeze planning/EVM_M6_DEVELOPER_PILOT.md. Deliver reusable provider/buyer/claims
HTTP/operator composition and restricted claim sender around unchanged contracts
and financial rules. Local isolated EVM execution only; all M5 public allowances
remain consumed. No UI/hosting or production/public rollout is inferred.

New buyer state stores the exact original request/payment encrypted before its
single paid attempt. Restore has no signer or createPayment path and uses a
strict retrieval-only HTTP header. Provider recovery cannot reserve/settle/start
a handler, even when journals are missing. Original receipt and exact canonical
payment reconciliation remain mandatory. Extend only M3 HTTP client/provider
and focused tests; absent the new mode, existing behavior stays unchanged.

Claims HTTP prepares existing M4 role-authenticated actions, holding no chain
signer. Payer/adjudicator submit only allowlisted claims/resolutions through a
one-attempt durable public-identity sender with same-hash-only reconciliation.
Single-process locks and local trusted storage/RPC/key custody remain explicit.
Record further interface/assumption refinements before dependent implementation.

## EVM-039 — Local developer pilot acceptance

Status: ACCEPTED. Date:2026-10-22.

Accept the EVM-038 M6 packet. Reusable provider/buyer SDKs, loopback claims HTTP
and the restricted payer/adjudicator CLI execute the actual local Core flow from
clean configuration. The real CLI example proves purchase, provider restart,
signer-free buyer-process retrieval and explicit3100atomic ProviderFault refund,
with exact payer delta, unchanged retrieval relayer nonce and Core solvency.
The signed500 test proves zero additional payment/relayer signatures, broadcasts
or handlers during retrieval and a full10003atomic PoolOnly refund.

Primary M6 typecheck/21tests and npm run demo pass. Full M3/M4/M5 regressions
pass30/18/48tests, with typechecks. Independent Luna(high) implementation and
cross-review plus primary verification close scoped blockers. Canonical included
reverts and lost-send responses reconcile the original hash without replacement;
prepared-unsent state remains stranded. Evidence and limits are recorded in
planning/EVM_M6_RESULTS.md and packages/developer-pilot/evidence/local-pilot.json.

This accepts local composition only. Contracts, economics, native public M5
proof, runtime custody and consumed public budgets remain unchanged. Trusted
local RPC/durable storage and key custody are assumptions; no production UI,
hosting, distributed recovery, subjective adjudication or further public mutation
is authorized. Scope the next phase in a new packet before dependent work.

## EVM-040 — Proposed external-pilot preparation scope

Status: PROPOSED; no implementation/public-execution approval. Date:2026-10-23.

Following M6 acceptance, the user asked to continue with next-phase scoping.
Primary and three Luna(high) reviews found that M6's local config/listeners,
online admin/relayer coupling, post-settlement canServe callback and bounded
projection do not establish an externally operable pilot. Preserve M1–M6 and
the consumed M5 public scopes; do not simply expose the sandbox or relax its
native-USDC rejection.

Propose planning/EVM_M7_EXTERNAL_PILOT.md: a local HTTPS transport rehearsal
that separates advertised canonical resource identity from a private loopback
listener, preserves existing local mode, and keeps claims private. The proposed
optional listenUrl interface is not yet frozen. Actual local Core/TLS execution,
restart retrieval and adversarial transport tests are its intended gate.

Deployment, admission/spend controls, separate offline admin, long-running
projection/recovery and fresh native-USDC acceptance remain later prerequisites
with their own scope. No hosting selection, public mutation, additional budget,
secret migration or broader product phase is inferred. Review results and open
input: planning/EVM_M7_SCOPE_RESULTS.md. Approve/revise the packet before code.

## EVM-041 — M7 local-only implementation and transport interfaces

Status: ACCEPTED for local implementation. Date:2026-10-23.
Source: user selected "Keep the next phase local only" after the M7 proposal.

Freeze the local scope of planning/EVM_M7_EXTERNAL_PILOT.md. No host selection,
remote provisioning or public-chain execution is authorized. Optional M3
ProviderOptions.listenUrl is an exact loopback HTTP origin used only to bind
the socket while canonical resourceUrl stays HTTPS. In that mode enforce one
exact advertised Host and route before challenge/payment work; ignore forwarding
metadata as an identity source. Omitted listenUrl preserves accepted behavior.
Contracts, canonical hashes, M6 local config/CLI and claims transport stay fixed.

Freeze the internal rehearsal helper boundary in developer-pilot/src/local-https.ts:
createLocalTls(directory) returns {certPath,keyPath,cert,key} for newly generated
private local certificate material only; createTrustedFetch(cert,origin) returns
a bounded HTTPS fetch with explicit local CA trust and no redirects/retries;
startLocalIngress({certPath,keyPath,port,upstream}) returns {url,close()} and runs
a separate loopback TLS proxy child with no blockchain keys in its environment.
Origin is https://127.0.0.1:<port>; certificate includes that IP SAN. Proxy copies
method/path/Host/financial headers and bytes, with no forwarding-derived identity.
The helper is local test/rehearsal code, not a hosted deployment service.

Rehearsal directly composes M3 provider/engine, M4 durable results and M6 buyer
against isolated actual M2/faithful ERC3009 fixture. Record exact signing/send/
handler counters, canonical identity and Core invariant checks. All TLS and role
keys are fresh ephemeral material; no existing env/journal reads or committed
TLS key. Public local report may contain only allowlisted metadata. No global
TLS verification disable, new public-mode CLI or claim of native/public proof.

## EVM-042 — Local HTTPS transport acceptance

Status: ACCEPTED. Date:2026-10-23.

Accept the local-only M7 packet frozen under EVM-041. Optional M3 listenUrl
separates the exact loopback HTTP socket origin from canonical HTTPS resource
identity, with strict advertised Host/path checks before financial work. Existing
M3/M6 local behavior, financial schemas/contracts, claims and public M5 records
are unchanged. Forwarding metadata cannot select the signed resource identity.

Actual local TLS/M2 execution with the faithful ERC3009 fixture proves purchase,
provider instance restart, buyer process restart and original-result retrieval.
Exactly1 payer/relayer/receipt signature, broadcast and handler occur at purchase;
retrieval adds none. Wrong transport/payment data, missing archive/journal and
RPC uncertainty do not settle or run another handler. Independent canonical
calldata/coverage and financial checks pass: Core62806=stake12029+pool50777,
locked3502/reserved10003 with one active coverage. The chain is temporary.

Primary typechecks/full33M3 and24pilot tests and standalone transport:demo pass.
Tests include actual TLS CA/name rejection, duplicate financial headers and
raw ingress body/header413/431 rejection without upstream work. Independent
Luna(high) reviews find no remaining scoped blocker. Results and public-only
local evidence:planning/EVM_M7_RESULTS.md and
packages/developer-pilot/evidence/local-transport.json.

Provider restart here is a same-process close/reopen with a new read-only engine,
not a provider OS-process restart; providerProcessRestart:false is explicit.
This accepts local transport preparation, not hosted/native-USDC/public operation,
finality, backup rollback, admission/spending policy or production custody.
The user selected local-only work; no host or public funding is needed/inferred.
Scope any next local phase before dependent code; all M5 public allowances stay
consumed and existing keys/journals stay preserved.

## EVM-043 — Local product surfaces and phased roadmap

Status: ACCEPTED direction and M8 definition scope. Date:2026-10-23.
Source: user explicitly requests provider SDK, client SDK/agent/skill, protocol
role dashboards and a separate consumer demo, broken into smaller phases.

Freeze planning/EVM_M8_PRODUCT_BOUNDARIES.md as the current definition phase.
Record the product/phase contract in planning/EVM_PRODUCT_ROADMAP.md. Reuse the
accepted protocol; make integrations independently consumable, keep the demo
on public client APIs, and treat agent/skill as a thin client adapter. First SDK
runtime is Node; browser UI uses a local backend and does not gain keys from a
bundle. Provider/admin/operator/adjudicator remain distinct responsibilities.
No operator contract role or automatic refund authority is inferred.

Current private cross-source composition is not an installable SDK, and current
buyer.prepare signs; it cannot be shown as an unsigned approval preview. Define
SDK packaging and consent gates before UI depends on them. Local console/demo UI
is explicitly in the user's requested scope; production hosting, public
publishing, new campaign budgets and browser-native custody are not.

After M8 review acceptance, freeze each detailed local implementation packet
before its dependent phase. Existing user direction authorizes work within this
roadmap, with one phase at a time, Luna(high) delegation, primary verification
and checkpoint commits/pushes. No broad new financial or public authority follows.

## EVM-044 — Product-boundary definition acceptance

Status: ACCEPTED definition gate. Date:2026-10-23.

Accept M8 under EVM-043. planning/EVM_PRODUCT_ROADMAP.md separates provider SDK,
client SDK plus one framework-neutral agent adapter/portable skill, protocol
read/control API and role console, and a separate consumer demo. Node-first
runtime and local-only operation are explicit. SDKs must pass outside-repo
pack/install gates with no deep source imports; preview/approval/signing and
same-request recovery are separate behaviors. Dashboard financial data must
have canonical provenance, and contract-specific roles remain distinct.

Primary source review plus three independent Luna(high) reviews close definition
gaps in skill artifacts, role signing/session boundaries, new admin/relayer
composition, and consumer-to-adjudicator handoff. M10 explicitly includes payer
claim and anchored status/balance reads required by the consumer flow. These are
accepted future requirements, not claims of implemented SDK/UI capabilities.
M8 is docs-only; no runtime/financial gate is asserted by this acceptance.

Exact next phase is M9 provider integration, with its detailed packet frozen
before code. M10–M14 stay planned and depend on preceding gates. Local console
and demo UI are authorized within those packets; production custody/hosting,
public publishing and new public spending remain out of scope. Results:
planning/EVM_M8_RESULTS.md. Existing M1–M7 evidence and private runtime survive.

## EVM-045 — M9 local provider SDK package boundary

Status: ACCEPTED for implementation. Date:2026-10-23.
Source: user requested continuation of the accepted local product roadmap.

Freeze planning/EVM_M9_PROVIDER_SDK.md. Deliver @assurepay/provider-sdk0.1.0
private/packable Node ESM, public root JS/types and separate CSV profiling service.
Bundle accepted runtime internally with esbuild0.25.12; external dependencies
are pinned viem/@x402/core. Typecheck the whole closure, then emit only the two
explicit public modules through pinned TypeScript5.9.3 transpileDeclaration. A
trial full-closure declaration emitter encountered TS2742 in accepted inferred
viem client types; public modules require no sibling declaration or new bundler.
The outside-consumer TypeScript gate must validate the emitted declarations.
Public facade/types are SDK-owned and expose only
validated config read, createProvider lifecycle and safe error code; no caller
wallet/RPC injection, raw key loading, buyer/adjudicator or generic transaction
surface. Exact signatures/schema/modes are in the packet before consumers depend.

Preserve M6 config/role/fee/read/projection constraints and existing financial
logic. No runtime source edits. New SDK retrieval-only mode passes neither a
relayer account nor transaction wallet, and archive/payment proof remains
mandatory. Preserve the old admin/relayer coupling explicitly; M11 separation
is not part of M9. Local-only configuration does not claim M7 HTTPS support.

Separate plain Node example consumes only SDK root and viem; bounded CSV grammar,
integer deterministic output and paid signed500 failure semantics are frozen.
Actual local EVM outside-repo tarball consumer and provider process restart are
the exit gate, not an in-repo import or npm-pack-only check. Root/tests may use
accepted buyer harness, without accepting M10. No npm publication, hosting,
public chain budgets, license grant or product UI is implied by this checkpoint.


## EVM-046 — Local provider SDK acceptance

Status: ACCEPTED. Date:2026-10-23.

Accept M9 under EVM-045. @assurepay/provider-sdk0.1.0 is private/packable ESM
with four root functions, SDK-owned types, fixed safe errors and no generic
wallet/client/raw-key surface. The five-file tarball bundles accepted runtime;
only pinned viem/@x402/core and Node built-ins remain external. Existing M1–M8
runtime/contracts and public/private campaign state are unchanged.

Separate plain Node CSV service consumes the root API. Actual outside-repo
pack/install tests prove public types/blocked deep imports, paid profiling,
lost-response original-hash recovery after provider OS-process restart, exact
receipt/body/transaction, signer-free retrieval and failure-closed state/RPC/
binding/lock behavior. A fresh valid payment cannot settle in retrieval-only
mode; controlled signed500 is a separate intentional second settlement.

Independent canonical transaction/event/coverage and anchored financial proof
pass: first profile Core62806=stake12029+pool50777, locked3502/reserved10003,
active/count1; payer debit10003 and provider credit7197 atomic fixture units.
Retrieval adds0payer signatures and no relayer nonce/broadcast. The report
separates the later two-coverage state and explicitly has buyerProcessRestart:
false; a new buyer instance is used, while the provider OS process restarts.

Primary full7SDK,8CSV and24pilot tests, typechecks/builds, separate outside-repo
example checkJs/root/deep-import checks and standalone demo pass. Independent
Luna(high) cross-review closes scoped blockers. Results:
planning/EVM_M9_RESULTS.md; local-only report:
packages/provider-sdk/evidence/m9-consumer-gate.json.

This is local fixture packaging evidence, not npm publication, native-USDC/
public/HTTPS deployment, finality, role decoupling or production custody.
Existing M5 public allowances stay consumed. Next is a self-contained M10 client
SDK/approval/agent/skill packet before dependent code; no client or UI acceptance
is inferred from M9's use of the existing in-repo buyer as a test harness.


## EVM-047 — M10 client approval, budget and agent boundary

Status: ACCEPTED for implementation. Date:2026-10-23.
Source: explicit user go-ahead after M9 checkpoint51ad845.

Freeze planning/EVM_M10_CLIENT_SDK.md before dependent code. Single private,
root-only @assurepay/client-sdk0.1.0 bundles accepted runtime, adds a thin
framework-neutral agent adapter and ships a repository-owned portable skill.
Local-only exact config/pinned dependencies/build strategy remain M9-compatible.
No public RPC/chain budgets, npm publishing or global skill installation.

M3 gains unsigned preview and separate fresh-challenge authorization; legacy
createPurchase keeps its one-challenge/signing behavior. M6 buyer exposes new
preview/authorize while preserving prepare/send/retrieve. SDK public API never
calls signing from preview: literal app approval, unchanged quote/identity and
freshness precede payment signing. Existing encrypted snapshot and exactly-once
attempted markers remain the only paid send/recovery path.

Persistent per-directory session caps reserve amount/count before forwarding a
payment signature. Unresolved reservations/attempts block new authorization;
crash windows may strand availability and never permit re-sign/replacement.
Limits/context cannot change on reopen. This is a host-configured local session,
not a global account spending or production admission policy.

Payer-only evidence/approved fileClaim and signer-free original-hash claim
reconciliation stay behind fixed methods; canonical single-head own coverage/
refund/balance reads support later consumer UI. No decision/arbitrary-call API.
Agent tools invoke a host-only approval callback per new payment; model/tool
arguments cannot approve, change caps or choose actor/endpoint. Service output
is data. Skill/tool tests must demonstrate approval denial, actual payment and
original-ID recovery through the packed API without private outputs.

Required gates include outside-repo real client OS-process recovery, actual
local EVM financial/claim/refund proof, persisted caps/failures, full M3/M6/M9
regressions, skill validation/forward-test and primary/independent review.
M11 role separation and later UI remain dependent phases.

Review refinement: rechecking a previously confirmed result first persists its
attempted guard before the retrieval/proof boundary. A failed guard write stops
before the read; an uncertain proof retains closed admission across restart.
Only a newly verified original result restores confirmed state.


## EVM-048 — Local client SDK and agent acceptance

Status: ACCEPTED. Date:2026-10-24.

Accept M10 under EVM-047. Private/packable @assurepay/client-sdk0.1.0 exposes
unsigned previews, explicit approval/fresh revalidation, durable per-session
caps before signing, encrypted one-send identity and signer-free original-ID
retrieval. Fixed payer evidence/claim and canonical own state/balance methods
expose no adjudication or arbitrary transaction capability. Four agent tools
require a host approval callback; model arguments cannot approve/change caps.
Explicit outputs and safe errors exclude private payloads. The portable skill
is packaged and independently validated/rehearsed; no global install.

Both actual tarballs run outside the repository through plain Node processes.
Lost-response recovery preserves the original body/receipt/transaction across
client and key-free provider process restart with no new payer signature or
settlement. Independent calldata/event/coverage and token accounting proof pass.
A separate signed500 claim executes from the payer with fixed gas/fees, then an
external test-only adjudicator refunds10003atomic fixture units. Core58415=
stake16087+pool42328; other2coverages stay active, locked7004/reserved20006,
payer119994. Same-evidence claim recovery/reconciliation signs nothing.

Primary typecheck/build and full23client/37M3/25pilot/7provider tests (92total),
external root/types/deep-import/example checkJs, skill validator, independent
Luna(high) review and standalone demo pass. Results:
planning/EVM_M10_RESULTS.md; local-only report:
packages/client-sdk/evidence/m10-consumer-gate.json.

Existing contracts/economics/receipt formats, M4/M5 logic, M9 sources and public
campaign/runtime state remain unchanged. This is local fixture evidence, not
public native-USDC deployment, finality, production custody, global account caps
or authenticated backup rollback. M5 public allowances remain consumed.

Next: freeze the self-contained M11 protocol API packet before implementation,
including canonical summary/list/provider/policy reads, fixed role actions,
admin/relayer separation and local browser actor/confirmation/CSRF boundaries.
M12 console and M13 consumer UI remain dependent; no UI acceptance is inferred.


## EVM-049 — Protocol application boundaries and role composition

Status: ACCEPTED for implementation. Date:2026-10-24.
Source: continuing user authorization after M10 checkpoint b772e67.

Freeze planning/EVM_M11_PROTOCOL_API.md after three independent Luna(high)
source reviews. New local-only packages/protocol-app owns canonical registry/
coverage/accounting read models, host-issued browser actor capabilities, fixed
preview/confirm controls and a separate durable selector-restricted sender.
No public chain action, UI, registry publication or production login is implied.

Preserve M6/M9 exact public v1 schemas and defaults. Add only an explicit internal
expectedAdmin seam to checkPilot/startPilotProvider; a new protocol composition
passes its separate admin, while the online provider holds only relayer signing
authority. Primary service owner=payout remains explicit; future public SDK
composition support needs its own scoped extension. Existing client SDK works
through its accepted public methods without an admin signing dependency.

Reuse M4 complete canonical coverage projection and claims/auth/evidence/decision
semantics. Index bounded provider/policy events and verify mappings at the same
head. Registries lack counts; trusted RPC completeness for unreferenced registry
events is an explicit limit. Public read rows omit request/evidence/decision
hashes and private content. Net-paid totals are cumulative receipts, not profit.

Host-created one-use bootstrap capabilities bind sessions to server actors;
browser role names grant nothing. Same-origin/Host/CSRF, bounded JSON, one-use
confirmed previews and cookie isolation precede any financial signing. Adjudicator
private evidence is scoped through the existing backend. New controls are fixed
admin registration/pause/funding, primary provider collateral/withdrawal and
explicit adjudication; exact ERC20 allowance is a separate approved operation.
Operator can only reconcile managed known hashes and read sanitized health.

Actor journals reserve before signing and persist locally derived hash/attempt
before a single broadcast. Unknown/prepared-unsent stays blocked, without
replacement/rebroadcast or fee escalation. Fixed fee/gas/amount/count limits,
all actor privileges, real EVM state/invariants and HTTP failure boundaries must
pass before M11 acceptance. M12–M14 remain dependent phases.

Review refinement: bind HTTP preview capabilities to their creating session,
validate registry logs against each requested chunk, and recheck the fresh
simulation anchor before signing/sending. Reconciliation uses exact transaction
events and immutable/terminal state; block-end mutable counters are not a
transaction-index snapshot. New app storage-key fingerprint binds configuration
identity only; M4 encrypts private payloads, while protocol journals contain
public metadata/commitments and have no authenticated rollback guarantee.

## EVM-050 — Local protocol application acceptance

Status: ACCEPTED. Date:2026-10-25.

Accept M11 under EVM-049. New private packages/protocol-app implements bounded
canonical summary/registry/coverage reads, host-issued actor sessions, fixed
unsigned previews/explicit confirmations, scoped evidence and durable original-
hash reconciliation. The narrow internal M6 expectedAdmin seam proves separate
admin/online-relayer composition while preserving legacy defaults and SDK schemas.
No contracts/economics/receipt formats or existing public campaign state change.

Primary final typechecks and21protocol/26pilot/7provider/23client tests PASS
(77total, no failures/cancellations/skips), including actual EVM financial effects
and included-revert/HTTP/state failures. Independent Luna(high) reviews close
scoped blockers. Standalone full demo passes with16broadcasts,3payment signatures
and3handlers. Original-hash refund recovery without signing accounts and key-free
original-result retrieval add no sends/payment signatures/handlers. Final Core
72415=stake20087+pool52328; other coverage locks3502/reserved10003 remain protected;
active/count1/3 and payer119994atomic fixture units. Results/evidence:
planning/EVM_M11_RESULTS.md and packages/protocol-app/evidence/m11-protocol-gate.json.

This is local fixture evidence, not public native-USDC proof, finality, production
auth/custody, authenticated rollback or globally durable budgets. Pre-broadcast
reservations/prepared-unsent records can strand an actor and deliberately block
new operations; no reset/abandon path is claimed. Protocol journal key identity
is a fingerprint only, with M4 retaining private payload encryption. Unreferenced
registry completeness remains a trusted-RPC assumption. Public provider SDK
separated-admin composition requires a future explicitly scoped extension.

Next freeze M12's local protocol-console packet: role-specific real-state views,
host-to-browser capability provisioning, explicit approvals and browser failure
journeys. M13 consumer app and M14 presentation remain separate dependent gates.
All M5 budgets stay consumed; no public financial action or hosting is authorized.

## EVM-051 — Local console and host-armed demo seat

Status: ACCEPTED for implementation. Date:2026-10-25.

After M11 checkpoint51cf1ac and three Luna(high) read-only source scouts, freeze
planning/EVM_M12_PROTOCOL_CONSOLE.md. Keep a buildless console inside the private
protocol app, on its existing API origin. Add only optional fixed static assets,
public context and one host-armed enrollment; existing M11 API-only behavior and
financial schemas remain unchanged. Every displayed amount/action comes from
M11; backend session role/capabilities remain authoritative.

The trusted host chooses one role at launch and arms one exact empty-body
same-origin enrollment. Consuming that arm creates the existing M11 cookie/CSRF
session without exposing bootstrap capabilities in URLs, HTML, logs or storage.
No browser request selects/rearms a role. This is a trusted-machine local demo
seat, not OS-user/production authentication: permitted local same-origin clients
can claim the host's one armed seat; same-user local processes remain trusted.
Logout/expiry requires host rearming, with no automatic enrollment. Header/CSP/
Origin controls exclude untrusted web origins and framing, not hostile local
machine administrators. A trusted host CLI role restart invalidates old sessions.

Keep session/CSRF/preview/cursor/private evidence only in volatile browser memory.
Render untrusted data with safe DOM text; label atomic units and per-panel block
provenance. Fixed action reviews require fresh explicit confirmation. Unknown
responses permit original-hash reconciliation only. No role-picker authority,
generic wallet, subjective adjudication, process endpoint or financial reset.

Use fresh local EVM/provider/client fixtures and supported real browser tooling
for success/failure/approval/refund/recovery gates. No new frontend/browser
dependency or public deployment is required. M13/M14 remain dependent phases;
all existing public accounts/campaign state/budgets remain untouched.
