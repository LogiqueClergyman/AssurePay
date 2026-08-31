# Session Handoff

## Current state

- Phase: P0 — Atomic-group spike
- State: BLOCKED (TestNet user-controlled prerequisites only)
- Branch: `main`
- TestNet runner checkpoint: `847ce6b` (`feat: add secret-safe P0 TestNet runner`)
- Active packet: `planning/P0_TESTNET_ACCEPTANCE.md`
- Results: `planning/P0_RESULTS.md`

The reusable TestNet runner, configuration template, and non-mutating preflight are complete. LocalNet evidence remains accepted. No TestNet credentials, selected ASA ID, or endpoint were supplied, so no TestNet account or transaction was touched.

## Verification

```text
npm run test:p0              PASS, 52/52
npm run typecheck:p0         PASS
npm run build:contract:p0    PASS
npm run localnet:p0          PASS
npm run testnet:p0 -- --preflight
                             BLOCKED only on TESTNET_PAYER_MNEMONIC,
                             TESTNET_ASA_ID, TESTNET_ALGOD_SERVER
```

## TestNet runner

- Command: `npm run testnet:p0`; readiness-only command: `npm run testnet:p0 -- --preflight`.
- Template: `spikes/p0-atomic/.env.example`; populated `spikes/p0-atomic/.env` is ignored.
- The runner never prints credentials and never guesses or creates the configured TestNet ASA. It creates a disposable app/provider only after all preflight requirements pass.
- On a ready TestNet configuration it records public setup/success/rejection IDs and rounds, ASA balances, and marker state, with simulation and actual pool rejection explicitly distinct.

## Exact next action

Provide the following through environment variables or the ignored `spikes/p0-atomic/.env`, then run `npm run testnet:p0`:

1. `TESTNET_PAYER_MNEMONIC` for a funded TestNet setup/payer account.
2. `TESTNET_ASA_ID` for the selected existing TestNet ASA; the payer must be opted in and hold at least 100 atomic units.
3. `TESTNET_ALGOD_SERVER` for a reachable TestNet endpoint; configure optional `TESTNET_ALGOD_TOKEN` and `TESTNET_ALGOD_TOKEN_HEADER` if required.
4. At least 3,000,000 spendable microALGOs on the payer for disposable setup and fees.

Do not begin P1 or access `/docs`.
