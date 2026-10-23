# M7 local HTTPS transport results

Date: 2026-10-23. ACCEPTED under EVM-042. Implemented under EVM-041 following the user's local-only
selection. Scope: planning/EVM_M7_EXTERNAL_PILOT.md. No hosting, external
endpoint, public RPC, native test-USDC campaign or existing runtime key/journal
was used. Contracts, economics, M6 local config/CLI and claims transport remain
unchanged. M1–M6 and both M5 campaign histories are preserved.

## Delivered behavior

M3 startProvider accepts optional listenUrl. When present, it validates an exact
loopback HTTP origin and a canonical HTTPS resourceUrl before journal access,
binds only to the private origin, and requires the advertised Host and exact
resource path before challenge/payment/handler work. The HTTPS URL remains the
request hash, x402 resource and archive identity. Forwarding metadata is ignored
as an identity source. Omitting the option preserves accepted M3/M6 behavior.

`npm run transport:demo` in packages/developer-pilot composes actual M2 with the
faithful ERC3009 fixture, encrypted durable results, a private HTTP provider,
a separate local HTTPS ingress and fresh buyer processes. TLS material is
fresh, temporary and mode0600. The buyer trusts only that generated certificate
with peer verification enabled. The ingress gets a PATH-only environment and
TLS file paths, without blockchain keys or buyer/provider data keys. Requests
and responses preserve signed bytes/financial headers; duplicate financial
headers remain visible to validation. Framing is reconstructed after bounded
buffering. The ingress is a local rehearsal helper, not a hosted deployment.

Provider restart means close/reopen of the provider instance in the coordinator
process, with a new read-only settlement engine and the same durable state.
The report explicitly records providerProcessRestart:false. Buyer purchase and
retrieval run in distinct OS processes, with no payer signer in retrieval.
M6's unchanged CLI test separately retains provider process-restart coverage.

## Verification and observed state

Primary M3 and developer-pilot typechecks pass. Full suites pass33 M3 and
24 developer-pilot tests (57 total), without failures, skips or cancellations.
Toolchain: Node24.18.0/npm11.16.0, Anvil1.7.1 and LibreSSL3.3.6. No dependency
version changed. The final TLS-only tests also check ingress limits directly.
The required standalone `npm run transport:demo` returned
LOCAL_HTTPS_TRANSPORT_VERIFIED. Its public report is
packages/developer-pilot/evidence/local-transport.json.

The real HTTPS/actual-EVM flow proves:

- Paid200 and retrieved200, with the same canonical HTTPS request hash, request
  ID, coverage, original transaction and exact response hash/bytes.
- Exactly1 payer signature,1 relayer signature,1 broadcast,1 handler and1 receipt
  signature for the purchase. Retrieval uses0 payer signatures and leaves all
  provider counts and the relayer nonce unchanged.
- Wrong Host/path, modified body and malformed payment header are rejected.
  Changing forwarding metadata leaves canonical identity unchanged.
- Missing encrypted archive, missing original payment journal and RPC failure
  cannot settle, sign or execute another handler. Restoring original local state
  recovers the exact original result; no replacement payment is created.
- Canonical receipt/block anchor and transaction sender/Core match. Settlement
  calldata and stored coverage bind the independently recomputed request hash.
- Core62806atomic fixture units = provider stake12029 + pool50777. There is one
  active coverage with locked stake3502 and pool reservation10003, matching the
  actual quote; coverage count1. The temporary chain is discarded afterward.

Focused M3 cases check wrong/duplicate Host, wrong path and invalid listener
config before payment work or journal creation. Local TLS cases check byte/Host
and duplicate financial-header preservation; request/response/header limits;
redirect refusal; wrong CA; and a real certificate name mismatch specifically
requiring ERR_TLS_CERT_ALTNAME_INVALID. Timeouts/child cleanup are bounded.
Full M6 regressions retain paid500, explicit refunds, claims authorization,
role/replay guards, encrypted persistence, journal recovery and financial checks.

Luna(high) agents implemented the listener and TLS helper independently; primary
implemented the actual-EVM/process composition and verified the results. Two
independent reviews found no remaining scoped blocker. Review fixes preserve raw
duplicate headers and one advertised Host, keep certificate-name and HTTP Host
negatives separate, keep TLS verification enabled, and bound shutdown cleanup.

## Limits

This proves local transport composition only. It does not prove an externally
reachable native-USDC service, hosted availability, provider OS-process restart
within this HTTPS rehearsal, arbitrary proxy compatibility, finality or trusted
backup/rollback recovery. It adds no public-mode CLI or public claims exposure.
The local ingress has no production rate/admission policy. M7 does not solve
online admin/relayer coupling, pre-settlement invitation/spending reservations,
long-running projection operations, key rotation or multi-host availability.
Those require explicit future scope; the user's current direction is local-only.
Old M5 public funding/execution allowances remain consumed.

Final full-suite results:33/33 M3 and24/24 developer-pilot, all passing with0
failures/skips/cancellations. The latter includes raw ingress413/431 checks
that prove oversized bodies/headers never reach the upstream. Separate required
transport:demo succeeds. Final whitespace,17-path scope and sensitive-field
checks pass; no populated environment, TLS private key or signed blob is staged.
The ignored dependency symlink and old runtime namespaces remain excluded.
M7's local-only exit condition is met; no dependent phase is active.
