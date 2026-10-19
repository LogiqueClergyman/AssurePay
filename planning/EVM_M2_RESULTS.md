# M2 financial core — local verification results

Date: 2026-10-19. Branch: `evm/restart`.
Requirements accepted by user in EVM-016; interfaces fixed in EVM-017.
Packet: `planning/EVM_M2_FINANCIAL_CORE.md`.
State: ACCEPTED under EVM-018 — local gate complete; no new public deployment.

## Delivered behavior

`packages/evm-core/contracts/AssuranceCore.sol` implements one non-upgradeable
Core with constructor-fixed token/admin/adjudicator. Admin registers immutable
providers and policies. A canonical policy hash binds owner, payout and economic
terms to the unchanged twelve-field M1 receive-authorization intent commitment.

Settlement receives gross, credits pool premium and provider stake withholding,
locks stake, reserves maximum pool liability, stores coverage, and pays provider
net atomically. Funding, owner-only free-stake withdrawal, timely payer claims,
adjudicator rejection/partial/full refunds, unclaimed expiry and pause behavior
follow the accepted packet. No arbitrary calls, pool withdrawal, role rotation,
upgrade, fixture failure switches or evidence evaluation were added.

For provider-fault refunds, actual execution proves own coverage lock, then
same-provider free stake, then pool funding while preserving other live locks
and unrelated providers' stake. Pool-only policies reserve the full gross as
well as their provider lock. Pending timely claims retain collateral indefinitely
until adjudication; this accepted trust/availability limit remains explicit.

## Tooling and verification

Isolated package/lockfile pins Solidity0.8.30, Cancun/optimizer200/viaIR,
OpenZeppelin5.6.1, viem2.57.7, TypeScript5.9.3, tsx4.20.6 and Anvil1.7.1.
The faithful M1 ERC3009 fixture is read-only test input; M1 source/evidence,
wallets and completed public journals were preserved. Ephemeral local accounts
are generated only in memory; no signer/env/public RPC is required.

From `packages/evm-core`:

- `npm run compile`: PASS, actual pinned Solidity compilation.
- `npm run typecheck`: PASS, strict TypeScript.
- `npm test`: PASS, 15 actual-EVM scenarios, including included negative cases.
- `npm run measure`: PASS, local gas evidence and aggregate invariant checks.

Local loopback permission is required for Anvil; sandbox-only startup failures
were not treated as contract results. Included negative cases reject gas-limit
exhaustion as evidence of an intended revert. Monetary calculations and model
expectations use atomic integers only.

| Evidence | Tests and concrete checks |
|---|---|
| Identity | M1 golden intent parity, canonical policy hash parity, all twelve substituted fields, wrong payer/domain/type, direct receive extraction, signed cancellation and replay |
| Admission and settlement | Independent P/W/N/L/Q arithmetic, exact token deltas, concurrent coverages, no pool/stake capacity, same-call withholding funding its own lock, zero/full stake, tiny gross and one-unit rounding |
| External-call rollback | False return, outgoing fee postcondition, withdrawal/refund failure, unused authorization after failed settlement, stable coverage/ledgers, and specific reentrancy-guard error selector |
| Authority and lifecycle | Invalid constructors, immutable registry/bounds, admin/provider/adjudicator/payer restrictions, stored-payer-only payout, partial/full/pool-only/reject, duplicate terminal failures |
| Time and pause | Strict authorization edges/300-second maximum, exact claim/expiry boundaries, expiry overflow, pending claim after expiry, paused admission/registration with funding/withdrawal/claims/finalization/expiry available |
| Financial invariants | Deterministic adversarial operation sequence and failure snapshots, aggregate provider free+locked sums, live coverage lock/reservation sums, one-time active/count transitions, actual token backing and isolation |

## Independent review and corrections

Separate Luna(high) agents implemented contracts, tooling and execution tests;
primary wrote additional security/boundary tests and verified the final suite.
Independent scoped source review traced settlement and each terminal refund
against the packet. No concrete unresolved defect was found after corrections.

Primary review corrected the initial implementation's reversed settlement Core
balance-delta comparison, missing provider-registration pause check, and missing
lifecycle reentrancy modifiers. Pulls reject Core/token/zero source addresses.
Test review corrected uint8 enum decoding, funded donation fixture balances,
and added a nonzero pool-fallback refund while multiple locks remain live.
This is a scoped development review, not a production security audit.

## Artifact and local cost evidence

Core creation bytecode: 12165 bytes, SHA-256
`d4680a45ecd7c1c5ebbf0e4436c1e0e531438dad2e0635852db44ef36b2688b6`.
Runtime template: 11562 bytes, SHA-256
`d37056adf70bd6b9d51d97a1729a4a4489733b42348084a10bdf55486063e3ae`.
Runtime is below the24576-byte limit; constructor immutables patch deployed code,
so a runtime-template hash is not a specific deployed contract identity.

Reproducible fixture gas in `packages/evm-core/evidence/local-execution.json`:

| Operation | Gas |
|---|---:|
| Core deployment | 2578907 |
| First assured settlement | 516653 |
| Claim filing | 56646 |
| Provider-fault refund (fixture free stake sufficient) | 152127 |
| Pool-only refund | 151525 |
| Rejection | 81589 |
| Unclaimed expiry | 61305 |
| Free-stake withdrawal | 89776 |

Values depend on fixture state/compiler and are not public Base fee estimates.
No new public transaction or fund movement was submitted. M1 public native USDC
acceptance proves its payment boundary, not public execution of this new Core.

## Next action

Primary review may accept the local M2 gate and prepare an M3 packet for dynamic
policy-backed client/provider HTTP flow. M3 must adapt the M1 experimental
transport to actual M2 ABI/economics and preserve confirmation-before-service,
canonical request/response commitments, explicit client limits and known-hash
recovery. Do not invent evidence/claims-backend requirements or public spending
scope from this local gate. No unresolved M2 economic requirement remains.
