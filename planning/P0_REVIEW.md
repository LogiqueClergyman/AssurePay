# P0 Orchestrator Review

Review date: 2026-08-30  
Reviewed repository HEAD: `abec4d2`  
Verdict: D-010 supported; P0 incomplete; local continuation available

The user intentionally recomposed the returned commit before this review. `abec4d2` is the authoritative reviewed P0 commit.

## What the spike established

- The disposable Algorand TypeScript contract compiles with PuyaTs 1.3.0 / Puya 5.10.0.
- The installed `@x402/avm` 2.24.0 payload contains `paymentGroup` plus one `paymentIndex`.
- Its facilitator verifies the selected asset-transfer payment against the requirements, prepares the group, simulates it, and submits it.
- In the current dependency stack, the signed `[provider axfer, premium axfer, appl]` test group returns `invalid_exact_avm_invalid_transaction` during group decoding, before simulation or submission.
- The package's single-payment requirements do not independently bind the premium, Assurance Core call, request commitment, or complete assured group semantics.

These findings justify a separate `assured-exact` scheme rather than silently changing the meaning of `exact`.

## Verification rerun

| Command | Result |
|---|---|
| `npm run typecheck:p0` | PASS |
| `npm run build:contract:p0` | PASS |
| `node --test spikes/p0-atomic/test/p0.test.mjs` | PASS, 10/10 |
| `npm run test:p0` | FAIL: referenced `spikes/p0-atomic/vitest.config.ts` is missing |

## Gaps against the P0 gate

### Test fidelity

Nine tests validate `src/group-validator.mjs`, an off-chain behavioral mirror. They do not invoke the compiled AVM contract. The tenth test invokes the real installed exact facilitator but proves rejection only.

### Contract validation

Before chain execution, the disposable contract must additionally:

- require exactly 32 commitment bytes;
- bind the application-call sender to the payer used by both transfers;
- reject rekey on the application call;
- use an explicit group profile supporting or deliberately excluding the facilitator fee transaction;
- preserve provider/premium asset close and rekey rejection.

### Network evidence

There is no LocalNet or TestNet application deployment, accepted group, rejected group, balance proof, or transaction ID. Therefore atomicity has not yet been empirically demonstrated.

## Orchestrator decision

P0 is `READY` for a tightly scoped continuation. It is not yet blocked solely on TestNet access because the minimal `assured-exact` verifier/settler, contract hardening, and local tests remain implementable.

P1 remains blocked until the continuation proves the selected profile through the intended x402 registration/verification/settlement boundary and obtains the required chain evidence.

## Review of continuation at `1305e95`

The canonical test, typecheck, and contract build commands now pass. The continuation also hardens commitment length and application-call payer/rekey checks and registers a local scheme through `@x402/core` with a mocked network signer.

P0 nevertheless remains in local engineering because:

1. raw application-call signatures are length-checked rather than cryptographically verified;
2. the client builds non-ABI application arguments that cannot invoke the compiled ABI method;
3. settlement uses signed bytes encoded as base64 where an Algorand transaction ID is required;
4. verified bytes are reconstructed from a mutable payload after an asynchronous boundary;
5. malformed numeric inputs may throw instead of producing a protocol validation failure;
6. the assured-exact negative test matrix is substantially incomplete; and
7. fee abstraction was excluded without proving that the selected facilitator path does not require it.

The next active packet is `planning/P0_CHAIN_READINESS_FIXES.md`. LocalNet setup follows these correctness fixes.

## ABI-safe checkpoint review at `ca4f664`

The orchestrator reran all canonical commands:

```text
npm run test:p0              PASS, 18/18
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
```

The implementation now uses Algorand SDK ABI construction, verifies all three signatures over `txn.bytesToSign()`, retains immutable prepared bytes, derives a real transaction ID, and separates submission/confirmation errors. D-017 is accepted for the caller-paid P0 path.

Only eight of the eighteen tests currently exercise `assured-exact`; the remaining ten are the logical mirror and stock-`exact` regression. Before LocalNet, Gate E still needs direct coverage for:

- simulation rejection and no submission;
- premium receiver substitution;
- provider and premium ASA substitution independently;
- payer mismatch for each non-provider role;
- provider-net, premium, gross, and arithmetic mismatches;
- wrong application ID;
- selector and ABI-argument corruption;
- signed commitment mismatch, not only malformed requirement metadata;
- missing and inconsistent group IDs;
- reordering and role substitution;
- missing, corrupt, and wrong-key signatures for each payer-owned role;
- rekey on all roles and close on both transfers;
- malformed numeric fields without thrown exceptions;
- distinct submission and confirmation failures; and
- explicit rejection of a fourth fee/extra member under D-017.

Each negative test should assert the expected stable error reason and that simulation/submission were not reached when rejection is pre-simulation. Tests that intentionally reach simulation must assert that submission remains empty on simulation failure.

## Gate E review at `4570c5a`

The orchestrator reproduced:

```text
npm run test:p0              PASS, 52/52
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
```

The signed-byte suite now covers the required transfer, payer, arithmetic, ABI, commitment, group, signature, rekey/close, malformed-input, lifecycle-error, x402-registration, stock-`exact`, and D-017 fourth-member cases. Negative tests assert stable error reasons and simulation/submission reachability. Gate E is accepted as complete.

The active Docker context is `orbstack`, but its socket is absent and the daemon cannot be reached. With safe offline work complete, P0 is genuinely environment-blocked until the user starts OrbStack or another Docker-compatible engine. After `docker info` succeeds, the same implementation session should proceed directly to LocalNet deployment and atomic success/rollback evidence; no additional offline coding packet is required first.

## LocalNet proof review at `fd52d43`

The orchestrator reviewed the deployment script and independently reran all four verification commands. The fresh LocalNet run reproduced:

- deployment of a disposable ASA and compiled application;
- application-account funding and ASA opt-in;
- successful settlement through `@x402/core` with the registered local `assured-exact` scheme;
- the exact `100 -> 93 + 7` asset split;
- marker transition from zero to one;
- an ABI-valid failing group submitted to the actual transaction pool;
- unchanged payer/provider/application ASA balances after rejection; and
- unchanged marker state after rejection.

The script correctly distinguishes mocked facilitator tests, real LocalNet simulation, successful on-chain settlement, and actual transaction-pool rejection. Gate G is accepted.

P0 is not yet externally blocked because the existing runner is hard-coded to LocalNet KMD and endpoints. The final safe local task is `planning/P0_TESTNET_ACCEPTANCE.md`: implement a secret-safe TestNet runner and preflight. Once that runner is ready, unavailable funded accounts/ASA holdings become a genuine external blocker.
