# AssurePay protocol API

Local Node application backend for the provider, admin, operator and adjudicator
console implemented in M12. It uses the accepted Core, claims backend and client
flow. The browser acceptance gate remains pending; there is no public deployment.

## Run the verified scenario

Use Node >=24.18, npm and Anvil on PATH, with the existing repository packages'
pinned dependencies installed. From this directory:

```sh
npm ci
npm run typecheck
npm test
npm run demo
```

The demo creates a disposable local chain, faithful ERC3009 token and five fresh
actors. It executes registry/policy registration, exact allowances, pool funding,
stake deposit/withdrawal, pause/unpause, three paid requests, two claims and an
explicit rejection/refund. It hides one broadcast response and original receipt,
then restarts without protocol signing accounts and reconciles the original hash.
Original-result retrieval also succeeds without provider or payer signing keys.
Each confirmed control checks actual Core accounting and solvency.

The process cleans up its temporary chain, actors and private runtime state. Only
the sanitized report at `evidence/m11-protocol-gate.json` is retained. This is
local fixture evidence; it does not establish public native-USDC settlement,
hosted availability, finality or production custody.

## Host integration

`src/index.ts` exports `validateProtocolConfig`, `createProtocolRuntime`,
`startProtocolServer`, `startProtocolConsole`, `startProtocolProvider`, safe errors and public types.
This private application runs through pinned `tsx`; it is not a packaged SDK.

The host supplies a validated `ProtocolConfig`, private storage, explicit action
caps and only the required actor accounts. Configuration is exact and loopback
only. The separate admin must differ from the four existing pilot actors.
The internal `startProtocolProvider` composition checks that separate admin while
the online provider receives only relayer settlement authority. The public
provider SDK's accepted v1 schema and default composition remain unchanged; a
future scoped SDK extension is needed to expose this separated composition.

Runtime methods are `snapshot`, `assertAnchor`, `preview`, `confirm`, `reconcile`,
`readEvidence` and `close`. Its role arguments are trusted host inputs. On HTTP,
the server alone derives roles from sessions; submitting a role grants no power.

| Role | Fixed capabilities |
|---|---|
| Admin | Register immutable provider/policy IDs, pause/unpause, exact token allowance and pool funding |
| Provider | Exact token allowance, primary-provider stake deposit and free-stake withdrawal |
| Adjudicator | Scoped private evidence read and explicitly confirmed rejection/refund |
| Operator | Sanitized reads and reconciliation of managed original hashes |

Payer payment/claim controls belong to the separate client SDK. This API has no
arbitrary transaction, recipient, calldata, process-control or expiry-close route.

## Browser authority and approval

`startProtocolServer({runtime})` binds the configured `127.0.0.1` HTTP origin.
The host calls `issueBootstrap(role)` programmatically and privately provisions
the resulting one-use, 60-second capability. Never print or persist it in public
reports. `POST /v1/session` exchanges it for an HttpOnly, SameSite=Strict cookie
and a session-bound CSRF token. Sessions last 30 minutes. The optional console
launcher provisions a host-selected demo seat as described below; this is not a
production login system.

All routes require exact Host and reject forwarded identity/cross-site metadata.
POST requires exact Origin and bounded, duplicate-free JSON; authenticated POST
also requires CSRF. There is no CORS. Cookies omit Secure only for this explicit
local HTTP composition. Responses are `no-store` with fixed safe errors.

GET routes expose session, summary and bounded provider/policy/coverage lists and
details. POST routes expose session/logout, action preview/confirm/reconcile and
adjudicator evidence read. Consult the self-contained
`planning/EVM_M11_PROTOCOL_API.md` packet at the repository root for exact schemas.

Preview validates and simulates one fixed operation without signing. Confirmation
requires its one-use session-bound preview and explicit user approval; it
revalidates context, state and canonical anchors. Reasons stay private, with only
a reason hash in preview. Actual salted decision commitments use the existing
claims backend after approval. Missing actor accounts permit reads/reconciliation
but cannot confirm financial actions or authorize private evidence access.

## Durable recovery and observations

Actor journals reserve before signing and save the locally derived transaction
hash and attempted marker before the single broadcast. Uncertain responses block
new operations for that actor. Reconciliation uses only saved original hashes;
it never signs, resends, replaces or raises fees. Prepared-unsent records remain
stranded. Missing/corrupt/changed state and lock collisions fail closed; do not
delete journals or locks to recover an interrupted operation.

The storage key binds configuration identity through a fingerprint. Protocol
journals contain public transaction metadata/commitments; they are not encrypted
or cryptographically authenticated. Existing M4 storage encrypts private evidence
and reasons. Trusted local durable storage, RPC and actor custody remain required;
there is no authenticated backup rollback or automatic stale-lock takeover.

Reads share one numbered canonical anchor, bounded event scans and verified
registry mappings. Lists use session-bound, expiring snapshot cursors and recheck
their original anchor. RPC/storage/reorg/limit failures return unavailable rather
than stale success. RPC completeness for unreferenced registry events remains
trusted because Core has no registry count. Monetary values are atomic decimal
strings; cumulative net paid is an event-derived total, not profit. General read
rows omit private payloads, request/evidence/decision hashes and signatures.

Limits include 100 providers, 100 policies, 1,000 coverages, 25,000 scanned blocks,
100-block registry chunks, 100 items/page and 32 volatile previews/actor. Action
amount/count caps and fixed gas/fee ceilings bind the saved context. These are
single-host controls, not production account-wide spending guarantees.

## M12 console work in progress

The active implementation packet is `planning/EVM_M12_PROTOCOL_CONSOLE.md`.
M11 above is accepted. M12 typecheck, syntax and all29 tests pass, along with
admin/provider browser writes and original-hash recovery. The final browser
refund confirmation/accounting check is pending because automatic approval
review requires a user handoff for that click, including on the local fixture.
See `planning/EVM_M12_RESULTS.md`; M12 is not accepted yet.

```sh
npm run console:check
npm run console:demo -- --role operator
```

The local launcher prepares a fresh EVM/provider/client scenario with a real
active coverage and a pending claim. The trusted host selects `operator`,
`provider`, `admin` or `adjudicator` at launch; browser navigation grants no role.
Open its printed loopback URL and click Connect local session to claim the one
seat armed by that host. Credentials stay out of URLs and console output. This
is a trusted-machine demo seat, not OS-user or production authentication.

Enrollment is one-use per server start. Reload resumes the existing HttpOnly
cookie through the API; logout/expiry requires the host to rearm. For development
rehearsal, exact host stdin commands are `status`, `role <role>`, `rpc-off`,
`rpc-on`, `expire-preview`, `lose-next-send`, `reveal` and `quit`. A role change
restarts the console server on the same fresh state and invalidates old sessions.
Fault controls exist only in this disposable launcher, never as HTTP endpoints.

All amounts are atomic integers with their observed API block. Preview and
Confirm are separate actions; cancelling a review sends nothing. Unknown
confirmations offer reconciliation of original operations. They never offer a
replacement or retry payment. Private adjudicator evidence/reasons stay in
volatile page memory and are cleared on navigation/session changes.
