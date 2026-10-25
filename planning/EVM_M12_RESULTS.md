# M12 protocol console — accepted local gate

Accepted2026-10-26 under EVM-052; implemented under EVM-051. All required local
checks pass. Final refund confirmation was performed by the user; primary then
verified the original transaction, payer delta, other coverage locks, private
clearing, read-only reconciliation and cleanup. Public-only machine report:
packages/protocol-app/evidence/m12-console-gate.json.

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

A second fresh fixture completed the final refund check and is now closed:
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
  was canceled without a send. A later fresh review was confirmed by the user,
  with the actual result recorded below.

Pre-refund actual block28, hash
0x894a8ed7475c1929db415e6af0266b177596d4d95b61967dcc6b1ad43e657fd1:
Core66412=stake13858+pool52554; locked7004/reserved20006; active/count2/2;
payer119994atomic test units. All three solvency booleans true. Exactly9broadcasts:
2relayer settlements,1payer claim,4admin controls,2provider withdrawals.
Two payer payment authorizations,2provider receipts,2service handlers,1claim,
zero adjudicator transactions. Same counters before/after recovery.

## User handoff, confirmed refund and final state

Automatic approval review required user handoff for the final Confirm action,
even after source proof of the isolated mock-token Anvil. No alternate sender or
workaround was used. On2026-10-26 the user first reported the generic operation-
failed message. Host status showed block28/broadcasts9/adjudicator0; primary
canceled the owned Guest's old unsigned review. Read-only reconciliation directly
proved its30-minute session had expired. The exact cause of the user's generic
message was not captured; it was not treated as an included transaction failure.

Host restarted only the adjudicator console on the same runtime/chain. Fresh
session reconciliation returned no adjudicator operations; no resend/replacement.
Primary prepared a fresh explicit Pool only(2)/10003review and the user clicked
Confirm action. Browser returned finalizeClaim SUCCESS with original transaction
0xfbcb21c9640ac13947141fa5603048644d5e1026f83187c0791c33cf430474fe,
operation0xa9713363461b8ab2b79d95080a7ce3033ed0a159b2a2491ee7c1490d0476c4da,
included at block29/hash
0x00149e095c8f7ae0db0fbfba3a6cebd1a36b80fa5be1f7d952025a3eae72ff57.

Primary host status independently proved Core56409=stake13858+pool42551,
locks3502/reserved10003, active/count1/2 and payer129997, up exactly10003from
119994. Other coverage remains Active; claimed coverage shows Refunded. All three
solvency booleans remain true. Exactly10broadcasts, adjudicatorTransactions1;
all other counters unchanged from the pre-refund snapshot. No second payment,
provider receipt or service handler occurred.

Browser decision form/reason/evidence were absent after success. Navigation kept
private content cleared. Explicit original-operation reconciliation returned the
same refund SUCCESS, and a later host status proved unchanged block/balances/
counters. Logout cleared authority/private fields and left enrollment disabled.
Sanitized final overview image was captured/reviewed and retained in the native
CUA tool result. Documented CUA APIs do not expose repository PNG export; no PNG
file is claimed. Earlier desktop/375px captures were also visually reviewed.

Normal host quit exited0, cleaning the temporary chain, fresh actors and private
runtime state. Only the owned Guest console tab was closed. Independent Luna(high)
review found no remaining scoped protocol/security blocker; primary closed its
remaining evidence/cleanup checklist. Final typecheck, console syntax, report
privacy/accounting and whitespace checks pass. Source is unchanged from29/29tests.

## Limits and next phase

This accepts local console evidence only: no public native-USDC/finality,
production authentication/custody, hosting or publication. Existing M5budgets
remain consumed and historical paused Cores/wallets stay untouched. Trusted local
machine/RPC/storage remain assumptions; pre-broadcast stranding stays fail closed.

M13 requires a self-contained consumer-app packet before dependent code, including
the public provider SDK's current admin=relayer composition constraint. Preserve
public client/agent approval and one-send recovery rather than adding another
payment path. M14 unified launch/rehearsal/presentation remains a later gate.
