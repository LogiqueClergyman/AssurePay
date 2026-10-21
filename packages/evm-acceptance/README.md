# Combined-stack acceptance campaign

M5 composes the unchanged M2 Core, M3 registered x402 flow and M4 encrypted
results/evidence backend. This is a bounded test campaign, not a production
deployment. The authoritative scope is
[`planning/EVM_M5_PUBLIC_ACCEPTANCE.md`](../../planning/EVM_M5_PUBLIC_ACCEPTANCE.md).

Use Node24.18.0 and the pinned lockfile. Install the existing M1–M4 package
dependencies first; the campaign reuses their compiler and local Anvil helper.

```sh
npm ci
npm run typecheck
npm test
npm run rehearse
```

The rehearsal executes fourteen real transactions on isolated Anvil using the
faithful ERC3009 fixture. It exercises HTTP200 and signed500 responses, exact
repeat/restart retrieval, authenticated encrypted evidence, two explicit refunds
and paused admission rejection. `M5_LOCAL_REHEARSAL_VERIFIED` never substitutes
for native public USDC proof. Temporary accounts and directories are discarded.

Public configuration is loaded through Node's runtime environment handling.
Never display populated configuration files. `setup` creates an exclusive ignored
mode0600 `.env.m5.local` once; preserve the existing file and never regenerate it
to recover a transaction. Existing M1 accounts/vault and completed journals remain
unchanged. The checked-in `.env.example` contains only empty placeholders.

Run these from this package directory:

```sh
node --env-file=../../spikes/evm-m1/.env.local --env-file=.env.m5.local --import tsx scripts/check.ts
node --env-file=../../spikes/evm-m1/.env.local --env-file=.env.m5.local --import tsx scripts/check-signers.ts
```

`check` reads chain/token/domain, balances, fees and funding shortfalls without
creating a signer or journal. `check-signers` derives public addresses from opaque
runtime keys without signing or submitting. Public execution additionally needs
Stage B authorization recorded in the packet. No M1 allowance carries forward.

The funding entry point defaults to a public-only plan and needs no vault key:

```sh
node --env-file=../../spikes/evm-m1/.env.local --env-file=.env.m5.local --import tsx scripts/funding.ts
```

Only after Stage B approval, load the vault runtime file as well and pass the
separate exact funding scope. The CLI pins the managed vault, three role targets
and the reviewed top-up amounts; changed shortfalls stop the operation.

```sh
node --env-file=../../spikes/evm-m1/.env.local --env-file=.env.m5.local --env-file=../../spikes/evm-m1/.env.vault.local --import tsx scripts/funding.ts --execute --scope m5-fund-campaign-roles-once
```

Signer-free funding reconciliation reads only `.local-m5/funding.json` and known
public hashes. It cannot submit unfinished transfers:

```sh
node --env-file=../../spikes/evm-m1/.env.local --env-file=.env.m5.local --import tsx scripts/funding.ts --reconcile
```

Funding measures aggregate fees from canonical vault balance changes, checking
known receipt components and the fixed reserve. Missing receipt components stay
labelled unavailable; estimates remain separate. This assumes no concurrent
vault/account use or incoming funds. Reconciliation checks funding targets before
protocol execution; once protocol roles spend their gas, their current balances
will no longer equal those initial targets.

The protocol campaign is fixed: one new Core/provider/policy, exact23508 USDC
approval,3502 stake and20006 pool donations, two10003-unit purchases, payer
claims,3100 ProviderFault and10003 PoolOnly refunds, pause and a distinct valid
receive intent with an included revert. Total initial allocation43514 atomic
USDC; protocol gas allowance7050000 and auxiliary reserve200000000000000wei.
Maximum campaign plus three funding transfer fees914300000000000wei test ETH.
The L1 reserve is an allowance, not an enforceable transaction-format fee cap.

After authorization and exact funding, the execution entry point is:

```sh
node --env-file=../../spikes/evm-m1/.env.local --env-file=.env.m5.local --import tsx scripts/public-run.ts --execute
```

It requires the exact `M5_PUBLIC_SCOPE` from the template and refuses an existing
nonempty campaign journal. Fixed public identities are persisted under ignored
`.local-m5/campaign.json` before broadcasting; raw signed transactions stay in
memory. HTTP/encryption observations are distinct from independent chain proof.
Public HTTP counters/hashes are fsynced after each repeat/restart check, so a
later verification outage preserves those observations. They contain no receipt
signature or private request/result bytes.

Recovery never signs, broadcasts, changes fees or makes a replacement purchase:

```sh
node --env-file=../../spikes/evm-m1/.env.local --env-file=.env.m5.local --import tsx scripts/reconcile.ts
node --import tsx scripts/verify.ts
```

`verify` needs no wallet environment; optional RPC configuration can be provided
through the process environment. It independently fetches all fourteen known
transactions, canonical anchors, exact calls, financial state and refund facts.
A prepared transaction lost before broadcast remains stranded. An incomplete
campaign cannot produce complete acceptance. Preserve journals and reconcile
unknown hashes before deciding any further action.

Public fee fields are reported only after matching receipt identity; unavailable
fields stay unavailable. Evidence establishes canonical inclusion, not finality,
private HTTP truth, production security or a post-receive rollback: the paused
negative case fails before the token receive call.
