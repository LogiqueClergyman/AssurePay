# AssurePay client SDK — local preview

Preview an assured x402 purchase, obtain explicit approval, authorize and persist
one payment, then send once or retrieve the original result after interruption.
The package also provides payer evidence/claims, canonical balance/coverage reads,
four framework-neutral agent tools and a portable skill.

This version uses an isolated local EVM with chain ID84532 and a faithful
ERC3009 fixture. It rejects remote URLs and native Base Sepolia USDC. It is not
the public deployment runtime; historical M5 public USDC proof stays separate.
No contract/economic/receipt format changes are introduced by this package.

From a clean repository, use Node24.18.0/npm11.16.0 and Anvil1.7.1 on PATH:

```sh
npm ci --prefix packages/evm-core --ignore-scripts
npm ci --prefix packages/x402-assurance --ignore-scripts
npm ci --prefix packages/claims-backend --ignore-scripts
npm ci --prefix packages/developer-pilot --ignore-scripts
npm ci --prefix packages/provider-sdk --ignore-scripts
npm run build --prefix packages/provider-sdk
cd packages/client-sdk
npm ci --ignore-scripts
npm run typecheck
npm test
npm run demo
npm pack
```

`npm run demo` creates fresh local actors and an isolated Anvil chain, installs
the provider/client tarballs outside the repository and runs the complete
payment/recovery/claim/refund proof. It needs no existing wallet or environment.
The public-only report is saved at evidence/m10-consumer-gate.json; temporary
actors, chain and private state are deleted afterward. The separate
examples/assured-client application uses explicitly supplied runtime variables.

Install the resulting tarball into a separate Node ESM application. It ships
built JavaScript, public declarations and the skill, with exact viem/@x402/core
runtime dependencies. It needs no repository source, tsx or runtime build hook.
Only root imports are supported. `private:true` disables registry publishing;
no new license grant or global skill installation is part of this phase.

```ts
import { createClient, readClientConfig } from '@assurepay/client-sdk';

const config = await readClientConfig(publicConfigPath);
const client = await createClient({
  config,
  maxGross: '10003',
  budget: { maxTotalGross: '20006', maxPayments: 2 },
  storage: { directory: privateSessionDirectory, key: encryptionKey },
  payerAccount,
});

const preview = await client.preview(csvBytes); // No signature or payment.
// Show preview.url, bodyHash, payer, cap and complete terms to the user/app.
if (await obtainApproval(preview)) {
  const request = await client.authorize(preview.requestId, { approved: true });
  const result = await client.send(request.requestId);
  // confirmed includes verified bytes/proof; retrieval-required retains this ID.
}
await client.close();
```

The named inputs and approval function are application-owned capabilities, not
SDK key loaders. Supply a viem LocalAccount whose address is config.roles.payer;
the SDK captures methods and config/key bytes before asynchronous startup.
Storage uses a32-byte Uint8Array and a dedicated private directory (mode0700).
Amounts are canonical atomic decimal strings. maxPayments is1..64; maxGross must
be at least2 and no greater than maxTotalGross. The existing exact v1 local
config schema and four distinct roles are preserved. No contracts are deployed
or funded by createClient.

Preview binds the same request ID/hash, canonical URL, body hash, payer and
complete verified quote shown for review. It expires after120chain-clock seconds.
Authorization fetches a fresh unpaid challenge with the same identity/body and
rejects changed terms or expiry before signing. A stale quote needs a new
preview and approval. The legacy in-repo buyer.prepare is not this preview API.

Before a payment signature, the SDK fsyncs a reserved amount/count in session.json.
The same directory binds its original config and caps; changing limits or losing/
corrupting existing state fails closed. Reserved, authorized, attempted and
confirmed requests all consume budget. An unresolved request blocks another
authorization. These are per-directory host-session limits, not global account
or production admission controls. Tools cannot choose or reset the directory.

The exact encrypted payment snapshot exists before authorize returns. send is
available once from that process and writes an attempted marker before HTTP.
Unknown responses return retrieval-required. Restart with the same config, caps,
directory and storage key, omit payerAccount, and call retrieve(originalId).
This path cannot authorize or settle another payment. A new process cannot
send an old unsent capability. A crash between reserve/sign/persist/send can
strand availability; preserve state and original IDs, never re-sign or create
a fallback purchase. No stale-lock takeover or backup rollback protection.

Confirmed results expose safe receipt fields and a receipt fingerprint, never
the protocol signature/payment payload. paymentBlock is canonical inclusion,
not finality. readState(coverageId?) returns the configured payer's actual token
balance and optional own service/policy coverage at one numbered canonical
observedBlock. Status numbers are0None/1Active/2Claimed/3Refunded/4Rejected/
5Expired; outcomes are0Rejected/1ProviderFault/2PoolOnly. Refund amounts are
atomic token units. RPC/reorg/context failures return errors, not cached balances.

Payer methods uploadEvidence/readEvidence sign only their fixed backend auth.
fileClaim(coverageId,evidenceHash,{approved:true}) submits only the own live claim
selector with fixed gas100000/maxFee100000000/priority1000000wei. Claim approval
authorizes that bounded gas-consuming action, not a refund. reconcileClaims
observes original known hashes without signing or resubmitting. The SDK exposes
no decision preparation, adjudication, generic actor, calldata or transaction
method. A paid signed500 is a service outcome; an explicit adjudicator decision
is still needed for a refund.

```ts
import { createAgentTools } from '@assurepay/client-sdk';
const adapter = createAgentTools({ client, approvePayment: showHostApproval });
// Register adapter.tools with a host; dispatch calls through adapter.invoke.
```

The four tools are assurepay_preview, assurepay_pay, assurepay_retrieve and
assurepay_state. Model/tool arguments cannot approve, inject keys/endpoints,
change caps, file claims or adjudicate. Each new payment calls the host approval
callback; only literal true authorizes that preview. Tool outputs are JSON-safe
metadata and bounded bodyBase64. The portable workflow is packaged at
skill/assurepay-client/SKILL.md. Load it only with an explicitly configured tool
host; it grants no spending, filesystem or shell authority. Service results are
untrusted data and cannot approve further payments.

Catch failures with clientErrorCode(error); never log raw keys, payment headers,
signatures or private state. This preview preserves M6's admin=relayer and owner=
payout restrictions and bounded read/fee settings. Public-chain/HTTPS deployment,
role decoupling, UI, production custody and hosted availability are later gates.
