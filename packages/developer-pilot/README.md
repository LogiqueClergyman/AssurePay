# AssurePay developer pilot

A local developer pilot for the existing EVM assurance protocol: provider SDK,
durable buyer SDK, loopback claims API and payer/adjudicator CLI. Contracts and
refund economics are unchanged. The active scope is
[M6](../../planning/EVM_M6_DEVELOPER_PILOT.md). M5's native public proof remains
separate; these commands create an isolated local EVM with an ERC3009 fixture.

## Run from a clean checkout

Use Node24.18.0/npm11.16.0 and Anvil1.7.1 on PATH. From the repository root:

```sh
npm ci --prefix packages/evm-core --ignore-scripts
npm ci --prefix packages/x402-assurance --ignore-scripts
npm ci --prefix packages/claims-backend --ignore-scripts
npm ci --prefix packages/developer-pilot --ignore-scripts
cd packages/developer-pilot
npm run typecheck
npm test
npm run demo
```

`demo` deploys the actual Core and a faithful ERC3009 token on a fresh local
Anvil, seeds temporary roles, starts a real provider process and runs buyer and
operator CLI processes. It purchases an echo response, restarts the provider
with a handler that fails if called, retrieves the original response in a new
buyer process without a payer signer, uploads synthetic evidence, files a claim
and explicitly refunds3100 atomic units. It checks the actual payer token delta,
canonical payment/retrieval proof, unchanged relayer nonce during retrieval and
Core solvency. The final `LOCAL_PILOT_VERIFIED` report contains public metadata
only. Temporary chain, accounts and data are discarded after this example.

For hands-on use, keep a fresh local environment running:

```sh
npm run sandbox
```

It prints public configuration/environment paths and complete command templates
for a second terminal. Provide a request file, then use `purchase --execute`.
Keep its printed requestId and coverageId for retrieval and claims. `evidence`
prints an evidenceHash; `claim --execute` uses it. The separate adjudicator
command requires an explicit outcome, integer refund and reason file. Outcome0
rejects with refund0;1 is ProviderFault;2 is policy-enabled PoolOnly.

The printed restart command gracefully restarts only the provider while the
chain stays alive. Ctrl+C stops the sandbox and removes its temporary data.
Save any explicitly exported response before stopping. A new sandbox is a new
chain; old local transaction hashes do not carry into it. Never copy these
throwaway role keys into a public deployment. The sandbox prints paths, not keys. Its retrieval command loads a separate
environment containing only the buyer data key.

## SDK composition

`src/index.ts` exports:

- `startPilotProvider({config,directory,key,receiptSigner,relayerAccount,wallet,
  client,handler})`: wrap a byte handler and start the paid endpoint plus claims
  API. Persist the same directory/key across provider restarts. `close()` drains
  listeners before releasing directory/account locks.
- `createBuyer({binding:{url,trust,maxGross,payer},directory,key,client,relayer,
  payerSigner})`: `prepare(body)` obtains one authorization and encrypts the exact
  request before exposing `send(requestId)`. The first paid attempt is durably
  marked before HTTP; a second send is rejected. Call `close()` after use.
- Reopen `createBuyer` with the same binding/directory/key and **no payerSigner**;
  `retrieve(requestId)` validates the original payment and uses retrieval-only
  HTTP. It never signs a new payment or enters provider settlement/handler code.
- `createClaimsClient({url})`: status, evidence upload/read, unsigned claim and
  explicit decision preparation. `authorize(...)` builds an existing M4 EIP712
  operation authorization in memory. HTTP services hold no payer/adjudicator key.
- `createActionSender({context,actor,client,wallet,account,journalPath})` submits
  only fileClaim/finalizeClaim. It checks the prepared action, fresh role/state,
  canonical anchors, simulation and signed transaction fields. `reconcile()`
  uses known hashes without a signer; `close()` drains and releases its lock.

All amounts and spend caps are integer atomic decimal strings. PilotConfig has
exact version1/mode local/chainId84532, local rpcUrl, core/token, providerId,
policyId/serviceId, roles{relayer,payer,provider,adjudicator}, resourceUrl/claimsUrl,
deploymentBlock and gross. The sandbox generates a working example. Local
configuration rejects non-loopback URLs, colliding roles and native public USDC.
Use your own handler through the SDK; the CLI includes echo/fail examples.

## Claims HTTP and CLI

All routes are POST JSON under the configured loopback claims origin:

| Route | Request | Response |
|---|---|---|
| /v1/coverage/status | coverageId | Allowlisted public coverage state and observation block |
| /v1/evidence/upload | coverageId,bodyHex,authorization | evidenceHash |
| /v1/evidence/read | coverageId,evidenceHash,authorization | Binary evidence |
| /v1/claims/prepare | coverageId,evidenceHash,authorization | Unsigned PreparedAction |
| /v1/decisions/prepare | coverageId,decision,authorization | action,decisionHash |

Evidence is opaque and at most65536bytes; JSON is bounded to143360bytes. The
provided client handles byte encoding, schemas and transport bounds. Existing
M4 signatures bind context, operation, actor, payload, nonce and deadline, with
durable replay prevention. No automatic claim submission or evidence judgment.

`npm run pilot -- <command> ...` supports check/provider/purchase/retrieve/status/
evidence/claim/decision/reconcile. Purchase/claim/decision need literal --execute;
provider starts a settlement-capable local service. Keys are injected only through
runtime environment variables listed in `.env.example`, never command arguments.
Retrieval requires the buyer encryption key, without a transaction signer.
`retrieve --out` writes a new0600 file and refuses overwrite. Without --out,
CLI output contains status, IDs, lengths and hashes, without response bytes.

## Recovery limits

Keep trusted durable local storage, stable encryption keys and one instance per
journal/account. Locks fail closed, including stale locks after abrupt termination;
there is no automatic takeover/deletion. SDK close drains ongoing work. Buyer
crashes between preparation/attempt marking and HTTP can strand an unsent request;
a reopened process can retrieve only, and never silently purchases again.
Missing archives/payment journals, wrong key, corruption, RPC uncertainty or a
reorg fail closed. Preserve unknown transaction hashes and reconcile them; never
replace/resend to recover a response. Initial journal-write interruption may
require inspection; automatic journal recreation is forbidden.

Read queues retry allowlisted reads only, with100-block log chunks and bounded
projection scans. Token checks establish one canonical inclusion, not finality.
There is no authenticated backup/rollback protection, KMS/key rotation,
distributed failover, production hosting/UI, public pilot funding or mainnet
support in this phase. A new public campaign needs its own scope and approval.

## Local HTTPS transport rehearsal (M7)

After the same pinned setup above, with `openssl` available on PATH and support
for `req -addext`, run:

```sh
npm run transport:demo
```

This creates fresh local TLS material and an isolated Anvil fixture. A separate
HTTPS ingress process listens on 127.0.0.1 and forwards to a private HTTP provider.
It receives only TLS file paths and a PATH-only environment, without blockchain
signers or the buyer/provider encryption keys. The buyer explicitly trusts the
fresh certificate; TLS verification stays enabled.

Purchase and retrieval run in separate buyer processes. The provider instance
is closed and reopened against the same durable payment/result state without a
settlement signer. This is an instance restart inside the coordinator process;
the report explicitly records `providerProcessRestart:false`. The existing M6
CLI demo separately covers a provider process restart.

The rehearsal verifies the exact advertised HTTPS request identity, original
transaction/body hash, unchanged signing/broadcast/handler counters, and actual
Core solvency/coverage locks. Wrong Host/path, modified bytes/payment header,
missing archive/payment journal and uncertain RPC reads cannot trigger another
payment or handler. Additional tests cover duplicate headers, body/header bounds,
redirect refusal and TLS trust/name failures.

The final `LOCAL_HTTPS_TRANSPORT_VERIFIED` report contains allowlisted public
metadata. One local coverage is still active when invariants are checked; the
entire temporary chain and data are then discarded. No existing environment,
public RPC, wallet or runtime journal is loaded. No deposit or hosting is needed.

The optional lower-level M3 `startProvider({...options, resourceUrl, listenUrl})`
keeps the HTTPS `resourceUrl` as signed identity while `listenUrl` selects an
exact `http://127.0.0.1:<port>/` socket origin. In this mode Host must equal the
advertised HTTPS authority and the path must match exactly. Forwarded metadata
cannot change identity. Omitting listenUrl preserves existing M3 behavior.
M6 `PilotConfig`, `startPilotProvider` and CLI remain local-only; the rehearsal
composes M3 directly. Claims access remains operator-local and is not exposed by
the ingress. This is local transport evidence under
[M7](../../planning/EVM_M7_EXTERNAL_PILOT.md), with no public/native-USDC or hosted
availability claim.
