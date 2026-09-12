# P1 Gate A Packet — Contract Skeleton and Storage

## Objective

Create the production Assurance Core contract project and prove its configuration, typed storage layout, event encoding, application creation, ASA opt-in, and minimum-balance calculations.

This packet is self-contained for Gate A. Do not read the phase-level `planning/P1_ASSURANCE_CORE.md`; the orchestrator will use that file to prepare later gates. Do not access `/docs`.

Implement Gate A only. Do not implement provider registration, policies, stake mutation, coverage opening, withdrawals, coverage closure, claims, or refunds.

## Starting state

- P0 is complete and must remain unchanged.
- P1 production code does not exist yet.
- The production contract belongs under `contracts/assurance-core/`.
- Reuse the installed P0 compiler/toolchain versions when compatible. Do not perform broad dependency upgrades.
- Read `DECISIONS.md`, especially D-010 through D-019 and D-011 storage semantics.

## Required paths

Create the smallest conventional project beneath:

```text
contracts/assurance-core/
  contract/                  # Algorand TypeScript source
  test/                      # deterministic Gate A tests
  scripts/                   # only a minimal Gate A LocalNet proof if needed
  artifacts/                 # generated ABI/application artifacts if conventionally tracked
  tsconfig.json
```

Exact filenames may follow the working P0/PuyaTs convention. Do not create `/apps`, `/packages`, `/infra`, or backend code.

## Fixed protocol types

Use fixed 32-byte identifiers throughout later P1:

```text
providerId: bytes32
policyId:   bytes32
coverageId: bytes32
claimId:    bytes32
```

Use distinct one-byte box namespaces followed by the identifier:

```text
provider box: prefix || providerId
policy box:   prefix || policyId
coverage box: prefix || coverageId
claim box:    prefix || claimId
```

Choose stable, non-overlapping prefix bytes and document them. Box keys must therefore have a fixed encoded length. Do not use human-readable variable-length IDs.

Declare fixed-layout record types in the following field order unless the compiler requires a documented equivalent.

### Provider record

```text
ownerAddress:            address
payoutAddress:           address
receiptSigningPublicKey: bytes32
active:                  bool
stakeTotal:              uint64
stakeLocked:             uint64
openFaultExposure:       uint64
createdAt:               uint64
```

### Policy record

```text
providerId:             bytes32
active:                 bool
premiumBps:             uint64
collateralRatioBps:     uint64
maxCoverageAmount:      uint64
claimWindowSeconds:     uint64
createdAt:              uint64
```

### Coverage record

```text
providerId:             bytes32
policyId:               bytes32
payerAddress:           address
grossAmount:            uint64
providerNetAmount:      uint64
premiumAmount:          uint64
stakeTopupAmount:       uint64
lockedStakeAmount:      uint64
requestHash:            bytes32
openedAt:               uint64
expiresAt:              uint64
status:                 uint64
exposureReleased:       bool
```

### Finalized claim record

```text
coverageId:    bytes32
approved:      bool
approvedAmount:uint64
providerFault: bool
resolutionCode:uint64
stakeDebit:    uint64
poolDebit:     uint64
resolvedAt:    uint64
```

Do not add speculative production fields. If Algorand TypeScript/ARC-4 boolean packing or struct constraints require a representation adjustment, keep it fixed-width, document the exact change in results, and do not alter the economic meaning.

## Required global state

Store only protocol-wide configuration and aggregates:

```text
admin:                  address
adjudicator:            address
acceptedAssetId:        uint64
paused:                 bool/uint64 fixed flag
assetOptedIn:           bool/uint64 fixed flag
totalProviderStake:     uint64
premiumReserve:         uint64
totalOpenFaultExposure: uint64
```

Application creation must:

1. derive `admin` from the creation sender;
2. require a non-zero existing-style asset ID argument;
3. require a non-zero valid adjudicator address;
4. initialize pause/opt-in flags to false;
5. initialize all accounting aggregates to zero;
6. reject unsafe rekey on the creation call where the AVM exposes it;
7. emit the creation/configuration event.

Do not implement admin rotation in Gate A.

## ASA opt-in

Implement only the application-account opt-in required by later financial operations.

Requirements:

1. only stored admin may call it;
2. protocol must not already be opted in through this method;
3. requested asset must equal stored `acceptedAssetId`;
4. outer application call must reject unsafe rekey/close controls where applicable;
5. issue the correct zero-amount inner ASA transfer from the application to itself;
6. use fee pooling explicitly and document the required outer fee;
7. set `assetOptedIn` only after the inner transaction succeeds;
8. emit the opt-in event;
9. repeated or wrong-asset calls must fail without changing state.

Do not implement deposits or other ASA transfers.

## Read-only ABI surface for Gate A

Expose only the smallest reads needed to verify configuration and accounting:

```text
getConfig() -> admin, adjudicator, acceptedAssetId, paused, assetOptedIn
getAccounting() -> totalProviderStake, premiumReserve, totalOpenFaultExposure
```

If the compiler cannot return the tuple directly, provide a typed query helper and record why. Do not expose raw secret or debug state.

## Event encoding

Use the current supported Algorand TypeScript ABI event/log mechanism. Gate A must emit and test:

```text
ProtocolCreated(version, admin, adjudicator, acceptedAssetId)
ProtocolAssetOptedIn(version, acceptedAssetId)
```

Freeze and document proposed signatures for later events without implementing their methods:

```text
ProviderRegistered
ProviderStatusChanged
PolicyCreated
PolicyStatusChanged
StakeDeposited
StakeWithdrawn
CoverageOpened
CoverageClosed
ClaimFinalized
RefundPaid
ProtocolPauseChanged
```

Use a numeric event version beginning at `1`. Events must be ABI-decodable and contain fixed-width projection-critical values. Do not log whole box blobs.

## Storage and minimum-balance evidence

Do not guess serialized sizes.

For every record type:

1. establish its exact encoded value length using compiled/generated type information or a deterministic encoding test;
2. establish the exact prefixed box-key length;
3. calculate the per-box Algorand minimum-balance increase using the current protocol formula;
4. record the formula, inputs, and result in `planning/P1_RESULTS.md`;
5. calculate example funding for one provider, one policy, one coverage, and one claim;
6. distinguish box MBR from application creation/global-state/ASA-holding MBR.

Verify the formula against current official Algorand documentation or observable LocalNet behavior. Cite the source URL in results. If documentation and observed behavior differ, stop and record the discrepancy.

Authoritative coverage and claim records will remain as tombstones in later gates; do not design automatic box deletion.

## Tests

Create deterministic tests covering at least:

- contract compiles and generated ABI/artifact is current;
- required Gate A methods exist with expected argument/return types;
- all four box namespaces are distinct and keys have the required fixed length;
- record encoded lengths match the documented results;
- MBR calculations match the recorded formula;
- creation stores exact admin/adjudicator/asset configuration and zero accounting;
- zero/invalid asset ID or zero adjudicator is rejected;
- non-admin opt-in is rejected;
- wrong-asset opt-in is rejected;
- successful opt-in creates the application ASA holding and flips the flag;
- repeated opt-in is rejected without state change;
- insufficient application ALGO for opt-in fails atomically;
- creation/opt-in unsafe rekey controls are rejected where exposed;
- Gate A events decode to the documented signatures and values.

Tests may combine fast deterministic checks with a minimal real LocalNet script. Clearly distinguish compiler/unit evidence from chain evidence.

## Canonical commands

Add minimal root scripts:

```text
npm run test:p1
npm run typecheck:p1
npm run build:contract:p1
```

Add `npm run localnet:p1` only if the Gate A LocalNet proof is implemented now. Later gates will extend these commands; do not create placeholder commands that falsely pass.

The default test command must never access or mutate TestNet.

## Required records

Update `planning/P1_RESULTS.md` Gate A with:

- exact tool/package versions;
- contract/artifact paths;
- global-state schema;
- record layouts and exact encoded sizes;
- box prefixes/key sizes;
- MBR formula and calculated values;
- event signatures;
- tests and commands run;
- whether LocalNet chain evidence exists;
- any compiler constraint or deviation.

Rewrite `SESSION_HANDOFF.md` with Gate A status and the exact next action. Do not mark Gate B ready yourself; the orchestrator reviews Gate A first.

If implementation facts refine D-011, update its evidence/consequences without changing the accepted storage decision. Add a superseding decision only for a genuine incompatibility.

## Allowed modifications

```text
contracts/assurance-core/**
planning/P1_RESULTS.md
SESSION_HANDOFF.md
DECISIONS.md                    # Gate A implementation facts only
IMPLEMENTATION_PLAN.md          # P1 status cell only
package.json
package-lock.json
.gitignore                      # build output or secret exclusions only
```

Do not modify:

```text
spikes/p0-atomic/**
planning/P1_ASSURANCE_CORE.md
any P0 planning/result file
/docs/**
```

## Exit condition

Gate A passes only when:

- the production contract skeleton builds;
- configuration and accounting reads are verified;
- application ASA opt-in is tested successfully;
- fixed storage encodings and exact MBR calculations are evidenced;
- Gate A event logs decode correctly;
- all negative tests pass;
- results and handoff are current.

Stop after Gate A. Do not implement Gate B even if time remains.

