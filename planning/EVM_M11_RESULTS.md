# M11 protocol API results

Date:2026-10-25. ACCEPTED under EVM-050, implemented under EVM-049. Local-only.

## Delivered scope

New private `packages/protocol-app` implements the application backend for M12's
console. Its summary/provider/policy/coverage reads share a numbered canonical
anchor and bounded indexes, verify registry mappings and policy hashes, sanitize
private fields and reject unavailable/reorged/over-limit state. Pagination binds
one expiring snapshot to its session and rechecks its original anchor.

Host-issued one-use bootstrap capabilities establish actor sessions. The HTTP
boundary enforces Host/Origin/Fetch Metadata, cookies, CSRF, bounded unique-key
JSON, fixed routes and safe errors. Session role grants only its fixed controls;
browser input cannot select an actor, target, arbitrary calldata or transaction
hash. A session can confirm only its own one-use preview. Preview does not sign;
confirmation revalidates canonical context, state, expiry and exact operation.

Admin controls cover immutable registrations, pause and pool funding. Primary
provider controls cover stake deposit/free-stake withdrawal. Exact bounded token
allowances are separately confirmed. Adjudicator controls cover authorized
evidence access and explicit decisions through the existing private backend.
Operator reconciliation uses only managed original hashes without signing.
Actor amount/count limits and fixed gas/fee ceilings bind durable storage.

The narrow internal M6 `expectedAdmin` seam permits a new composition with a
distinct admin while preserving the legacy default. The online provider receives
the relayer account, never the admin account. Existing SDK schemas/contracts/
economics/receipt formats and all public campaign state remain unchanged. The
public provider SDK's separated-admin composition still requires a future scoped
extension; M11 proves the internal product composition only.

## Actual local execution

Primary standalone `npm run demo` PASS. The report is
`packages/protocol-app/evidence/m11-protocol-gate.json`. The scenario creates only
fresh local actors, a local Core and faithful ERC3009 fixture. It executes every
fixed operation kind, including registration with an owner/payout difference,
exact approvals, collateral movements and pause/unpause. The relayer's attempted
admin call fails in actual Core simulation.

Three explicitly approved client purchases produce one200 and two signed500
results. The payer uploads/reads evidence and files two claims through the
accepted client SDK. Admin/provider/operator evidence reads are denied; the
adjudicator reads the filed evidence and explicitly rejects one claim and
refunds10003atomic units on the other via PoolOnly. No automatic decision or
evidence-truth inference is made.

A proxy forwards that refund's original transaction, drops its response and
hides only its original transaction/receipt. The API durably reports unknown.
After API/runtime restart without protocol signing accounts, operator
reconciliation proves the original inclusion with unchanged send/sign counters.
Separate key-free buyer/provider restart retrieves the same original successful
result/body/receipt/transaction, with no second payment or handler execution.
Pagination retains its original anchor across an unrelated new block.

Exactly16 broadcasts:6admin,3provider,2adjudicator,2payer claims and3relayer
settlements. Payment authorizations3 and handler executions3. Recovery changes
none of these counters. These counters exclude fixture deployment/seeding.

| Final fixture observation | Atomic units/count |
|---|---:|
| Core token assets | 72415 |
| Provider stake | 20087 |
| Pool assets | 52328 |
| Locked stake | 3502 |
| Reserved pool | 10003 |
| Active / total coverages | 1 / 3 |
| Payer token balance | 119994 |
| Primary provider payout balance | 117591 |
| Admin token balance | 90000 |

Core72415 = stake20087 + pool52328. Other coverage remains active with its
3502stake lock and10003pool reservation protected. Exact equality and all
solvency inequalities are checked after every scenario control; direct token
donations in general require balance>=accounted assets, not unconditional
equality. Coverage statuses are Active, Refunded and Rejected; two provider and
two policy registrations are visible. Balances are not profit metrics.

## Verification

Final complete protocol typecheck and21tests PASS. Required sibling regressions
are complete: pilot26/provider SDK7/client SDK23 tests PASS, no failures/skips;
all three typechecks pass and both SDK builds run through their suites. Packed
outside-repository SDK checks remain included in those regression tests.
Across the four final suites77tests pass, with no failures/cancellations/skips.
Primary earlier runtime/integration3/3 and standalone complete demo PASS. Final
full suite includes the corrected new test-wallet fixture and strengthened
zero-sign/send action-count-cap assertion; no incomplete earlier run is accepted.

Failure coverage includes every operation-family wrong-role denial, missing/
false approval, stale/expired/replayed/concurrent confirmations, preview/action/
amount caps, insufficient free stake and immutable registration state. HTTP
tests cover one-use/expired host capabilities, session/cursor expiry, session-
bound previews and cursors, private output omission, duplicate Host/JSON names,
UTF8, body/media bounds, forwarded identity, Origin/CSRF/Fetch Metadata and close.

Sender tests execute an included token-transfer revert, verify unchanged Core/
provider accounting and recover the same hash without a signer or second send.
They also test substituted receipts, durable success-to-unknown demotion on RPC
failure, original-hash recovery, live journal tamper, missing/corrupt/context-
changed state, exclusive locks and pre-broadcast interruption stranding.

Read negatives cover wrong chain/admin, missing coverage events versus actual
state count, malformed registry chunk bounds, a101-entry registry response,
unavailable RPC, invalid anchors, symlinks and scan limits. Malicious/over-limit
RPC wrappers test rejection paths; the25000-block limit test uses a synthetic
future head over an actual fixture. It is not a mined25001-block financial proof.
Positive reads and all financial effects use actual EVM contract execution.

Two Luna(high) independent final reviews find no remaining scoped blocker.
Earlier findings closed empty-journal persistence, live disk checks, strict
role/target/cap records, terminal-recheck guards, receipt/emitter/context checks,
canonical simulation anchors, registry chunks, session-bound confirmations,
sanitized reviews and status5 handling. Mutable block-end counters are not
treated as a transaction-index snapshot. Primary report accounting/counter/
sensitive-field/lock metadata checks and `git diff --check` PASS.

## Limits and next gate

This accepts no public native-USDC campaign, hosting, finality, production login,
browser wallet, global spending budget or authenticated backup rollback. Trusted
local RPC/storage/custody and RPC completeness for unreferenced registry events
remain assumptions. M4 encrypts private content; protocol journals hold public
metadata/commitments and the app key is a configuration fingerprint only.

Reserved/prepared-unsent operations can strand the actor after interruption.
They remain blocked rather than being reset or resent. This intentional local
fail-closed liveness limit is documented and tested; no abandon/reset operation
is claimed. Existing M5 allowances remain consumed and its paused Core is untouched.

Temporary chains, fresh private actors and runtime state are cleaned up. No
existing wallet or populated environment was read. No `/docs` access. M12's
console requires a new self-contained packet after M11 acceptance, including
secure local browser provisioning and explicit approval presentation. M13's
consumer app and M14 presentation remain separate dependent gates.
