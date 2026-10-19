# Session handoff

Date:2026-10-19. Branch:`evm/restart`. M1:ACCEPTED under EVM-015.
Active work: M2 requirements closure, draft packet:
`planning/EVM_M2_REQUIREMENTS.md`. No M2 contract implementation gate is open.
Completed packet:`planning/EVM_M1_SETTLEMENT_SPIKE.md`; results:
`planning/EVM_M1_RESULTS.md`. All gates pass. Compile/typecheck and105 tests pass.

Actual Base Sepolia native USDC registered x402 settlement and included
valid-signature admission rollback passed. Independent signer-free recovery
returned PUBLIC_RUN_RECONCILED. Public evidence JSON is under
`spikes/evm-m1/evidence/public-native-usdc-{proof,verification}.json`.
Core:`0x35e6a35b68869bbe8548d41ac75ddd8e4bf6cfce`. One canonical inclusion only;
no finality, traced revert cause, HTTP service or full financial core is claimed.

Managed vault:`0x7a776d8F819B33F50ef85d37EFFcB5BDD2714756`, balance
99154640689918186 wei. Relayer400519981996929 wei after proof. Payer native
USDC19999900 atomic; Core7, provider93. Vault normalization and protocol proof
are complete; do not run either as a fresh attempt or top up without a recorded
next purpose. Funding evidence:`evidence/vault-normalization.json`.

Preserve ignored mode0600 `.env.local` and `.env.vault.local`, completed public
journals `.local-public-run`/`.local-vault-funding`. Never display populated envs,
keys, signatures or raw signed blobs. Runtime Node env loading only.
Do not delete journals or replace a payment to recover a response.

Exact next action: obtain the intended refund/authority model for the concrete
M2 draft. A product-clarification question is pending with three choices:
use the proposed baseline, provider-fault refunds only, or automatic on-chain
claim decisions. Do not treat elapsed time as an answer. Proposed baseline uses
configurable immutable policy terms, fully
reserved refunds, provider stake before pool for provider-fault refunds, optional
policy-authorized pool-only refunds, and one configured adjudicator submitting
partial/full refunds or rejection. Timely pending claims retain collateral.
These are proposals, not accepted economic requirements. Record the selected
terms in DECISIONS, then prepare the complete M2 implementation packet with
interfaces, equations and execution invariants. Do not import requirements from
`/docs`, history or comments. AGENTS requires gaps recorded and affected work
stopped, so financial contracts wait for these requirements to be resolved.

User authorizes Luna(high) delegation, gated continuation and checkpoint commits.
No push, history amendment or `/docs` access. Preserve archive/main.
