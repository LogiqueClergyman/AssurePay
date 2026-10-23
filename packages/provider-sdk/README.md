# AssurePay provider SDK — local preview

Add assured x402 payment and durable signed results to a Node byte handler.
The SDK reuses the accepted AssurePay settlement and claims runtime. Business
logic belongs to your service; the CSV example lives separately at
`examples/data-profile-service`.

This version supports an isolated local EVM with chain ID 84532 and a local
ERC3009 fixture token. It rejects native Base Sepolia USDC and remote URLs.
It is not a public-chain deployment package. The historical public USDC proof
remains separate from these local packaging checks.

To build and verify from a clean repository, use Node24.18.0/npm11.16.0 and
Anvil1.7.1 on PATH. Install the accepted runtime/test dependencies from the
repository root first:

```sh
npm ci --prefix packages/evm-core --ignore-scripts
npm ci --prefix packages/x402-assurance --ignore-scripts
npm ci --prefix packages/claims-backend --ignore-scripts
npm ci --prefix packages/developer-pilot --ignore-scripts
cd packages/provider-sdk
```

Then:

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run demo
npm pack
```

Install the resulting tarball into a separate Node ESM application:

```sh
npm install /absolute/path/to/assurepay-provider-sdk-0.1.0.tgz
```

The package includes built JavaScript and declarations, with pinned `viem` and
`@x402/core` runtime dependencies. It needs no TypeScript runtime or repository
source files. Only root imports are supported. `private:true` prevents registry
publication; this phase grants no new license or publishing permission.

```ts
import { createProvider, readProviderConfig, providerErrorCode }
  from '@assurepay/provider-sdk';

// Supply these capabilities from your application's runtime configuration.
// Keep all private keys and storage keys out of source, logs and browser bundles.
const config = await readProviderConfig(publicConfigPath);
const service = await createProvider({
  config,
  storage: { directory: privateStateDirectory, key: encryptionKey },
  receiptSigner: providerReceiptAccount,
  relayerAccount,
  handler: async bytes => profileYourData(bytes),
});

// Drain requests and release exclusive locks during graceful shutdown.
await service.close();
```

The named variables above are application-provided capabilities, not SDK key
loaders. `receiptSigner` needs only `address` and `signTypedData` from a viem
local account. `relayerAccount` is a viem `LocalAccount`. Storage requires a
32-byte `Uint8Array` and a private durable directory. The SDK copies config/key
bytes and captures signing methods before asynchronous initialization. It
returns only `resourceUrl`, `claimsUrl`, `mode` and an idempotent `close()`.
Catch errors and log only `providerErrorCode(error)`, which returns a fixed
allowlisted code or `PROVIDER_OPERATION_FAILED`.

`validateProviderConfig(unknown)` and `readProviderConfig(path)` validate the
exact v1 public schema: `version`, `mode`, `chainId`, `rpcUrl`, `core`, `token`,
`providerId`, `policyId`, `serviceId`, `roles`, `resourceUrl`, `claimsUrl`,
`deploymentBlock` and `gross`. The four role addresses are distinct; amounts
and block numbers are unsigned atomic decimal strings. URLs use explicit
`http://127.0.0.1:<port>` listeners. Config files are bounded to 16 KiB and
symlinks are rejected. The separately deployed Core/provider/policy and funds
must already exist. The SDK neither deploys nor seeds them.

This preview preserves admin=relayer and provider owner=payout, the 100,000,000
wei fee cap, bounded reads and projection horizon (25,000 blocks, 1,000
coverages). It does not implement the planned admin/relayer separation or
advertised HTTPS composition. The local claims listener retains operation-
specific authorization; a navigation role or known URL grants no authority.

For recovery, omit `relayerAccount` and supply the same provider address with
a `signTypedData` function that throws. The resulting `retrieval-only` service
has no transaction wallet/account passed to its engine. Restart using the same
config, storage directory and encryption key. An original client request can
retrieve only its verified archived result with canonical payment proof.
Missing/corrupt state or unavailable RPC fails closed. Recovery never creates
another payment or runs the handler again. New paid calls cannot settle in
this mode.

Keep durable state and its key together. Locks do not take over automatically
after a crash, and backup rollback is not authenticated. Preserve unknown
payment identities and reconcile their original transaction hashes; never
delete journals or create a replacement purchase to recover a response.

The handler returns response bytes. Thrown business errors become a fixed,
paid, signed HTTP 500 after settlement; they do not automatically issue a
refund. Claim submission and an explicit adjudicator decision are separate
protocol actions. Public deployment, production custody, finality and hosted
availability are outside this preview.
