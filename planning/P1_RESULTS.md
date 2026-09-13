# P1 Results — Assurance Core

Status: IN_PROGRESS — Gate A ACCEPTED; Gate B REVIEW; Gates C–F remain NOT_STARTED

## Baseline

- Starting commit: `886a08d2daf808d2e6e6b303afe4cf8a515d6fb2`
- Node/package manager: Node `v24.18.0`, npm `11.16.0`
- AlgoKit/PuyaTs/Algorand TypeScript: `@algorandfoundation/puya-ts 1.3.0`, Puya compiler `5.10.0`, `@algorandfoundation/algorand-typescript 1.3.0`, `@algorandfoundation/algokit-utils 10.0.0-alpha.46`
- Algorand SDK and AlgoKit Utils: `algosdk 3.5.2`; x402 packages remain pinned at `2.24.0` and were not changed
- Target ASA configuration: externally created ASA; Gate A stores only its non-zero uint64 ID and performs application-account opt-in

## Gate A — Contract skeleton and storage

Status: ACCEPTED

- Storage layout and exact byte sizes:
  - ARC-4 fixed tuples are used directly as box values. ARC-4 `bool` is one byte in these structs; all uint fields are uint64. No dynamic fields or speculative fields were added.
  - `ProviderRecord`: `ownerAddress:address, payoutAddress:address, receiptSigningPublicKey:byte[32], active:bool, stakeTotal:uint64, stakeLocked:uint64, openFaultExposure:uint64, createdAt:uint64` — **129 bytes**.
  - `PolicyRecord`: `providerId:byte[32], active:bool, premiumBps:uint64, collateralRatioBps:uint64, maxCoverageAmount:uint64, claimWindowSeconds:uint64, createdAt:uint64` — **73 bytes**.
  - `CoverageRecord`: `providerId:byte[32], policyId:byte[32], payerAddress:address, grossAmount:uint64, providerNetAmount:uint64, premiumAmount:uint64, stakeTopupAmount:uint64, lockedStakeAmount:uint64, requestHash:byte[32], openedAt:uint64, expiresAt:uint64, status:uint64, exposureReleased:bool` — **193 bytes**.
  - `FinalizedClaimRecord`: `coverageId:byte[32], approved:bool, approvedAmount:uint64, providerFault:bool, resolutionCode:uint64, stakeDebit:uint64, poolDebit:uint64, resolvedAt:uint64` — **74 bytes**.
  - Deterministic encoding evidence: `algosdk.ABIType` reports all four layouts as non-dynamic and encodes exactly 129, 73, 193, and 74 bytes; the generated ARC-56 `structs` section matches each field order and type.
  - Box namespaces are stable and non-overlapping: provider `0x70` (`p`), policy `0x6c` (`l`), coverage `0x63` (`c`), claim `0x66` (`f`). Each key is `prefix || byte[32] ID`, so every full key is **33 bytes**.
- Box minimum-balance calculations:
  - Current formula: `BoxFlatMinBalance + BoxByteMinBalance * (key length + value length)` = `2,500 + 400 * (key bytes + value bytes)` microAlgos. The key length is included. Source: [Algorand Box Storage](https://dev.algorand.co/concepts/smart-contracts/storage/box/).
  - One provider: `2,500 + 400 * (33 + 129)` = **67,300 microAlgos**.
  - One policy: `2,500 + 400 * (33 + 73)` = **44,900 microAlgos**.
  - One coverage: `2,500 + 400 * (33 + 193)` = **92,900 microAlgos**.
  - One finalized claim: `2,500 + 400 * (33 + 74)` = **45,300 microAlgos**.
  - Example one-of-each box funding: **250,400 microAlgos**. Later coverage and claim records remain tombstones; no automatic deletion is implemented.
  - These box amounts are distinct from app/global-state/ASA costs: with zero extra pages and global schema `6 uints + 2 byte slices`, creator-side application allocation is `100,000 + (28,500 * 6) + (50,000 * 2)` = **371,000 microAlgos** (flat application term plus global schema). The application account itself has the normal **100,000 microAlgo** base MBR; its ASA holding adds **100,000 microAlgos**, for **200,000 microAlgos** after opt-in. Protocol cost parameters: [Algorand Protocol Parameters](https://dev.algorand.co/concepts/protocol/protocol-parameters/).
- Global state:
  - `admin:address` (creation sender), `adjudicator:address`, `acceptedAssetId:uint64`, `paused:uint64` (`0` initially), `assetOptedIn:uint64` (`0` initially), `totalProviderStake:uint64` (`0` initially), `premiumReserve:uint64` (`0` initially), `totalOpenFaultExposure:uint64` (`0` initially).
  - ARC-32 schema is exactly `num_uints: 6`, `num_byte_slices: 2`; no local state is allocated.
  - ABI reads only: `getConfig() -> (address,address,uint64,uint64,uint64)` and `getAccounting() -> (uint64,uint64,uint64)`. Generated ARC-56 marks both read-only.
- Event signatures:
  - Implemented and ABI-decoded: `ProtocolCreated(uint64,address,address,uint64)` and `ProtocolAssetOptedIn(uint64,uint64)`, both versioned with numeric version `1` and ARC-28 SHA-512/256 four-byte prefixes.
  - Frozen proposed signatures for later gates only; no methods are implemented here: `ProviderRegistered(uint64,byte[32],address,address,byte[32],uint64)`, `ProviderStatusChanged(uint64,byte[32],bool)`, `PolicyCreated(uint64,byte[32],byte[32],uint64,uint64,uint64,uint64,uint64)`, `PolicyStatusChanged(uint64,byte[32],bool)`, `StakeDeposited(uint64,byte[32],uint64,uint64)`, `StakeWithdrawn(uint64,byte[32],uint64,uint64)`, `CoverageOpened(uint64,byte[32],byte[32],byte[32],address,uint64,uint64,uint64,byte[32],uint64,uint64)`, `CoverageClosed(uint64,byte[32],uint64,bool)`, `ClaimFinalized(uint64,byte[32],byte[32],bool,uint64,bool,uint64,uint64)`, `RefundPaid(uint64,byte[32],byte[32],address,uint64)`, `ProtocolPauseChanged(uint64,bool)`.
- Verification:
  - `npm run typecheck:p1` — passed with PuyaTs 1.3.0 / Puya 5.10.0.
  - `npm run build:contract:p1` — passed; generated current ARC-32, ARC-56, TEAL, source maps, and typed client under `contracts/assurance-core/artifacts/`.
  - `npm run test:p1` — **7 passed, 0 failed**. Covers artifact freshness, exact ABI surface, namespace/key widths, compiled record lengths, MBR arithmetic, global schema, event encoding/decoding, and unsafe controls.
  - `npm run localnet:p1` — passed against LocalNet `dockernet-v1`; the script creates a real ASA and apps, proves creation/configuration/accounting reads, successful pooled inner ASA opt-in and holding, non-admin/wrong-asset/rekey/repeated/insufficient-balance rejection, and state atomicity.
  - LocalNet evidence from the final run at round **120**: genesis `dockernet-v1`, ASA **1137**, application **1138**, app address `KHJVMSPD53NFZWLB4IC3SSMXJTR2WV3PFYDEEW2M7CM5WJIYASM5E2ISEE`, creation tx `3UY5SUTDZG3FV54FW5RLR4GIFLV5IIW2ZH242CMVVFVUZ4IZSV3A`, `getConfig` read tx `IWBKR7RMNCG6O37K7FF7MNAD275NLOMTOAF23HIMOB4AYHYZRTLQ`, `getAccounting` read tx `WCL5XDQWHHUY6NNX76FXWC4QMPPL5NYVHRD6BCCCC76AGKSSFYTQ`, opt-in tx `RRDHQYRCSBHTFV33IVMKLCOAGBNB2KUB5M4C3D3BFDDVHS2EIU3Q`, read calls and event decoding passed, and app min balance after opt-in was **200,000 microAlgos**. The proof also created test app **1141** for insufficient application-ALGO atomicity.
- Compiler constraint/deviation: PuyaTs requires `BoxMap` proxies to be direct contract members with literal compile-time prefixes; this is implemented. The AVM rejects explicitly reading zero-address optional inner account fields as unavailable resources, so the opt-in inner transfer leaves `rekeyTo`/`assetCloseTo` implicit (safe zero defaults) while the outer application call explicitly rejects unsafe rekeying. No economic or storage-layout deviation was made.
- Orchestrator review: accepted at commit `cd6f036`. Reproduced `typecheck:p1`, `build:contract:p1`, and all 7 deterministic tests with a clean worktree; reviewed the real LocalNet runner and its evidence against every Gate A exit condition.

## Gate B — Provider, policy, and stake

Status: REVIEW

- Implemented behavior:
  - Added admin-only `setPaused(bool)` with no-op rejection, explicit zero-rekey guard, and `ProtocolPauseChanged(uint64,bool)`, version `1`. Registration, provider status, policy creation/status, and typed stake deposits reject while paused; pausing changes no entity or accounting state.
  - Added provider registration and status/read methods. Provider ownership is derived from `Txn.sender`; records initialize active with zero stake/lock/exposure and confirmed `Global.latestTimestamp`. Registration and status changes emit the frozen provider events. Provider deactivation/reactivation changes only the active byte.
  - Added immutable policy creation and owner-controlled status/read methods. Creation binds the policy to an active provider owned by the caller, enforces `1..10_000` bps and positive maximum/window, and status changes only the active byte.
  - Added `depositStake(byte[32],axfer)void`. The real group profile is exactly `[owner axfer -> application, owner application call]`; the typed `axfer` argument compiles to the preceding group member. It validates group size/order, sender/receiver/ASA/amount, all unsafe asset fields, application rekey, opt-in, provider ownership/status, checked uint64 additions, and actual application ASA balance before writing provider/global stake.
- ABI and events:
  - Gate B methods: `setPaused(bool)void`, `registerProvider(byte[32],address,byte[32])void`, `setProviderStatus(byte[32],bool)void`, `getProvider(byte[32])(address,address,byte[32],bool,uint64,uint64,uint64,uint64)`, `createPolicy(byte[32],byte[32],uint64,uint64,uint64,uint64)void`, `setPolicyStatus(byte[32],bool)void`, `getPolicy(byte[32])(byte[32],bool,uint64,uint64,uint64,uint64,uint64)`, `depositStake(byte[32],axfer)void`, and `getAvailableCapacity(byte[32],byte[32])uint64`.
  - Events are ARC-28 versioned with exact signatures: `ProtocolPauseChanged(uint64,bool)`, `ProviderRegistered(uint64,byte[32],address,address,byte[32],uint64)`, `ProviderStatusChanged(uint64,byte[32],bool)`, `PolicyCreated(uint64,byte[32],byte[32],uint64,uint64,uint64,uint64,uint64)`, `PolicyStatusChanged(uint64,byte[32],bool)`, and `StakeDeposited(uint64,byte[32],uint64,uint64)`.
- Capacity arithmetic:
  - `getAvailableCapacity` requires both fixed box records and exact provider/policy binding, then computes `floor((stakeTotal - stakeLocked) * 10_000 / collateralRatioBps)`.
  - Puya compiles `arc4.Uint64.asBigUint()` arithmetic to AVM v13 `b-`, `b*`, and `b/`; conversion back to uint64 is saturated at `18,446,744,073,709,551,615` before conversion. Deterministic tests cover ratios, floor rounding, locked stake, zero unencumbered stake, invalid locked state, and saturation.
- Box MBR evidence:
  - LocalNet application minimum balance after ASA opt-in was `200,000` microAlgos. After one provider and two policies it was `357,100` microAlgos: provider delta `67,300`, policy deltas `44,900` each. The runner then created a second provider only for the binding-negative test; final observed minimum balance was `424,400` microAlgos. Application balance remained `600,000` microAlgos, explicitly distinguishing balance from minimum balance.
- Negative and rollback evidence:
  - Deterministic suite covers ABI/event shape, zero/duplicate IDs, zero payout/key, bps and positive-term bounds, ownership/status no-ops, fixed box namespaces/references, group validation, unsafe asset fields/rekeys, actual-balance invariant, rollback model, and capacity failures.
  - The real LocalNet runner rejected `48` labeled cases covering non-admin/no-op pause, all paused Gate B mutations, duplicate/zero/invalid/missing-box provider and policy operations, non-owner/inactive status/creation/deposit, wrong group size/order, wrong sender/receiver/ASA/amount, asset sender/close-to/rekey, application rekey, pre-opt-in deposit, provider-policy mismatch, and duplicate group replay. Failed groups left application ALGO/ASA balances, boxes, and accounting unchanged; the successful deposit moved `123` ASA and set both provider and global stake to `123`.
- LocalNet public evidence (final run, genesis `dockernet-v1`, round `343`): ASA `1358`; application `1359`; application address `SNREASBV6GJKOTLB6NLPLVVWAWADWPVP6KI6NI2LNX7ABWZR3KB3RNJ2KU`; second negative-test app `1362`; provider ID `0707070707070707070707070707070707070707070707070707070707070707`; policy IDs `0909090909090909090909090909090909090909090909090909090909090909` and `0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a`.
  - Public transaction IDs: creation `YKBAUSPOCKLN4SLDS2YAVOZJP2VW4YGS2CRZZXGLWJL6NTEW354Q`; config read `DNGFLXHPOR2EKSGSHLIA45XAT26CKFNISTVTXSO3NIB2OQNM6KFA`; accounting read `NR533HXHPYQH4JYADW4IBDD6LH5UMZTSSNXKRIH7LQO4XPBWPCKA`; ASA opt-in `F6Q3FUC55EUWFJYHC5U37CK6FCUXHLHQIBKMOFBOBTUDKP64CRHA`; provider registration `3AR2GBA6NBTGVXGXEKVM3K2VSJXXFYYCI3LBSEELDKRZWU54JBCA`; policy creation `UCQSYV6JLUZBZVZ7LCEXQZCCWTDPPYMQS6GWRXASSKOFLT4JY2DQ` and `D6OWBK7D7ZW43CQLAITLCASF7KFZLV236GPWRJFGN35MAORQGMWA`; pause `3R5Y35FDPJ54O7JURA5334SYH67HPMFXQ3B7Z6EK43GXOO2XYCZA`; unpause `4A7N2W3ME35IZE5QFLEPXWE2JM5Q5RUVAKOF4WCNY4D32ETVDXPQ`; policy status `VS7TXQGJSGJSUUBHSGHRBZMWYWLTUIG4Q3VNXPPEU6XYRVT2X22Q` and `UIVJ45G3ZOOTRACH36SLMNQSZ4AYOPCN7OTFKPN5ZIX47ETU24XA`; provider status `RH2KFQAEIRIWONZJMJUWSCLNCLNGTWKWLNLPBCTAYW7CRVODWAEQ` and `KPGQTVE4BB7YMOLRDC2TF5RA3IQWCKAL6CMIZKCBKBKSVNZH6EPQ`; deposit application call `UALLGHN6WLC4Y3MSOMLFT2B7V3H2WMWHWFQBWESL2MD6XCLKN2RQ`.
- Verification:
  - `npm run typecheck:p1` — passed with PuyaTs `1.3.0` / Puya `5.10.0`.
  - `npm run build:contract:p1` — passed; ARC-32/ARC-56, TEAL, maps, and typed client regenerated.
  - `npm run test:p1` — **13 passed, 0 failed**; deterministic tests require no LocalNet.
  - `npm run localnet:p1` — passed against real LocalNet `dockernet-v1`; all positive, decoded-event/read, negative, rollback, MBR, stake, capacity, and duplicate-replay checks passed.
- Deviations and scope: no compiler/protocol conflict was found. The AVM v13 biguint primitive is used for the required wide arithmetic; no invented global maximum, withdrawal, coverage, Gate C mutation, TestNet runner, backend, SDK, or P0 change was added.

## Gate C — Coverage profile

Status: NOT_STARTED

- P0 profile compatibility:
- Premium arithmetic:
- Group validation and rollback:
- Verification:

## Gate D — Withdrawal, close, claims, and refunds

Status: NOT_STARTED

- Withdrawal safety:
- Exposure release:
- Claim authority and loss waterfall:
- Accounting reconciliation:
- Property/state-machine checks:
- Verification:

## Gate E — LocalNet lifecycle

Status: NOT_STARTED

- Network/genesis:
- ASA/application IDs:
- Public transaction/group IDs:
- Balance and state deltas:
- Intended rejection evidence:
- Accounting reconciliation:
- Command:

## Gate F — TestNet acceptance

Status: NOT_STARTED

- Preflight:
- Network/ASA/application:
- Public transaction/group IDs:
- Balance and state deltas:
- Intended rejection evidence:
- Read-only evidence verification:
- Command:

## Decisions and deviations

- D-011: refined with compiled ARC-4 sizes, one-byte prefixes, 33-byte full keys, and the AVM optional-inner-field constraint above; accepted storage decision unchanged.
- D-012:
- D-013:
- D-014:
- D-015:
- Superseding decisions, if any:

## Remaining work or blockers

- None. Gate A passed; Gate B is not started and is awaiting orchestrator review.
