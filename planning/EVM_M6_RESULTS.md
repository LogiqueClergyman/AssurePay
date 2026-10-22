# M6 developer pilot results

Date: 2026-10-22. ACCEPTED under EVM-039; implemented under EVM-038. The implementation and
verification cover `planning/EVM_M6_DEVELOPER_PILOT.md`; no public transaction,
funding, contract change or economic change was made. M5 evidence is preserved.

## Delivered behavior

`packages/developer-pilot` composes the existing Core, x402 flow and encrypted
claims backend into reusable provider and buyer SDKs, a loopback claims HTTP
API, and payer/adjudicator CLI commands. Its README documents pinned setup,
`npm run demo`, `npm run sandbox`, SDK interfaces and recovery limits. The
sandbox deploys a fresh isolated chain and prints public paths and commands;
new environment files are exclusive mode0600 and deleted on shutdown. Retrieval
uses a separate environment containing only the buyer encryption key.

A buyer encrypts its exact request and original payment before exposing a paid
send, then fsyncs an exclusive attempted marker before HTTP. A second paid send
is unavailable. A fresh buyer process retrieves with the same binding and data
key, without a payer signer. Narrow M3 changes add strict retrieval-only restore
and provider handling before reservation, settlement or handler invocation.
An archived response still requires its original receipt and exact canonical
payment-journal proof. Existing M3 behavior without this mode is preserved.

The claims API exposes allowlisted public status, authenticated opaque evidence,
unsigned claim preparation and explicit decision preparation. It has exact
schemas, duplicate-key detection, stream bounds, fixed errors and existing M4
role/context/operation/replay checks. It holds no transaction signer. The
restricted sender permits only fileClaim/finalizeClaim, verifies fresh state,
simulation, canonical observations and signed transaction fields, and persists
public identity before its sole broadcast. Recovery observes the original hash;
unknown or prepared-unsent attempts cannot be replaced. Directory/account locks
remain held until active work drains.

## Verification

Primary verification uses actual M2 EVM execution and HTTP, with the faithful
local ERC3009 fixture. All four package typechecks pass with Node24.18.0/npm11.16.0 and Anvil1.7.1.
The final full suites pass117 tests without failures, skips or cancellations:

| Package | Tests passed | Scope |
|---|---:|---|
| developer-pilot | 21 | Full M6 actual-EVM/HTTP/CLI, recovery, API and sandbox suite |
| x402-assurance | 30 | Full M3 suite, including strict restore and retrieval-only failure paths |
| claims-backend | 18 | Full M4 suite, including encrypted archives and canonical/reorg-safe projection |
| evm-acceptance | 48 | Full M5 suite, including financial, journal, RPC and recovery regressions |

M6 tests cover real CLI/server process purchase and restart retrieval; actual
signed HTTP500 recovery; explicit ProviderFault and full PoolOnly refunds;
exact payer delta and Core solvency; unchanged payment/relayer signatures,
broadcasts and handler counts during retrieval; absent archives/payment journals
and corrupted buyer ciphertext; mutable snapshot capture; bounded HTTP/schema,
authentication, role and replay failures; signed transaction substitutions;
lost-broadcast-response recovery without a signer; prepared-unsent identities;
canonical included-revert reconciliation; terminal RPC uncertainty; symlink/context/journal/lock conflicts; close draining;
and sandbox environment metadata, restart and cleanup. Existing M3/M4/M5 suites
retain the underlying canonical/reorg/RPC and financial invariant checks.

The separate required `npm run demo` returned `LOCAL_PILOT_VERIFIED`. Its
allowlisted report is `packages/developer-pilot/evidence/local-pilot.json`.
Observed example:

- Paid response200 and retrieved response200 after provider and buyer-process
  restarts; exact response bytes/hash preserved and relayer nonce unchanged.
- Explicit ProviderFault refund3100 atomic units; actual payer delta3100.
- Core assets59706 = provider stake8929 + pool50777 atomic fixture units.
- Locked stake, reserved pool and active coverage count are all0.
- Payer and adjudicator journal reconciliation succeeds without their signers.

Luna(high) agents implemented buyer/retrieval, claims HTTP and action sender.
Primary review and independent cross-review closed defects in attempted-marker
updates, terminal canonical rechecks, asynchronous input capture, close draining,
HTTP parsing and journal paths. The sandbox retrieval command was tightened to
avoid loading a payer key. No remaining scoped blocker was identified.

## Limits and preserved state

This is local composition evidence, not additional native-USDC/public testnet
proof. The local config rejects public URLs and native public USDC. M5's accepted
public evidence and both existing runtime namespaces remain untouched, with all
old public allowances consumed. No existing populated environment/private wallet
or runtime journal was read, regenerated or overwritten.

Trusted local RPC/storage and key custody remain assumptions. Canonical inclusion
is not finality. There is no backup rollback protection, automatic stale-lock
recovery, transaction replacement, key rotation, distributed availability,
production UI/hosting, subjective adjudication or new public campaign. An
interruption before the sole send may strand availability by design.

Final diff/whitespace checks, pinned-lock comparison and scoped new-file/public-
artifact sensitive-field checks pass. The ignored node_modules session link,
populated environments and private runtime directories are excluded from Git.
M6 is accepted under EVM-039. Further product work needs its own scoped packet.
