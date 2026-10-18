# AssurePay: first EVM MVP

Version: 0.2. Date: 2026-10-18. Status: EVM MVP starting proposal.
Network: Base Sepolia. Asset: native test USDC. Wallet profile: EOA first.

The proposed settlement path requires feasibility proof. The design is in
`evm_x402_assurance_technical_architecture_v0.2.md`; alternatives and rationale
are in `evm_design_rationale_v0.2.md`. Technical choices, including x402 scheme
and call type, can change when a better EVM mechanism meets the product
invariants. Implementation agents receive self-contained phase packets under
`/planning`.

## 1. Exit condition

A clean checkout can start local services, deploy Solidity Core, fund the demo
pool, register/seed a provider and immutable policy, and complete an assured
x402 HTTP call. The client verifies its response receipt; encrypted evidence
can be retrieved and verified; the payer files an on-chain claim and receives
a constrained approved refund. Capacity, pool funding, withdrawal, expiry,
replay and tampering failures are demonstrated. The core lifecycle is repeated
with real USDC on Base Sepolia and public evidence verified independently.

Each gate requires its own implementation and execution evidence.

## 2. MVP boundaries and candidate implementation

- One chain, one fixed token, one non-upgradeable Core, one development adjudicator.
- Provider middleware, not an HTTP proxy or service orchestrator.
- One gross price; premium and optional top-up come from provider revenue.
- Provider receives net in the settlement transaction, with no later revenue withdrawal.
- Candidate: EOA token receive authorization, relayer-paid settlement gas and a custom x402 profile; validate alternatives in M1.
- Immutable terms, provider-specific stake, fully reserved maximum permitted pool loss.
- One claim and one terminal resolution per coverage, including partial approved refunds.
- Payer registers its claim on-chain before expiry; pending claims remain encumbered.
- Buffered HTTP request/response demo, deterministic failure taxonomy, manual POC adjudication.
- PostgreSQL and MinIO, AES-256-GCM, dev key wrapper, encrypted retry spool.
- No Merkle service, public rankings, actuarial model, arbitrary ERC-20s, smart-account
  compatibility promise, proxy upgrades, production UI, governance or commerce integration.

## 3. Proposed stack

| Area | Choice |
|---|---|
| Contracts | Solidity, Foundry/Anvil, pinned OpenZeppelin helpers |
| Off-chain code | TypeScript/Node, viem-compatible signer and RPC boundary |
| Payment integration | x402 v2 core/server/client registration with custom assured handler |
| Demo server | Express |
| Evidence/workflow | One backend process, PostgreSQL, MinIO |
| Local verification | Real Anvil execution plus deterministic and invariant tests |
| Public verification | Base Sepolia, actual native USDC authorization and transfers |

Do not install guessed package versions. M1 records exact compatible versions,
compiler/EVM target and upstream revisions. A mock authorization token can aid
local tests but cannot satisfy the real-USDC compatibility gate.

## 4. Required behavior

### Registration, policies and pool

Owner registers provider identity, payout and dedicated receipt signer. Policy
terms are immutable; owner creates, admin activates/deactivates permitted
policies. Admin can disable new provider activity. Neither role can rewrite
an existing coverage's terms, payer, or payout history.

`fundPool(amount)` explicitly credits measured token inflow as a donation.
There are no pool shares or pool withdrawals. `depositStake` attributes measured
owner inflow to that provider only. Unexpected token donations do not implicitly
credit any ledger. All amounts use integer atomic units.

### Payment and admission

Requirements identify `scheme=assured-exact`, `profile=assurepay-evm-v1`,
Core as `payTo`, native USDC address, chain ID, gross, policy/hash, request/hash,
provider payout, and deterministically calculated split.

The payer signs `ReceiveWithAuthorization`, with nonce committing to the full
assurance intent. Core verifies that commitment before receiving gross and
recording coverage. Payer is token authorizer, not relayer or HTTP sender.
Wrong intent/chain/Core/token/policy/hash/amount/deadline must fail.

```text
premium = max(1, floor(gross * premiumBps / 10_000))
topup = floor(gross * stakeTopupBps / 10_000)
net = gross - premium - topup
stakeLock = ceil(gross * collateralBps / 10_000)
poolLock = gross                 # if pool-only approval is permitted
poolLock = gross - stakeLock     # otherwise
```

Require post-top-up stake to cover all stake locks and post-premium pool
liquidity to cover all pool locks. Record exact locks, payer, request, gross,
provider/policy and expiry. Failed token receipt, allocation or state checks
must revert token movement, authorization consumption and coverage together.
Reverted transaction gas remains charged to its sender.

### Request, response and evidence

Client and provider independently compute identical versioned request hashes.
Secret removal and encoding rules are explicit. Response signer binds coverage,
request, policy, response bytes and relevant metadata. Receipt is returned with
the response and verified by the caller. A missing/invalid receipt is a separate
assurance error even if the HTTP body appears valid.

Encrypted request/response objects and a manifest bind hashes, receipt, nonce,
wrapped DEK and object identities. Every AES-GCM object uses a distinct nonce.
Idempotent encrypted retries cannot replace prior evidence without detection.
Missing evidence does not cancel financial coverage. No plaintext, credentials,
private keys, DEKs or token authorizations in logs or public release evidence.

### Claims and closure

Reasons: `NO_RESPONSE`, `INVALID_RESPONSE_RECEIPT`,
`OBJECTIVE_PROVIDER_FAILURE`, `MANUAL_POC_DISPUTE`. These are adjudication inputs,
not automatic on-chain proof of fault.

The payer registers before expiry, creating `CLAIM_PENDING`. Direct filing
requires payer gas in this first profile. Backend acceptance alone does not
protect a claim against expiry; the API must expose this distinction.
At expiry, only unclaimed `OPEN` coverage can close permissionlessly.

Adjudicator finalizes a registered claim. Refund cannot exceed gross and goes
only to stored payer. Provider-fault payouts draw from that provider's stake
available after protecting other coverage locks, then from this coverage's
pool reserve. Pool-only payouts require a policy that permits them. Rejection
pays zero. Release both reservations once; every resolution is terminal.

Pending claims keep collateral until adjudication; POC adjudicator outage can
lock it indefinitely. No automatic timeout rejection/payout is included.
If USDC blocks a refund recipient or Core, failed payment reverts finalization
and retains pending state. No arbitrary alternate refund address is accepted.

Pause prevents new admissions, registrations and policy creation. It preserves
funding, deposits, safe exits, claims and closure. Disablement of providers or
policies cannot cancel existing coverage.

## 5. Minimum contract interface

Conceptual interface; M1/M2 freeze exact ABI and events before dependent code.

```text
constructor(token, admin, adjudicator, maxAuthorizationSeconds)
registerProvider(providerId, payout, receiptSigner)
setProviderActive(providerId, active)                 # admin
createPolicy(policyId, immutableTerms)                 # provider owner
setPolicyActive(policyId, active)                      # admin
fundPool(amount)
depositStake(providerId, amount)                       # provider owner
withdrawStake(providerId, amount)                      # provider owner
settleAssured(intent, tokenAuthorizationSignature)
registerClaim(coverageId, reasonCode, evidenceHash)     # stored payer
finalizeClaim(coverageId, approved, amount, providerFault, resolutionCode, decisionHash)
closeCoverage(coverageId)
setPaused(paused)                                      # admin
getProvider / getPolicy / getCoverage / getClaim
canOpenCoverage / getAccounting
```

No arbitrary refund receiver, asset argument overriding configured token,
caller-supplied stake/pool debit, generic multicall/delegatecall or accepted-token
rescue function. ERC-20 owner deposits require allowance; the payment receive
authorization does not grant or depend on that allowance.

## 6. Required verification

| Area | Success and failure evidence |
|---|---|
| Authentication | Correct EOA, wrong signer, altered every intent field, wrong type/domain, expiry/cancellation/replay |
| Atomicity | Real EVM transfer and coverage; provider-transfer failure and later postcondition revert roll back token nonce and all state |
| Admission | Mixed policy ratios, top-up bootstrap, rounding, last-capacity race, exhausted provider and pool |
| Accounting | Actual token balance vs separate ledgers; donations, stake isolation, reserved pool safety |
| Withdrawal | Free withdrawal, locked rejection, all free stake removed before claim, post-resolution exit |
| Claims | Payer-only timely registration, expired filing, pending-vs-close race, authorization, stake/pool paths, duplicate/over-cap failure |
| Pause | Admission blocked, pending claim and expiry/exit still possible |
| Token behavior | False/reverting transfers, reentrancy harness, exact deltas; live USDC pause/freeze limits documented |
| HTTP | Real 402/verify/settle/response through registered handlers; no service on failed payment; retry does not double-pay/reexecute |
| Evidence | Encrypt/store/decrypt/verify; wrong receipt, object substitution, missing object, nonce/metadata mismatch |
| Projection | Canonical event replay, reorg rollback, deduplication, consistent-block reconciliation |
| Operations | Pending RPC result reconciled without new payment; read-only verifier uses no signer |

Use actual contract execution and stateful/fuzz tests for financial properties;
do not rely on source-string checks or a JavaScript copy of the contract.

## 7. Demonstration scenarios

1. **Successful assured request:** caller loses gross, provider gains net, Core
   gains premium/top-up, coverage and both reservations exist, receipt/evidence verify.
2. **Rejected admission:** insufficient provider stake and, separately, pool
   reserve; no service tokens move or coverage/nonce is consumed.
3. **Withdrawal and expiry:** locked withdrawal fails, timely claim prevents
   expiry close, unclaimed expiry releases exactly once, zero capacity rejects.
4. **Refund:** provider-fault stake plus pool waterfall pays original payer,
   preserves unrelated stake and reservations; separately demonstrate policy-permitted pool-only payout.
5. **Tampering and replay:** wrong request/intent, receipt or encrypted object
   fails; a repeated settled payload is reconciled, not paid twice.

Repeat the required core financial path and HTTP integration on Base Sepolia.
Record actual native USDC/Core identities, transaction and block hashes, token
deltas, decoded events, observed invariants, gas/calldata and evidence finality.
Local mocks, fork impersonation and public simulations do not substitute for
a real payer signature and public settlement transaction.

## 8. Sequential implementation

| Phase | Deliverable | Gate |
|---|---|---|
| Baseline | EVM design and clean working tree | Reviewed starting proposal and bounded M1 packet |
| M1 | Compare/select settlement mechanism, prove intent binding and x402 integration | Real local rollback and Base Sepolia USDC compatibility proof |
| M2 | Full Solidity financial core | Real execution/invariants, funding/reservation/claim lifecycle |
| M3 | HTTP client/provider and cryptographic schemas | Working request through receipt verification |
| M4 | Evidence, observer and claims API | Encrypted evidence and canonical projection, payer claim workflow |
| M5 | Reproducibility and public acceptance | All scenarios, measured costs and independent read-only verification |

No mainnet deployment in these packets. Scope changes require a recorded
decision before code depends on them.
