# P1 Gate F Packet — Secret-Safe TestNet Acceptance

## Objective

Close P1 by proving the accepted Assurance Core lifecycle on real Algorand TestNet with the configured existing ASA and the user's Pera Universal Wallet development account. Deliver a non-mutating preflight, an explicit mutating acceptance run, compact public evidence, and a read-only public-evidence verifier.

Gates A–E are accepted at clean commit `5a50f95`. Gate E independently passed twice without a LocalNet reset and established the canonical lifecycle/evidence shape. Gate F ports that accepted behavior to TestNet; it does not redesign the contract or protocol.

## Scope and authority

Follow, in order:

1. `AGENTS.md`;
2. this packet;
3. accepted decisions D-010 through D-021 in `DECISIONS.md`;
4. the accepted Gate E and Gate F sections in `planning/P1_RESULTS.md`;
5. the P1 status cell in `IMPLEMENTATION_PLAN.md`.

Do not access `/docs`. Do not read any populated `.env` file except through the runner's normal runtime configuration loading. Never print or commit its contents.

Implement Gate F only. Do not begin P2, backend, UI, governance, key rotation, fee sponsorship, MainNet, or infrastructure work.

Preserve:

- scheme `assured-exact` and profile `assurance-core-v1`;
- exactly three payer-signed, payer-funded members `[provider axfer, premium axfer, application call]`;
- configured existing TestNet ASA; never create, guess, freeze, claw back, reconfigure, or destroy it;
- immutable signed bytes between facilitator validation, simulation, and submission;
- accepted contract ABI/storage/events/arithmetic, `extraPages=1`, permanent tombstones, and stored destinations;
- all 26 deterministic tests and the accepted LocalNet command.

## Ownership boundary

Gate F must not import runtime code from `spikes/p0-atomic/**`. It may inspect these public P0 files only as verified behavioral references:

```text
spikes/p0-atomic/src/pera-hd-signer.mjs
spikes/p0-atomic/.env.example
spikes/p0-atomic/test/pera-hd-signer.test.mjs
spikes/p0-atomic/scripts/run-testnet.mjs
spikes/p0-atomic/test/testnet-runner.test.mjs
```

Create a P1-owned opaque signer module under `contracts/assurance-core/**`. It must:

- accept only a valid 24-word BIP-39 Pera recovery phrase;
- use ARC-52 Peikert derivation path `m/44'/283'/account'/0/addressIndex`;
- accept bounded non-negative account/address indices;
- expose only the public address and transaction-signing operation needed by the runner;
- require a configured expected public address before any mutation;
- never expose `{addr, sk}`, root keys, derived private keys, seed bytes, or mnemonic text;
- zero disposable seed/root-key material where the library permits and expose deterministic disposal;
- use sanitized errors that never interpolate secret input.

Use a public deterministic test mnemonic only inside tests. Never reuse, read, or copy the user's populated P0 `.env`.

## P1 TestNet configuration

Add a checked-in secret-empty example and ignore the populated P1 file:

```text
contracts/assurance-core/.env.example
contracts/assurance-core/.env
```

Use these variables:

```text
TESTNET_PAYER_HD_MNEMONIC=
TESTNET_PAYER_ADDRESS=
TESTNET_PAYER_ACCOUNT_INDEX=0
TESTNET_PAYER_ADDRESS_INDEX=0
TESTNET_ASA_ID=
TESTNET_ALGOD_SERVER=
TESTNET_ALGOD_PORT=
TESTNET_ALGOD_TOKEN=
TESTNET_ALGOD_TOKEN_HEADER=X-Algo-API-Token
```

The runner may load ignored `contracts/assurance-core/.env`, but existing process environment values take precedence. Never log token/header values. For the known public endpoint, an empty token must work with `https://testnet-api.algonode.cloud`.

## Canonical commands

Add exact root commands:

```text
npm run testnet:p1 -- --preflight
npm run testnet:p1
npm run testnet:p1 -- --verify-evidence
```

`npm run test:p1` and `--preflight` must never mutate TestNet. `--verify-evidence` must not require a mnemonic, derive a key, or submit a transaction.

## Non-mutating preflight

Preflight must fail closed before mutation and return compact sanitized JSON with:

- `ok`, phase, TestNet genesis ID, expected/derived public payer address when safe;
- ASA ID/name/unit/decimals;
- payer total, minimum, and spendable microAlgos;
- payer ASA holding in atomic units;
- approval byte length, `extraPages`, calculated application/box funding budget, ephemeral-account funding budget, fee budget, and total conservative required spendable microAlgos;
- required ASA units for the complete TestNet scenario;
- named missing prerequisites.

Validate:

1. all configuration formats;
2. valid 24-word checksum;
3. derived address exactly equals `TESTNET_PAYER_ADDRESS`;
4. endpoint is reachable and identifies Algorand TestNet, not LocalNet/MainNet;
5. existing ASA exists and payer is opted in;
6. payer has enough ASA atomic units for every successful scenario transfer plus margin;
7. spendable ALGO—not total ALGO—covers deployment, all MBR, ephemeral accounts/opt-ins, fees, and a conservative margin;
8. compiled approval remains 3,517 bytes with `extraPages=1`, unless a legitimate build change is separately escalated.

Preflight must not guess a minimum. Derive and report its components from the actual planned transaction/box lifecycle. It may conservatively overfund, but unexplained or hidden prefunding is forbidden.

## Mutating TestNet acceptance

Only the default `npm run testnet:p1` path may mutate TestNet, and only after preflight passes.

Use the Pera signer for every payer transaction. Ephemeral accounts may be generated in memory for a distinct provider payout and authorization-negative actor. Never print their private material. Fund only the minimum plus explicit margin needed for ASA opt-in/fees. One user-controlled Pera account may fill admin, adjudicator, provider-owner, and payer roles where separation is immaterial; at least one authorization-negative transaction must use a distinct funded ephemeral signer.

Deploy the committed P1 contract artifact directly. Do not depend on a source-compilation service if the committed bytecode is accepted by the network. Use the recorded schema and `extraPages=1`.

Produce one coherent public result proving:

1. correct TestNet network and configured existing ASA;
2. ephemeral account funding/ASA opt-in as needed;
3. application creation, explicit ALGO funding, and application ASA opt-in;
4. provider registration, policy creation, and atomic stake deposit;
5. capacity read after deposit;
6. successful real `@x402/core` `assured-exact` coverage group with group ID, all member IDs/round, exact ASA deltas, coverage record, lock/exposure/reserve changes, and stored payer;
7. otherwise-valid insufficient-capacity group: facilitator simulation rejects with zero submission, direct real-pool submission of identical signed bytes rejects for the same deployed app/PC, and complete balances/state/box rollback holds;
8. over/lock-crossing withdrawal rejects for the intended deployed-app assertion with complete rollback;
9. genuine approved provider-fault claim with a non-zero stake debit and non-zero pool debit, exactly one inner configured-ASA refund to the stored original payer, unrelated collateral preserved, and exact claim/global/physical-balance deltas;
10. exposure release and a permitted withdrawal;
11. full withdrawal of a released provider to zero capacity followed by an otherwise-valid zero-capacity assured group rejected in simulation and by the real pool with identical bytes and complete rollback;
12. final provider/coverage/claim/global accounting reconciliation and invariants 1–10.

The TestNet scenario may use smaller counts than the exhaustive LocalNet runner, but it must use checked integer atomic units and genuinely exercise the stake-plus-pool waterfall. Explicitly fund every box MBR before creation. Do not rely on accidental excess application balance.

For every intended rejection, reject endpoint, rate-limit, timeout, stale-round, malformed request, signature, and unrelated resource failures. Match current deployed application identity and assertion PC/message in both simulation and pool evidence. Rejected transaction IDs/group IDs are public identifiers only; never output their signed bytes.

## Compact public evidence

Output only:

- network, ASA metadata, app ID/address, approval bytes/pages;
- public actor addresses;
- public transaction/group IDs and confirmed rounds;
- explicit funding amounts/purposes and MBR reconciliation;
- balance/state/box deltas;
- rejection classifications and matching app/PC fingerprints;
- claim waterfall and decoded inner-refund fields;
- final accounting and invariant flags.

Never output mnemonics, seeds, root/derived keys, signatures, signed blobs, tokens, headers, full pending responses, full simulations, or raw environment objects. On unexpected failure, emit a stable public error code and sanitized remediation text; do not serialize the original exception wholesale.

## Accepted evidence artifact and read-only verifier

After a successful mutating run, store only its compact public result in a checked-in P1 evidence file under `contracts/assurance-core/**`. The verifier must read that file; do not embed a second hand-copied constant that can drift.

`npm run testnet:p1 -- --verify-evidence` must require only endpoint configuration and must:

- confirm TestNet genesis, ASA, application, address, schema/program identity where publicly queryable, and current global/box terminal state;
- verify successful transaction/group membership and confirmed rounds through pending lookup with historical-block fallback;
- verify application-call IDs and publicly observable inner refund details where available;
- verify the recorded final accounting against current app/box/ASA state;
- clearly label acceptance-time pool rejection/rollback fields that cannot be reconstructed from the ledger because rejected transactions never entered a block;
- fail with stable `PUBLIC_EVIDENCE_*` codes for unavailable or mismatched public evidence.

Historical pruning or a non-archival endpoint must not be mistaken for invalid evidence. Use a precise unavailable code when neither pending nor block lookup can prove a field.

## Deterministic tests

Add tests, without network mutation, for at least:

- Pera mnemonic/index/address derivation and opaque signing;
- expected-address mismatch before network access;
- ignored `.env` parsing with process environment precedence;
- endpoint/network/ASA/spendable/holding/budget preflight branches using fakes;
- exact transaction construction and P1 `assurance-core-v1` bindings;
- sanitized error behavior and secret absence from all serializable results;
- compact evidence schema and exclusion of pending/simulation/signed/private data;
- intended app/PC failure matching versus endpoint/rate-limit/stale-round/unrelated-app errors;
- read-only verifier success, mismatch, and historical-fallback behavior with fakes;
- default `npm run test:p1` never invoking a mutating TestNet entry point.

Do not weaken or remove the 26 accepted tests.

## Required verification sequence

Run:

```text
npm run typecheck:p1
npm run build:contract:p1
npm run test:p1
npm run localnet:p1
npm run testnet:p1 -- --preflight
```

If preflight is blocked only by missing user-controlled P1 configuration, stop safely with Gate F `BLOCKED`, record the exact missing variables/action, and do not claim TestNet evidence.

If preflight passes, additionally run:

```text
npm run testnet:p1
npm run testnet:p1 -- --verify-evidence
```

Do not run the mutating command twice merely for repetition. A second mutation requires explicit user direction.

## Allowed modifications

```text
contracts/assurance-core/scripts/run-testnet.mjs
contracts/assurance-core/src/**
contracts/assurance-core/test/**
contracts/assurance-core/.env.example
contracts/assurance-core/testnet-evidence.json
planning/P1_RESULTS.md
SESSION_HANDOFF.md
IMPLEMENTATION_PLAN.md                    # P1 status cell only
package.json
package-lock.json                         # only if package.json requires it; no dependency upgrades
.gitignore                                # P1 .env entry only
DECISIONS.md                              # only for a genuine new/superseding decision
```

Do not modify the accepted contract, adapter, generated artifacts, LocalNet runner, earlier packets, P0, `/docs`, `/apps`, `/packages`, or `/infra`.

## Records and exit condition

Record preflight, TestNet identities, public transaction/group IDs, balances/state/MBR deltas, rejection evidence, waterfall/refund, verifier result, commands, and deviations in `planning/P1_RESULTS.md`.

Rewrite `SESSION_HANDOFF.md` with the exact state:

- `REVIEW` only when mutating TestNet acceptance and read-only verification both pass;
- `BLOCKED` when only user-controlled configuration/funding prevents mutation;
- otherwise remain `IN_PROGRESS` with the exact implementation defect.

Do not mark P1 `COMPLETE`; only the orchestrator may accept Gate F and close P1 after reviewing code, records, real TestNet evidence, and the clean checkpoint.

Gate F passes only when preflight is safely non-mutating, the Pera signer boundary is secret-safe, the complete required TestNet lifecycle succeeds, intended real-pool rollback is proved, compact evidence contains no secret material, read-only verification passes, all prior gates remain green, generated artifacts remain unchanged, records are accurate, commits are focused, and the worktree is clean.

Stop after Gate F even if time remains.
