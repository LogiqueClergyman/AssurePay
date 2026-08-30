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

