# P0 Work Packet — Atomic-Assured x402 AVM Spike

## Mission

Prove or disprove that the current Algorand x402 AVM settlement path can safely settle one atomic group containing:

```text
[PROVIDER] payer -> provider payout address, providerNet asset units
[PREMIUM]  payer -> Assurance Core application account, premium asset units
[COVERAGE] payer -> Assurance Core.openCoverage(...)
[FEE]      optional facilitator fee-abstraction transaction
```

The decisive property is atomicity: if `openCoverage` rejects, neither the provider nor the Assurance Core application may receive the asset transfers.

This is an integration-risk spike, not the production implementation.

## Fixed constraints

- Target chain: Algorand TestNet for the final proof; LocalNet may be used during development.
- Implementation language: TypeScript.
- Contract language/tooling: Algorand TypeScript compiled with PuyaTs/AlgoKit.
- Chain tooling: `@algorandfoundation/algokit-utils`.
- x402 packages to evaluate: `@x402/core`, `@x402/avm`, and `@x402/express` where applicable.
- Use the challenge-compatible GoPlausible Algorand x402 facilitator path where it is available and workable.
- Keep all asset amounts as integers in atomic units.
- Never store a mnemonic, private key, API token, or funded account secret in source, fixtures, logs, screenshots, or result documents.
- Do not access `/docs` for any reason.

Package APIs and facilitator behavior may have changed. Verify current behavior using installed package source, official package documentation, and the upstream Algorand/x402 sources. Record exact package versions in the results.

## Economic semantics used by the spike

Let `G` be the caller's gross price:

```text
premium    = integer premium derived from G
stakeTopup = 0 for the minimum spike
providerNet = G - premium
providerNet + premium == G
```

The caller's total service cost remains `G`; the premium comes from the provider's gross revenue rather than being added on top.

Use a locally created test ASA on LocalNet. On TestNet, use the configured test asset selected for the POC and record its asset ID. Do not guess or silently hard-code an asset ID.

## Minimum contract behavior

Create only the smallest disposable or clearly isolated Assurance Core spike contract needed to test the boundary. Its `openCoverage` call must be able to:

- inspect and/or validate the relevant grouped asset transfers;
- check the configured asset ID;
- check the provider transfer receiver and amount;
- check the premium receiver and amount;
- check that provider net plus premium equals gross amount;
- require a correctly sized, non-empty request commitment;
- reject on an explicit test condition so rollback can be demonstrated;
- reject unsafe transaction controls such as rekey or asset close fields on transactions it trusts, where exposed by the group;
- record a minimal success marker or emit evidence that the application call executed.

Do not add provider registration, policy storage, collateral capacity, withdrawals, claim handling, refunds, PostgreSQL, evidence encryption, or production coverage storage during P0.

Derive values from grouped transactions where practical. The spike must identify any critical value that the contract cannot safely derive or validate.

## Questions the spike must answer

1. What exact `@x402/avm` payment payload shape is currently accepted?
2. Can the existing `exact` scheme carry the expanded group without weakening facilitator verification?
3. Which group transactions are signed by the payer, provider, facilitator, or application?
4. Does fee abstraction preserve the group structure and application-call validation?
5. Does facilitator verification validate only a single payment transaction, or can it validate the assurance group semantics?
6. Does facilitator settlement submit the complete group unchanged?
7. What transaction ordering or index assumptions are unavoidable?
8. Can the contract reliably reject asset substitution, receiver substitution, rekey, close fields, and malformed group shapes?
9. Is same-group stake top-up feasible without complicating the wire profile? This is observational only; it is not required for the minimum spike.
10. Should P1 extend `exact`, or is a distinct `assured-exact` scheme required?

## Implementation sequence

### Step 1 — Establish current upstream behavior

- Record Node, package-manager, AlgoKit, Algorand TypeScript/PuyaTs, and x402 package versions.
- Inspect the actual AVM client/facilitator encode, verify, and settle path.
- Document the current payment payload and signer responsibilities in `planning/P0_RESULTS.md`.
- Avoid copying an old example without verifying it against the installed versions.

### Step 2 — Build the minimum LocalNet group

- Create the isolated spike under `spikes/p0-atomic/` unless the selected AlgoKit tooling requires a narrowly different layout.
- Create/fund test accounts and a test ASA through reproducible scripts or test fixtures.
- Deploy the minimal contract.
- Construct and submit the provider, premium, and application-call group.
- Assert balances and the contract success marker.

### Step 3 — Prove rollback

- Submit the same logical group with an application-call condition that must fail.
- Capture balances before and after.
- Assert that provider and Assurance Core asset balances did not change.
- Confirm there is no successful coverage marker.

### Step 4 — Exercise the real x402 boundary

- Send the group through the actual AVM x402 verification and settlement flow rather than only submitting it directly with the Algorand SDK.
- Add fee abstraction when the chosen facilitator path requires it.
- Determine whether `exact` can safely represent and validate the group.
- If it cannot, create only the smallest proof needed to establish why a dedicated `assured-exact` scheme is necessary. Do not build the full production scheme in this spike.

### Step 5 — Repeat on TestNet

- Deploy and execute the success and forced-failure cases on TestNet.
- Record network, application ID, asset ID, transaction/group IDs, package versions, and commands.
- Verify final balances/state from confirmed transactions.
- If credentials, funding, asset access, or an external facilitator prevent execution, finish all safe LocalNet work and state the exact external prerequisite. Do not fabricate TestNet success.

## Required automated checks

At minimum, tests or reproducible verification scripts must cover:

1. successful provider + premium + application-call atomic group;
2. forced application rejection rolls back both transfers;
3. wrong provider receiver is rejected;
4. wrong premium receiver is rejected;
5. wrong asset is rejected;
6. incorrect gross/net/premium arithmetic is rejected;
7. missing or malformed request commitment is rejected;
8. unsafe rekey/close controls are rejected where applicable;
9. the real x402 verification/settlement path receives and submits the intended full group;
10. facilitator fee abstraction works, or its incompatibility is demonstrated precisely.

## Deliverables

- Isolated, reproducible spike code.
- Minimal contract and generated client artifacts required by the spike.
- Automated tests or verification scripts for the cases above.
- `.env.example` containing names only, never secret values.
- A completed `planning/P0_RESULTS.md`.
- An accepted D-010 entry in `DECISIONS.md` selecting `exact` extension or `assured-exact`.
- Updated `SESSION_HANDOFF.md` with the exact next action or blocker.

## Allowed paths

The P0 session may create or modify:

```text
spikes/p0-atomic/**
planning/P0_RESULTS.md
SESSION_HANDOFF.md
DECISIONS.md
IMPLEMENTATION_PLAN.md          # status cells only
.gitignore                      # only entries required by the spike
```

If bootstrapping requires root workspace files such as `package.json`, a lockfile, or an AlgoKit configuration, keep changes minimal and record why each root file is necessary in `planning/P0_RESULTS.md`.

Do not reorganize the repository or create the production `/apps`, `/packages`, or `/contracts/assurance-core` implementations during this spike.

## Explicit non-goals

- Full Assurance Core implementation.
- Production ABI or storage layout.
- Provider onboarding and policy management.
- Capacity, exposure, stake withdrawal, claims, or refunds.
- Provider/client SDK design beyond the minimum x402 integration proof.
- Evidence storage, encryption, database, indexer, API, or UI.
- Production hardening of a custom x402 scheme.

## Completion rule

P0 is `COMPLETE` only when both success and rollback have been demonstrated through the intended x402 path on TestNet and D-010 has been accepted with supporting evidence.

P0 is `BLOCKED`, not complete, if LocalNet passes but required TestNet access or an external facilitator is unavailable. Record the exact prerequisite so the orchestrator or user can resolve it.

