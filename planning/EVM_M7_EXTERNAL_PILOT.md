# M7 — local HTTPS transport rehearsal

Date: 2026-10-23. State: ACCEPTED under EVM-042; results: planning/EVM_M7_RESULTS.md. The user selected
"Keep the next phase local only" after the concrete M7 proposal. This authorizes
the local rehearsal; no external deployment or public execution is included.
M1–M6 are accepted. The local scope derives from the reviewed proposal.
Historical scope review: planning/EVM_M7_SCOPE_RESULTS.md. No public execution budget exists for M7.

## Intended users and boundary

The eventual pilot serves an invited developer using the buyer SDK/CLI and a
single operator running one provider instance. The proposed topology is one
operator-owned Linux host, an HTTPS ingress for the paid resource, a loopback
provider listener and a private claims API. Claims access stays operator-local
for M7. Remote claims transport, including tunnels or private-network exposure,
needs separate scope; no public claims exposure, browser UI or CORS is included.
Hosting/vendor/domain selection is deferred by the user's local-only direction.

M7 proves only the transport prerequisite on an isolated local EVM. It does not
make M6 publicly deployable. Spend/admission controls, public-chain runtime and
operator readiness remain separate prerequisites listed below. They must pass
under their own approved packets before an external financial pilot starts.

## Baseline and gaps before M7 (checkpoint2057051)

| Code-grounded fact | Consequence |
|---|---|
| M6 config fixes local mode, loopback HTTP and a fixture token; it rejects native Base Sepolia USDC (`packages/developer-pilot/src/config.ts`) | Keep M6 defaults intact; external/native operation needs a separate explicit configuration and gate |
| M3 binds its socket using resourceUrl, which also enters the request hash and archive context (`packages/x402-assurance/src/http-provider.ts`, `canonical.ts`) | Advertised HTTPS identity must be separated from the private listening address; proxy rewriting must not change signed identity |
| At the M6 baseline, M3 checks one Host header but not equality to the configured authority | The new transport path needs exact Host/path enforcement and tests |
| Claims server/client accept loopback only, and the server requires its exact local Host (`packages/developer-pilot/src/claims-http.ts`, `claims-client.ts`) | Keep claims private; do not claim that proxying it is supported |
| M3 canServe runs after adapter.settle | It cannot be reused as a pre-payment invitation or spending guard |
| M6 checkPilot requires admin=relayer, while Core settlement is permissionless (`provider.ts`, `packages/evm-core/contracts/AssuranceCore.sol`) | An eventual online relayer must be decoupled from the administrative key; no contract change is currently demonstrated necessary |
| M6 projection scans from deployment with maxBlocks25000/maxCoverages1000 (`provider.ts`, `packages/claims-backend/src/projection.ts`) | A long-running pilot needs a demonstrated history/availability strategy; raising a limit alone is not evidence of indefinite operation |
| Journals, keys and exclusive locks are required for recovery; authenticated rollback protection is absent | No automatic state restore, stale-lock deletion or fresh payment to recover a response |

These are source observations and design requirements. No externally deployed
HTTPS/native-USDC M6 service has been proven.

## Implementation scope

Read AGENTS.md, this packet, its scope results, DECISIONS.md,
IMPLEMENTATION_PLAN.md, planning/EVM_M6_DEVELOPER_PILOT.md and EVM_M6_RESULTS.md.
Implementation references: packages/x402-assurance/{src,test,README.md,package.json,
package-lock.json,tsconfig.json}; packages/developer-pilot/{src,test,scripts,
README.md,package.json,package-lock.json,tsconfig.json}; packages/claims-backend/
{src,test}; packages/evm-core/{src,contracts,test,toolchain.json}; and only the M1
faithful ERC3009 fixture imported by the existing compiler. Installed pinned
dependency types may be read. Do not access /docs, populated environments,
private wallets or existing runtime journals. No historical campaign execution.

Write paths are packages/x402-assurance/src/http-provider.ts and a
focused test/transport.test.ts; packages/developer-pilot local transport rehearsal
source/script/tests, README, package scripts and evidence/local-transport.json; this packet, EVM_M7_RESULTS.md,
DECISIONS.md, IMPLEMENTATION_PLAN.md and SESSION_HANDOFF.md. Existing contracts,
economic schemas, canonical request/receipt hashes, payment engine, financial
journals, M4 claims and M5 code/evidence remain unchanged. Expand paths only via
a recorded requirement/decision, not an implementation shortcut.

### Frozen interface under EVM-041

Use an optional ProviderOptions.listenUrl with these exact semantics:

- Omitted: preserve the existing M3 listener behavior and accepted M6 flow.
- Present: resourceUrl is the canonical advertised HTTPS URL; listenUrl is an
  explicit `http://127.0.0.1:<port>/` origin with no credentials/query/fragment.
  Require a different local port for the HTTPS ingress in the rehearsal.
- Bind the HTTP socket only to listenUrl's loopback address/port. Match incoming
  method/path to the configured resource, and require exactly one Host header
  equal to resourceUrl's authority. Reject mismatches before challenge, payment,
  reservation or handler work.
- Use resourceUrl unchanged for request hashing, x402 resource identity, archive
  context, receipts and buyer snapshot bindings. Never derive signed identity
  from Host, Forwarded or X-Forwarded-* headers. Ignore Forwarded and
  X-Forwarded-* values; changing them must not change the
  resource identity, request hash or listener selection. No redirect, path/body
  decoding, re-encoding, compression or financial-header rewriting is supported.
- The ingress forwards the exact Host, path, bytes and financial headers. TLS
  terminates at ingress; this option is not a direct HTTPS server or permission
  to expose the plain HTTP listener. The operator/proxy are within the trust
  boundary. Host comparison is routing validation, not caller authentication.

Existing M6 local config/CLI restrictions stay unchanged. The new example
directly composes lower-level M3 startProvider and its
settlement engine with the isolated fixture, durable result store and M6 buyer
SDK. Existing M6 startPilotProvider does not accept advertised HTTPS URLs and
is not changed or presented as the new composition. The example must not
quietly enable a public-mode CLI. Claims API and EIP712 authorization stay
on their existing private origin.
No new payer/relayer/admin/adjudicator key is stored on an ingress process.

### Local rehearsal deliverable

Add a reproducible transport rehearsal that deploys actual M2 on isolated Anvil
with the faithful ERC3009 fixture, starts the provider on loopback, and uses a
real local HTTPS ingress plus buyer process. Use fresh TLS and role keys only;
never commit TLS private keys, set global TLS verification off, print signatures
or reuse existing runtime files. Clients explicitly trust only the generated
local certificate. Temporary certificates/data are private and cleaned up.

Prove a paid200 response and exact signer-free retrieval through HTTPS after
provider restart, preserving the original canonical URL, request ID, payment,
body hash and transaction identity. Assert no new payment/relayer signature,
broadcast or handler during retrieval, and independently check actual Core
solvency/coverage state. A local fixture report must label itself local and
must not claim public native-USDC proof, hosted availability or finality.

## Acceptance gate

1. Primary typecheck and full M3/M6 suites pass; the new local HTTPS rehearsal
   command passes from documented setup without editing internal source.
2. Actual HTTPS200 purchase/restart/retrieval proves unchanged canonical
   identity and zero new payment/signing/broadcast/handler work on retrieval.
3. Wrong/duplicate Host, wrong route, body or financial-header tampering,
   redirect and unsupported listener config fail closed. Forwarded-header
   changes cannot alter canonical resource identity or listener selection.
   Existing byte/header limits remain enforced through ingress.
4. Missing archive/journal and RPC uncertainty never fall through to settlement
   or handler work. TLS certificate mismatch is rejected by the client.
5. Existing local mode, financial invariants, claims authorization and retrieval
   regressions pass. Independent Luna(high) review and primary verification
   close blockers; exact evidence and limitations go in EVM_M7_RESULTS.md.

M7 acceptance is transport preparation only. Local TLS/Anvil success is not a
replacement for a future real endpoint/native-USDC acceptance gate.

## External-pilot prerequisites outside this implementation

Before deploying a settlement-capable external service, freeze additional
packets covering all of the following:

- Invitation/payer policy, per-request and aggregate limits, concurrency and
  durable reservations enforced before the first signature/broadcast. Account
  balance and client maxGross alone do not bound operator spending. Read-only
  retrieval remains available when new admissions are stopped.
- A public-chain runtime that separates offline admin from online relayer,
  explicitly pins Base Sepolia/native test USDC/Core/provider/policy/service,
  and keeps payer/adjudicator keys off the provider host. Relayer and receipt
  signer co-residency must be an explicit accepted custody assumption.
- A demonstrated projection horizon, request/header/time/concurrency limits,
  non-sensitive health/readiness, supervision and graceful drain, and a manual
  crash/state-loss procedure. No untested automatic lock takeover or backup
  rollback. Specify data retention and the person operating recovery.
- Hosting/domain/TLS/RPC ownership and access; a finite native-USDC campaign,
  exact account/transaction/fee/funding/USDC caps and a concrete approval packet.
  The old M5 Core is paused and its allowances consumed. Do not unpause, sweep,
  reuse its campaign approvals or create another run from existing journals.

User selection: keep this phase local only. No hosting/vendor/domain/custody
selection is needed or inferred for M7. External deployment remains deferred.
No hosting purchase, remote account provisioning, external deployment or public
blockchain mutation follows from local rehearsal acceptance.
