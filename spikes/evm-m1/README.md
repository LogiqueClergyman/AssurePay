# M1 settlement feasibility — local Gates A/B/C

This package contains the first implementation checkpoint, not the full MVP.
The packet is `planning/EVM_M1_SETTLEMENT_SPIKE.md` at repository root.

## Run

```sh
cd spikes/evm-m1
npm ci --ignore-scripts
npm run compile
npm run typecheck
npm test
npm run preflight
```

Preflight uses the public Base Sepolia RPC by default. Optionally configure
`BASE_SEPOLIA_RPC_URL` at runtime. Do not put credentials in checked-in files.
The command has no signer and exposes only read-only RPC capabilities. It uses
an invalid synthetic signature in `eth_call`; it never submits a transaction.
An unavailable endpoint returns a fixed failure code without printing its URL.

## Selected experiment

- x402 v2 `assured-exact` / `assurepay-evm-v1`.
- `extra.assetTransferMethod=assured-eip3009-receive`.
- `extra.paymentFlow=upfront`; settlement-before-service is the only supported flow.
- Fixed fixture gross/net/premium = `100/93/7` atomic USDC units; no stake system.
- Full intent hash becomes token nonce and coverage ID. The signature builder
  recomputes that hash and rejects any substituted nonce.

Standard exact in the pinned package signs a transfer authorization and calls
the token directly. It does not invoke our receive/split/coverage path. Permit2,
up-to, batch and direct-wallet alternatives were compared; EVM-007 records why
the dedicated candidate is selected for this experiment. It remains replaceable
if later execution evidence favors a better mechanism.

## Implemented boundaries

`src/intent.ts` strictly parses the twelve-field intent and trusted bindings,
checks integer/time/address bounds, hashes a fixed ABI encoding and constructs
the token's receive-authorization typed data. Intent JSON uses lowercase hex;
trusted EVM addresses are normalized before comparison.

`src/profile.ts` defines exact requirements and payment payload binding and a
real SDK server interface with upfront-only flow. It rejects unknown financial
fields and unnegotiated extensions. It validates signature encoding only;
`src/call.ts` now verifies the receive signature and prepares/revalidates only
the fixed Core calldata. `src/relay.ts` derives/stores the public transaction hash
before one broadcast attempt and recovers only through bounded receipt reads.
The original registration test retains its rejecting facilitator as a Gate A
negative fixture. Gate C now separately exercises a real self-hosted adapter.

`src/preflight.ts` checks chain, deployed code, token metadata/domain, an unused
probe nonce and the v/r/s receive selector at a consistent canonical block.
The live result is in `evidence/token-preflight.json`. That result proves ABI
dispatch/rejection behavior, not a successful transfer or funded payer.

## Wire schema

Requirements have exactly `scheme`, `network`, `asset`, `amount`, `payTo`,
`maxTimeoutSeconds`, `extra`. The fixed timeout is 300 seconds. Core is `payTo`.
`extra` contains exactly:

```text
profile, assetTransferMethod, paymentFlow, name, version,
providerId, policyId, policyHash, requestHash, providerPayout, providerNet, premium
```

The payload has `x402Version: 2`, exact `accepted` requirements, and
`payload: {intent, intentHash, signature}`. Optional `resource` contains `url`
and optional `description`/`mimeType` strings. No extensions are negotiated.
Integers are canonical decimal strings, addresses/hashes lowercase hex, and
signature encoding is 65-byte hex. Compare all requirements against trusted
configuration, never against another untrusted copy of the same metadata.

Intent fields/type order and a synthetic unsigned golden vector are published
in `vectors/intent-v1.json`. Solidity parity must be established in Gate B.
Parse-time error categories are `M1_PROFILE_REQUIREMENTS`,
`M1_PROFILE_PAYLOAD`, `M1_PROFILE_INTENT`, `M1_PROFILE_CAPABILITY`; intent errors
name the invalid field without printing values. Preflight returns bounded
codes defined by `PreflightCode` and public metadata only.

## Real local execution

`contracts/AssuranceCoreSpike.sol` receives100, records coverage/premium7 and
pays93 atomically. Immutable demo terms, exact balance deltas, replay checks,
strict time bounds and a reentrancy guard are enforced. Admin admission and
forced-postcondition controls are explicit disposable spike fixtures.

`contracts/mocks/AuthorizationTokenMock.sol` implements signed receive/transfer
authorization and cancellation; its failure/fee/reentry controls exercise
rollback. This token is a local fixture, not public USDC.

`test/execution.test.ts` compiles actual Solidity and starts isolated Anvil
chains with no default unlocked accounts. Ephemeral wallets/signatures are
held in memory. Tests prove hash parity, successful split/event/state, every
intent-field substitution, signer/domain/type/replay/cancellation, exact time
boundaries, admin checks, reentrancy selector and full nested rollback including
token nonce. Included reverts still charge native gas to the relayer.

Run `npm run test:execution` for that subset; `npm test` includes all78 tests.
Anvil1.7.1 must be available on PATH and local loopback binding permitted. The
call/relay unit checks additionally exercise immutable calldata and recovery
after a lost broadcast response. Relay state is process-local, not durable
across a restart. Actual registered settlement is described below.

## Reproducibility and limits

Exact packages/integrities are in `package-lock.json`; `toolchain.json` records
compiler/EVM target, installed-source SHA-256 hashes and the independently
identified upstream research revision. The npm release and research commit are
separate identities. No moving source URL is treated as an installed revision.

Solidity 0.8.30 with Cancun target/optimizer 200 and OpenZeppelin 5.6.1 are pinned
and used by Gate B. Forge/Anvil1.7.1 are available. Actual local compilation/
execution and all78 tests pass. The full financial core, public mutation and
native USDC settlement acceptance are not yet proven.


## Gate C — registered local settlement

`src/x402.ts` registers actual pinned SDK client/facilitator schemes;
`src/flow.ts` wires them to the actual initialized resource server. This is a
self-hosted facilitator and a JSON-wire harness, without an HTTP app. SDK
optional `undefined` fields are omitted at that wire boundary; actual extension
objects remain rejected. The client explicitly allows only the configured asset
with a 100-unit cap. Trusted configuration and prepared calls are frozen.

The upfront SDK flow skips facilitator verification during server verify.
Tests separately call facilitator verify for signature/binding validation, then
server verify, then server settlement in `before-handler`. Service must wait
for confirmed settlement; server verify alone establishes no coverage. Admission
is rechecked by simulation and Core execution, not reserved by signature checks.

`src/evm-driver.ts` signs bounded transactions in memory, derives their hashes
locally and awaits a public journal callback before broadcast. No signed bytes
leave its closure. `src/receipt.ts` verifies chain/transaction/canonical block,
exact coverage and token events, and nonce/coverage state at that block.
Transient read failures remain pending. Retries reconcile the same known hash
even after authorization expiry; a different purchase is refused while pending.

`src/public-proof.ts` additionally pins deployment creation input to the compiled
Core plus constructor, compares canonical pre/post balances and accounting, and
verifies an included revert while admission is disabled with a valid payer
signature. A status-0 receipt does not itself prove the exact revert cause; no
trace-based reason proof is claimed. Its local test installs mock bytecode at
the native token address on an isolated Anvil chain only. That test supplies no
native-token or public-chain evidence.

`src/public-config.ts` parses bounded public configuration without touching a
signer or RPC. `src/journal.ts` persists only public identities exclusively and
fsyncs them before submission; existing sessions permit read-only recovery.
Public execution still requires separate explicit scope/funding. The runner
and signer-free CLI verifier are the remaining preparation work.

Base fees include L1 publication costs outside EIP-1559 execution fee caps.
The public auxiliary reserve is not a transaction-format L1 fee ceiling; use a
dedicated relayer with the exact approved total funding and no concurrent use
or incoming funds. EVM-010 records this constraint and the bounded four-step
attempt. Sources: [Base network fees](https://docs.base.org/specifications/transactions/network-fees),
[OP Stack fees](https://docs.optimism.io/op-stack/transactions/fees).
