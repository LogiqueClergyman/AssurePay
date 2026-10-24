# Session handoff

Updated:2026-10-25. Branch:`main`, tracking origin/main. M1–M11 are ACCEPTED.
Read AGENTS.md, completed planning/EVM_M11_PROTOCOL_API.md and
planning/EVM_M11_RESULTS.md, planning/EVM_PRODUCT_ROADMAP.md, DECISIONS.md and
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

Exact next action: freeze the self-contained M12 protocol-console packet, then
implement its browser views and host-to-browser session provisioning over M11.
M12 must show provider collateral/net-paid/coverage, admin registrations/pause/
funding, operator canonical availability/reconciliation and adjudicator private
review/explicit decisions. Every visible amount/action must come from the API;
explicit confirmation must show the frozen preview and its real authority.
Include browser success, denied, unavailable, stale/expired and recovery journeys.
Do not use a browser role picker as authorization, expose keys/bootstrap tokens
in logs or replace unknown operations. No M12 implementation has started.

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
https://github.com/LogiqueClergyman/AssurePay main. M11 checkpoint commit/push is
the final session action after these passing checks. Preserve unrelated work and
archive/algorand-p1 at958f65002d6afd97e8cbb86bae63ecabe5abb024 locally/remotely;
remote evm/restart remains preserved. Never amend shared history or force push.
