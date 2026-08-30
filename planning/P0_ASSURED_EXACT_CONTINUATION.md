# P0 Continuation — Minimal `assured-exact` Path

## Mission

Continue P0 by implementing the smallest assurance-aware x402 AVM scheme that can validate, simulate, and submit the complete Algorand atomic group selected by D-010.

This packet closes the gap between “current `exact` cannot express the POC safely” and an actually executable Atomic-Assured settlement path. It is not P1 and must not grow into the production Assurance Core.

## Starting evidence

The prior spike and orchestrator review established:

- `@x402/avm` 2.24.0 `exact` uses a `paymentGroup` and one `paymentIndex`;
- it rejects the tested signed application-call group before simulation/submission;
- its single selected-payment validation does not bind all assurance semantics;
- D-010 accepts a distinct `assured-exact` scheme;
- the disposable contract compiles, but it has not executed on LocalNet or TestNet;
- `npm run test:p0` is broken and must be repaired.

Read `planning/P0_REVIEW.md` for the precise review findings. Do not access `/docs`.

## Required outcome

Implement a local, isolated `assured-exact` scheme that participates in the actual x402 core scheme interface and proves this flow:

```text
x402 payment requirements
  -> assurance-aware payload construction
  -> facilitator scheme verification
  -> simulation of the exact prepared group
  -> submission of those same prepared transaction bytes
  -> confirmation/result
```

The verifier must understand and bind every required group role, not merely select one transaction as “the payment.”

## Scope boundary

Allowed implementation remains under `spikes/p0-atomic/**`, plus the minimal root package/configuration changes needed to run it. Do not patch files under `node_modules`; use public package APIs or implement a local scheme adapter.

Do not create production `/apps`, `/packages`, or `/contracts/assurance-core` code. Do not implement provider registration, policies, stake accounting, coverage storage, claims, refunds, evidence, database access, or UI.

## Step 1 — Repair and strengthen the existing spike

- Make `npm run test:p0` the canonical working test command. Remove the unused Vitest setup/dependency or add a real configuration; prefer one test runner rather than duplicate commands.
- Require a 32-byte request commitment in the off-chain verifier and contract.
- Bind the application-call sender to the two asset-transfer senders.
- Reject application-call rekey.
- Preserve the existing asset, receiver, amount, rekey, and asset-close protections.
- Make tests distinguish off-chain unit validation, facilitator integration, LocalNet execution, and TestNet execution.

## Step 2 — Specify the P0 wire profile

Resolve D-016 and record it in `DECISIONS.md`. The decision must specify:

- the `assured-exact` payment-requirements fields;
- the payment payload fields;
- base transaction order and role indices;
- optional facilitator fee-payer position and how its presence changes indices;
- which addresses sign which transactions;
- canonical integer/string encoding of ASA amounts and IDs;
- application ID, method/arguments, gross, premium, provider net, and request commitment binding;
- maximum group size and whether unexpected extra transactions are forbidden;
- network binding and group-ID validation.

Use a simple fixed profile. Do not add extensibility that P0 does not require.

The minimum economic invariant remains:

```text
providerNet + premium == gross
stakeTopup = 0
```

If fee abstraction is included, follow an explicit ordering compatible with the chosen client construction. The contract and facilitator must agree on it. If fee abstraction cannot be completed locally, document the exact technical blocker; do not quietly omit it.

## Step 3 — Implement the facilitator scheme

Implement the smallest scheme-network facilitator compatible with the installed `@x402/core` interfaces. It must:

- accept only `assured-exact` on the expected Algorand network;
- validate payload shape, group length, indices, and a consistent non-empty Algorand group ID;
- decode every group member and reject malformed or unexpected transaction types;
- require valid signatures for every payer-owned transaction;
- accept an unsigned transaction only when it is the explicitly designated facilitator fee-payer transaction from a configured facilitator address;
- validate the provider transfer's sender, configured ASA, receiver, and `providerNet` amount;
- validate the premium transfer's same payer, configured ASA, application-account receiver, and premium amount;
- validate the application call's same payer, target application ID, method/arguments, gross amount, premium, and 32-byte request commitment;
- reject rekey and close fields on every trusted transaction where those fields exist;
- validate `providerNet + premium == gross` using integer arithmetic;
- safely validate and sign an optional zero-value facilitator self-payment used only for fees;
- simulate the fully prepared group before submission;
- submit byte-for-byte the prepared group that passed validation and simulation;
- return stable, scheme-specific error codes without leaking secrets.

Avoid copying private methods from the installed package blindly. Reuse public helpers where safe, and add tests for any locally implemented decoding/signature logic.

## Step 4 — Implement the client-side payload construction proof

Build only enough client behavior to:

- receive or construct `assured-exact` requirements;
- build the fixed transaction group;
- assign its group ID before signing;
- sign every payer-owned transaction;
- leave only the permitted fee-payer transaction for the facilitator, when enabled;
- encode the group into the selected payload schema;
- pass it through the actual x402 core scheme registration/selection boundary used by the installed package version.

A direct call to a standalone helper is useful for unit tests but does not alone satisfy the x402 boundary requirement. Include at least one integration test showing the scheme is registered/selected and its `verify`/`settle` methods are invoked through the real core interface available in the installed version.

## Step 5 — Automated tests

The canonical `npm run test:p0` must cover at least:

1. valid three-role group verifies, simulates, and submits;
2. forced application rejection produces simulation failure and no submission;
3. submitted bytes exactly match the bytes that were validated and simulated;
4. wrong provider receiver;
5. wrong premium receiver;
6. wrong ASA in either transfer;
7. payer mismatch across transfers or application call;
8. incorrect provider-net/premium/gross arithmetic;
9. wrong application ID or method/arguments;
10. missing or non-32-byte request commitment;
11. inconsistent/missing group ID;
12. invalid or missing payer signature on each payer-owned role;
13. unexpected transaction, extra transaction, or role/index substitution;
14. rekey or close fields on trusted transactions;
15. valid fee abstraction, if enabled;
16. unsafe or incorrectly positioned fee-payer transaction;
17. registration/selection through the actual x402 core interface;
18. regression proof that stock `exact` still rejects or fails to bind this profile.

Mocked signer/network tests must be labeled as such. They prove facilitator logic, not chain atomicity.

## Step 6 — LocalNet chain proof

If a LocalNet endpoint is available:

- deploy the hardened disposable contract;
- create and distribute a local test ASA;
- opt in and fund required accounts/application;
- execute a successful group through `assured-exact`;
- record transaction IDs and before/after balances/state;
- execute a group whose application call rejects;
- prove neither asset transfer settles and the success marker is unchanged;
- exercise fee abstraction if the chosen P0 profile includes it.

If LocalNet cannot start because Docker/OrbStack or another daemon is unavailable, finish all offline implementation and record the exact command and prerequisite. Do not call mocked settlement LocalNet evidence.

## Step 7 — TestNet proof

After local verification, repeat success and forced-failure through the same scheme on TestNet. This remains required for P0 completion.

TestNet secrets must come from environment variables. Record only public application, asset, transaction/group, network, and explorer identifiers. If accounts, funding, opt-ins, selected ASA, or network/facilitator access are unavailable, mark the phase externally blocked only after every preceding local step passes.

## Deliverables

- Hardened disposable contract and mirror validator.
- Local `assured-exact` client/facilitator scheme implementation.
- Working canonical `npm run test:p0`.
- Automated unit and x402 scheme-integration tests.
- LocalNet execution evidence, or an exact local-environment blocker after offline tests pass.
- TestNet execution evidence, or exact external prerequisites after all local work passes.
- Accepted D-016 in `DECISIONS.md`.
- Updated `planning/P0_RESULTS.md` separating offline, LocalNet, and TestNet evidence.
- Updated P0 row in `IMPLEMENTATION_PLAN.md`.
- Rewritten `SESSION_HANDOFF.md` with the actual final HEAD obtained after the final commit.

## Completion and blocker rules

Mark P0 `COMPLETE` only after the successful and forced-failure groups run through `assured-exact` on TestNet and the atomic balance/state results are recorded.

Use `BLOCKED` only when all safe local implementation and verification are complete and the remaining requirement needs an unavailable daemon, credential, funded account, opt-in, selected asset, or external network/facilitator state.

Otherwise leave P0 `IN_PROGRESS` and name the exact next local engineering task.

