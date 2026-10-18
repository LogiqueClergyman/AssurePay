# AssurePay EVM design rationale

Date: 2026-10-18. Status: starting proposal for feasibility testing.

## Product invariants

The provider operates its own x402 service and receives net revenue during
settlement. One gross price funds net revenue, premium and optional provider
stake. Payment and the corresponding coverage must be all-or-nothing. On-chain
state governs admission and safe collateral withdrawal. Approved refunds return
to the original payer. Signed receipts and encrypted evidence support disputes;
provider receipt signatures do not prove delivery, truth or service quality.

The backend must not manufacture coverage or spend stake through API keys.
MVP adjudication is disclosed as centralized and financially constrained.
Analytics and reputation are future products, not first-MVP implementation scope.

## Select mechanisms on their merits

The user explicitly allows changing x402 mechanisms/call types and every other
technical choice if a better EVM alternative serves the product. The
architecture/MVP describe candidates; they do not freeze payment APIs before
compatibility testing. Base is the initial target, not a multiple-chain project.

| Candidate | Question the feasibility gate must answer |
|---|---|
| Standard x402 exact with supported programmable settlement | Can the actual handler atomically enforce both payment and the complete liability intent? |
| USDC receive authorization with intent-bound nonce | Can one signature safely authorize Core to receive/split gross and create exact coverage? |
| Permit2 witness with restricted router | Do general token support and explicit intent binding justify approval/deployment dependencies? |
| Direct wallet settlement | Does simpler caller authorization justify payer gas/allowance setup? |
| Up-to authorization | Is variable final charge needed, and when is liability reserved before service? |
| Batch/voucher settlement | Can admission and refunds remain funded before batched payments finalize? |
| Smart-account batching/sponsorship | Does the chosen wallet/dependency improve UX enough for first-MVP scope? |

A token transfer followed by a separate coverage transaction fails atomicity.
Off-chain hooks alone cannot repair that. Scheme compatibility must be verified
against actual registered x402 client/server/facilitator behavior; hosted support
must not be assumed. A custom scheme is a candidate, not a product requirement.

The current receive-authorization candidate uses a signed token nonce derived
from the entire assurance intent, which Core recomputes. Receiver-restricted
receive authorization addresses transfer-only signature extraction from contract
wrappers. This is an AssurePay composition to test, not an upstream assurance
standard. [ERC-3009 security considerations](https://eips.ethereum.org/EIPS/eip-3009#security-considerations),
[current x402 EVM exact specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md).

## Funding and claims proposals

Provider collateral and pool liquidity are different admission constraints.
The starting funding proposal reserves each coverage's maximum permitted pool
contribution. It conservatively funds nominal payouts but requires pool capital;
premium alone may not cover it. Alternative underwriting is an explicit economic
change, not an incidental gas optimization.

The starting lifecycle proposal registers pending claims on-chain before expiry
so closure cannot release their collateral during adjudication. Direct filing
requires payer gas. Pending claims can remain locked if the POC adjudicator is
unavailable; production deadlines/recovery need separate design.

Revenue-funded stake top-up is feasible within a composed settlement call, but
its exact policy rounding and effect on capacity must be tested. It does not
guarantee that a provider with no capital can insure every price/risk profile.

## Efficiency and evidence

Start with constant-time accounting, immutable terms, minimal required storage,
one composed settlement and off-chain response evidence. Measure storage growth,
gas, calldata, L1 data fees, inclusion latency and failure/claim/closure costs
before asserting economic efficiency. Sponsorship changes who pays gas.

Keep explicit replay protection and claim availability before considering
log-only coverage, state deletion or batching. Keep cryptographic formats
versioned, avoid credential retention and freeze canonical encodings with test
vectors. EVM signatures do not require every off-chain payload hash to change.

## Current implementation state

Only the EVM design and phase packets exist. Settlement composition, exact
package versions, deployed token compatibility, fees and public confirmation
policy remain unverified. The next work is the self-contained
`planning/EVM_M1_SETTLEMENT_SPIKE.md` packet, followed by the full financial core
only after feasibility acceptance.
