# M8 product-boundary results

Date:2026-10-23. ACCEPTED under EVM-044; definition phase under EVM-043; runtime implementation of the
new product phases has not started. Baseline main atf97e10f was initially clean.

## Delivered contract

planning/EVM_PRODUCT_ROADMAP.md defines provider integration, client integration,
one framework-neutral agent adapter plus portable SKILL.md, a role-specific
protocol API/console, and a separate consumer application. It sequences M9–M14
with explicit gates: independently installed SDK artifacts, actual local EVM
consumer checks, consent and recovery behavior, anchored read models, constrained
role actions, browser journeys and a repeatable presentation. Later roadmap rows
are implementation intentions, not acceptance evidence.

The first SDK runtime is Node. Browser applications use a local backend, with
no keys in UI/tool responses or claim of browser-native wallet/storage support.
Role signatures target local Node actor adapters; M11 must freeze explicit
actor/session/consent/CSRF/secret boundaries before browser-controlled writes.
The agent/skill wraps the client SDK and cannot create a second payment engine,
bypass per-payment approval, send arbitrary calldata or adjudicate a refund.

The consumer app handles buyer purchase/evidence/claim/retrieval via documented
client exports. Refund adjudication occurs in the separate protocol console;
the consumer reads the actual outcome. This preserves both application separation
and the full buyer-to-refund demonstration. SDK packaging is tested via local
artifacts; registry publishing, hosting and new public campaigns are excluded.

## Source evidence and review

Primary and three Luna(high) agents inspected only the named checked-in source.
Findings agreed:

- developer-pilot is private, has no build/exports/types surface and imports
  sibling source; current functions are reusable internally, not standalone SDKs.
- buyer.prepare already signs, so a future unsigned preview/approval split is
  required rather than calling current prepare a preview.
- Existing HTTP status exposes one known coverage. Dashboard lists, summaries,
  provider/policy/financial read DTOs and extra controls do not exist yet.
- Current action sender permits fileClaim/finalizeClaim only. Core has specific
  admin, adjudicator, payer and provider-owner authority, with no operator role.
- Current M6 checkPilot couples admin to relayer; a new composition must prove
  separate actors before a UI represents them as separate authorities.
- Dashboard solvency uses the Core >= invariant, with anchored provenance and
  explicit unavailable states; no fictional yields, health or private evidence.

Review clarified actual skill deliverables, where local role signatures occur,
positive stake deposits for existing providers, the new composition boundary,
and the separate consumer/console handoff for adjudication, and M10 anchored coverage/outcome/
payer-balance reads needed by M13. No contradictory
requirement remains in the definition scope. Detailed API signatures/build tools
and per-phase allowed paths remain for each respective implementation packet.

## Verification and next action

M8 is documentation/definition only. No dependencies, contracts, runtime code,
existing environments/private journals, chain state, npm registry or hosted
application changed. No runtime tests were required or relabelled as M8 proof.
Verification is source-grounded role/interface review, named-reference checks,
roadmap/phase/status consistency and git diff --check.

Exact next action: freeze the self-contained M9 provider-integration packet
within this accepted local roadmap, then implement/verify a packed provider SDK
and separate example service through its external-consumer gate. One phase at
a time; M10–M14 remain planned. M1–M7 proof and consumed M5 public scopes remain
unchanged. Local UI is explicitly in product scope; production custody/hosting,
public publishing, multiple chains/assets and subjective adjudication are not.

Final definition checks PASS: exactly six allowed documentation paths changed,
named implementation references exist, M8 is accepted with M9–M14 only planned,
client/demo dependencies and required skill artifacts are explicit, no key
assignment was introduced, and git diff --check is clean.
