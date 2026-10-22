# Session handoff

Updated:2026-10-22. Branch:`main`, tracking origin/main. This checkpoint completes
M5 under EVM-037; predecessor689703e. Read AGENTS.md, active completed packet
planning/EVM_M5_PUBLIC_ACCEPTANCE.md, DECISIONS.md, IMPLEMENTATION_PLAN.md and
planning/EVM_M5_RESULTS.md. Do not access /docs.

## Current outcome and exact next action

M1/M2/M3/M4/M5 ACCEPTED under EVM-015/018/022/026/037. The bounded core MVP
implementation and native public acceptance gates are complete. No dependent
phase is active and no further campaign transaction is needed. Publish this
verified checkpoint to the already authorized origin/main if not yet published.
Then define the next self-contained packet from explicit product requirements
before implementation. No requirements have been supplied for a next phase;
do not infer production UI/hosting, governance, actuarial models, subjective
adjudication, commerce integration, mainnet or multiple chains/assets.

The user authorizes Luna(high) delegation, checkpoint commits and non-force
pushes to https://github.com/LogiqueClergyman/AssurePay main. Preserve unrelated
work and archive/algorand-p1 at958f65002d6afd97e8cbb86bae63ecabe5abb024 locally/
remotely. Remote evm/restart remains preserved. Never amend/force push.

## Completed second public campaign

User explicitly approved the exact second campaign at689703e; EVM-032. Base
Sepolia84532, native test USDC0x036cbd53842c5426634e7929541ec2318f3dcf7e.
RunId0x28daab42bd847baae99a50c2ac97666cc9f2117add83540527b0815e8a37e58b.
Core0x36e4f1080719a12af93e2d7a33940e81671af3b1.

Exactly two vault top-ups completed once, nonces4/5, value21375666006913wei,
measured fees252000000256wei, total vault outflow21627666007169wei. Evidence:
packages/evm-acceptance/evidence/second-public-funding.json, saved before protocol
accounts spent gas. After spending, funding-target/default nonce preflights no
longer describe live readiness; do not overwrite this pre-spend evidence.

Exactly14 protocol steps completed:13successes and final included revert. Both
HTTP200/500 observations record one payer payment signature, relay signature,
broadcast and handler with exact retry/restart recovery. Both explicit refunds
3100/10003atomic USDC went to stored payer. Separate signer-free reconciliation,
verification and costs pass; independent review finds no blocker. Evidence:
second-public-continuation.json, second-public-reconciliation.json,
second-public-verification.json, second-public-costs.json and second-final-state.json.
These are public artifacts under packages/evm-acceptance/evidence.

Final anchor48756153/hash
0xe001bb55d043b245e118a445c26e1f962fe647f03d099b4c60631342caa93913.
Core16017atomic USDC =4460provider stake+11557pool assets; locked stake/reserved
pool/active coverages0, count2, both Refunded, payer Core allowance0, pausedtrue.
Payer19935978/provider21684atomic USDC. Negative authorization unused, no financial
change. Protocol gas4579677, measured fees27478062008522wei; with funding total
27730062008778wei (0.000027730062008778test ETH), below911200000000000wei approved
fee allowance. Operator fee fields remain unavailable; no-concurrent-use native
balance-delta assumption applies. Canonical inclusion, not finality/private HTTP
truth/evidence truth/post-receive native rollback or production audit.

## Recovery and verification completed

The second run initially stopped after purchaseA with PROJECTION_UNAVAILABLE.
Signer-free reconciliation confirmed the original seven hashes before recovery.
Diagnostic getLogs error-32614 was range-related; raw500-block request failed
while100/10/1 worked. Exact network maximum was not established. EVM-033 bounds
retries to allowlisted reads; sends/signing/unknown methods are never retried.
EVM-035 adds an M5-only client adapter with contiguous <=100block getLogs chunks,
retaining full filters/ranges/logs and fail-closed projection checks. EVM-036
sets M5's existing maxBlocks option25000 (backend hard cap100000), retaining
maxCoverages1000 and original financial expiry. No M4 source change this turn.

A full canonical projection refreshed successfully at48753926, A active with
expiry1792675751. EVM-034 guarded --continue recovered the exact seven-step prefix
and submitted only the seven remaining approved steps. A was never paid or
executed again. Complete-prefix continuation and --execute now refuse existing
state. All funding/campaign allowances are consumed; no third campaign, top-up,
fee escalation, replacement or old-Core cleanup is authorized.

Primary M5 typecheck and full48tests PASS, no failures/skips/cancellations. They
include actual local EVM/HTTP, financial/verifier adversarial cases, same-prefix
recovery, expired rejection before signing, read-only retries, exactly-once send,
CLI scope guards and actual Anvil chunked/unchunked log equivalence. Earlier
M4 projection fix typecheck/18tests passed at689703e. Unchanged M1–M3 not rerun.
Final diff checks and12public-artifact sensitive-field/report-consistency checks
PASS. Runtime environments and both live namespaces remain ignored by Git.

## Historical first campaign: preserve, do not continue

EVM-029 approved the first campaign at922947f. Its three vault top-ups completed
once (nonces1/2/3), value504480018003071wei, fees378000000276wei. Core
0x615c52d5a4f98a04943f95d598b0128e74890d86 included seven successful steps through
purchaseA0x34f1ca3d3836635e270516ad617f400bcf7c1ec7ddf9e9c7ec054a59e59d6b1b,
block48418406, plus original HTTP200/retry/restart observation. Its projection
stopped on ordinary latest-tip progress. EVM-030 fixed only canonical numbered
head validation. During interruption its claim expired1792608700 (2026-10-22
00:21:40IST). No expired claim, duplicate payment, backdating or cleanup followed.
Its evidence, result, collateral and ignored .local-m5 namespace remain intact.
The partial first campaign never satisfied M5; only the separate approved
second run does. No old-Core withdrawal/close/unpause transaction is authorized.

## Runtime and custody preservation

Never manually read populated environments/private journals, print signatures,
signed blobs, keys or mnemonics. Runtime Node --env-file loading is permitted.
Preserve ignored mode0600 spikes/evm-m1/.env.local and .env.vault.local,
packages/evm-acceptance/.env.m5.local, original .local-m5 and second .local-m5-r2.
Second config overrides public IDs in memory; no new key generation or runtime
file overwrite occurred. Never rerun setup or regenerate keys for recovery.
Existing .local-public-run/.local-vault-funding journals remain untouched.

Managed vault0x7a776d8f819b33f50ef85d37effcb5bdd2714756; relayer/admin
0xc6643871078fd90c1a94528369c2443f53b9762a; payer
0x6671c66c40133c62f3442baa91f6868f1d7769fd; provider/receipt signer
0x2ccf71ae890f9fe8c85d97086ffe145ddcc3bc29; adjudicator
0xbd06d6bf0cc8e4099ffd16d65caa7346351ff8e8. No account sweeping is authorized.

Unknown transaction responses reconcile only the original hash; never resend or
make a fresh payment to recover a response. Prepared-unsent identities remain
stranded. Exclusive locks fail closed, with no automatic stale-lock takeover.
A crash during exclusive initial empty-journal creation may leave invalid JSON;
inspect rather than delete/recreate. Trusted durable filesystem/RPC and runtime
key custody remain assumptions; no KMS/rotation/distributed availability guarantee.
