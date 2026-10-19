# AssurePay EVM financial core

This package implements the M2 local financial-core gate. The accepted rules
and exact ABI are in `planning/EVM_M2_FINANCIAL_CORE.md` at repository root.
M1 proved the receive-authorization payment boundary using native USDC on Base
Sepolia; this new Core has local execution evidence only.

```sh
cd packages/evm-core
npm ci --ignore-scripts
npm run compile
npm run typecheck
npm test
npm run measure
```

Tests require Anvil 1.7.1 and local loopback access. They launch isolated chain
84532 nodes with no unlocked default accounts and use ephemeral signers only.
No populated environment, public RPC, wallet file or public transaction is
needed. The compiler reads the explicitly permitted faithful ERC3009 fixture
from M1 and resolves its libraries from this package's pinned dependencies.

`AssuranceCore` fixes token, administrator and adjudicator at deployment. The
administrator registers immutable providers and policies; policies bind owner,
payout, premium, withholding, stake, duration and pool-only eligibility through
a canonical hash. Settlement verifies the same twelve-field intent commitment
proven in M1, receives gross USDC, creates coverage, credits premium/withholding,
locks provider stake, reserves pool capacity, and pays provider net atomically.

All money uses atomic integers. Pool assets and provider stake are separate
ledgers. Premium and donated pool funds carry no withdrawal right. Providers
withdraw only their own free stake. The pool reserves each coverage's maximum
permitted contribution, so withdrawable free stake is never assumed as a
refund guarantee. Unsolicited token surplus grants no withdrawal rights.

Only the original payer files a timely claim and receives any approved refund.
The adjudicator may reject or approve a partial/full provider-fault refund,
using the coverage lock, then that provider's free stake, then pool assets.
A policy may separately authorize pool-only refunds. Pending claims retain
collateral until adjudication; unclaimed expiry releases it. Pausing blocks new
registration/admission while funding and existing obligations remain available.

The fixed adjudicator is a trusted resolution authority. No objective evidence
evaluation, dispute system, timeout fallback, role replacement, upgrade or
production recovery mechanism is implemented in M2. An unavailable adjudicator
can pin pending claims. M3 supplies the HTTP/client integration; later evidence
and claims backend work supplies the decision workflow.

Compiler output includes creation/runtime template sizes and hashes. Constructor
immutables patch deployed runtime bytes, so a template hash is not a deployed
code identity. `npm run measure` writes public-only local gas metadata to
`evidence/local-execution.json`; those fixture measurements are not Base public
cost estimates. Local execution and scoped source review are not a production
audit or public acceptance of the new Core.
