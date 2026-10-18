# Session handoff

Date: 2026-10-18. Branch: `evm/restart`.
Current phase: M1 settlement feasibility — IN_PROGRESS.
Active packet: `planning/EVM_M1_SETTLEMENT_SPIKE.md`.
Results: `planning/EVM_M1_RESULTS.md`.
Checkpoint: Gate A COMPLETE; Gate B next; public settlement NOT STARTED.
Starting commit: `0026c60`. Gate A is ready for the user-authorized checkpoint commit.

## Implemented state

`spikes/evm-m1/` contains pinned dependencies, strict intent/hash/typed-data
helpers, trusted wire requirements/payload validation, upfront-only SDK server,
read-only token preflight, 21 passing tests, an unsigned hash vector, source/
toolchain identities and a compact public token-compatibility result. There are
no Solidity contracts, application services or financial-core implementation yet.

User explicitly requested Luna agents with high reasoning for bounded delegated
tasks and primary verification. Three agents did comparison, intent and preflight;
primary reviewed/fixed/integrated and ran the combined checks. Additional
blockchain/Solidity skills may be installed when a concrete need arises.

Read EVM-007 before continuing: experiment uses `assured-exact`, profile
`assurepay-evm-v1`, ATM `assured-eip3009-receive`, and upfront-only flow. Ordinary
x402 exact defaults to settlement after service and uses transfer authorization;
our server rejects that flow. The custom choice is for this experiment, remains
replaceable, and is not a claim of already proven settlement.

## Verification and proof limits

From the spike: `npm run typecheck` and `npm test` pass, 21/21 tests. Installed
package/lock integrity and source identities passed. A signer-free public
preflight passed on Base Sepolia/native USDC at block 48276820: decimals6,
USDC/version2 typed-data domain and expected receive-selector rejection.
Public output has no signature, raw response or secret. No transaction was sent.

The actual SDK registration test deliberately rejects execution; signature
syntax validation is not cryptographic verification. No Solidity compilation,
TS/Solidity parity, real token transfer, capacity, claims, HTTP service or live
settlement acceptance has been proven. Review `planning/EVM_M1_RESULTS.md`
for corrections and commands rather than treating fixture tests as chain proof.

## Exact next action

Continue M1 Gate B in the existing isolated spike. Read its README,
`vectors/intent-v1.json` and `toolchain.json` as named by the packet. Implement
minimal fixed-economics Solidity Core and a faithful ERC-3009 fixture. Prove
hash parity, receive/split/coverage success, every altered binding, replay,
and nested token nonce/balance/state rollback with actual EVM execution.
Keep full provider/policy/stake/claims architecture out until M2.

Then Gate C requires actual registered x402 settlement, independent read-only
verification and a bounded authorized/funded public run. None was attempted or
provisioned here. Do not reintroduce separate post-payment coverage creation.
The user now authorizes focused commits at verified checkpoints and proceeding
sequentially through gates, with Luna(high) delegation and primary review.
Never manually read populated environments or private backups. M1 is
self-contained; no `/docs` access is needed or authorized for implementation.
