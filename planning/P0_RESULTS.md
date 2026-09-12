# P0 Atomic-Group Spike Results

Status: COMPLETE — real Algorand TestNet assured-exact success and actual-pool-rejection acceptance recorded

## Final TestNet acceptance (2026-09-13)

- Network: Algorand TestNet (`testnet-v1.0`). The configured Algod endpoint was queried read-only with `npm run testnet:p0 -- --verify-evidence`: it confirmed ASA `10458941` as `USDC` with 6 decimals, application `771586806`, the application address `C5R73ZOB4R2MXRITSETIQLBPQU5GQIV3LATS2YSMFHWR4GF52Q2BRZERHY`, and current `opened` marker `1`.
- Final non-mutating preflight also passed against that endpoint: payer `G5V2CFA6OELV6YN6RRABZUAJJAFRLUNG6VC3UHPKP2S3UVPHT64OV3BYYU` has `19,999,900` ASA atomic units, `8,284,000` spendable microALGOs, and no outstanding prerequisite. No TestNet mutation was performed during this closing session.
- Successful real `assured-exact` group: `P/UeimX9rfN7M9bX+GVkRLVn3w8Ch0LmcnxtVVnm5/0=`. The configured endpoint’s historical block at round `67235792` contains exactly the three group members and its transaction-ID index contains `2FLY2PVDH6TNTYP3YKF7JY4OM5LCQZOGMDN4AUGFPITF5GDRAVBA`, `O37H5XIJ2OHO5HRYWD446OQGXU2RUV5LSOVMHODGKKHL7DHJ4SLQ`, and `7TIGGAWFQUTY2RUEJCKPIEEGG3Q6C7EONYIL2EIMQOS2U4D3BV2Q`.
- Successful settlement evidence from the supplied runner result: payer ASA `20,000,000 -> 19,999,900` (−100 atomic units), provider `0 -> 93`, application `0 -> 7`; contract marker `0 -> 1`. This is real TestNet chain evidence, not mocked-facilitator or LocalNet evidence.
- Actual rejection/atomicity evidence: ABI-valid group `2kqU7jR+J/+R/u0IhVfrPSJVylJHi1XB24UAKoAmBgc=` with member IDs `NR6I4JKAFWP4ERTWRQTWNSDQLDN76IQQU7JIWQMZ52JOM4IAATJA`, `U3WEAJFODDDMQX7QQZ7PMCYARDBQODZMW7RQUEU2UYECCCE75V2A`, and `P4VOKN44QWSXZFL23TN7DIBS2LGWJJHUAU26RQV3HRZ5YJ474DOQ` was rejected by the real TestNet transaction pool for the intended assertion in app `771586806`. The facilitator simulation is predictive only; the distinct pool rejection plus unchanged rejected-case ALGO/ASA balances and marker `1 -> 1` is the network atomic-rollback proof.
- The supplied acceptance evidence does not include setup transaction IDs/rounds. They are not reconstructed or invented here; the successful settlement and rejection evidence above is the P0 gate evidence supplied for this closing session.
- Final conclusion: D-010 remains correct—`assured-exact`, not the stock AVM `exact`, is required to bind and settle the full three-member group. D-017 remains correct—this accepted path used caller-paid fees and no fourth fee-payer member. P0 is complete; P1 has not started and still requires its own packet.

## Pera Universal Wallet HD signer checkpoint (2026-09-12)

- Replaced the TestNet payer's legacy Algo25 `algosdk.mnemonicToSecretKey(...)` path with an opaque 24-word BIP-39/ARC-52 signer. Pera's current public iOS implementation establishes the default Peikert variant and BIP-44 path `m/44'/283'/account'/0/addressIndex`, with account/address defaults `0/0`; it signs the already-prefixed Algorand transaction bytes through its HD signing API. The headless runner follows that exact shape and never converts a Pera phrase to Algo25.
- Official sources consulted: Pera's [HD wallet service](https://github.com/perawallet/pera-ios/blob/main/PeraWalletCore/Utils/HDWalletService/HDWalletService.swift), [derivation type](https://github.com/perawallet/pera-ios/blob/main/PeraWalletCore/Utils/SDK/HDWallet/Model/HDWalletDerivationType.swift), and [transaction signer](https://github.com/perawallet/pera-ios/blob/main/PeraWalletCore/Utils/Transaction/HDWallet/HDWalletTransactionSigner.swift); Algorand Foundation's [ARC-52 TypeScript implementation and vectors](https://github.com/algorandfoundation/xHD-Wallet-API-ts). These establish Pera compatibility; no browser or WalletConnect path is involved.
- The runner now requires `TESTNET_PAYER_HD_MNEMONIC` and the mandatory public `TESTNET_PAYER_ADDRESS` assertion, with optional/defaulted `TESTNET_PAYER_ACCOUNT_INDEX=0` and `TESTNET_PAYER_ADDRESS_INDEX=0`; it also retains the configured ASA and Algod variables from T1. It validates the 24-word BIP-39 checksum, derives the Peikert address, and rejects an address mismatch before creating a network client, signing, or mutating chain state.
- Dependencies are pinned to `@algorandfoundation/xhd-wallet-api` `1.0.3`, `bip39` `3.1.0`, `libsodium-wrappers-sumo` `0.7.13`, and `libsodium-sumo` `0.7.13`. The LibSodium pair is pinned because the package's compatible ESM runtime requires that companion version. The Foundation ARC-52 public Khovratovich vector and Pera's Peikert defaults are covered in deterministic tests; the Pera payment group also has independent Ed25519 verification for all three payer-owned members.
- Unit/mocked verification: `npm run test:p0` PASS, 61/61. It covers BIP-39 word-count/checksum rejection, the published ARC-52 public vector, Pera account/address indices, address-mismatch abort, opaque signing, independent verification of all three `[provider axfer, premium axfer, appl]` members, group identity/order, and secret-safe errors. Existing signed-byte rejection and mocked-facilitator tests continue to pass; none is chain evidence.
- `npm run typecheck:p0` and `npm run build:contract:p0` PASS. `npm run testnet:p0 -- --preflight` makes no mutation and now reports the missing `TESTNET_PAYER_HD_MNEMONIC` and `TESTNET_PAYER_ADDRESS` public prerequisites rather than a legacy mnemonic. No mnemonic, seed, root key, derived private material, or token was printed.
- Current LocalNet rerun: attempted and unavailable in this environment (`npm run localnet:p0` -> endpoint `ECONNREFUSED`; Docker shows `algokit_sandbox_algod` and `algokit_sandbox_postgres` stopped, while Indexer/Conduit restart because their dependencies are absent). This is neither new LocalNet evidence nor a TestNet result; the accepted historical LocalNet evidence below is unchanged.
- TestNet evidence: none. No TestNet deployment, transfer, application, group, or rejection was attempted or claimed.

## TestNet runner correction checkpoint (2026-08-31)

- Spendable ALGO is now calculated as `account.amount - account.minBalance`, and the public preflight result reports `totalMicroAlgos`, `minimumBalanceMicroAlgos`, and `spendableMicroAlgos`. The conservative 3,000,000 microALGO requirement applies to spendable funds, not total balance.
- `npm run testnet:p0` now loads ignored `spikes/p0-atomic/.env` if it exists, without replacing any key already present in the process environment. It emits no mnemonic, secret key, token, or populated environment value.
- The forced-rejection path now requires both the TestNet simulation and actual transaction-pool submission error to identify `logic eval error`, `assert failed`, and the same deployed application ID. Authentication, endpoint, rate-limit, timeout, stale-round, or other unrelated failures abort acceptance rather than becoming rollback evidence.
- Focused deterministic coverage verifies process-environment precedence, total/minimum/spendable calculation, and intended-assertion matching versus unrelated failures. `npm run test:p0` passes 55/55.
- Superseded by the 2026-09-12 Pera HD checkpoint above: the payer prerequisite is now the 24-word `TESTNET_PAYER_HD_MNEMONIC` plus the mandatory `TESTNET_PAYER_ADDRESS` assertion, not `TESTNET_PAYER_MNEMONIC`.

## TestNet runner orchestrator review

Reviewed checkpoint: `4ae9cae276f709ada168a0c5e19a8f01026748be`.

The orchestrator reproduced the 52 tests, PuyaTs checks, contract build, and secret-free empty-configuration preflight. The preflight exits with code 2 and reports only the three missing variable names; no credential values are exposed.

Three safe local fixes remain before the status can be considered externally blocked:

- The 3,000,000 microALGO threshold is described as spendable but is checked against total account amount. Preflight must subtract the account minimum balance.
- The ignored `spikes/p0-atomic/.env` is advertised as supported but is not loaded by the npm command or runner.
- The actual-pool-rejection branch treats every submission exception as proof of the intended contract rejection and discards its cause. It must require the expected simulation failure and verify the pool error is the intended application logic/assertion rejection, not an endpoint/authentication/rate-limit/round error.

Until these are fixed, P0 remains `IN_PROGRESS` rather than externally blocked.

## TestNet acceptance runner and preflight (2026-08-31)

- T1/T6: added secret-safe `npm run testnet:p0` and `spikes/p0-atomic/.env.example`. The local populated `spikes/p0-atomic/.env` path was already ignored. The runner reads environment variables only, never creates/guesses an ASA, and emits only public addresses, identifiers, balances, rounds, and outcome summaries.
- T2 preflight: `npm run testnet:p0 -- --preflight` performs no deployment, funding, opt-in, or transfer. It validates mnemonic/ASA/endpoint configuration, requires a TestNet genesis, derives only the payer public address, queries ASA metadata, validates the payer ASA holding against the P0 `100/93/7` split, and requires a conservative `3,000,000` spendable microALGO setup balance before mutation.
- T3–T5 implementation: when preflight passes, the runner compiles the checked-in artifact, creates a disposable application, generates/funds/opts in an ephemeral provider, funds and opts in the application, settles through registered `assured-exact`, and checks public balance/marker deltas. It then simulates and separately submits an ABI-valid `reject=true` group, requiring a real pool rejection and unchanged ASA balances/marker. The structured result labels simulation separately from the actual pool rejection.
- Superseded by the 2026-09-12 Pera HD checkpoint above: TestNet uses the 24-word Pera BIP-39/ARC-52 configuration, never a legacy Algo25 mnemonic.
- TestNet evidence: none. No TestNet account, asset, application, transaction, group, balance, or marker data was created or claimed.

## Gate G LocalNet evidence (2026-08-31)

- Tooling: AlgoKit `2.10.2`; Docker `29.4.0` / Compose `5.1.2`; LocalNet genesis `dockernet-v1`. Started with `/Users/adi/Library/Application Support/pipx/venvs/algokit/bin/algokit localnet start` after the official `algorand/algod`, `algorand/indexer`, and `algorandfoundation/conduit-localnet` images were available.
- Reproducibility: `npm run build:contract:p0 && npm run localnet:p0` compiles the disposable contract, creates a new disposable ASA/app/accounts per run, funds accounts, opts payer/provider/application into the ASA, then emits public evidence JSON only. It reads no secrets from the repository and logs none.
- Successful real settlement through registered `assured-exact`: LocalNet ASA `1045`, app `1046`, application `QVP5TVUA6ISFQQAXICQMMQM3G7XCA2X7LQXXRM7VMPCSXT7WSXJ62YY6E4`; confirmed provider-transfer transaction ID `6AY6OFQ6IFO43CEBCEWELA5PJMWAYVMWMBSLHTWFWENGLKGQ7QZA`. ASA balances changed payer `1000 -> 900`, provider `0 -> 93`, application `0 -> 7`; payer Algo changed `4,999,000 -> 4,996,000` (three caller-paid fees), provider/application Algo remained `999,000`/`300,000`; contract `opened` marker changed `0 -> 1`.
- Actual network-rejected atomic group: group `swX5Mc8vAZvkZfX6iik3tmY5tCM4sYwiJyeQ9JswOSM=`, provider member ID `W6GQDH4VEDSY4GFEPHLMRK36RGDK6KOYKGEHHRZBZYAQEJ4WW5EA`, rejected app-call ID `DD7QBMKJXWWMJ37OTRSQLU2FVYCHEI35JAJ4KIC4GIPILDCEYPTA`. The ABI-valid `reject=true` call failed the contract assertion (`pc=329`) in LocalNet simulation and, separately, actual submission returned HTTP 400 / `TransactionPool.Remember` for the same app-call ID. ASA balances remained payer `900`, provider `93`, application `7`, and marker remained `1`; therefore neither transfer settled.
- Evidence distinction: Gate E's facilitator simulation-rejection test uses a mocked signer and is not chain evidence. Gate G's `simulateRawTransactions` only predicted this deliberate AVM failure; the separate raw submission to LocalNet's real transaction pool was rejected and the unchanged state is the atomic-rollback proof.
- TestNet: not attempted and not complete. P0 is blocked only on TestNet’s external funding, ASA/app setup, and credentials/network configuration.

## Gate E signed-byte matrix and LocalNet attempt (2026-08-31)

- Gate E: COMPLETE. `npm run test:p0` passes 52/52. The direct `assured-exact` matrix covers independently re-signed receiver/ASA/amount/application/ABI/commitment mutations, payer mismatch for both non-provider roles, group IDs and reordering, all three signature roles (missing, corrupt, wrong key), all rekey roles, both close fields, malformed numeric/wrapper input, simulation rejection, submission failure, confirmation failure, and D-017 fourth-member rejection. Each pre-settlement negative case asserts its stable error code, zero simulations, and zero submissions; the simulation rejection asserts one simulation and zero submissions.
- Mocked facilitator evidence only: the successful settlement test registers through `@x402/core`, verifies the immutable prepared bytes are submitted after simulation, and asserts a transaction-ID-shaped confirmation input. It is not LocalNet evidence.
- Official installation verification: the current official AlgoKit CLI README documents `curl -fsSL https://cli.algokit.io/install.sh | bash` as the recommended macOS/Linux method and `pipx install algokit` as a supported legacy fallback. On 2026-08-31 the documented installer endpoint returned literal `404: Not Found`; the fallback installed AlgoKit `2.10.2` through pipx.
- LocalNet: attempted with the installed official CLI. `algokit doctor` reports Docker `29.4.0` and Compose `5.1.2`, but `algokit localnet start` returned `Container engine isn't running; please start it.` No LocalNet containers, deployment, transaction IDs, balances, success evidence, or rollback evidence exist.
- TestNet: not attempted. No TestNet evidence exists.

## Independent LocalNet reproduction

The orchestrator independently reran `npm run localnet:p0` against `dockernet-v1` after obtaining localhost access. The run created ASA `1058` and application `1059`.

```text
Successful provider transaction: JREDJGVMXYLXOTXONPQ4IJWFTFBWLNWHSJZYFVRJQDF44N2DJ6NQ
ASA balances before: payer/provider/app = 1000/0/0
ASA balances after:  payer/provider/app = 900/93/7
Marker: 0 -> 1

Rejected group ID: B3Q8Wf7uii2DC+LgBYgCfEYnRBjcOleHjaWomdad0aE=
Rejected provider transaction: ARG5HKOYZTHFRC5W7K7JAPS6RPM6AEFMFZ2WSUHR577RLS4G27ZQ
Rejected application transaction: JLEVQVPHQZLU3DWOMPIAQ6RPLD2IMS4M4B43MTGN3BVXW2LV4DFA
Balances after rejection: payer/provider/app = 900/93/7
Marker after rejection: 1
```

The rejected ABI-valid group failed both simulation and actual transaction-pool submission at the contract assertion. Balances and marker state remained unchanged. Gate G LocalNet evidence is accepted. P0 still needs a reusable TestNet runner and real TestNet evidence.

Orchestrator verification at `4570c5a3ee32e6241b76db23d536557ca52269b2` reproduced all 52 tests plus the PuyaTs dry run and contract build. The worktree was clean before this orchestration update. Gate E is accepted as complete. The active Docker context is `orbstack`, and `docker version` cannot connect because `/Users/adi/.orbstack/run/docker.sock` does not exist. P0 is therefore accurately `BLOCKED` on starting a container engine before LocalNet work can continue.

## Chain-readiness correction checkpoint (2026-08-31)

- Mocked facilitator evidence only: `algosdk` now constructs a canonical ABI application call for `openCoverage(uint64,uint64,byte[],bool)void`; all three signed members are cryptographically verified with `ed25519Verifier` over `txn.bytesToSign()`.
- The scheme validates the ABI selector, ABI-encoded gross/premium/32-byte commitment/reject flag, canonical numeric requirements, group ID, roles, and signatures. Settlement preserves verified byte copies, uses the decoded provider transfer transaction ID, and separates submission and confirmation errors.
- `npm run test:p0`: PASS, 18/18. This includes mocked `@x402/core` integration and does not constitute LocalNet evidence.
- D-017 accepted: caller-paid fees are supported by the intended AVM path; no fee-payer member is present in P0.

Orchestrator verification at `ca4f664` reproduced all three passing commands. This checkpoint clears the ABI, cryptographic-signature, immutable-prepared-group, transaction-ID, and error-separation implementation defects identified at `1305e95`. Gate E remains incomplete because only eight tests exercise `assured-exact`; see `planning/P0_REVIEW.md` for the required signed-byte negative cases before LocalNet.

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
