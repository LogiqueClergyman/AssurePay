# Combined-stack acceptance campaign

M5 composes the M2 assurance Core, M3 registered x402 flow and M4 encrypted
results/evidence backend on Base Sepolia with native test USDC. The bounded
acceptance scope is in
[`EVM_M5_PUBLIC_ACCEPTANCE.md`](../../planning/EVM_M5_PUBLIC_ACCEPTANCE.md); the
recorded outcome and decisions are in [`EVM_M5_RESULTS.md`](../../planning/EVM_M5_RESULTS.md).

## Result

M5 is accepted on the fresh second campaign. Its independent signer-free
verification matched all fourteen ordered transactions to canonical receipts
and checked the calls, state transitions, refunds and final revert. The earlier
first campaign remains partial and expired; preserve its `.local-m5` journal
and result. The accepted campaign has a separate `.local-m5-r2/` namespace.

Public proof:

- [Funding reconciliation](evidence/second-public-funding.json)
- [Campaign continuation and HTTP observations](evidence/second-public-continuation.json)
- [Independent chain verification](evidence/second-public-verification.json)
- [Measured public costs](evidence/second-public-costs.json)
- [Final Core state](evidence/second-final-state.json)

The campaign deployed a fresh Core and completed both purchase cases. The
ProviderFault and PoolOnly claims refunded 3,100 and 10,003 atomic USDC. Final
state records 16,017 atomic USDC in the Core, comprising 4,460 stake and 11,557
pool assets, zero locked stake and pool reserves, no active coverage, and a
paused Core. The distinct valid receive intent reverted while paused, leaving
its nonce unused and financial state unchanged. The measured aggregate native
fee was 27,730,062,008,778 wei under the no-concurrent-account-use assumption.
Unavailable operator-fee components remain labeled unavailable.

The HTTP evidence records one payment signature, relay signature, broadcast
and handler for each paid case, with exact repeat retrieval. This is
runner-observed transport evidence, not independent proof of private HTTP or
evidence truth. Public evidence establishes canonical inclusion, not finality
or post-receive rollback.

## Read-only follow-up

Use Node 24.18.0 and the pinned lockfile. The accepted run's funding and
execution allowances are consumed; do not run `--fund` or `--execute`, and do
not create another campaign under this approval. Signer-free reconciliation,
verification and cost reporting are:

```sh
node --import tsx scripts/second-attempt.ts --reconcile
node --import tsx scripts/second-attempt.ts --verify
node --import tsx scripts/costs.ts --second
```

The `--continue` recovery mode is reserved for an explicitly approved,
prepared campaign with exactly seven successful transactions through
`purchaseA`. It reconciles that exact prefix and can submit only the remaining
seven approved steps. It refuses any different or complete prefix and expired
claim coverage. This accepted run has all fourteen steps, so continuation must
refuse it. Never use the expired first campaign for continuation.

The bounded read queue retries only allowlisted idempotent reads; it never
retries signing, sending or other writes. M5 log requests are split into
contiguous chunks of at most 100 blocks. That adapter limit does not establish
the network's maximum accepted range. Projection scans use a 25,000-block
horizon and retain their deployment anchor; the horizon does not extend claim
expiry.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run rehearse
```

The local rehearsal uses isolated Anvil and a faithful ERC3009 fixture. It
checks the campaign's success and failure paths but does not replace public
native-USDC proof. Keep populated runtime configuration and private keys
private; never regenerate an existing environment or journal to recover a
transaction.
