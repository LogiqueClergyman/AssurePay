# AssurePay x402 HTTP composition

M3 implements one protected POST resource with an injected byte handler. It uses
M2's immutable Core and the registered x402 2.28.0 client/resource-server/
facilitator APIs. The custom `assured-exact` scheme negotiates
`assurepay-evm-v2`; ordinary x402 `exact` transfers do not create this coverage.

## Verification

Use Node 24.18.0/npm 11.16.0. Install this package's pinned lockfile with `npm ci`.
The integration tests reuse `../evm-core`'s pinned compiler, dependencies and
Anvil 1.7.1 installation; prepare that package first as described in its README.

```sh
npm run typecheck
npm test
```

Tests require localhost sockets. They deploy the actual M2 Solidity Core and a
faithfully signed ERC3009 fixture on isolated Anvil nodes with ephemeral runtime
accounts. No test uses the public wallets, vault, populated environments or
public network. Fixture results prove local composition; native public USDC
acceptance of this full stack remains a later gate.

## Entry points

- `chain.ts`: `readTerms`, `verifySettlement`, `isServiceAdmissible`.
- `engine.ts`: `createSettlementEngine` with one relayer and public-only journal.
- `http-provider.ts`: `startProvider` with independently configured terms,
  required current-coverage admission callback, owner receipt signer and handler.
- `http-client.ts`: `createPurchase` with trusted IDs, integer cap, independent
  chain readers/verifier and opaque payer signer. `send()`/`retry()` reuse the
  same authorization and exact body bytes.
- `protocol.ts`, `canonical.ts`, `receipt.ts`: strict profile validation,
  registered SDK adapters, exact request hashing and owner-signed receipts.

`test/helpers/integration.ts` is a complete local composition example. Monetary
values are atomic decimal strings; the route quote is read independently from
the configured Core and compared with the HTTP challenge before signing.
Provider execution starts only after canonical payment proof and current Active,
unexpired coverage. The receipt binds coverage, request, response bytes and HTTP
status; its timestamp and service content remain provider assertions.

## Recovery and deployment boundary

A payment hash and nonce are fsynced before one broadcast attempt. Lost RPC or
HTTP responses never trigger a replacement payment. Keep the journal and the
original purchase session; retry/reconcile that identity, including without a
relayer signer after restart. A process crash after preparing but before
broadcast can leave a permanently unresolved hash: this implementation fails
closed and does not reconstruct or rebroadcast signed bytes.

Service records reserve one payment identity before charging, then persist start
before handler entry. Concurrent identical requests share one execution and
in-memory result. A restarted `reserved` request may reconcile and start; a
restarted `started` request is indeterminate; a completed request without its
in-memory result reports unavailable. Neither case reruns the handler. A handler
exception returns a signed 500 and retains paid coverage.

Run one provider/engine instance per journal and relayer. Journals are local
public metadata, not authenticated backups or a distributed lock service. Keep
them on durable trusted storage and preserve them across restarts. A stale
payment lock file after process termination requires operator inspection; never
delete a payment record or submit a replacement to bypass an unresolved hash.
An RPC outage or canonicality uncertainty closes service admission. One canonical
inclusion is checked, not finality. Response bytes and signatures are intentionally
memory-only in M3; encrypted durable results/evidence and reorg-safe projection
belong to M4.

The Node listener is a local HTTP reference transport; production HTTPS
termination, public deployment hardening, authentication, distributed failover,
EOA replacement, claims and subjective adjudication are outside this phase.
Request/response bodies are bounded to 65,536 bytes and payment headers to 16,384.
