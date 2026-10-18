# M1 settlement feasibility — Gate A

This package contains the first implementation checkpoint, not the full MVP.
The packet is `planning/EVM_M1_SETTLEMENT_SPIKE.md` at repository root.

## Run

```sh
cd spikes/evm-m1
npm ci --ignore-scripts
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
cryptographic verification and settlement execution belong to the next gate.
The registration test uses an explicitly unimplemented, rejecting facilitator
to prove scheme discovery/negotiation without pretending to settle.

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

## Reproducibility and limits

Exact packages/integrities are in `package-lock.json`; `toolchain.json` records
compiler/EVM target, installed-source SHA-256 hashes and the independently
identified upstream research revision. The npm release and research commit are
separate identities. No moving source URL is treated as an installed revision.

Solidity 0.8.30 with Cancun target/optimizer 200 and OpenZeppelin 5.6.1 are pinned
for Gate B. Forge/Anvil 1.7.1 are available. No Solidity contract, compiler
execution, real x402 settlement or public mutation is claimed at Gate A.
Gate B must prove signature binding, actual nested token rollback and replay
behavior in real EVM execution before proceeding to public proof.
