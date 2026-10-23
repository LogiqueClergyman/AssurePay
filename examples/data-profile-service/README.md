# AssurePay data profile service example

This plain Node ESM service demonstrates the public `@assurepay/provider-sdk`
API with a deterministic CSV profile handler. It does not deploy, fund, or
configure contracts. Use it only with a local configuration and runtime
credentials prepared for the M9 local acceptance fixture.

## Install the local SDK artifact

Build and pack the SDK in the repository first. Then install the resulting
tarball here; no registry is required:

```sh
cd examples/data-profile-service
npm install --no-save --package-lock=false /absolute/path/to/assurepay-provider-sdk-0.1.0.tgz
```

Provide an `ASSUREPAY_CONFIG` JSON file that passes `validateProviderConfig`
and describes the isolated local EVM endpoints: chain id 84532, local RPC,
deployed core/token/provider/policy/service identifiers, the four distinct
configured roles, loopback resource and claims URLs, deployment block, and
atomic gross amount. The SDK validates this schema and the example reads it
through `readProviderConfig`.

Copy `.env.example` into your shell environment manually (the service does not
load dotenv files). Set `ASSUREPAY_CONFIG`, `ASSUREPAY_STORAGE_DIRECTORY`, and
`ASSUREPAY_STORAGE_KEY` in every mode. The storage key is exactly 64 hex
characters (32 bytes), without a prefix. In `profile` and `fail` modes, also set
`ASSUREPAY_PROVIDER_PRIVATE_KEY` and `ASSUREPAY_RELAYER_PRIVATE_KEY` to keys
whose addresses match the configured provider and relayer. Never put keys in
arguments or commit them.

Start the service with:

```sh
npm start
```

`npm run build` checks the plain JavaScript syntax; there is no transpilation
or runtime build hook. `npm run typecheck` checks the JavaScript against the
installed SDK declarations, and `npm test` runs the independent parser suite.
The repository's `packages/provider-sdk` command `npm run demo` creates a fresh
local chain and installs a packed SDK into a separate temporary project to run
this service through a paid purchase and restart/retrieval journey.

The only startup output is JSON containing the public resource URL, claims URL,
and SDK mode. SIGTERM and SIGINT drain and close the provider service.

## Modes and CSV behavior

`ASSUREPAY_MODE=profile` (the default) returns deterministic UTF-8 JSON with
schema version, row and column counts, and each header's present/missing cell
counts. The handler accepts strict UTF-8 CSV up to 65,536 bytes, rejects a BOM,
supports comma-delimited LF/CRLF records and doubled quotes, and allows quoted
commas/newlines. Headers are nonempty and unique; the limits are 32 columns,
128 UTF-8 bytes per header, 512 data rows, and 4,096 UTF-8 bytes per field.
Every data row must have the header width. Empty cells count as missing;
whitespace-only cells count as present. A blank line is parsed as one empty
field, so it counts as a missing row in a one-column file and fails width
validation for a wider header. A header-only file is valid.

For example, the raw request bytes:

```csv
name,age
Ada,37
Lin,
```

produce:

```json
{"schemaVersion":1,"rows":2,"columns":2,"fields":[{"name":"name","present":2,"missing":0},{"name":"age","present":1,"missing":1}]}
```

Paid requests use the protocol's `application/octet-stream` byte contract;
ordinary unauthenticated HTTP requests receive the payment challenge. The
business handler owns only the CSV-to-JSON transformation.

`ASSUREPAY_MODE=fail` uses the same signing and settlement configuration but
intentionally throws from the business handler. It exercises the existing
fixed, signed HTTP 500 behavior.

`ASSUREPAY_MODE=retrieve-only` omits both private signer keys. It supplies a
same-address receipt capability that throws if called and a handler that throws
if called; the SDK starts without a relayer signer so only existing original
results can be retrieved. It still needs the encrypted storage key and the
matching persisted provider directory.

Malformed CSV throws a stable local `CSV_*` error. The paid byte-handler
transport maps handler errors to its fixed signed HTTP 500 response; it does
not send parser details as a 4xx response and does not automatically refund a
payment. This is distinct from the explicit `fail` mode. The service makes no
model or external-network calls.
