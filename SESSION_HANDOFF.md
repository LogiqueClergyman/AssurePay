# Session Handoff

## Current state

- Phase: P0 — Atomic-group spike
- State: BLOCKED (TestNet user-controlled prerequisites only)
- Branch: `main`
- Corrected TestNet runner checkpoint: `2e43a3b` (`fix: harden P0 TestNet preflight evidence`)
- Active packet: `planning/P0_TESTNET_ACCEPTANCE.md`
- Results: `planning/P0_RESULTS.md`

All three TestNet-runner correctness issues are fixed. The runner/preflight is now safe to call externally blocked: it uses spendable (not total) ALGO, loads ignored local `.env` without overriding process environment, and only accepts the intended deployed-app assertion as simulation/pool rejection evidence.

## Verification

```text
npm run test:p0              PASS, 55/55
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
npm run localnet:p0          PASS
npm run testnet:p0 -- --preflight
                             BLOCKED only on TESTNET_PAYER_MNEMONIC,
                             TESTNET_ASA_ID, TESTNET_ALGOD_SERVER
```

## TestNet preflight and evidence safeguards

- Public account funds are reported as total, minimum balance, and spendable microALGOs; the 3,000,000 threshold applies to spendable funds.
- The runner loads `spikes/p0-atomic/.env` when present but preserves supplied process-environment values. Credentials are never printed.
- A forced rejection is accepted only if both Local/TestNet simulation and the actual pool error identify `logic eval error`, `assert failed`, and the current application ID. Unrelated authentication, rate, endpoint, timeout, or stale-round errors fail the run.
- No TestNet credentials or selected ASA ID were provided, and no TestNet mutation/evidence exists.

## Exact next action

Supply environment variables or ignored `spikes/p0-atomic/.env`, then run `npm run testnet:p0`:

1. `TESTNET_PAYER_MNEMONIC` for a funded TestNet payer/setup account.
2. `TESTNET_ASA_ID` for the selected existing TestNet ASA; payer must be opted in and hold at least 100 atomic units.
3. `TESTNET_ALGOD_SERVER` for a reachable TestNet endpoint, plus optional `TESTNET_ALGOD_TOKEN` and `TESTNET_ALGOD_TOKEN_HEADER`.
4. At least 3,000,000 spendable microALGOs after account minimum balance.

Do not begin P1 or access `/docs`.
