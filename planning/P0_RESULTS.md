# P0 Atomic-Group Spike Results

Status: IN_PROGRESS — `assured-exact` local mocked path implemented; LocalNet/TestNet pending

## Continuation evidence (2026-08-30)

- Unit tests: `group-validator.mjs` validates the fixed three-role profile and negative cases; this is not chain evidence.
- Mocked facilitator integration: local `AssuredExactAvmScheme` is registered and invoked through `@x402/core` with a mocked signer/network; it verifies, simulates, and submits identical bytes in the happy-path test. This is not LocalNet evidence.
- LocalNet: Docker daemon is available, but `algokit` is absent. A genuine attempt, `npx --yes @algorandfoundation/algokit-cli localnet start`, failed with npm `404`; that CLI is not distributed under that npm package. No deployment, balances, or transaction IDs exist.
- TestNet: not attempted; no funded payer, selected ASA, app, provider opt-in, or credentials exist.
- D-016 fixes `assured-exact` to `[provider axfer, premium axfer, appl]` and deliberately forbids fee abstraction/extra transactions for P0.

## Continuation orchestrator review

Reviewed at repository HEAD `1305e95`.

Verification rerun:

```text
npm run test:p0              PASS, 17/17
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
```

The passing suite is not yet chain-ready evidence. The following local correctness gaps remain:

- The raw signed application-call fallback checks only for a 64-byte signature; it does not cryptographically verify that signature against the sender and transaction signing bytes.
- The constructed application arguments are plain strings beginning with `openCoverage`, while the compiled `@abimethod` dispatches on the ABI selector `0xfca9b335` for `openCoverage(uint64,uint64,byte[],bool)void` and expects ABI-encoded arguments.
- `settle()` passes a base64-encoded signed transaction blob to `waitForConfirmation()` instead of an Algorand transaction ID.
- `settle()` reconstructs bytes from the mutable payload after asynchronous verification instead of carrying forward one immutable prepared group.
- Malformed decimal or application arguments can throw during `BigInt(...)` parsing instead of returning a structured invalid response.
- `algorand-msgpack` is imported directly but is available only as a transitive dependency; either declare it directly or avoid the direct import.
- The assured-exact suite lacks most required negative cases: premium receiver, ASA substitution, payer mismatch, arithmetic, ABI method/argument mismatch, missing group ID, cryptographically invalid signatures for each payer role, rekey/close, and explicit fee-member rejection or support.
- D-016 excludes fee abstraction without establishing whether the selected POC facilitator path requires it. D-017 must resolve that compatibility question before P0 completes.

No LocalNet or TestNet evidence exists yet. Continue with `planning/P0_CHAIN_READINESS_FIXES.md`.

## Orchestrator review

Reviewed on 2026-08-30 at repository HEAD `abec4d2`.

- PuyaTs dry run passes.
- Contract build passes.
- `node --test spikes/p0-atomic/test/p0.test.mjs` passes 10/10.
- The declared `npm run test:p0` command fails because `spikes/p0-atomic/vitest.config.ts` does not exist.
- Nine passing cases exercise an off-chain mirror validator. They do not demonstrate execution or atomic rollback on LocalNet.
- The remaining test directly exercises the installed `@x402/avm` facilitator and supports D-010 by proving that the submitted signed group is rejected before simulation/submission.
- The spike contract still needs a fixed 32-byte request commitment check, application-call payer/rekey validation, and an explicit optional fee-payer group layout before chain execution.
- Local engineering remains, so P0 is ready for the continuation packet rather than externally blocked. TestNet credentials, funding, asset selection, and a running network endpoint remain later external prerequisites.

## Environment

```text
Date: 2026-08-30
Git branch / starting HEAD: main / 4e596cd
Node / npm: v24.18.0 / 11.16.0
AlgoKit CLI: not installed
Algorand TypeScript / PuyaTs: 1.3.0 / 1.3.0 (Puya 5.10.0)
@algorandfoundation/algokit-utils: 10.0.0-alpha.46
@x402/core, @x402/avm, @x402/express: 2.24.0
```

## Observed x402 AVM behavior

The current `ExactAvmPayloadV2` is `{ paymentGroup: string[], paymentIndex: number }`: base64 msgpack group members and one selected ASA transfer. The installed facilitator verifies only that transaction's asset, amount, receiver, and signature against requirements. It does not bind the provider payout, premium, request commitment, or app-call semantics.

Payer signs both asset transfers and the application call. In gasless exact, the facilitator signs only its own zero-value self-payment fee-payer transaction.

The current `@x402/avm` 2.24.0 `ExactAvmScheme.settle()` rejects a cryptographically signed `[provider axfer, premium axfer, appl]` group with `invalid_exact_avm_invalid_transaction` while decoding the application call, before simulation or submission. Fee abstraction therefore cannot preserve this profile through `exact`.

## Available verification

```text
npm run typecheck:p0                          PASS (PuyaTs dry run)
npm run build:contract:p0                     PASS
node --test spikes/p0-atomic/test/p0.test.mjs PASS (10/10)
```

The tests cover the accepted profile; forced rejection; wrong provider and premium receivers; wrong asset; gross/net/premium arithmetic; malformed commitment; unsafe rekey and close fields; and the actual current x402 facilitator settlement boundary. The contract compiles but no LocalNet deployment was run: the intended exact settlement path rejects the application call before it could reach chain.

## TestNet evidence

Not run. No application ID, ASA ID, transaction IDs, or credentials were created or recorded. The asset ID was not guessed.

## Decision recommendation

```text
Recommendation: assured-exact
Evidence: exact identifies only one payment transfer and rejects the required signed app-call member before simulation. The automated test directly invokes ExactAvmScheme.settle() and asserts no submission occurs.
Security implications: assured-exact must bind the ordered complete group, asset, provider, app address, gross/net/premium arithmetic, commitment, and trusted transaction controls; it must submit identical bytes after simulation.
Required P1 interface constraint: retain the fixed base profile [provider axfer, premium axfer, appl] and contract-side final validation. Specify optional fee-payer indexing explicitly.
```

## Same-group stake top-up observation

Not tested. The current facilitator blocker occurs first; defer D-015 and use pre-deposited stake for the POC.

## Commands to reproduce

```sh
npm install --ignore-scripts
npm run typecheck:p0
npm run build:contract:p0
node --test spikes/p0-atomic/test/p0.test.mjs
```

## Files and blockers

Root package files are the minimal reproducible TypeScript/PuyaTs/x402 harness; no production workspace was created. P0 requires an `assured-exact` facilitator that validates, simulates, and submits the full group, plus a funded TestNet payer holding the selected POC ASA, an opted-in provider recipient, and a funded/deployed spike app opted into the asset. These prerequisites are not available.
