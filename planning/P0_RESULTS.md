# P0 Atomic-Group Spike Results

Status: BLOCKED

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
