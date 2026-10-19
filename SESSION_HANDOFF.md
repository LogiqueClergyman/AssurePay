# Session handoff

Date: 2026-10-19. Branch: `evm/restart`.
Current phase: M1 settlement feasibility — IN_PROGRESS.
Active packet: `planning/EVM_M1_SETTLEMENT_SPIKE.md`.
Results: `planning/EVM_M1_RESULTS.md`.

## Verified state

Gates A/B and Gate C local integration pass. Compile/typecheck and **105/105**
tests pass, including actual Anvil contract execution, registered x402 flow,
complete bounded runner/recovery, two-transfer vault normalization, lost-response
recovery and changed-balance rejection. Public native USDC proof is still absent.
Solidity hashes are unchanged. Luna(high) agents implemented/reviewed scoped
paths; primary verified and corrected integration/recovery issues. No production
audit is claimed.

The user authorized the four protocol proof transactions (EVM-011), managed
local Base Sepolia test vault (EVM-012), checkpoint commits and gated phase
continuation. Do not ask again for the same scope. No push or history amendment.
`/docs` remains outside scope.

## Exact next action

The vault was created once at `0x7a776d8F819B33F50ef85d37EFFcB5BDD2714756`.
Retain existing ignored mode0600 `.env.local` and `.env.vault.local`; do not run
setup again. Funding journal `.local-vault-funding` does not yet exist. Never
manually inspect populated envs or print keys/signatures/raw signed blobs.
Load configs with Node runtime `--env-file` only.

User-funded relayer is over the exact proof budget: latest recorded balance
99564892689918374 wei; payer has20000000 atomic native USDC. Run default vault
funding check, then the authorized `vault-funding.ts --execute` using both env
files. It sends balance-minus410000000000000 wei to the vault, then the measured
shortfall back. Funding fees are separate from the four protocol transactions.
Each transfer has21000 gas, max fee100000000 wei, priority1000000 wei; L1 estimate
guard100000000000000 wei. On ambiguity reconcile journaled hashes; never repeat
excess transfer. Only the missing top-up may follow a confirmed first transfer.

Then run preflight/config checks and the already-approved public runner once:
`node --env-file=.env.local --import tsx scripts/public-run.ts --execute`.
Persistent `.local-public-run` must never be deleted/recreated. Existing journal
routes to signer-free recovery before signer access. Recover/verify using
`public:verify -- --journal <absolute .local-public-run path>`. Record native USDC
100/93/7 proof, nonce/coverage, canonical included valid-signature status0 rollback
and measured fees before M1 acceptance. No new purchase to recover a response.

Protocol bounds: exact initial relayer410000000000000 wei; gas caps
2000000/500000/100000/500000; max fee100000000, priority1000000 wei; total gas
3100000 plus auxiliary reserve100000000000000 wei; payer >=200 atomic USDC,
successful spend100. EVM-013 enriches allowlisted Base receipt fees. One canonical
inclusion is observed, not finality. No public transaction has yet been submitted.
Stop at M1 REVIEW after proof; M2 remains NOT_READY until acceptance.
