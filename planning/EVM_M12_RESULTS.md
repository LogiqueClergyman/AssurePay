# M12 protocol console — verification checkpoint

Date:2026-10-25. IN_PROGRESS under EVM-051. M12 is **not accepted**. Implementation
is complete; one required browser financial journey is pending user handoff.
Public-only machine report: packages/protocol-app/evidence/m12-console-gate.json.

## Implementation and checks

Buildless same-origin console in packages/protocol-app/console, fixed asset
loader, additive HTTP host options and one host-armed local enrollment. Existing
M11 session/CSRF/capability and fixed financial schemas remain authoritative.
Provider/admin/operator/adjudicator views show exact atomic values and individual
canonical anchors. Private content stays in volatile safe DOM text. Explicit
unsigned reviews precede writes; unresolved work locks controls and offers only
original-hash reconciliation. The disposable CLI owns fault/role controls; there
are no HTTP process controls, new dependencies or SDK/Core changes.

Primary full protocol suite:29/29 PASS, zero failures/skips/cancellations
(21 preserved M11 tests,5console HTTP and3actual-EVM fixture tests). Typecheck and
console syntax pass, including the final human-readable outcome label change.
Fixtures prove actual seeding, claim filing, role restart on unchanged state,
one forwarded original transaction and read-only recovery without another send.
HTTP tests cover exact captured assets/headers/context, one-use host arm, invalid
requests preserving the arm, concurrent enrollment, cookie resume, logout/no
rearm, expiry and unchanged API-only/bootstrap behavior. These HTTP unit tests
are not financial proof. Prior SDK/Core gates remain accepted and unchanged.

Independent Luna(high) source reviews found no remaining material scoped blocker.
Primary reviews corrected async private-response restoration, stale read races,
unknown reconciliation locks, focus restoration, disabled-form timing and clear
outcome labels before this checkpoint. No /docs or populated environment access.

## Actual browser evidence

Primary used native CUA with a temporary Chrome Guest window. No browser connector
was enabled. Desktop and375px layouts were visually reviewed; dialog focus,
Escape/cancel and focus restoration passed. No unexpected JavaScript exception
was observed. Native tool captures were reviewed; no repository PNG is claimed.

An initial read-only rehearsal proved one-row pagination across two coverages at
the same anchor, unavailable RPC clearing all displayed panels, host-role views,
logout/no automatic rearm and natural session expiry clearing authority. That
fixture closed cleanly with only3seed broadcasts and zero console writes.

A second fresh fixture remains live for the required final refund check:
Core0x7dcab24bfcc90faead435662fcb76eeb3911decd; locally deployed ERC3009 mock
token0xe6951e672e169359027e97e4d08f50d1eb7ec234. Chain ID84532 identifies the
local fixture configuration, not a public Base Sepolia connection. Source starts
an unforked127.0.0.1 Anvil, generates disposable actors and mints test units. No
existing wallet, public RPC, real USDC or public transaction was used.

Confirmed journeys on that second fixture:

- Admin expired approval rejects with no signature/broadcast. Fresh exact1000
  allowance and separate1000pool funding succeed, followed by pause/unpause.
  Reload resumes the same cookie. Four admin transactions total.
- Provider sees only its controls. A real browser forged admin preview returns
  403. Withdrawal100 cancels via Escape with no send and restores focus; a new
  explicit review/confirmation withdraws100successfully.
- A second explicit100withdrawal forwards once, loses its response and hides its
  original receipt. UI shows unknown and locks financial controls. Reload plus
  manual reconciliation retains that lock. Host reveal and operator reconciliation
  recover transaction0x5dc0bcb2d5d1737cc0e0e2a9e9b96d17c46f7bdb454983478ee8e6da3b87e67b
  as success without another signature, broadcast, payment or handler.
- Adjudicator reads scoped evidence and prepares an explicit Pool only(2),10003
  refund review. It shows the real actor/Core, frozen anchor, reason hash, fixed
  gas/fee limits and deferred decision commitment. An earlier unsigned preview
  was canceled; no adjudicator transaction has been sent.

Latest actual block28, hash
0x894a8ed7475c1929db415e6af0266b177596d4d95b61967dcc6b1ad43e657fd1:
Core66412=stake13858+pool52554; locked7004/reserved20006; active/count2/2;
payer119994atomic test units. All three solvency booleans true. Exactly9broadcasts:
2relayer settlements,1payer claim,4admin controls,2provider withdrawals.
Two payer payment authorizations,2provider receipts,2service handlers,1claim,
zero adjudicator transactions. Same counters before/after recovery.

## Pending gate and exact continuation

Automatic approval review rejected clicking Confirm action on the final refund,
classifying it under the browser financial-action handoff rule. The rejection
persisted after source evidence established the isolated localhost mock-token
fixture. No workaround or alternate sender was used. The user must perform that
final browser click; generic approval does not replace the required handoff.

The existing Chrome Guest review at http://127.0.0.1:58440 remains open. Current
host is adjudicator. After the user confirms, inspect its actual result, read the
host status and verify payer delta10003, Core56409=stake13858+pool42551, remaining
lock3502/reserved10003, active/count1/2 and10broadcasts/adjudicator1. These are
**expected values, not proven results**. If the preview/session expired, require
a fresh explicit review; never infer failure from timeout or resend an unknown
transaction. Verify private evidence/reason clearing after decision/navigation/
logout, capture a sanitized final overview, then quit the fixture for cleanup.

Only after those checks pass may M12 be accepted and M13 implementation start.
M13 still needs a self-contained packet addressing the public provider SDK's
admin=relayer composition constraint. M14 rehearsal remains later. Existing M5
budgets are consumed; no public funding, hosting, publication or finality claim.

## 2026-10-26 user-reported failure recovery

User reported the generic operation-failed/reconcile message after handoff.
Primary host status remained at block28 with9broadcasts/adjudicator0 and unchanged
payer/Core balances. The owned Guest window still had an old unsigned review;
it was canceled without confirmation. A read-only reconcile request proved the
old session had expired and cleared browser authority/private content.

Trusted host restarted only the adjudicator console on the SAME runtime/chain,
then primary connected a fresh seat and explicitly reconciled. API/UI returned
no managed adjudicator operations; no operation was resent or replaced. A fresh
unsigned Pool only(2)/10003review is ready from the still-pending claim. The exact cause
of the user's generic message was not captured; session expiry is directly
observed, not an inferred included transaction failure. All previous transactions
and balances remain preserved. Final confirmation still requires user handoff.
