# M9 — installable local provider SDK and example service

Date:2026-10-23. ACCEPTED under EVM-046; implemented under EVM-045.
Results: planning/EVM_M9_RESULTS.md. User asked to continue the
accepted product roadmap after M8. Local-only scope; no npm publication, public
RPC/campaign, hosting, native-USDC runtime, UI or client-SDK phase.

## Gate and deliverables

Deliver @assurepay/provider-sdk0.1.0 as a private/packable Node ESM package with
built JS and clean declarations; a separate examples/data-profile-service ESM
app importing its root API; docs and an outside-repository consumer acceptance
harness. Pack/install the artifact into a fresh temporary project, typecheck its
public interface and run plain node without tsx, source aliases, symlinks to
workspace runtime code or sibling source files. Against isolated actual M2 and
faithful ERC3009 fixture, prove paid profiling, signed receipt, actual provider
OS-process restart and original-result retrieval with zero new financial work.
Existing M3/M6 buyer is allowed only as M9's temporary test harness, not M10.

## Read/write scope

Read AGENTS.md, SESSION_HANDOFF.md, DECISIONS.md, IMPLEMENTATION_PLAN.md,
planning/EVM_PRODUCT_ROADMAP.md, EVM_M8_PRODUCT_BOUNDARIES.md, EVM_M8_RESULTS.md,
EVM_M6_DEVELOPER_PILOT.md, EVM_M6_RESULTS.md, EVM_M7_EXTERNAL_PILOT.md and
EVM_M7_RESULTS.md (all under planning); packages/{developer-pilot,x402-assurance,
claims-backend,evm-core}/{README.md,package.json,package-lock.json,tsconfig.json,
src,test,contracts,toolchain.json} as applicable; only evm-acceptance/src/
{read-queue,log-chunks,run-lock}.ts; imported M1 faithful fixture; root .gitignore
and LICENSE/README if present; installed pinned dependency source/types.
No /docs, populated environments, wallets or existing runtime journals.

Write packages/provider-sdk/**, examples/data-profile-service/**, this packet,
planning/EVM_M9_RESULTS.md, DECISIONS.md, IMPLEMENTATION_PLAN.md and
SESSION_HANDOFF.md. Existing M1–M8 runtime/contracts/tests/evidence are read-only.
A narrow SDK facade may import accepted internal source at build time; emitted
artifacts must include that runtime closure and no sibling-source dependency.
No edits to financial logic, canonical request/receipt formats or existing CLI.

## Frozen package/API contract

Package name @assurepay/provider-sdk, version0.1.0, private:true (packing/install
allowed; publishing disabled), type:module, engines Node>=24.18.0. Root export
only, dist/index.js and dist/index.d.ts plus package-owned types.d.ts. Files
allowlist dist and README; no source maps/tests/tools/config/secrets/journals or
TLS material in tarball. Exact runtime dependencies viem2.57.7 and @x402/core2.28.0;
no new financial dependency. Existing esbuild0.25.12, TS5.9.3, tsx4.20.6 and
@types/node24.10.1 may be pinned for build/tests only. No registry publishing or
new license grant is part of this local phase.

Build with esbuild (Node ESM) bundling accepted internal runtime, externalizing
Node built-ins/viem/@x402/core. Use explicit public signatures and package-owned
types so declarations need no internal source paths. Typecheck the full closure
with tsc --noEmit, then use pinned TypeScript5.9.3 transpileDeclaration on only
the two explicit public modules. This avoids TS2742 inferred sibling/viem
declaration leakage and adds no declaration bundler; compile the actual packed
declarations in the outside-repository consumer. Package imports have no runtime
build/install hooks. The build must
exclude tests, compiler/fixtures, campaign runners and private runtime files;
pure named M5 runtime helpers are allowed. Build outputs/node_modules/tarballs
are ignored, not committed. Test the actual pack contents, not only source.

Public API (exact names, explicit return types):
- validateProviderConfig(input:unknown):ProviderConfig
- readProviderConfig(path:string):Promise<ProviderConfig>
- createProvider(options:ProviderOptions):Promise<ProviderService>
- providerErrorCode(error:unknown):string (allowlisted uppercase code or fixed
  PROVIDER_OPERATION_FAILED; never raw exceptions/private data)

ProviderConfig is the current exact PilotConfig v1 local/84532 public schema:
rpcUrl, core/token, providerId/policyId/serviceId, roles{relayer,payer,provider,
adjudicator}, resourceUrl/claimsUrl, deploymentBlock/gross atomic strings.
Preserve loopback URLs/native-token rejection, all validation and bounded M6
projection/read/fee settings. This M9 preview deliberately retains M6's
admin=relayer and providerOwner=providerPayout constraints; M11's new role
composition is not implemented or claimed. M7 HTTPS separation stays separate.

ProviderOptions has {config, storage:{directory,key:Uint8Array}, receiptSigner,
relayerAccount?:LocalAccount, handler}. ReceiptSigner is a narrow typed address/
signTypedData capability using viem's public account types. Handler takes/returns
Uint8Array or Promise<Uint8Array>. Capture public config, key bytes and signer
methods before awaits. No raw key strings, environment loading, generic calls,
custom RPC/wallet injection or public runtime switches in this facade.

ProviderService exposes only {resourceUrl,claimsUrl,mode,close()}; mode is
settlement-enabled when relayerAccount is supplied, otherwise retrieval-only.
The latter passes no transaction wallet/account to accepted runtime. New paid
requests cannot settle without a relayer signer; exact original archive/payment
proof is still required. A receipt signer is bound to the provider owner; a
read-only caller may supply a same-address throwing capability to prove it is
never called for retrieval. Existing runtime owns locks/drain/replay/durable
results; expose no internal servers, backend, SDK buyer or adjudicator functions.
createProvider delegates accepted startPilotProvider and its underlying engine,
HTTP, claims/vault logic, with clients created from validated local config.

## Example service contract

examples/data-profile-service is separate plain Node ESM code. It imports only
the SDK root and declared viem account helpers; no internal package paths. It
loads public config and relevant keys from runtime environment (empty example
only), starts/stops through SDK, and has profile/fail/retrieve-only modes to
exercise business success, controlled signed500 and no-sign restart. No secrets
in arguments/stdout. No installation/runtime script deploys or funds contracts.
Document install of a local SDK tarball and the public config prerequisites.

CSV profile v1: strict UTF-8, reject BOM, comma delimiter, LF/CRLF records,
double-quoted fields with doubled-quote escape, quoted commas/newlines allowed;
reject bare CR, quotes inside unquoted fields and non-delimiter characters after
a closing quote. Required first record has nonempty unique exact headers, at
most32 columns and128 UTF-8 bytes/header. At most65536 input bytes,512 data rows,
4096 UTF-8 bytes/field; every row matches header width. A final separator is
allowed; blank records are not silently skipped. Empty/quoted-empty fields are
missing; whitespace is present. Header-only is valid; empty input is invalid.
Output is deterministic UTF-8 JSON {schemaVersion:1,rows,columns,fields:[{name,
present,missing}]} in header order, using integer counts and no timestamps or
external model/network. Throw stable CSV_* codes for parser failures locally;
existing byte-handler transport maps all thrown service errors to a fixed paid,
signed500, not parser-specific4xx or automatic refund. Explicit fail mode is
separate from malformed input and also throws; document these semantics.

## Required verification

1. SDK/example typecheck/build/unit checks. Pack artifact into temporary output;
   verify allowlisted files, no private data and clean runtime/type imports.
   Install with pinned deps in an outside-repo temp consumer, no workspace
   symlinks/NODE_PATH/source aliases/tsx. Compile a positive TypeScript consumer
   and meaningful negative public API cases; plain Node root import works and
   deep imports are blocked. No publication/network endpoint needed.
2. Outside-repo plain Node provider child and separate business handler run on
   actual isolated M2/faithful ERC3009. Existing buyer harness pays once, verifies
   exact profile/body/receipt/canonical transaction and coverage. Assert token
   deltas, stake/pool/locks/reservations and solvency against actual EVM state.
3. Gracefully stop provider OS process, restart same storage/key with no relayer
   signer and a throwing receipt/handler capability; retrieve original request.
   Same bytes/hash/receipt/transaction, no new payer/relayer/receipt signatures,
   broadcasts/handler or relayer nonce; no second send/payment on uncertainty.
4. Negative paid/failure cases include controlled signed500, invalid config or
   signer, lock conflict, missing/corrupt archive and missing payment journal,
   wrong request binding/body and RPC failure. Fail closed, no fallback payment.
   Bounded parser happy/invalid/limits/determinism tests operate independently.
5. Primary reviews all changes; independent Luna cross-review closes blockers.
   Existing runtime source is unchanged; run full M6/pilot regression plus SDK
   checks and separate reproducible npm run demo command. Record exact counts,
   local report and limitations; update handoff, checkpoint commit/nonforce push.

All test/demo role keys are new ephemeral local accounts. Fresh temp data may
be inspected programmatically by tests, never existing private runtime. Keep
all output public metadata; clean temporary chains/accounts/keys/journals after
completion. Local artifact/runtime evidence does not replace M5 public proof or
accept M10 client/agent/UI work. No public campaign allowance is renewed.
