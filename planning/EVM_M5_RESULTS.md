# M5 combined-stack public acceptance results

Updated:2026-10-22. Branch:`main`. State:ACCEPTED under EVM-037; complete public
proof, costs and independent scoped review pass. Packet:`planning/EVM_M5_PUBLIC_ACCEPTANCE.md`.
Decisions:EVM-027..037. The first campaign remains partial/expired; the separately
approved second campaign supplies the complete native-USDC proof.

## Public result

The second Base Sepolia campaign completed exactly14 ordered protocol transactions:
13 successes and the expected included revert. Core:
`0x36e4f1080719a12af93e2d7a33940e81671af3b1`; native test USDC:
`0x036cbd53842c5426634e7929541ec2318f3dcf7e`. Four distinct EOAs serve as
relayer/admin, payer, provider/receipt signer and adjudicator. No M2 contract or
financial rule changed during M5.

| Evidence in packages/evm-acceptance/evidence | Result |
|---|---|
| second-public-funding.json | Two exact top-ups confirmed before protocol spending |
| second-public-continuation.json | Complete runner result; HTTP observations and full verifier pass |
| second-public-reconciliation.json | Signer-free reconciliation of14 original hashes |
| second-public-verification.json | Separate process without wallet environment: M5_PUBLIC_CHAIN_VERIFIED |
| second-public-costs.json | M5_SECOND_PUBLIC_COSTS_RECONCILED; canonical balance deltas within allowance |
| second-final-state.json | Actual pinned final balances, refunded coverages and solvency equality |

The independent verifier fetches transactions/receipts/code/state itself. It checks
exact creation bytecode/immutables, roles, nonces, calls, policy, native-USDC logs,
per-step financial deltas, claim commitments, refund waterfalls, unused negative
nonce and unchanged financial state across the final revert. Every inclusion
anchor is re-read for canonicality at the end. Public calldata signatures are
reconstructed only in memory; artifacts do not duplicate signatures or raw calls.

## Product behavior exercised

Registered x402 client/server/facilitator composition settles before the handler.
PurchaseA returns HTTP200; PurchaseB intentionally throws and returns a signed500.
Both retry and provider restart return matching archived body/receipt hashes.
Each case observes one payer payment signature, relay signature, broadcast and
handler execution. Original A observations are recovered during continuation;
A is never paid or executed a second time. These are actual runner observations,
separate from what the chain can independently prove about private HTTP bytes.

Authenticated synthetic encrypted evidence prepares direct payer claims and
explicit adjudicator decisions. A refunds3100atomic USDC through ProviderFault;
B refunds10003atomic through permitted PoolOnly. These are fixed test decisions,
not service-quality judgments or evidence classification. Both pay the stored
payer. Admin then pauses and submits a distinct valid receive authorization:
included revert, no token authorization consumption/coverage, no financial change.
The failure precedes USDC receive; it does not prove post-receive native rollback.

| Critical step | Transaction hash |
|---|---|
| Deployment | 0xaa64bc785db862ce5f7c3a95221e657a73050e3618447d8db5f2f947d035cf11 |
| PurchaseA | 0xa966cc94877d8f9921ad5e11e19e21af56f0e8b3ede8975ac62d74f39304e291 |
| RefundA | 0xa94c165e0c5c4a4133f5cd42beffa16ac72205420239fbaa1f620038462eed05 |
| PurchaseB | 0x69b38b59ca963335ccd8c432fad0db0dfdfa6c986c396ad852b6434976a3381e |
| RefundB | 0xb05f10b334e9c7211fc31a675489c9452930a2b5937f98dfb71e5c543eddb2dd |
| Included negative | 0x6a87f649d57cddc326767b5f4444944eb53c6ce5e6384840a02f24b390188cdf |

## Final public financial state

Pinned final block48756153, hash
`0xe001bb55d043b245e118a445c26e1f962fe647f03d099b4c60631342caa93913`.
All token amounts below are integer atomic USDC units (six decimals).

| Item | Observed value |
|---|---:|
| Core USDC |16017|
| Provider stake |4460|
| Pool assets |11557|
| Locked stake / reserved pool |0 / 0|
| Coverage count / active count |2 / 0|
| Payer USDC |19935978|
| Provider USDC |21684|
| Payer allowance to Core |0|

Core USDC equals stake plus pool:16017=4460+11557. Both coverages are Refunded;
outcomes are ProviderFault1 and PoolOnly2, amounts3100 and10003, respectively.
Core is paused. The final rejected authorization remains unused. Old-Core funds
and the historical first campaign were not cleaned up or modified.

## Funding and measured costs

EVM-032 records the user's explicit second-campaign approval at689703e. Initial
USDC allocation43514atomic: exact23508approval for3502stake+20006pool donations,
plus two10003gross purchases. Policy remains777premium/3500stake/2200withholding
bps,3600seconds, poolOnlyAllowed=true. Each purchase quotes P777/W2029/net7197,
stake lock3502 and pool reservation10003.

Vault nonces4/5 funded exactly19674564006637wei to relayer and1701102000276wei
to payer. Hashes:
`0x9b0cf99fd592d3278226f66dc565991151e52229b852c13290278c0c8f412440` and
`0x0c363068be6716d8f932e8a2ed9e459022f753a046afe2c5445cdb09d4724178`.
No additional top-up, replacement, fee increase or third campaign was used.

| Measurement | Actual wei | Approved allowance wei |
|---|---:|---:|
| Protocol native expenditure |27478062008522|905000000000000|
| Funding fees |252000000256|6200000000000|
| Combined fees |27730062008778|911200000000000|
| New vault outflow, including transferred value |21627666007169|27575666006913|

Combined actual fees are0.000027730062008778 test ETH. Protocol gas4579677
versus7050000gas caps, calldata14649bytes. Execution fees27478062000000wei;
identity-matched reported L1 fees8522wei. Funding used42000gas and measured
aggregate auxiliary fees256wei from canonical vault balance deltas. Matching
funding receipts also expose256wei L1 fees. Operator fields remain unavailable;
zero unattributed balance delta is not an independently reported operator fee.
Balance-delta attribution assumes no concurrent account use or incoming funds.
Amounts are measured testnet costs, not production estimates.

## Recovery corrections and historical first campaign

The first EVM-029 campaign included seven steps and one paid200 result on Core
`0x615c52d5a4f98a04943f95d598b0128e74890d86`. Its three funding transfers cost
378000000276wei; total old vault outflow504858018003347wei. It stopped before
claimA because the projection required latest tip equality. EVM-030, committed
in689703e, validates the original numbered canonical head while permitting normal
tip advancement. Backend typecheck/18tests pass, including actual advancement
and replacement rejection. During interruption the first claim expired at
1792608700 (2026-10-22 00:21:40 IST); no expired claim or duplicate payment was
submitted. Its journals, result, collateral and public evidence remain preserved.
That partial campaign never satisfied M5; it cannot be retried as a fresh run.

The approved second run also stopped after its seventh step. Safe reconciliation
preceded all recovery. This time diagnostic getLogs returned range-related
RPC error-32614. Raw probes rejected500blocks while100/10/1 succeeded; the exact
network maximum was not established. EVM-035 adds an M5-only adapter that divides
the complete requested range into contiguous at-most100-block reads, preserves
all filters/logs and rejects any failed chunk. EVM-033 retries only allowlisted
idempotent reads; signing/sending/unknown methods are never retried.

EVM-036 sets M5's existing projection maxBlocks option to25000 (backend hard cap
100000), retaining maxCoverages1000 and all canonical/state/range checks. It does
not extend coverage expiry. A full public projection refreshed successfully at
block48753926 with A still active. EVM-034 then routed the existing tested exact
seven-prefix continuation to the second namespace; only the remaining seven
approved steps were submitted. M4 source was not changed by these corrections.

## Verification and review

Primary M5 `npm run typecheck` PASS; full `npm test` PASS, **48tests**, no failures,
skips or cancellations. Actual local EVM/HTTP tests cover complete execution,
signer-free same-hash recovery, continuation without repeating A, expired-claim
rejection before signing, financial isolation/solvency and adversarial verifier
state/log/fee/canonical evidence. New tests cover read serialization/retries,
exactly-once write delegation, CLI scope guards, chunk boundaries/filter snapshots,
fail-fast behavior and actual Anvil chunked/unchunked log equivalence.

Luna(high) agents implemented the bounded read/log helpers and independently
reviewed funding, continuation guards, final public proof and costs. Primary
verified the code, regression suite and separate signer-free public reports.
No M1/M2/M3 contract/source changes; M4 only has the earlier EVM-030 projection
correction. No `/docs` access or populated runtime environment inspection.

## Limits and next action

Single process per trusted local journal/storage/RPC, runtime key custody and
exclusive run lock. No automatic stale-lock takeover; prepared-but-unsent
transactions stay stranded. An initial empty-journal crash can leave invalid JSON
and requires inspection; recovery never silently recreates it. Unknown broadcast
responses reconcile the same hash without replacement. Preserve both ignored
namespaces and populated runtime files; never regenerate keys for recovery.

Evidence proves canonical inclusion, not finality, private evidence truth,
production security, distributed availability or post-receive M2 rollback.
No production hosting/UI, key rotation/KMS, subjective adjudication, mainnet,
additional chains/assets or old-Core cleanup was authorized.

All public campaign/funding allowances are consumed; do not run fund/execute or
continuation again for this completed experiment. M1–M5 have no
remaining implementation gate. Publish this verified checkpoint to authorized
origin/main. Any next
phase needs its own self-contained packet and explicit product requirements;
this checkpoint does not infer scope for a production service or UI.
