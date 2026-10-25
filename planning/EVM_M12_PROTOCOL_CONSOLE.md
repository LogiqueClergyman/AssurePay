# M12 — local protocol console

Date:2026-10-25; accepted2026-10-26 under EVM-052. Implemented under EVM-051
after M11 acceptance EVM-050 at
51cf1ac. User authorizes local product continuation, Luna(high) delegation,
primary verification, checkpoint commits and non-force main pushes. No public
transaction, hosting, publication, existing wallet use or production login.

Implementation,29tests and required native browser journeys pass. The user
performed final refund confirmation; primary independently verified actual payer
delta, protected locks, original-hash reconciliation, private clearing and normal
fixture cleanup. Results: EVM_M12_RESULTS.md. This frozen packet records scope.

## Goal and scope

Deliver the browser console over accepted M11: provider collateral/coverage,
admin registry/funding/pause, operator availability/original-hash reconciliation
and adjudicator evidence/explicit decisions. Browser controls use only M11's
fixed API. Every amount/status comes from actual anchored reads; every financial
action requires its unsigned preview followed by explicit confirmation.

Read AGENTS/handoff/DECISIONS/IMPLEMENTATION_PLAN, planning/EVM_PRODUCT_ROADMAP.md,
M11 packet/results and packages/protocol-app source/tests/scripts/metadata;
accepted M6–M10 packets/results and scoped source/test helpers when imported.
Existing SDK/example source and Core enum/ABI may inform composition. Read the
Sites local-only skill/workflow and supported browser tool documentation.
No /docs, populated environments, old wallets/private journals or public actions.
Exclude dependencies/generated runtime state from recursive searches.

Write packages/protocol-app/{console/**,src/console.ts,src/http.ts,src/types.ts,
src/index.ts,test/console*.ts,scripts/console-demo.ts,package.json,README.md,
evidence/m12-console*.json,evidence/m12-console*.png}, this packet,
planning/EVM_M12_RESULTS.md, DECISIONS.md, IMPLEMENTATION_PLAN.md and
SESSION_HANDOFF.md. No other source/test/evidence changes. No dependency changes:
buildless HTML/JS/CSS, existing pinned Node/tsx/TypeScript/viem. Do not widen
financial operations, roles, Core, claims, SDKs or M11 JSON schemas. No framework,
chart/asset library, remote fonts, image generation or external network resource
is needed for this operational console.

## Host provisioning decision

Extend startProtocolServer with an optional trusted-host console configuration:
`console?:{role:Role,assets:{html:string,javascript:string,stylesheet:string}}`.
Capture/validate exact plain data and copy strings before awaiting. Each asset
is nonempty UTF8 <=262144bytes. Old API-only default stays unchanged.

Serve only GET `/`, `/assets/app.js`, `/assets/styles.css`; query strings and
other static paths fail. Serve no private files/directory traversal. Existing
Host/Origin/forwarded/Fetch Metadata guards apply before static/console routes.
HTML/assets are no-store, nosniff, no-referrer and frame-denied, with CSP:
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'.
No inline handlers/scripts/styles, external code, service workers or data URLs.

GET `/console/context` returns only host-selected role, localOnly:true,
chainId:84532, Core/token/primary provider/policy IDs from validated runtime
config. It returns no accounts/keys/session tokens/CSRF or browser-selected data.

The host arms exactly one enrollment for its selected role when starting this
server. POST `/console/session` accepts exact `{}`, existing same-Origin JSON/
Host/Fetch Metadata/body checks, and no role argument. It consumes that single
host arm synchronously and creates the existing M11 session/cookie/CSRF response.
Reuse one internal session constructor with POST `/v1/session`; do not create a
second auth system or weaken that existing capability exchange. No bootstrap
token needs to enter HTML, URLs, logs or browser storage. The host arm is not
rearmed by any HTTP request, logout or expiry. Further enrollment requires the
trusted host to restart/rearm the server. Existing M11 issueBootstrap remains a
trusted Node host method and is not exposed by HTTP.

This is a **trusted-machine local demo seat**, not user identity authentication:
the first permitted same-origin browser session receives the role explicitly
armed by the host. Same-user local processes are trusted; loopback headers do
not authenticate an OS user. Untrusted web origins cannot enroll through CORS,
cross-site navigation, form posts or frames. There is no production access/login
claim. Browser navigation never selects/rearms a role. The host CLI may restart
the server with another role on the same disposable fixture; old in-memory
sessions are invalidated. Browser cookie Path=/v1/HttpOnly/SameSite remains as M11.

Export startProtocolConsole({runtime,role}) from a new src/console.ts and root;
it loads only three fixed application-owned assets and delegates to that optional
HTTP composition. No arbitrary asset path argument or general filesystem server.
Types expose the additive host configuration; no runtime/financial schema changes.

## Browser behavior

Build console/index.html, app.js and styles.css. Use semantic accessible HTML,
system fonts, dark ink navigation, light neutral content and a restrained green
accent with text statuses. Provide responsive readable cards/tables/forms,
visible keyboard focus, labelled fields and a keyboard-operable review dialog
with focus restoration. No decorative dashboard metrics/placeholder balances.

Initial shell reads public host context, then GET /v1/session to resume an
existing cookie. If none, show host role plus an explicit Connect local session
button; only its click POSTs /console/session. No automatic re-enrollment after
logout/expiry. Show an instruction to ask the host to rearm when the one-use
seat is consumed. CSRF/session/preview/cursor/private evidence remain in volatile
JS memory only. No localStorage/sessionStorage/IndexedDB/URL credentials/logging.

Session role/address/capabilities come from server responses. Render controls
only when advertised by that role; API remains authority. Host context is public
provenance, not an authorization claim. No role picker, wallet/key entry, generic
recipient/calldata/transaction tool or payment/claim creation UI.

Common overview: current summary, token/stake/pool/locks/reservations, coverage
counts and all three solvency booleans. Label values exact **atomic units**;
use decimal strings/BigInt for validation/derived fee ceilings, never Number/
parseFloat for money. Label local EVM chain ID84532 and fixture context without
claiming a live Base Sepolia/native-USDC connection. Show full IDs/addresses in
details/review with readable wrapping and an observed block/hash per data panel.
Separate API reads may have different anchors; do not imply a single combined
head or mix paginated heads. Empty data and unavailable data are distinct.

Provider: own provider/policy, free/locked collateral, payout balance and
cumulative net paid (explicitly event-derived, not profit), coverages/details;
exact allowance, deposit and free-stake withdrawal. Use actual listed primary
provider ID; no arbitrary provider/recipient.

Admin: provider/policy tables/details, immutable registration forms (no edits),
pause/unpause, exact allowance and pool funding as separate controls. Inputs are
the exact M11 operation union and bounds; no unlimited approval shortcut.

Operator: sanitized summary/registries/coverage and a Reconcile original
operations control. Display returned operation status/original transaction/
inclusion. No settlement retry, replacement, arbitrary hash or process control.
Do not claim a journal read endpoint exists: reconciliation loads its results.

Adjudicator: actual ClaimPending rows (status2 plus evidence), scoped explicit
evidence read and decision form. Status labels are Core enum0None/1Active/
2ClaimPending/3Refunded/4Rejected/5Expired; outcomes0Reject/1ProviderFault/2PoolOnly.
Display outcome/refund only when provided for finalized3/4. Evidence bytes are
untrusted: render via textContent (UTF8 replacement or bounded hex), never HTML;
no console logging/download/storage. Clear evidence/reasons on navigation,
logout/session failure and after decision. No inferred/automatic adjudication.

Every write follows form→POST preview→review dialog populated only from the
returned safe ActionPreview→explicit Confirm. Show actor, operation, all review
fields, chain/Core, observed anchor, expiry and fixed gas/maxFee/priority ceiling.
Reason hash is shown, never a fabricated decision commitment. Cancel signs/sends
nothing. Consume the displayed preview before awaiting confirmation and disable
concurrent submission. Stale/expired/denied previews require a fresh review and
approval; never silently recreate/reconfirm. Unknown/failed transport after
confirmation offers only reconciliation of original managed operations, no
resend. Prepared-unsent stranding remains explicit and has no reset control.

Refresh and list pagination use exact M11 routes/cursors. Pages retain their own
anchor; expired/reorged cursors require new first-page loading. A failed read
clears affected displayed values/rows and marks unavailable, with an explicit
retry-read control; never retain stale success as current. Error text uses a
fixed safe mapping/fallback and no backend/private exception. Session failure
clears private data/approvals. Logout uses the existing CSRF-protected route.

## Disposable host and fixture

scripts/console-demo.ts runs `npm run console:demo -- --role <fixed-role>`;
default operator, exact role/flags only before fixture creation. It uses a fresh
local M11 Core/faithful ERC3009 fixture, separate admin and accepted provider/
client paths. Seed one normal purchase and one signed500 with an actual payer
claim/evidence. No direct replacement settlement implementation. Runtime accounts
stay Node-side. Print only public ready URL/role/context and safe status/errors.
No bootstrap/cookies/CSRF/preview/private body/reason/keys are printed.

Test-only fixture support lives in test/console-fixture.ts and named console
tests. Its CLI may accept exact host stdin commands `status`, `role <role>`,
`rpc-off`, `rpc-on`, `expire-preview`, `lose-next-send`, `reveal`, `quit`.
These exist only inside the disposable launcher; no HTTP process/fault endpoint.
Role changes restart only the server on the same fixture/runtime, invalidating
old sessions; no journal deletion or actor regeneration. Expire-preview advances
only its fresh local chain. RPC fault injection never retries a send: loss mode
forwards one original send once, hides that original hash, then reveal permits
read-only recovery. Status reports sanitized actual Core/payer balances/counters.
All new actors/runtime/Anvil state are removed on normal shutdown/signals/error.

## Verification and exit gate

1. Existing pinned typecheck, `node --check console/app.js`, and full protocol
   suite, including preserved M11 tests plus focused static/host-enrollment tests.
   Prove API-only default, exact assets/context, CSP/no-store/no traversal,
   one-use host arm, exact Origin/Host/body, absent browser role authority,
   logout/expiry/no rearm and unchanged original API capability exchange.
2. Actual fresh-EVM fixture seeding/accounting and CLI invalid-flag/cleanup tests.
   No mocks count as financial/browser proof. Sibling SDK/Core sources unchanged;
   prior77test checkpoint stays accepted, no needless unchanged-suite reruns.
3. Primary real browser through supported local CUA preview, not only source/
   model tests: connect/resume/logout; each role's correct views and absence of
   other-role controls; wrong-role forged API denied; anchored/empty/paginated/
   unavailable states; preview/cancel/no send, actual approved admin/provider
   control, stale/expired rejection/fresh review, actual adjudicator evidence/
   explicit refund and payer delta/other locks; unknown original-hash reconcile
   without additional signatures/broadcasts. Host fault commands support these.
4. Inspect desktop and narrow layouts, focus/labels/dialog behavior and browser
   console errors. Save only sanitized overview screenshots without tokens/
   private evidence/reasons and a public-only result report; no HAR/auth traces.
   Native browser tooling is available; no new browser dependency is required.
5. Independent Luna(high) review plus primary source/scope/secret checks, results,
   handoff, checkpoint commit/non-force push. Do not accept if required browser
   journeys cannot be completed; record the exact blocker instead.

M12 does not accept M13 consumer UI, M14 combined presentation, public funds,
production login/hosting/custody, browser-native wallets or the public provider
SDK's separated-admin extension. All old campaign budgets remain consumed.
