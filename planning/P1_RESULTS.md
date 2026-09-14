# P1 Results — Assurance Core

Status: IN_PROGRESS — Gates A–C ACCEPTED; Gate D REVIEW; Gates E–F remain NOT_STARTED

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

Status: ACCEPTED

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
- Orchestrator review: accepted at commit `d0582fa`. Reproduced `typecheck:p1`, `build:contract:p1`, all 13 deterministic tests, and a fresh real LocalNet run. The review run passed at round `370` with ASA `1387`, app `1388`, application address `7V26SPQYZI2IJBT2K6ZZ62S4LLHVRZ4TDRDFBCQHQNPT6SRDMTUKNF4PMY`, observed one-provider/two-policy MBR `357,100`, stake `123`, capacities `492`/`164`, and all `48` intended rejected cases. No contract blocker or scope leak was found.

## Gate C — Coverage profile

Status: ACCEPTED

- P0 profile compatibility: Implemented production `assurance-core-v1` over the accepted `assured-exact` x402 v2 group: index 0 payer -> stored provider payout / accepted ASA / providerNet; index 1 same payer -> application / accepted ASA / premium; index 2 same payer `NoOp` application call. The application ABI is exactly `openCoverage(byte[32],byte[32],byte[32],byte[32],uint64)void`; `getCoverage(byte[32])` is read-only and returns the complete 193-byte `CoverageRecord`. The adapter registers the scheme with real `x402Facilitator().register(...)`, verifies all three single signatures and the recomputed group ID, binds every metadata and ABI argument, simulates, and submits immutable copies of the verified signed bytes.
- Contract/accounting behavior: Coverage IDs are permanent tombstones in `0x63 || coverageId` boxes. Gate C validates pause/opt-in, exact group/order/index, non-zero IDs/request hash, provider/policy existence/status/association, common sender, payout/application receivers, accepted ASA, unsafe transfer/rekey fields, derived premium/net, maximum coverage, stake validity/capacity, checked lock/exposure/reserve/expiry additions, and the complete precomputed `totalProviderStake + newPremiumReserve` against the actual application ASA balance. Success stores status `OPEN = 1`, `stakeTopupAmount = 0`, `exposureReleased = false`, then increases provider locked stake, provider/global exposure, and premium reserve without changing total stake and emits the frozen `CoverageOpened(..., version=1)` event.
- Arithmetic: AVM `biguint` computes `floor(gross * premiumBps / 10_000)`, applies the one-unit minimum, derives `providerNet = gross - premium`, and computes ceiling collateral with `(gross * collateralRatioBps + 9_999) / 10_000`. Deterministic tests cover floor/minimum, ceiling, exact-capacity and one-unit-insufficient cases, maximum uint64 boundaries, conservation, and mixed-policy summation. Gate C deployment uses one additional approval page because the compiled program is 2,329 bytes; this is recorded as implementation fact D-021 and does not change the frozen ABI/profile/storage.
- Deterministic verification: `npm run test:p1` — **21 passed, 0 failed**. Tests cover the corrected reserve/balance invariant, artifact/ABI/event/record shape, arithmetic and state accounting, schema-valid x402 v2 envelopes with optional standard fields, real x402 registration, immutable signed-byte snapshots, all three missing/corrupt/wrong-key signature positions, multisig/logic-sig rejection, every group/role/index/ABI/reference/transfer/metadata binding, stable malformed-input handling, simulation-before-submission, stale-snapshot invalidation, and failure-shaped settlement responses.
- Real LocalNet evidence (final remediation run, `dockernet-v1`, round `933`): ASA `2017`; application `2018`; application address `3ULKEUPPSRLHECVHX4HZDQONNTDMHJKI7OGUTW6XJGUKPOSG7VQ6JIWZSU`; insufficient-capacity test app `2021`; coverage provider `0c`*32 with payout distinct from payer; policies `0b`*32 at 2,500 bps collateral and `0d`*32 at 7,500 bps collateral; coverage IDs `15`*32 and `16`*32. Coverage-box MBR delta was **92,900** microAlgos per box and **185,800** for two boxes; final application minimum balance was **767,300** microAlgos, ALGO balance **992,900**, and ASA balance **249**.
- Successful state/balance evidence: coverage 1 gross/providerNet/premium/lock = **40/39/1/10** and coverage 2 = **100/98/2/75**; mixed-policy lock sum **85**. Payer/provider/application ASA deltas were respectively `(-40,+39,+1)` and `(-100,+98,+2)`. Provider 3 ended at stake total **123**, locked **85**, open exposure **140**; global accounting was provider stake **246**, premium reserve **3**, open exposure **140**; capacities were **152** and **50** for the 2,500/7,500-bps policies. Both `CoverageOpened` events and complete `getCoverage` reads decoded successfully. Successful group IDs were `FQzTdovFX54ZYcAsf3hWTOHOoP+pMpNRXWePSkzrCFA=` and `Rk5EaM9QD8axSbaegLt37rwdHQ6TItAt5Y6E7stsUXQ=`.
- Rollback/rejection evidence: The validly signed gross-51 group under the 7,500-bps policy failed x402 simulation with category `simulation`, assertion **pc=1976**, and facilitator submissions **0**. The exact same signed bytes were rejected by the real transaction pool at **pc=1976**. Before/after comparison covered payer, provider, and application ALGO/ASA balances, application minimum balance, provider/policy/coverage boxes, provider record, and all global accounting fields; every value was unchanged and the rejected coverage box remained absent. The runner executed **17** counted Gate C representative rejection cases, including wrong ASA, exact group size, reordered group with recomputed group ID, unsafe transfer assetSender/close-to/rekey, application rekey, and the paused/inactive/duplicate/reference negatives; total runner rejected cases were **65**.
- Required commands: `npm run typecheck:p1` passed; `npm run build:contract:p1` passed; `npm run test:p1` passed (**21/21**); `npm run localnet:p1` passed against real `dockernet-v1` with **65** total rejected cases.
- Deviations/blockers: none. Gate C is left in `REVIEW` as required; Gate D, TestNet, P2, UI, backend, and infrastructure work were not started.
- Orchestrator review: accepted at commit `911b0af` after inspecting both remediation commits and their documentation diffs. Reproduced typecheck/build, all 21 deterministic tests, and a fresh LocalNet run at round `979` with ASA `2070`, app `2071`, two real x402-core settlements, exact locks `10 + 75 = 85`, 17 counted Gate C rejections/65 total, and matching insufficient-capacity simulation/pool assertion `pc=1976` with full rollback. The standard x402 v2 envelope, facilitator interface, stale-snapshot invalidation, failure-shaped settlement, complete reserve balance bound, and previous evidence defects were verified in code. A cumulative audit also reproduced P0's 63 tests/build/typecheck, fresh real LocalNet success/rollback, and read-only TestNet public evidence; current Gate A/B behavior is exercised by the combined 65-case P1 LocalNet run.

## Gate D — Withdrawal, close, claims, and refunds

Status: REVIEW

- ABI/events: Preserved the exact four Gate D methods, frozen records, statuses (`OPEN=1`, `REFUNDED=2`, `CLOSED=3`), event signatures, `assurance-core-v1` profile, and permanent coverage/claim tombstones. Refund and withdrawal destinations remain storage-derived.
- Implementation: Owner-only withdrawals are pause-blocked, inactive-provider-safe, explicitly pooled-fee checked, protected by lock/global/physical-ASA/post-transfer liability bounds, and emit one configured-ASA inner transfer. Permissionless expiry close accepts equality and paused execution, shares one release operation with claims, and cannot release twice. Claims remain adjudicator-only; rejected claims close with zero debits/transfers, pool-only claims debit reserve, and provider-fault claims preserve other open locks with exact stake/pool waterfall.
- Compiled artifact: Approval program **3,517 bytes**, `extraPages=1`; the accepted D-021 page allocation remains sufficient. Three claim tombstones each increased application MBR by exactly **45,300** microAlgos; final application MBR was **1,271,700**.
- Deterministic verification: `npm run test:p1` — **26 passed, 0 failed**. The seeded schedule owns and asserts exactly **250** lifecycle steps, with complete pre-failure snapshots and invariants 1–10 after every attempted transition. Fixed observed category counts (success/failure) are deposits `31/2`, mixed-policy opens `40/6`, partial withdrawals `39/10`, full withdrawals `1/0`, expiry closes `8/9`, rejected claims `13/3`, approved pool claims `11/0`, approved provider-fault claims `8/0`, and zero-capacity `0/1`.
- Deterministic boundary proof: the model explicitly proves stake-only provider fault `stakeDebit=20`, `poolDebit=0`, unchanged premium reserve, exact global/physical stake decrease, stored-payer-only refund, and protection of another open coverage's locked stake. Withdrawal fixtures cover insufficient pooled fee, actual ASA underflow, global stake underflow, post-withdrawal tracked-liability failure, max-`uint64` withdrawal, zero/over-total/locked amounts, and successful inactive-provider withdrawal; every defensive injected-state failure restores the complete pre-call snapshot.
- Fresh real LocalNet: `dockernet-v1`, round **3692**, ASA **5243**, app **5244**, app address `AAJUJH6SZZV4HK3ABE47N3ZCKOQCECRW7H6FGQRWJGUUKCBIRBSZKFCUFI`. One-provider/two-policy MBR was **357,100**; final app ALGO **1,428,800**, app ASA **227**, total provider stake **198**, premium reserve **29**, open exposure **100**; `198 + 29 <= 227`. Approval was **3,517 bytes**, `extraPages=1`; final app MBR was **1,271,700** and each of three claim boxes added exactly **45,300**. Mixed-policy locks were `10 + 75 = 85`; fault waterfall was `25 stake / 75 pool` for refund `100`; pool-only was `0 / 1`; stored payer was `GVEZG4GCSVYZUR2BKAK32EAPTPDR7ZE24DEZO7DDS4DO53GN6ETYIVAW6I`. Owner withdrawal transferred exactly `23` ASA and left provider 3 at stake `100` before the fault debit; full post-release withdrawal reduced provider 2 to zero capacity. Expiry timestamps were opened `1788262625`, target `1788262655`, and confirmed close `1788262700` while paused.
- Fresh public transaction IDs: creation `WYCHAM4S63O2ZFT6I6JNRQJUTTXZE77TFXQ64J5MAVRPZVT45ELA`; claim-box funding `RLJSQTQFVCGM4ZRD75WQAWY7KDS27YD4FPLMLKK6AQQG3UDGHNCA`; rejected claim `4VUNQESHLCJLNF6TQSNT63JB55AAZVM4G6DULDK4NWE2CQNTYHKA`; pool claim `YGZKSCU2K6MT2H37DZC3QCCBHI2TCTGHAQUCXCNNJZO5J66FS4TQ`; pool settlement `ORQQE2Y6U4OLSHV2OPIIHY4B527ROZTCRMA6LFCNR32PJAWQXX3A`; fault claim `RU2BQ6DIGXQMHB3KO2F7DJTYX63WD77QN6WTGXEXBDO2IZVK4HYQ`; fault settlement `BNBA7EPWXUCMCK2YNBI3YQLMCWZ4MGWY4ET5XC6XHY2UA6WARVXQ`; withdrawal `EX5MGD3YG4Z7Z4BKOPOQAMUDWNQJQDOTNFBHHGY6Q57OLEFRFJSA`; paused expiry close `HD3ZRK2RSTLMJY3GCU4SOUPOFS4TJAIFRAISWOC5P2E6JTNFXVNQ`; full withdrawal `XR6ILHK27LW6VCD7W3RI7SSFCNRCIBP4CWHNT4GXBMOLE7YD25FA`.
- Rejection evidence: **95** total runner rejections, including **27** Gate D application-assertion cases. For those cases, extracted simulation and pool application IDs were both **5244**; the exact final application-assertion PC set was `{2344, 2346, 2366, 2375, 2386, 2404, 2527, 2552, 2575, 2717, 2983, 3515}` and each simulation/pool pair matched. The two same-signed-transaction withdrawal resource negatives were `withdraw missing provider box` (`invalid Box reference`, app `5244`, simulation/pool `pc=2352`) and `withdraw missing accepted asset` (`unavailable Asset 5243`, app `5244`, simulation/pool `pc=2412`); both had complete balance/box/global-state rollback. Zero-capacity assured-exact simulation and real pool evidence extracted app **5244**, matched `pc=2036`, and preserved complete rollback with facilitator submissions `0`. No signed bytes were changed between simulation and pool submission.
- Rollback/state proof: Failed transitions compared payer/provider/other ALGO+ASA balances, application ALGO+ASA and MBR, all relevant boxes, records, and global accounting before/after. Successful events and reads decoded; pool-only logs were exactly `ClaimFinalized` + `RefundPaid`, and no `CoverageClosed` was emitted for refunded claims. Other-provider state stayed byte-for-byte unchanged through the fault waterfall. All ten final invariant flags were true.
- Commands: `npm run typecheck:p1` passed; `npm run build:contract:p1` passed; `npm run test:p1` passed (**26/26**); `npm run localnet:p1` passed. No TestNet, Gate E, P2, backend, UI, governance, or infrastructure work was started.

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
- D-012: accepted floor premium with a one-atomic-unit minimum; Gate C recorded its AVM biguint boundary evidence.
- D-013: accepted explicit permissionless expiry close; applies in Gate D.
- D-014: accepted one configured development adjudicator; applies in Gate D.
- D-015: accepted pre-deposited stake and zero same-group top-up.
- D-020: accepted `assurance-core-v1` production binding for the fixed `assured-exact` three-member profile.
- Superseding decisions, if any:

## Remaining work or blockers

- None. Gates A through C are accepted. Gate D is ready from `planning/P1_GATE_D_LIFECYCLE.md`.
