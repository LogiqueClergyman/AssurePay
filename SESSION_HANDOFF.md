# Session handoff

Date: 2026-10-19. Branch: `evm/restart`.
Current phase: M1 settlement feasibility — IN_PROGRESS.
Active packet: `planning/EVM_M1_SETTLEMENT_SPIKE.md`.
Results: `planning/EVM_M1_RESULTS.md`.
Commits: Gate A `5126ccf`; Gate B `07957e5`; registered local Gate C `6a2b92b`.
Gates A/B and Gate C preparation/local integration PASS. Public proof PENDING.

## Verified state

`spikes/evm-m1/` compiles the pinned unchanged Solidity, passes strict typecheck
and all87 tests. Actual Anvil execution proves registered x402 settlement,
atomic100/93/7, negative/rollback cases, and the complete bounded four-step
runner plus signer-free restart recovery and journal-tamper rejection. A fresh
read-only runner-adapter check passed native Base Sepolia USDC at block48318516.
No public transaction or native USDC settlement acceptance exists yet.

Luna(high) agents implemented and independently reviewed focused paths; primary
integrated, corrected SDK/viem/nonce assumptions and ran final checks. This is a
scoped spike review, not a production security audit. Source hashes and proof
limits are recorded in evidence/public-preparation.json and the results file.

Default `npm run public:run` and `public:check` are configuration-only. Existing
journal paths enter recovery before accessing signers. `public:verify --
--journal <directory>` only reads public journal/RPC state. Partial known-hash
runs are reconciled without replacements. No signatures/raw signed blobs or
secrets are persisted. Runtime role/budget variables are currently missing.

## Exact next action and blocker

Obtain explicit bounded public approval and funded opaque runtime wallets; do
not manually inspect populated envs/private backups or ask for keys in chat.
Prepared scope: one fresh Core deployment, one registered successful purchase,
one admission-disable fixture transaction, one valid-signature included revert.
The template uses gas caps2000000/500000/100000/500000, max fee100000000 wei,
priority1000000 wei and auxiliary reserve100000000000000 wei. Dedicated relayer
must hold exactly410000000000000 wei (0.00041 test ETH), payer >=200 atomic
native USDC; successful spend100. No concurrent relayer use/incoming funding.
Auxiliary reserve is not an on-chain L1 fee cap; follow EVM-009/010.

After approval/configuration/funding, run `public:check`, signer-free token
preflight, then the guarded `public:run -- --execute` once with a fresh explicit
M1_PUBLIC_JOURNAL_DIR. On uncertainty read existing hashes only; never remove a
journal/re-sign to recover a response. Verify independently with `public:verify`
and record actual public hashes, canonical financial outcomes and measured fees.
M1 cannot be accepted and M2 cannot begin until the packet's public gate passes.

User authorizes verified checkpoint commits and Luna(high) delegation. No push,
history amendment, or `/docs` access is authorized/needed. Preserve archive/main.
