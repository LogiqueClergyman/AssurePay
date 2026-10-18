# M1 — EVM intent-bound settlement feasibility

State: IN_PROGRESS — Gates A/B complete; Gate C next. Date: 2026-10-18.

## Mission

Select and prove the smallest EVM mechanism that makes payment and exact
coverage creation atomic before implementing the full assurance core. Target
Base Sepolia/native test USDC and an EOA payer. The candidate below uses receive
authorization, a custom x402 handler and relayer-paid transaction; it is not
mandatory if Gate A establishes a better supported approach.
Read `AGENTS.md`, handoff, this packet, EVM-001 through EVM-007 in `DECISIONS.md`,
and the M1 gate in the root plan. This packet is self-contained; no `/docs`
access is necessary.

## Allowed scope

Create only `spikes/evm-m1/**`, `planning/EVM_M1_RESULTS.md`, and required focused
decision/handoff/plan updates. A dedicated spike package may hold its pinned
dependencies/lockfile; leave the neutral root package unchanged unless a
documented tooling requirement needs a focused root change. No application
backend or full provider registry/policy/claims implementation. Use fixed demo
terms in the spike. Run one gate at a time and report concrete blockers.

## Candidate profile to evaluate

Gate A selected this candidate for the spike under EVM-007. The transfer method
is `assured-eip3009-receive` and `extra.paymentFlow=upfront`; server supports only
settlement-before-service. Exact schemas, unsigned hash vector and installed
release identities are in `spikes/evm-m1/README.md`, `vectors/intent-v1.json` and
`toolchain.json`. Read those files when continuing implementation. Gate A results
are in `planning/EVM_M1_RESULTS.md`. Selection is not settlement acceptance.

`scheme=assured-exact`, `profile=assurepay-evm-v1`, x402 v2,
`network=eip155:84532`, `asset=<verified native USDC>`, `payTo=<spike Core>`.
All monetary fields are integer atomic units/canonical decimal strings.

Implement equivalent TypeScript/Solidity intent hashing with this exact literal:

```text
AssuredIntentV1(uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore)
```

`intentHash = keccak256(abi.encode(keccak256(bytes(typeLiteral)), all fields))`.
`authorizationNonce = coverageId = intentHash`. Fresh random payer salt for a
new purchase; unchanged intent for retries. Validate every field against chain,
deployed Core/token and fixed immutable demo policy. Fix a 300-second maximum
authorization duration in the spike and test its boundaries. The token's own
strict validity checks still apply.

Payer signs the deployed token's EIP-712 `ReceiveWithAuthorization` with
`from=payer`, `to=Core`, `value=gross`, matching time bounds, `nonce=intentHash`.
Use actual token name/version/domain and supported v/r/s receive ABI. Core is
the token-call sender and receives gross. It marks coverage, credits premium,
and transfers provider net within the same transaction, reverting every change
if any step fails. No arbitrary token/target/calldata or generic authorization
forwarder. Non-reentrant entry point and exact token delta checks.

For the spike only, fixed demo `gross=100` atomic units, `premium=7`, `net=93`,
top-up zero; no stake/capacity system. An explicit allow/fail switch stands in
for admission, clearly labeled as a spike fixture. Do not claim it proves
provider capacity or reserved pool solvency.

## Gate A — Inspect, pin and freeze

- Compare actual supported EVM x402 mechanisms: exact with programmable
  settlement, receive authorization, Permit2 witness, direct wallet execution,
  up-to authorization and batch/voucher settlement where relevant. Evaluate
  atomic liability creation, signed intent, funding/admission timing, payer
  gas/approval UX, cost and dependencies. No requirement to preserve a custom
  scheme or call type. Do not add all mechanisms to the MVP.
- Select one supported path and record evidence in `DECISIONS.md` before code
  depends on its profile. The candidate-specific ABI/schema below may change;
  document equivalent binding/rollback guarantees for any alternative.
- Inspect available toolchain and pin compiler, EVM target, OpenZeppelin,
  TypeScript/viem and x402 versions compatible with custom scheme registration.
- Record exact upstream revisions and interfaces, including local lockfile
  integrity; do not describe a moving `main` source as a pinned dependency.
- Define exact requirements/payload/error schemas and intent/hash vectors.
- Preflight official Base Sepolia chain ID 84532 and Circle native USDC registry
  address, deployed code, decimals, typed-data domain and receive interface.
  Wrong chain/token or unsupported ABI is a blocker; do not silently switch token.
- Confirm the custom scheme is independently registered; ordinary `exact`
  settlement cannot be treated as our handler.

## Gate B — Real local execution

Use Solidity/Anvil and a faithful ERC-3009 fixture. Unit/model checks alone are
insufficient. Prove:

1. TS/Solidity hash equality and one successful receive/split/coverage transition.
2. Altering each intent field invalidates authorization; wrong payer/signature,
   chain/Core/token, deadline, type and policy fail.
3. Directly using the extracted receive authorization outside Core fails its
   recipient-caller check. Transfer-authorization signatures are rejected.
4. Success consumes the token nonce once; replay cannot double-pay or recreate
   coverage. Cancellation, not-yet-valid and expired authorizations fail.
5. Admission failure leaves payer/provider/Core token balances, coverage and
   token nonce unchanged. An included revert still spends relayer gas.
6. A token-transfer failure after receive/coverage marking reverts everything;
   add a later postcondition failure fixture to prove nested nonce rollback.
7. Changed fields between facilitator verify and settle cannot alter the exact
   submitted call; exact call is revalidated before broadcast.
8. A confirmation timeout queries public state/receipt before retry; it never
   generates a fresh payer salt or a second payment.

## Gate C — Real x402 integration and public proof

Use an actual registered x402 core client/server/facilitator path. A compatible
self-hosted facilitator is acceptable and must be labeled. A fake submitter or
direct contract call alone does not satisfy this integration gate.

Prepare non-mutating preflight and a bounded public runner. Runtime signer is
opaque with configured expected payer; do not print/read populated environments,
private keys or signatures. Public mutations require explicit session scope and
a stated bounded budget/attempt; do not infer authorization from this prepared
packet. If public execution is not authorized or funded, finish local work and
record the exact prerequisite without claiming M1 complete.

For the public gate, obtain a real EOA authorization against actual Base Sepolia
USDC, settle through the registered handler, observe `-100/+93/+7` token deltas,
coverage identity and nonce consumption. Demonstrate admission rollback with
that real token and valid signature. Prefer one deliberately included status-0
transaction for public rollback proof under an explicit gas budget; local
reverted execution plus public simulation alone must be labeled partial public
evidence. Mempool rejection is not itself an EVM execution-revert receipt.

Public snapshots must use consistent canonical blocks. Require successful
receipt plus matching Core event/state and token logs; successful simulation
or broadcaster acknowledgment alone is insufficient. Record confirmation
policy/finality level, public transaction/block hashes and gas/calldata.
Distinguish true token deltas from unavoidable native gas fees.

## Results and stopping rule

Results record verified versions, schemas/vectors, test commands, actual EVM
execution outcomes, x402 handler registration, network/token/domain identity,
cost measurements, public evidence or exact blocker. No signature, signed
transaction blob, raw RPC response, key or token in checked-in evidence.
Provide a signer-free read-only verifier for public proof.

If the nonce commitment construction or token ABI fails, record a decision
before trying an alternative. Candidates: a dedicated EIP-712 intent signature
plus restricted token spending, or a Permit2 witness profile. Do not weaken
atomicity or fall back to payment followed by coverage in a second transaction.

Stop at M1 REVIEW after gates and exact next action. Prepare M2 only after
acceptance. There is no permission to start full contracts, SDKs or backend here.
