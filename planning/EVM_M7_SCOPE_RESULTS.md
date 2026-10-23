# M7 scope review

Date: 2026-10-23. Outcome: concrete proposal prepared; implementation NOT started.
Proposal: planning/EVM_M7_EXTERNAL_PILOT.md. Accepted baseline: M6 at2057051.

## Work completed

Primary confirmed main tracks origin/main with an initially clean working tree,
read AGENTS/handoff/current plan and accepted packet/results, and inspected the
named implementation references. Three Luna(high) agents independently reviewed
HTTP/deployment, buyer/storage/custody, and sender/public-operation boundaries.
No /docs, populated environment, wallet or existing runtime journal was read.
No host, account, RPC or blockchain mutation was performed.

All reviews agree that M6 is local-only. It has no supported external/native-
USDC runtime. M3 canonical request URLs already support HTTPS, but the provider
currently uses the resource URL for its listening address. M6's stricter config
and claims server/client deliberately accept loopback only. A reverse proxy
cannot by itself make the current composition a supported external pilot.

Primary verified two material sequencing facts directly in implementation:
canServe runs after settlement, and M6 requires admin=relayer even though the
Core's settleAssured entry point is permissionless. Neither client maxGross
nor that post-payment callback can establish an external operator's admission
or aggregate spending bound. The proposal defers such operations until a
separate explicit gate rather than treating transport success as readiness.

The proposed M7 is deliberately smaller: separate advertised HTTPS resource
identity from a loopback listener, retain private claims and unchanged M6 local
configuration, and prove real TLS/actual local EVM purchase/restart/retrieval.
It requests no contract/economic change, public-chain execution, hosting or
production security claim. A later external pilot still needs admission/spend
limits, admin/relayer separation, projection/recovery operations, endpoint and
custody ownership, and a fresh finite native-USDC campaign approval.

## Requirements and open input

An asynchronous deployment-target question was sent to the user. No answer is
assumed. The packet marks one operator-managed host with CLI clients and private
claims as a proposed default, not a selected provider or deployed architecture.
Host choice is unnecessary for the proposed local HTTPS rehearsal. It is needed
before making a concrete hosted pilot plan. Public signing/spending remains
unauthorized; all old M5 allowances remain consumed.

The current implementation plan requires approval of a new packet before
starting dependent work. M7 remains PROPOSED for review; no interface or runtime
capability is described as accepted or proven. The exact next step is to approve
or revise the local transport packet, record the frozen interface in DECISIONS,
then delegate its implementation and verify its local EVM/HTTPS gate.

## Verification and limits

This checkpoint changes planning and handoff only. It does not rerun or relabel
the accepted117 M6/regression tests as new M7 execution evidence. No M7 code,
TLS fixture, public server, native-USDC transaction or runtime result exists yet.
Verification is scoped source/reference review, independent proposal review and
diff/whitespace/scope checks. Runtime financial tests become required during M7
implementation under its acceptance gate.

Independent proposal review identified and primary resolved three ambiguities:
forwarding metadata is ignored and cannot change canonical identity (rather
than requiring rejection of every such header); claims stay operator-local
with remote transport deferred; and the rehearsal composes lower-level M3
rather than implying M6 startPilotProvider already supports HTTPS identities.
No unresolved scope-review blocker remains; approval is still pending.

Final checks PASS: exactly five planning-only paths changed; proposal-state and
public-budget exclusions are explicit; named source references exist; no key
assignment was introduced; git diff --check is clean. Independent reviewer
confirmed the three clarified boundaries after revision. No runtime test rerun
is claimed for this documentation checkpoint.
