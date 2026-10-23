# M9 provider integration results

Date:2026-10-23. ACCEPTED under EVM-046; implemented under EVM-045. Scope: planning/EVM_M9_PROVIDER_SDK.md. No public transaction/funding,
hosting or registry publication occurred. Existing M1–M8 runtime, contracts,
evidence and private namespaces remain unchanged.

## Delivered behavior

@assurepay/provider-sdk0.1.0 is private/packable Node ESM with four root functions
for validated configuration, provider lifecycle and fixed safe errors. SDK-owned
types describe the narrow signing/storage capabilities. Config/key bytes and
signing methods are captured before asynchronous startup. Retrieval-only mode
passes neither a transaction wallet nor a relayer account into the accepted
runtime. The returned service exposes only URLs, mode and close().

Esbuild bundles the accepted runtime; exact viem2.57.7 and @x402/core2.28.0 stay
external. Whole-closure TypeScript checking precedes declaration emission from
the two explicit public modules. The tarball contains exactly package.json,
README.md, dist/index.js, dist/index.d.ts and dist/types.d.ts. No sibling source,
map, test/compiler, state, key or install hook ships in it. No npm publication.

The separate plain Node example imports only the SDK root, viem account helpers
and Node built-ins. Its profile/fail/retrieve-only modes implement bounded CSV
profiling and graceful close. Tests cover strict UTF-8/BOM, quoting, blank/empty/
whitespace semantics, determinism and byte/row/column/field/header bounds,
including exact limits and multibyte boundaries. Thrown business errors retain
the paid signed500 behavior; no automatic refund. README files document local
tarball installation, prerequisites, environment inputs and recovery limits.

## Primary verification

Node24.18.0/npm11.16.0 and Anvil1.7.1. All complete suites pass without failures,
skips or cancellations:

| Package | Tests | Checks |
|---|---:|---|
| provider-sdk | 7 | Full source/test typecheck and build; API/config/error failures; packed files; external consumer with actual EVM/process/recovery/negative cases |
| data-profile-service | 8 | Syntax build; parser success/failure/determinism and exact byte limits |
| developer-pilot | 24 | Full accepted local EVM/HTTP/CLI, claims, refund, restart, TLS and sandbox regression; typecheck |

These suites contain39tests. Parent independently installed the actual tarball
into a new outside-repository project with pinned TypeScript/Node types, copied
the real example, and passed syntax build, checkJs,8parser tests, plain Node root
import and ERR_PACKAGE_PATH_NOT_EXPORTED deep-import rejection. The installed
real path stays in the temporary project; comparisons normalize macOS /var
aliases. Temporary files were deleted.

The SDK suite separately packs/installs into a fresh consumer with no workspace
runtime symlinks/source aliases. Positive public TypeScript usage compiles;
raw storage key strings and custom client injection fail expected type checks.
The copied example runs in its own plain Node process with a restricted
environment, without tsx or payer/adjudicator keys. Only the test coordinator
uses the accepted in-repo buyer/fixture harness.

Actual isolated M2/faithful ERC3009 execution proves:

- One profile purchase has1payer authorization and1settlement broadcast. The coordinator loses
  the paid response deliberately, refuses a second paid send, closes the
  provider process and restarts the same storage without either signer key.
  Exact body/status/transaction and receipt fingerprint return. Retrieval adds
  0payer signatures and leaves relayer nonce/broadcast count unchanged. Receipt
  and handler capabilities throw if used in retrieval mode.
- Independent request hashing, decoded settlement calldata, Core hashIntent,
  CoverageOpened event, stored coverage, receipt/block identity and final
  numbered-head canonicality bind the original payment. Financial reads share
  one numbered observation block.
- At the first profile snapshot, actual payer debit10003, provider credit7197
  and Core increase2806atomic fixture units match balances129997/7197/62806.
  Core62806 = provider stake12029 + pool50777; locked3502, reserved10003 and
  active/count1. Reservation/stake bounds pass.
- A valid new paid request is refused in retrieval-only mode. Altered retrieval
  bytes, copied buyer state under a different binding, unavailable transaction
  RPC reads, missing/corrupt encrypted archive and missing original payment
  journal fail closed with no added broadcast. Concurrent startup fails on its
  lifetime lock while the original provider remains usable.
- A separate explicit fail-mode purchase returns verified paid signed500 and
  opens the second coverage. There are exactly2broadcasts across these two
  intentional settlements. The refused fresh request has one payer authorization
  but no settlement; total payer authorizations are3. It is not a recovery
  payment for the interrupted original request.

The separate primary npm run demo PASS returned LOCAL_PROVIDER_SDK_VERIFIED.
Artifact: packages/provider-sdk/evidence/m9-consumer-gate.json. firstProfileSnapshot is
distinguished from the later two-coverage state. Temporary chains, key material
and consumer state are deleted. Provider OS-process restart is true;
buyerProcessRestart is false (new buyer instance in the same coordinator).

Luna(high) agents implemented packaging, example and external consumer. Primary
and independent review closed BOM decoding, error-message capture, declaration
closure, transaction/receipt comparisons, financial expectations, binding
fixtures and counter/report defects. Reviewers found no remaining scoped blocker.
Unchanged M3–M5 standalone suites were not rerun; the required full pilot
regression passes. Earlier public evidence remains historical.

## Limits and next phase

Local Node preview only: no native-USDC/public operation, hosted availability,
finality or production custody. Preserve M6's admin=relayer/owner=payout, loopback
URLs, fee bounds and projection horizon. M7's HTTPS composition remains separate.
Trusted RPC/storage/key custody, no rollback protection and no stale-lock
takeover remain explicit. No public campaign authority is renewed.

Final scope, whitespace, pinned-lock and public-artifact/secret checks pass.
M10 has not started. Freeze its client package, unsigned preview/explicit
approval/signing boundary, payer-scoped claims/status, framework-neutral agent
adapter and portable skill in a detailed packet before implementation. Later
protocol API/console and consumer UI remain ordered roadmap phases.
