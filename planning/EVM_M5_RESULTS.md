# M5 combined-stack acceptance results

Updated:2026-10-22. Branch:`main`. State:first public campaign PARTIAL/EXPIRED;
second experiment is local preparation only, awaiting new approval.
Packet:`planning/EVM_M5_PUBLIC_ACCEPTANCE.md`. Decisions:EVM-026..031.
M5 is NOT accepted: complete native public combined-stack proof remains pending.

## Delivered scope

New isolated `packages/evm-acceptance` composes the unchanged M2 financial Core,
M3 registered x402 HTTP flow and M4 encrypted results/evidence/claims backend.
The campaign fixes fourteen ordered steps, exact roles, calldata/economics,
nonces, fee/gas allowances and one-attempt public journals. Its sender derives
and persists public transaction identity before broadcast; raw signed bytes
remain in memory. A separate signer-free verifier fetches transactions, receipts,
code and canonical state itself, reconstructing public receive signatures only
in memory. Reports never serialize signature/calldata/raw transaction material.

Both successful200 and signed500 HTTP cases settle before handler execution.
Each repeated request and provider restart retrieves the exact archived result
with one payment signature, relay signature, broadcast and handler. Synthetic
authenticated encrypted evidence leads to direct payer claims and explicit
adjudicator refunds:3100 ProviderFault and10003 PoolOnly. These fixed fixtures
do not classify evidence or infer service quality. The final distinct valid
receive intent reverts after pause; the nonce remains unused and all financial
state unchanged. This is admission failure before receive, not post-receive
native-USDC rollback proof.

## Local evidence

`packages/evm-acceptance/evidence/local-rehearsal.json` records an actual
fourteen-transaction Anvil execution with the faithful ERC3009 fixture:

- Independent result:`M5_LOCAL_REHEARSAL_VERIFIED`; thirteen successes and the
  final included revert. Total gas4499026 versus7050000 aggregate gas caps.
- Local execution fees19403010205875wei; calldata14649bytes. Anvil L1/operator
  fee fields are unavailable. These are local observations, not public estimates.
- Exact approval/funding, purchase/refund token deltas, coverage claim pins,
  provider-fault waterfall, pool-only payment and solvency/isolation checks pass.
- HTTP200/500 repeat/restart bodies and receipt hashes match; each case records
  one payer signature, relay signature, broadcast and handler.

Primary `npm test` passed26/26, no skips/failures, including actual EVM financial
execution and real HTTP sockets. Typecheck passed. Local tests also cover signer
field substitutions, request/config/manifest/schema tampering, lost responses,
prepared-no-broadcast crashes, signer-free known-hash recovery, exclusive run
locking and verifier rejection of wrong chain, missing receipt/RPC, changed
canonical anchors, excessive fees/gas, altered refund state and missing events.
The original primary suite passed after funding fee corrections and durable
transport observation changes. A subsequent focused funding rerun covers
confirmed measurement tampering. Unchanged M1–M4 packages were not rerun.

Three Luna(high) agents completed bounded funding, adversarial verifier tests
and independent review/run locking. Primary and cross-component review closed
fee-allowance/actual-spending confusion, strict plan derivation, concurrent CLI
starts, stale inner locks, canonical receipt anchors and immutable measured fees.
The reviewer reports no remaining financial blocker. Initial empty-journal crash
availability is retained as an explicit limit below. This is development review,
not a production security audit. At that checkpoint no contracts or M1–M4
source were changed; the later EVM-030 projection correction is described below.

## Original public approval and preflight

`packages/evm-acceptance/evidence/public-preflight.json` is a read-only snapshot
at Base Sepolia block48418077, hash
`0x07c22ee43aa788eb7c07c4a26ee0f49a9db00192518dcc60824d54cd46fa92c0`.
Native USDC has code, USDC/2/six-decimal domain matches, payer balance19999900
atomic exceeds required43514. Base fee5000000 plus priority1000000wei fits the
fixed max fee100000000wei. Runtime signer address/config check passed without
signing or submitting. No public mutations occurred during Stage A.

The concrete signer-free funding plan is
`packages/evm-acceptance/evidence/funding-plan.json`, observed at block48418067,
hash`0xf4c8ff41cebfdca3f48958bf8fb3fdfcf6f0a61b50c8d19355a81318d8ffa277`.
It proposes vault nonces1/2/3; relayer current nonce5, payer/adjudicator0. Balances
and the separate preflight agree. No vault signer was loaded to build this plan.

| Role | Address | Current wei | Target wei | Proposed top-up wei |
|---|---|---:|---:|---:|
| Relayer/admin | `0xc6643871078fd90c1a94528369c2443f53b9762a` |400519981996929|703000000000000|302480018003071|
| Payer | `0x6671c66c40133c62f3442baa91f6868f1d7769fd` |0|108000000000000|108000000000000|
| Adjudicator | `0xbd06d6bf0cc8e4099ffd16d65caa7346351ff8e8` |0|94000000000000|94000000000000|
| Provider | `0x2ccf71ae890f9fe8c85d97086ffe145ddcc3bc29` |0|0|0|

Managed vault:`0x7a776d8f819b33f50ef85d37effcb5bdd2714756`, balance
99154640689918186wei. Three top-ups total504480018003071wei; their fee allowance
adds9300000000000wei, so maximum new vault outflow513780018003071wei at this
snapshot. Each transfer uses21000gas, max fee100000000, priority1000000wei and
1000000000000wei auxiliary reserve. Refresh balances/nonce/fees before execution;
changed conditions stop rather than increase the approved values.

Fourteen protocol transactions use7050000 gas caps and200000000000000wei
auxiliary reserve:905000000000000wei protocol allowance. Campaign plus funding
fee allowance914300000000000wei (0.0009143 test ETH). Maximum initial USDC
allocation43514 atomic (0.043514 test USDC), including23508 approval for stake/
pool donations and two receive-authorized10003-unit purchases. All refunds go
to the stored payer. The user approved this exact first-campaign scope under
EVM-029 at checkpoint922947f. It does not authorize another campaign.

## First public campaign: partial, no M5 acceptance

All three top-ups are canonically confirmed, with one distinct vault nonce each:
1/2/3. `evidence/public-funding-reconciliation.json` reports funding_complete.
Each used21000gas at6000000wei plus92wei auxiliary cost; total fees378000000276wei,
total vault outflow504858018003347wei. Immediate receipt reads were unavailable;
signer-free reconciliation observed each original hash before the next missing
step. No transfer was rebroadcast or replaced.

`evidence/public-reconciliation.json` records seven successful protocol steps:
deployment, provider, policy, approval, stake, pool, purchaseA. Core:
`0x615c52d5a4f98a04943f95d598b0128e74890d86`. PurchaseA:
`0x34f1ca3d3836635e270516ad617f400bcf7c1ec7ddf9e9c7ec054a59e59d6b1b`,
block48418406. `evidence/public-first-http-observation.json` preserves its200
response hashes and exact repeat/restart observations: one payment signature,
relay signature, broadcast and handler. This is observed transport evidence,
separate from independent chain verification.

The runner stopped before claimA with PROJECTION_UNAVAILABLE. Read-only diagnosis
identified PROJECTION_HEAD_CHANGED: the tip advanced during otherwise pinned
projection reads. EVM-030 changes only the final projection check to re-read the
original numbered block/hash. It permits normal tip progress and still rejects
replacement of that block. Backend typecheck and18actual/local tests pass,
including advancement and reorg cases. A bounded seven-step-prefix continuation
also checks exact calls/settlement and refuses expired claims before signing.
Its typecheck and28M5 tests pass, including actual failure/recovery and zero-sign/
zero-broadcast expiry rejection. No public continuation was executed.
With the second-experiment proposal/nonce guards added, final primary M5
typecheck and31tests pass, no failures/skips. Backend typecheck/18tests pass.
The expired-case test also compares the full unchanged public journal snapshot.

During the work interruption the one-hour claim window expired.
`evidence/public-continuation-status.json` reads canonical block48613869:
opened1792605100, expires1792608700, observed1792644642, statusActive/refund0,
canFileClaim=false. Expiry was2026-10-22 00:21:40 IST. No backdated claim, policy
change, duplicate payment or doomed refund transaction was submitted. The original
approved fourteen-step proof cannot now complete. Read-only reconciliation of
seven known hashes is not full M5 verification; costs.ts rejects partial campaigns.

Current role balances in `evidence/public-post-interruption-preflight.json`
are683325435993363wei relayer,106298897999724wei payer,94000000000000wei adjudicator,
provider0. Their native balance decrease from the funded targets is21375666006913wei
under the documented no-concurrent-use assumption. Payer USDC is19966389atomic.

## Second experiment proposal: approval required

`evidence/second-attempt-proposal.json` fixes a distinct public runId:
`0x28daab42bd847baae99a50c2ac97666cc9f2117add83540527b0815e8a37e58b`.
Fresh provider/policy/service IDs and Core, same four EOAs/token/economics and
fourteen protocol steps; separate ignored `.local-m5-r2/` journal/data. Original
runtime config, paid result, collateral and all first-campaign journals remain
preserved. There is no old-Core cleanup transaction in this proposal.

At canonical funding-plan block48614729, vault nonce4 and role nonces9/3/0,
proposed exact top-ups are19674564006637wei to relayer and1701102000276wei to payer;
adjudicator needs none. Total21375666006913wei. Two transfers' fee allowance is
6200000000000wei; maximum new vault outflow27575666006913wei
(0.000027575666006913 test ETH). Predicted deployment Core, conditional on nonce9:
`0x36e4f1080719a12af93e2d7a33940e81671af3b1`.

New initial allocation43514atomic native test USDC (0.043514); new fourteen-step
protocol fee allowance905000000000000wei plus funding allowance6200000000000wei
=911200000000000wei (0.0009112 test ETH). Existing vault/USDC balances suffice;
no deposit is required. Fixed gas/fee/reserve settings remain unchanged. A separate
guarded CLI defaults to read-only and pins the proposal; changed conditions stop.
This is a new acceptance experiment, not recovery of the original paid response.
EVM-029 does not authorize it; request approval after the verified checkpoint.
`evidence/second-attempt-preflight.json` records the default CLI's successful
signer-free public check (`M5_SECOND_PROPOSAL_CURRENT`). It created no second
journal and sent no transaction. Three Luna(high) agents finished implementation,
actual-EVM regression tests and independent scoped review; the new CLI review
found no blocker. Funding plans reuse the strict derived-plan validator.

## Limits and next action

Single process per trusted local journal/storage/RPC; exclusive public CLI run
lock; no concurrent incoming funds/account use. Fee caps do not cap Base L1
publication charges. Auxiliary reserves and preflight estimates are allowances;
included fee fields must match receipt identity and unavailable data stays
unavailable. Unknown public hashes are reconciled without rebroadcast/replacement;
prepared-but-unsent transactions remain stranded. Incomplete campaigns cannot
produce complete acceptance.

The initial empty journal is created exclusively before signing. A process crash
during that first write can leave invalid JSON and require local inspection;
recovery fails closed and never deletes/recreates the journal automatically.
Subsequent identity/receipt updates use fsynced temporary-file replacement.

No production audit, hosting/UI, key rotation/KMS, subjective adjudication,
mainnet/multiple assets, finality or private HTTP/evidence truth proof. M1–M4
contracts and M1–M3 source/evidence remain unchanged. M4's only scoped source
change is the canonical projection check plus its two regression tests. Original
completed private journals remain preserved.
Preserve ignored `.env.m5.local` containing the fresh adjudicator/data key and
runId`0xa753b52d7bef756487b10139573a51c28f49f0f1844d6222e9088a48e8ceae15`.
Never display its populated contents or regenerate it for recovery.

Next after checkpoint publication: request the exact new second-experiment funding/public
scope. Execute only after approval. M5 remains
incomplete until both public refunds and the full signer-free proof pass.
