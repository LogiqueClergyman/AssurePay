# AssurePay evidence and claims backend

M4 is a programmatic backend for one configured Base Sepolia Core. It adds
AES-256-GCM storage for service results/evidence/decision records, canonical
coverage projection and operation-authenticated preparation of payer claims and
explicit adjudicator decisions. M2 contracts and financial rules are unchanged.

## Verify locally

Use Node24.18.0/npm11.16.0. Prepare the pinned dependencies and Anvil1.7.1 used
by `../evm-core` and install `../x402-assurance` first; see their READMEs.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests launch real M2 contracts on isolated local Anvil chains, use the faithfully
signed ERC3009 fixture and ephemeral signers, and compose the registered x402
HTTP stack. They require localhost sockets. They never load populated wallet
environments, contact public RPCs or spend public funds. Fixture success is
local evidence; native public USDC acceptance of the complete stack is M5.

## Compose the backend

`src/index.ts` exports these entry points:

- `EncryptedVault({directory,namespace,keyId,key})` stores immutable JSON objects.
  Supply a fresh runtime 32-byte key and stable keyId; keep them available across
  restarts. `contextNamespace(context)` derives a namespace for one backend.
- `createResultStore(vault)` implements the optional M3 provider `resultStore`.
  Pass it to `startProvider`; the engine must implement read-only `reconcile`.
  Existing providers without a store retain M3 memory-only behavior.
- `createProjection({client,context,journalPath,fromBlock})` rebuilds current
  canonical coverage state and persists a public checkpoint. Include the Core's
  deployment block or an earlier block. Defaults bound scans to5000 blocks and
  1000coverages. A scan omitting an earlier coverage fails the count check.
- `createClaimsBackend({context,projection,vault,replayPath})` exposes
  `uploadEvidence`, `readEvidence`, `prepareClaim` and `prepareDecision`.

`context` pins chain84532, Core, token, adjudicator and a nonzero bytes32 serviceId.
There is no HTTP claims server or transaction sender. Prepared actions include
expected `from`, fixed `to`, value0, calldata and observation block. The caller
checks them and submits through their own wallet. Contract authorization and
state at inclusion remain final; preparation neither files a claim nor reserves
an outcome. `test/product-flow.test.ts` is a complete paid HTTP → encrypted
evidence → direct claim → explicit refund example.

Each backend operation requires an EOA EIP712 authorization. Use
`operationPayloadHash(payload)` and `operationTypedData(context,message)` with
actor, operation, coverageId, payloadHash, randomNonce() and a deadline at most300
seconds ahead of current canonical chain time. Payloads are exactly:

| Operation | Payload |
|---|---|
| uploadEvidence | `{bodyHex}` with `0x`-prefixed exact bytes |
| readEvidence / prepareClaim | `{evidenceHash}` |
| prepareDecision | `{outcome,refundAmount,reason}` |

The payer uploads one nonempty opaque bundle<=65536 bytes and chooses its digest
when preparing a claim. Salted encrypted records bind the exact bundle, payer,
request and canonical opening. The backend does not interpret evidence. The
configured adjudicator can read the exact included claim's bundle and prepare
an explicit Reject(0), ProviderFault(1) or permitted PoolOnly(2) decision. Refund
amounts are atomic decimal strings; the reason must be nonempty and<=8192 UTF8
bytes. The decision hash commits the encrypted salted record. On-chain rights
also exist without this backend; missing local artifacts prevent backend
preparation without changing Core permissions.

## Durability and operational boundary

Result order is durable start → handler → signed response → encrypted result
fsync → completed marker fsync → response. Restart retrieves the same bytes and
receipt, including after coverage expiry, only after verifying the receipt and
canonical original payment anchor. A saved result with a missing completed marker
can finish that marker without another handler. A start without a result remains
indeterminate. Missing/corrupt ciphertext, wrong key, orphaned opening or missing
payment journal fails closed without signing or submitting a replacement.

Evidence access and preparation refresh chain state every time. Projection fully
rebuilds within configured bounds; same-height/deeper reorgs remove orphaned
coverage/claim/refund state. An encrypted object from an old opening cannot attach
to a replacement opening of the same coverage ID. A failed RPC/canonicality/range
check leaves the last checkpoint intact and supplies no stale authorization.
One canonical inclusion is checked; no finality claim is made.

Run exactly one backend instance per replay journal and one provider/engine per
service/payment journal. Nonces are durably consumed before side effects. An
interrupted operation can consume its authorization without returning a result;
use a new nonfinancial authorization, never a replacement payment. Replay metadata
is bounded to10000 entries; capacity exhaustion fails closed. No journal deletion,
rotation or stale-lock stealing is automated. Trusted durable local filesystem
and RPC are assumptions; encrypted storage is not an authenticated backup or a
rollback-resistant multi-process database.

Inject the encryption key through runtime configuration; `.env.example` contains
empty placeholders only. Never print keys, authorizations, signed transactions,
plaintext evidence or raw RPC errors. Losing the key loses access to stored data;
key rotation/KMS, deletion/retention policy, distributed deployment, production
transport, subjective adjudication and public combined-stack acceptance are
outside M4. Scoped development review is not a production audit.
