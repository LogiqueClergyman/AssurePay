# Session handoff

Updated:2026-10-26. Branch:`main`, tracking origin/main. M1–M12 are ACCEPTED;
M12 acceptance is EVM-052 (implementation EVM-051). Read AGENTS.md, active
planning/EVM_M12_PROTOCOL_CONSOLE.md, completed planning/EVM_M11_PROTOCOL_API.md
and planning/EVM_M11_RESULTS.md, planning/EVM_PRODUCT_ROADMAP.md, DECISIONS.md and
IMPLEMENTATION_PLAN.md. Do not access /docs.

## Current outcome and exact next action

M11 is ACCEPTED under EVM-050, implemented under EVM-049. The new private
packages/protocol-app owns canonical summary/provider/policy/coverage reads,
host-issued actor sessions, fixed preview/confirm controls, scoped private
adjudicator evidence and durable original-hash reconciliation. The narrow M6
expectedAdmin compatibility seam preserves legacy defaults and enables the new
internal product composition with separate admin/online relayer. Existing public
SDK schemas, contracts/economics/receipts and public campaign state are unchanged.

Primary final typechecks and21protocol/26pilot/7provider/23client tests PASS
(77total; no failures/cancellations/skips). SDK suites include builds/packed
outside-repository consumption. Standalone protocol npm run demo PASS, public
report: packages/protocol-app/evidence/m11-protocol-gate.json. Full scenario
executes every fixed operation kind,3explicit purchases,2payer claims, authorized
private evidence, rejection/PoolOnly refund and signer-free original-hash recovery
following a deliberately lost response/hidden receipt. Key-free provider/buyer
restart retrieves the original result with no additional charge/handler.

Exactly16broadcasts:6admin/3provider/2adjudicator/2payer claims/3relayer settlements;
3payment authorizations and3handlers. Recovery changes none. Core72415=
stake20087+pool52328, locks3502/reserved10003, active/count1/3; payer119994atomic
fixture units. Real EVM included revert and accounting/state/HTTP failures pass.
Independent Luna(high) reviews close scoped blockers. Public artifact, lock
metadata, sensitive-field exclusions and whitespace checks pass. Earlier
cancelled/fixture-failing runs were superseded by the final complete21test pass.
Temporary local chains/private actors/runtime state are cleaned up.

M11 checkpoint51cf1ac is committed/pushed; main/archive remote refs verified and
working tree was clean. M12 packet is now frozen after three Luna(high) scouts.
It chooses a same-origin buildless console and a trusted-machine one-use seat
armed by the host role at launch. POST /console/session {} grants only that
host-selected role once; no browser role selection/rearming or bootstrap token
URL/HTML/log. This is a local demo seat, not production/OS-user authentication.

M12 is ACCEPTED under EVM-052 after implementation checkpoints331b57e/57a767f.
All29protocol tests, typecheck and console syntax pass; independent Luna(high)
review closes scoped blockers. Native Chrome Guest proves all role views, real
admin/provider controls, expiry/cancel/denial/unavailable/session/pagination and
original-hash recovery without a second send/signature/payment/handler.

The final user-performed Confirm succeeded on2026-10-26: PoolOnly10003refund,
original transaction0xfbcb21c9640ac13947141fa5603048644d5e1026f83187c0791c33cf430474fe,
operation0xa9713363461b8ab2b79d95080a7ce3033ed0a159b2a2491ee7c1490d0476c4da,
block29/hash0x00149e095c8f7ae0db0fbfba3a6cebd1a36b80fa5be1f7d952025a3eae72ff57.
Actual Core56409=stake13858+pool42551; other coverage locks3502/reserved10003,
active/count1/2, payer129997(+10003). Exactly10broadcasts,2payer authorizations,
2provider receipts,2relayer,4admin,2provider,1adjudicator,2handlers,1claim. Explicit
read-only reconciliation returned the SAME refund success and later status kept
all counters/balances unchanged. No new send/replacement/payment was created.

Private evidence/reason/decision form clear after success/navigation/logout;
logout does not rearm. Sanitized final overview capture retained in native CUA
tool result; documented CUA API has no repository PNG export, so no PNG is claimed.
Desktop/375px layouts were visually reviewed. Fresh fixture exec12636 quit normally
exit0 and cleaned its temporary actors/private state/Anvil. Owned Chrome Guest tab
closed. URL127.0.0.1:58440 is no longer running; do not reuse sessions/previews.
An earlier user generic error was reconciled: old session directly observed
expired, no adjudicator operation/broadcast then; only the console server was
rearmed on unchanged state before fresh review. Automatic review required user
handoff for final click; do not bypass future browser final-action restrictions.

Results: planning/EVM_M12_RESULTS.md; report:
packages/protocol-app/evidence/m12-console-gate.json. Public historical accounts,
paused Cores and ignored environments/journals remain untouched. No /docs access.
No production authentication, public deployment/native-USDC/finality claim.

Exact next action: freeze the self-contained M13 consumer-demo packet after
source-grounded Luna(high) scouts; no dependent code before packet/interface
freeze. Resolve public provider SDK v1 admin=relayer versus protocol app separate
admin composition explicitly. The consumer must use public client/agent SDK,
not protocol/provider internals, with visible approval/quote/payment/result,
failure/evidence/claim, separate adjudicator refund and original-ID recovery.
M14 combined local launch/rehearsal/presentation remains dependent. No input or
additional local funds are needed. The earlier M13 scout hit an agent usage limit;
retry scouts if available, preserving completed M12 acceptance evidence.

M13's separate consumer app uses the public client SDK/agent adapter and example
provider, with success/failure/claim/refund/original retrieval. M14 covers unified
local launch/rehearsal/presentation. These remain separate dependent gates. User
requests Luna(high) delegation, primary review/verification, checkpoint commits
and non-force main pushes. Continue autonomously within that scope; no user input
is needed for local M12 packet preparation.

## Accepted integration references

M10 under EVM-047/048: planning/EVM_M10_CLIENT_SDK.md and EVM_M10_RESULTS.md;
packages/client-sdk0.1.0,4agent tools/portable skill, examples/assured-client.
Packed plain Node SDK consumer, bounded approval/caps, payer claims/reads and
original recovery across actual client/provider OS-process restarts pass.
Checkpoint b772e67 is committed/pushed. M9 under EVM-045/046:
planning/EVM_M9_PROVIDER_SDK.md and EVM_M9_RESULTS.md; packages/provider-sdk0.1.0,
examples/data-profile-service. Provider/client packages remain private, publishing
disabled. M6/M7 accepted packets/results are named runtime/transport references.
M8 roadmap is planning/EVM_PRODUCT_ROADMAP.md under EVM-043/044.

The public provider SDK's v1 composition still assumes admin=relayer and primary
owner=payout. M11's internal product wrapper separately pins admin without passing
its account online. A future scoped SDK extension is required before claiming
separated composition through provider-sdk. Primary owner=payout remains coupled;
other registry entries can differ. No arbitrary sender, process controls, expiry
closure, subjective decision inference or browser-native custody is implemented.

## Scope and custody limits

Local-only direction persists. No hosting, registry publication, fresh public
campaign, deposit/top-up, unpause, cleanup, sweep, fee escalation or old-Core
financial action is authorized. Existing M5 allowances are consumed. Public
native-USDC/finality/production availability is not proven by M9–M11 fixtures.

Trusted local RPC/storage/custody remain assumptions. Unreferenced registry event
completeness is trusted because Core lacks registry counts. Protocol journals
contain public metadata/commitments; the app key binds a configuration fingerprint
only, not encryption/MAC. M4 encrypts private evidence/reasons. No authenticated
backup rollback or stale-lock takeover. Reserved/prepared-unsent operations can
strand an actor; they intentionally block rather than reset/resend. Do not delete
journals or locks to bypass uncertainty. Unknown responses reconcile only known
original hashes; never create another payment merely to recover a response.

Never manually read populated environments/private journals, print or commit
keys, mnemonics, tokens, signatures or signed blobs. Runtime Node --env-file
loading is permitted for separately scoped existing workflows. Preserve ignored
spikes/evm-m1/.env.local and .env.vault.local, packages/evm-acceptance/.env.m5.local,
original .local-m5 and second .local-m5-r2, .local-public-run/.local-vault-funding.
Never rerun setup/regenerate existing keys. New demo actors are disposable only.

## Historical public proof — preserve, do not continue

M5 accepted under EVM-037; checkpoint b018cf6 and planning/EVM_M5_RESULTS.md.
The explicitly approved distinct second campaign at689703e completed14protocol
steps (13successes, final included revert) and its two exact vault top-ups.
Base Sepolia84532/native test USDC0x036cbd53842c5426634e7929541ec2318f3dcf7e;
Core0x36e4f1080719a12af93e2d7a33940e81671af3b1 remains paused. Final anchor48756153,
hash0xe001bb55d043b245e118a445c26e1f962fe647f03d099b4c60631342caa93913;
Core16017=stake4460+pool11557, locks/reservations/active0, count2both Refunded.
Public reports under packages/evm-acceptance/evidence include second-public-
funding/continuation/reconciliation/verification/costs and second-final-state.json.
Funding targets/default nonce snapshots are historical; do not overwrite them.

The first campaign Core0x615c52d5a4f98a04943f95d598b0128e74890d86 reached seven
confirmed steps and purchaseA, then its claim expired during interruption.
Its collateral/evidence/ignored namespace stay preserved; do not continue it.
No old-Core withdrawal/closure/unpause or vault sweep is authorized. Managed vault
0x7a776d8f819b33f50ef85d37effcb5bdd2714756 and all existing actors remain untouched.

## Git

User authorizes checkpoint commits and non-force pushes to
https://github.com/LogiqueClergyman/AssurePay main. M11 checkpoint51cf1ac is pushed;
M12 is accepted under EVM-052; see Git log/status for its acceptance checkpoint. Preserve unrelated work and
archive/algorand-p1 at958f65002d6afd97e8cbb86bae63ecabe5abb024 locally/remotely;
remote evm/restart remains preserved. Never amend shared history or force push.
