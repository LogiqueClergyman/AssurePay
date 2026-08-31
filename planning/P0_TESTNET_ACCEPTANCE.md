# P0 Final Packet — TestNet Acceptance

## Mission

Turn the accepted LocalNet proof into a reproducible, secret-safe TestNet runner, then execute the same Atomic-Assured success and rejection cases on Algorand TestNet.

This is the final P0 task. Do not begin P1, generalize the spike into production packages, or access `/docs`.

## Starting point

The repository already has:

- a compiled disposable Assurance Core contract;
- a registered local `assured-exact` x402 facilitator scheme;
- a credential-free LocalNet runner;
- 52 passing unit/mocked integration tests;
- real LocalNet settlement and transaction-pool rejection evidence; and
- accepted caller-paid three-member group decisions D-016/D-017.

Preserve those behaviors. Reuse or carefully extract common helpers rather than maintaining divergent encodings.

## Gate T1 — Secret-safe configuration

Add the minimum configuration needed for TestNet execution under `spikes/p0-atomic/`.

Requirements:

- Provide only variable names and descriptions in `.env.example`.
- Accept the funded TestNet account through an environment-supplied mnemonic or another explicit local signer mechanism supported by the spike.
- Accept the selected TestNet ASA ID through configuration; never guess it.
- Accept an Algod endpoint and any required token/header configuration without hard-coding private service credentials.
- Never print the mnemonic, secret key, token, or populated environment.
- Confirm existing ignore rules cover the populated local environment file.
- Do not automatically use a faucet, dispenser, wallet connector, or remote account mutation beyond transactions explicitly required by this runner.

The funded account may act as payer, application creator, and setup funder for the disposable P0. An ephemeral provider account may be generated per run, funded with the minimum required ALGO, and opted into the selected ASA. Never print its secret key.

## Gate T2 — Preflight

Before creating or funding anything, the runner must:

1. validate all configuration fields without exposing their values unnecessarily;
2. query the connected network and require Algorand TestNet rather than LocalNet/MainNet;
3. derive and print only the funded account's public address;
4. confirm sufficient spendable ALGO for deployment, application minimum balance, opt-ins, funding, and grouped transaction fees;
5. confirm the payer is opted into and holds enough units of the selected ASA;
6. fetch the selected ASA and print its public ID/unit/name/decimals where available;
7. abort before mutations with one actionable list of missing prerequisites.

Add a preflight-only mode so the user can validate readiness without deploying or transferring funds.

## Gate T3 — Reproducible TestNet setup

Adapt the accepted LocalNet setup without KMD assumptions:

- compile/use the checked-in generated contract artifacts;
- deploy the disposable application on TestNet;
- generate/fund and opt in the ephemeral provider;
- fund the application account for its minimum balance and inner opt-in fee;
- invoke the setup-only application ASA opt-in;
- verify the application and provider asset holdings before settlement;
- record every public setup transaction ID and confirmed round.

Use conservative balance checks and integer atomic units. Do not create a replacement ASA when a configured POC ASA is required.

## Gate T4 — Successful `assured-exact` settlement

Using the same registered `@x402/core` scheme path as LocalNet:

- build and sign `[provider axfer, premium axfer, appl]`;
- use the configured TestNet network identifier;
- simulate, submit, and confirm the prepared group;
- verify payer decreases by gross, provider increases by provider net, and application increases by premium;
- verify the contract marker increases exactly once;
- record public group/member transaction IDs, confirmed round, before/after asset balances, and marker values.

The gross/provider-net/premium values may remain the small P0 `100/93/7` atomic-unit example if the configured asset holding and decimals make it appropriate.

## Gate T5 — Actual TestNet rejection and atomicity

Construct an ABI-valid three-member group that passes the off-chain structural profile but intentionally fails the disposable contract assertion.

- Simulate and record the public failure message without treating it as chain evidence.
- Submit the signed group to the real TestNet transaction pool and require rejection.
- Record the group ID and member transaction IDs even though they are not confirmed.
- Re-query payer/provider/application asset balances and marker state.
- Assert that neither transfer settled and the marker did not change.
- Clearly label the distinction between facilitator simulation rejection and actual TestNet transaction-pool rejection.

If the public endpoint refuses submission for a reason unrelated to the intended contract assertion, do not count the attempt. Fix the setup or report the precise blocker.

## Gate T6 — Output and repeatability

The runner must emit one structured, secret-free JSON result containing:

- network/genesis identifier;
- public payer/provider/application addresses;
- ASA/application IDs;
- setup transaction IDs and rounds;
- successful group/member transaction IDs and round;
- before/after asset balances and marker values;
- rejected group/member transaction IDs;
- simulation and pool-rejection summaries; and
- post-rejection balances and marker values.

Make the command discoverable as `npm run testnet:p0`. A rerun may deploy a fresh disposable application/provider; it must not rely on undocumented manual state.

## Gate T7 — Verification and status

Before handoff, run:

```text
npm run test:p0
npm run typecheck:p0
npm run build:contract:p0
npm run localnet:p0
npm run testnet:p0 -- --preflight
```

Then:

- If preflight reports missing user-controlled credentials, funds, ASA holding/opt-in, or endpoint access after the runner is otherwise ready, mark P0 `BLOCKED` and list only the public/actionable prerequisites.
- If full TestNet success and rejection evidence passes, mark P0 `REVIEW`; do not mark it complete yourself and do not start P1.
- If local implementation remains, keep P0 `IN_PROGRESS` and name the exact next code/test task.

## Required repository updates

- TestNet runner and any narrowly shared spike helper.
- Secret-free `.env.example` and matching ignore coverage.
- `package.json` command.
- `planning/P0_RESULTS.md` with either real public evidence or precise preflight blockers.
- `IMPLEMENTATION_PLAN.md` P0 row only.
- `SESSION_HANDOFF.md` with the actual final HEAD after commits.
- Focused commits and a clean worktree.
