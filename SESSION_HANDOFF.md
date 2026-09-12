# Session Handoff

## Current state

- Phase: P0 — Atomic-group spike
- State: BLOCKED (real TestNet acceptance has user-controlled prerequisites)
- Branch: `main`
- Starting HEAD for this checkpoint: `488dbab4ceded1ac01fb96bf0bd520f8dcb78b74`
- Active packet: `planning/P0_TESTNET_ACCEPTANCE.md`
- Results: `planning/P0_RESULTS.md`

The TestNet runner now supports Pera Universal Wallet's 24-word BIP-39 HD format in a headless Node workflow. It uses the Pera-verified ARC-52 Peikert path `m/44'/283'/account'/0/addressIndex` (defaults `0/0`) and signs transaction `bytesToSign()` through an opaque signer. It never converts the phrase to Algo25 and never exposes a derived private key as `{ addr, sk }`.

`TESTNET_PAYER_ADDRESS` is mandatory. Preflight validates the BIP-39 checksum, derives the configured account/address index, checks the exact public-address match before creating a network client, then performs the existing TestNet/ASA/balance checks. An ignored `spikes/p0-atomic/.env` remains supported and does not override supplied process values.

## Verification

```text
npm run test:p0                 PASS, 61/61 (unit + mocked facilitator; not chain evidence)
npm run typecheck:p0            PASS
npm run build:contract:p0       PASS
npm run testnet:p0 -- --preflight
                                BLOCKED with public missing prerequisites:
                                TESTNET_PAYER_HD_MNEMONIC and TESTNET_PAYER_ADDRESS
npm run localnet:p0             NOT AVAILABLE: endpoint ECONNREFUSED
```

The LocalNet command did not create any evidence in this session. Docker inspection showed the existing `algokit_sandbox_algod` and `algokit_sandbox_postgres` containers stopped; Indexer/Conduit restart because those dependencies are absent. This is distinct from the accepted historical LocalNet settlement/rollback proof recorded in `planning/P0_RESULTS.md`, and it is not TestNet evidence.

No TestNet transaction, deployment, asset setup, successful settlement, forced rejection, balances, marker values, or transaction IDs were produced in this session.

## Exact next action

1. In an ignored `spikes/p0-atomic/.env` or the process environment, set `TESTNET_PAYER_HD_MNEMONIC` to the Pera 24-word phrase and `TESTNET_PAYER_ADDRESS` to its exact derived public address. Set or retain `TESTNET_PAYER_ACCOUNT_INDEX` / `TESTNET_PAYER_ADDRESS_INDEX` (both default to `0`), `TESTNET_ASA_ID`, `TESTNET_ALGOD_SERVER`, and optional port/token/header variables. The payer must hold at least 100 selected-ASA atomic units and 3,000,000 spendable microALGOs.
2. Run `npm run testnet:p0 -- --preflight`. If it passes, run `npm run testnet:p0` to obtain genuine TestNet success and actual-pool-rejection evidence.
3. Separately restore the existing AlgoKit LocalNet environment before treating `npm run localnet:p0` as a current rerun; do not reset or discard the repository to do so.

## Commit checkpoint

Implementation/dependency checkpoint: `6530f00` (`feat: support Pera HD TestNet payer signing`). P0 decision/results/plan checkpoint: `a983e2b` (`docs: record Pera HD P0 TestNet checkpoint`). The session's final HEAD is reported by `git rev-parse HEAD` at handoff; the worktree must remain clean.
