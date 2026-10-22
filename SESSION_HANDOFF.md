# Session handoff

Updated:2026-10-22. Branch:`main`, tracking origin/main. Last published checkpoint
922947f (M5 Stage A). Active packet:`planning/EVM_M5_PUBLIC_ACCEPTANCE.md`.
M1/M2/M3/M4 ACCEPTED under EVM-015/018/022/026. M5 IN_PROGRESS, NOT ACCEPTED.
Read AGENTS.md, active packet, DECISIONS.md and IMPLEMENTATION_PLAN.md. No /docs.

## Exact current state

User approved the exact first M5 funding/14-transaction campaign at checkpoint
922947f; EVM-029 records that authorization. All three vault top-ups confirmed
once, nonces1/2/3, total value504480018003071wei, measured fees378000000276wei.
Public evidence:packages/evm-acceptance/evidence/public-funding-reconciliation.json.
No transaction was replaced/rebroadcast after unavailable immediate RPC reads.

First public Core:0x615c52d5a4f98a04943f95d598b0128e74890d86. Seven confirmed
steps:deploy/provider/policy/approve/stake/pool/purchaseA, recorded in
public-reconciliation.json. PurchaseA tx:
0x34f1ca3d3836635e270516ad617f400bcf7c1ec7ddf9e9c7ec054a59e59d6b1b.
The HTTP200 case, exact retry and provider restart completed with one payer
signature/relay signature/broadcast/handler; public-first-http-observation.json
preserves hashes/counters without signatures or private response bytes.

The run stopped before claimA with PROJECTION_UNAVAILABLE. Read-only diagnostic
reproduced PROJECTION_HEAD_CHANGED on normal Base tip progress. EVM-030 permits
only the narrow M4 projection source/test change: final canonical re-read of the
original numbered head, instead of requiring latest tip to remain unchanged.
Backend typecheck/18 tests pass, including actual advancement/reorg cases.

During interruption purchaseA's one-hour claim window expired at2026-10-22
00:21:40 IST (1792608700). public-continuation-status.json proves canonical
head48613869 timestamp1792644642, statusActive/refund0/canFileClaim=false.
DO NOT run public continuation, repeat the first payment/setup, backdate a claim,
change old policy, close/withdraw old collateral or create another campaign under
EVM-029. No such additional public transaction has been sent. Full M5 refund/
negative-case acceptance is still unproven. Unused original scope is not a fresh
campaign allowance.

## Local corrections and next action

Bounded exact-seven-prefix continuation is implemented for timely future recovery:
validates all prior identities/calls, reconciles known hashes, recovers the A
intent in memory, preserves public observation, checks current claim eligibility
before any signing, then can submit only remaining seven approved steps. It is
not usable for this expired public coverage. Agent typecheck/28 M5 tests pass,
including actual local recovery and expiry rejection with zero signing/broadcast.
The isolated second-attempt guards are also implemented. Final primary M5
typecheck/31tests and backend typecheck/18tests pass, no skips/failures; independent
CLI review reports no blocker. Default second-attempt CLI passed public read-only
checks without keys, journal creation or transactions. Evidence:second-attempt-preflight.json.

EVM-031 authorizes LOCAL preparation of a distinct second experiment only.
Exact next action after this verified checkpoint is published: request NEW public
approval. Do not execute second-attempt funding/campaign until user explicitly
approves that concrete scope. No dependent phase begins before complete M5 proof.

Public proposal:packages/evm-acceptance/evidence/second-attempt-proposal.json.
Fresh runId:0x28daab42bd847baae99a50c2ac97666cc9f2117add83540527b0815e8a37e58b,
fresh provider/policy/service IDs and predicted Core (relayer nonce9):
0x36e4f1080719a12af93e2d7a33940e81671af3b1. Same four existing EOAs and unchanged
14-step economics. Separate ignored .local-m5-r2 journals/data; preserve original
.local-m5 and runtime configuration. Reuse runtime data key with new Core namespace
and fresh IVs; no new key/environment generation or manual environment inspection.

Proposed second funding:19674564006637wei relayer +1701102000276wei payer;
adjudicator/provider need0. Vault nonces4/5; role nonces9/3/0. Total top-ups
21375666006913wei; funding-fee allowance6200000000000wei; maximum new vault outflow
27575666006913wei. New 14 protocol txs allocate43514atomic test USDC, protocol
fee allowance905000000000000wei; combined new fee allowance911200000000000wei
(0.0009112 test ETH). Existing funds suffice; changed conditions stop rather than
enlarge scope. There is no old-Core cleanup transaction in this proposal.

## Wallet, journal and repository preservation

Managed vault:0x7a776d8f819b33f50ef85d37effcb5bdd2714756, latest balance
98649782671914839wei. Relayer:0xc6643871078fd90c1a94528369c2443f53b9762a,
683325435993363wei. Payer:0x6671c66c40133c62f3442baa91f6868f1d7769fd,
106298897999724wei and19966389atomic USDC. Adjudicator:
0xbd06d6bf0cc8e4099ffd16d65caa7346351ff8e8,94000000000000wei. Provider:
0x2ccf71ae890f9fe8c85d97086ffe145ddcc3bc29,0native. Snapshot evidence:
public-post-interruption-preflight.json. Amounts are atomic integers.

Preserve ignored mode0600 spikes/evm-m1/.env.local and .env.vault.local;
completed .local-public-run/.local-vault-funding journals remain untouched.
Preserve packages/evm-acceptance/.env.m5.local and live .local-m5 journal/data.
Original runId:0xa753b52d7bef756487b10139573a51c28f49f0f1844d6222e9088a48e8ceae15.
NEVER rerun setup, display populated files/keys/signatures/signed blobs, delete
journals or infer non-inclusion from an RPC timeout. Runtime Node env loading is
allowed. Existing scopes/keys cannot authorize a fresh campaign implicitly.
Exclusive run locks fail closed; stale locks require inspection, not takeover.
Initial empty-journal truncation can block availability before signing; never
silently recreate a corrupt journal. Funding aggregate fee observations use
canonical balance deltas with no concurrent account use/incoming funds; unknown
receipt components remain unavailable. One canonical inclusion, not finality.

M1 public proof remains accepted, Core0x35e6a35b68869bbe8548d41ac75ddd8e4bf6cfce;
no M1/M2/M3 source or completed evidence changed. M4 only the scoped projection
fix/tests. No production security audit/hosting/UI/subjective adjudication inferred.

User authorizes Luna(high) delegation, checkpoint commits and non-force pushes to
https://github.com/LogiqueClergyman/AssurePay main. Preserve archive/algorand-p1 at
958f65002d6afd97e8cbb86bae63ecabe5abb024 locally and remotely. Remote evm/restart
is preserved. Never amend shared history or force push. No /docs was accessed.
