# Session handoff

Date: 2026-10-19. Branch: `evm/restart`.
Current phase: M1 settlement feasibility — IN_PROGRESS.
Active packet: `planning/EVM_M1_SETTLEMENT_SPIKE.md`.
Results: `planning/EVM_M1_RESULTS.md`.
Commits: Gate A `5126ccf`; Gate B `07957e5`; registered local Gate C `6a2b92b`.
Gates A/B and Gate C preparation/local integration PASS. Public attempt APPROVED;
wallet funding and public proof PENDING.

## Verified state

`spikes/evm-m1/` compiles the pinned unchanged Solidity, passes strict typecheck
and all90 tests (including the private wallet bootstrap). Actual Anvil execution proves registered x402 settlement,
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
secrets are persisted. Runtime roles/budget/scope are configured in an ignored mode0600 `.env.local`;
keys were generated locally and never printed or manually inspected.

## Exact next action and blocker

Approval is already granted and recorded in EVM-011. Only wallet funding is
missing. Do not ask again for the approved attempt, manually inspect populated
envs/private backups, or request keys in chat. Preserve the existing wallets.
Prepared scope: one fresh Core deployment, one registered successful purchase,
one admission-disable fixture transaction, one valid-signature included revert.
The template uses gas caps2000000/500000/100000/500000, max fee100000000 wei,
priority1000000 wei and auxiliary reserve100000000000000 wei. Dedicated relayer
must hold exactly410000000000000 wei (0.00041 test ETH), payer >=200 atomic
native USDC; successful spend100. No concurrent relayer use/incoming funding.
Auxiliary reserve is not an on-chain L1 fee cap; follow EVM-009/010/011.

After the user funds the public addresses in evidence/wallet-funding-pending.json,
load the existing config with Node runtime `--env-file=.env.local` from the spike.
Use `node --env-file=.env.local --import tsx scripts/check-public-config.ts --execute`
for non-mutating validation, then run the token/funding preflight and guarded
`node --env-file=.env.local --import tsx scripts/public-run.ts --execute` once.
The existing file fixes M1_PUBLIC_JOURNAL_DIR to the persistent ignored
`.local-public-run`; do not recreate config or erase any journal. On uncertainty read existing hashes only; never remove a
journal/re-sign to recover a response. Verify independently with `public:verify`
and record actual public hashes, canonical financial outcomes and measured fees.
M1 cannot be accepted and M2 cannot begin until the packet's public gate passes.

User authorizes verified checkpoint commits and Luna(high) delegation. No push,
history amendment, or `/docs` access is authorized/needed. Preserve archive/main.


Wallet setup checkpoint: `wallets:setup` was run once after primary verification.
It refuses existing configs; do not run it again to recover keys/addresses.
A readonly canonical check at block48319038 saw both required balances0. No
public transaction was submitted. The last pre-setup checkpoint is `82094e3`.


Latest funding check supersedes the initial zero-token snapshot: block48320062
shows payer native USDC20000000 atomic (20 test USDC), relayer ETH0. Only the
relayer's exactly410000000000000 wei funding remains. Do not execute while
that balance is0. No public test transaction or execution journal was created.


Latest update supersedes the zero-ETH check: block48320595 shows relayer
99564892689918374 wei (0.099564892689918374 test ETH) and payer20000000 atomic
native USDC. Funding has arrived, but the relayer balance exceeds the approved
exact410000000000000 wei ceiling. No test/funding transaction has been sent.
Current next step is to normalize the execution balance under explicit funding
scope, then use the existing approved test. Do not bypass the excess-balance
guard, increase the budget, move funds or create a second purchase silently.
