# M2 — Solidity financial core

State: REVIEW — local implementation and execution gate pass; results in
planning/EVM_M2_RESULTS.md. Prerequisite M1 ACCEPTED (EVM-015); requirements accepted by
user on 2026-10-19 (EVM-016). Target: Base Sepolia/native USDC, EOA authorization.
Read AGENTS.md, SESSION_HANDOFF.md, EVM-016/017 in DECISIONS.md, accepted
planning/EVM_M2_REQUIREMENTS.md and the M2 row of IMPLEMENTATION_PLAN.md.
This packet is self-contained; `/docs` and historical requirements are excluded.

## Scope and deliverables

Allowed writes: `packages/evm-core/**`, this packet, M2 requirements/results,
and focused DECISIONS/SESSION_HANDOFF/IMPLEMENTATION_PLAN updates. Root package
may receive only a focused tooling entry if needed. Read-only reuse of these
M1 sources is allowed: contracts/mocks/AuthorizationTokenMock.sol,
contracts/interfaces/IReceiveAuthorization.sol, src/intent.ts, test/helpers/evm.ts,
vectors/intent-v1.json, toolchain.json, package.json and package-lock.json under
spikes/evm-m1. Preserve M1 contracts, public journals, wallets and acceptance.

Deliver one non-upgradeable Core, pinned isolated compiler/test package, ABI
and integer hash parity checks, actual Anvil execution tests, independent
security/accounting review and concise results. No production UI, HTTP SDK,
backend, automated/subjective adjudication, governance/role rotation, share token,
multiple assets/chains or public mutations in M2. Public M1 proof remains proof
of its payment boundary; do not claim public execution of the new Core.

## Frozen interfaces and identity (EVM-017)

Solidity0.8.30, Cancun, optimizer200, viaIR enabled for this package only;
OpenZeppelin5.6.1, viem2.57.7, TypeScript5.9.3, tsx4.20.6, Anvil1.7.1.
Constructor `(address token, address admin, address adjudicator)` fixes all roles;
nonzero deployed token, admin/adjudicator nonzero and neither Core nor token.
No role changes, rescue/sweep, upgrades or fixture fail switches.

`registerProvider(bytes32 providerId,address owner,address payout)` admin-only,
unique nonzero ID; immutable nonzero owner/payout neither token nor Core.
`registerPolicy(bytes32 policyId,bytes32 providerId,uint16 premiumBps,
uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)`
admin-only, unique nonzero ID and existing provider, immutable terms.
`setPaused(bool)` admin-only. Pause blocks registration and admission only.

Policy hash is keccak256(abi.encode(keccak256(bytes(literal)), providerId,
policyId, providerOwner, providerPayout, premiumBps, stakeBps, withholdingBps,
duration, poolOnlyAllowed)), literal exactly:
`AssuredPolicyV1(bytes32 providerId,bytes32 policyId,address providerOwner,address providerPayout,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)`.
All economics/provider recipients are therefore bound to M1's signed policyHash.
The intent remains its twelve-field AssuredIntentV1 tuple and identical hash
literal/encoding; nonce=coverageId=intentHash. Preserve hash parity, strict
exclusive authorization times and maximum300-second authorization duration.

`settleAssured(intent,uint8 v,bytes32 r,bytes32 s)` relayer-callable; returns ID.
Validate chain/Core/token, existing provider/policy association/hash, payer
nonzero and distinct from token/Core/payout, nonzero requestHash/salt, gross>=2,
and unused coverage. Only call native-token receiveWithAuthorization with
recipient Core, gross/time/nonce derived exactly from the intent. No arbitrary
call forwarding. `hashIntent(intent)` and `quoteSettlement(policyId,gross)` are
read-only. Quote returns `(premium,withheld,net,stakeLock,poolReservation)`.

`depositStake(bytes32 providerId,uint256 amount)` pulls caller tokens and credits
that provider; anyone may donate. `fundPool(uint256 amount)` pulls a donation.
`withdrawStake(bytes32 providerId,uint256 amount)` owner-only, pays stored owner,
free stake only. Amounts positive. No pool withdrawals or transferable shares.

`fileClaim(bytes32 coverageId,bytes32 evidenceHash)` stored payer only, active
coverage and block.timestamp<expiresAt, nonzero evidence hash. Claim pins locks.
`finalizeClaim(bytes32 coverageId,Resolution outcome,uint256 refundAmount,
bytes32 decisionHash)` immutable adjudicator only, pending claim, nonzero
decision hash. Resolution enum order: Reject=0,ProviderFault=1,PoolOnly=2.
Reject requires refund0; refund outcomes require0<R<=stored gross and PoolOnly
requires the stored flag. Always pay stored payer. No automatic decision/timeout.
`closeExpired(bytes32 coverageId)` anyone, unclaimed Active and now>=expiresAt.
CoverageStatus enum: None=0,Active=1,ClaimPending=2,Refunded=3,Rejected=4,Expired=5.
No second claim, terminal transition, refund or lock release. Registration,
settlement, funding, withdrawals and lifecycle events expose IDs and amounts;
no signature/signed blob is persisted in logs or test artifacts.

## Accounting and transitions

Policy premium/withholding bps each0..9999; stake bps0..10000; duration>0 and
expiry addition representable in uint64. Overflow-safe mulDiv rounding:
P=max(1,floor(G*premiumBps/10000)); W=floor((G-P)*withholdingBps/10000);
N=G-P-W>0; L=ceil(G*stakeBps/10000); Q=poolOnlyAllowed?G:G-L.
Premium becomes pool assets; W becomes this provider's stake before capacity
checks/locking. Require post-credit free>=L and poolAssets+P>=totalPoolReserved+Q.
Receive G, credit P/W, lock L, reserve Q, store immutable coverage snapshot,
pay N in one nonReentrant transition. No fixed M1 gross/net/premium constants.

Track poolAssets,totalPoolReserved,totalProviderStake,totalLockedStake,
coverageCount and activeCoverageCount; provider includes owner,payout,freeStake,
lockedStake; policy stores provider/hash/all immutable parameters. Coverage stores
payer/provider/policy/hash/request/gross,P,W,L,Q,openedAt,expiresAt,pool-only flag,
status,evidenceHash,decisionHash,refundAmount,outcome. Initial L/Q remain stored
snapshots after terminal resolution; status determines whether they are live.

For provider-fault R, F is pre-resolution free stake excluding this lock:
a=min(R,L), b=min(R-a,F), c=R-a-b. Provider free becomes F-b+L-a; locked and
aggregate locked decrease L; total stake decreases a+b; poolAssets decreases c.
Release entire Q reservation. For pool-only R, poolAssets decreases R, provider
free increases L and locked decreases L; total stake unchanged; release Q.
Rejection/expiry release L/Q with no asset consumption. Each terminal transition
decrements activeCoverageCount once. Free stake is never a collateral guarantee.

After every financial operation actual Core token balance >= poolAssets+
totalProviderStake, poolAssets>=totalPoolReserved, totalProviderStake>=
totalLockedStake. Unsolicited surplus creates no withdrawal rights. Tests sum
all provider/coverage ledgers and verify aggregate identities. Exact sender/Core/
recipient deltas apply to deposits, receive, payout, withdrawal and refund;
reject zero/self recipients that break independent accounting. Token failure,
fees, callback/reentrancy or any failed postcondition reverts every nested
state change, including USDC authorization nonce. ReentrancyGuard and checked
state transitions protect financial entry points. No coverage consumes another
coverage's lock/reservation or an unrelated provider's stake.

## Required execution gate

1. Compile pinned actual Solidity, strict TS typecheck and local actual EVM tests.
2. Constructor/admin/owner/adjudicator restrictions; registration uniqueness,
   policy hash parity/bounds/immutability; M1 intent hash parity and substitutions.
3. Real ERC3009-signature receive/split/coverage with nontrivial P/W/L/Q, zero and
   full stake, one-unit rounding, tiny gross, seeded-pool admission, insufficient
   pool/stake rollback, wrong binding/signature/domain/type/time, replay.
4. Deposits/withdrawals cannot take locked/other provider assets; exact deltas,
   malicious/fee/false-return token rollback and reentrancy checks.
5. Timely payer-only claims, unauthorized/late/duplicate filing; partial/full
   provider-fault waterfall, allowed/disallowed pool-only, rejection, immutable
   payer payout, invalid resolver/amount/decision, repeated terminal failure.
6. Exact expiry boundary, pending claim beyond expiry, no timeout release;
   pause blocks admission/registration but funding/withdrawal/claim/finalize/
   expiry remain available. Cover concurrent live coverages and two providers.
7. Deterministic adversarial multi-operation actual-EVM sequences check solvency,
   aggregate sums, collateral isolation and one-time terminal behavior after
   success AND included reverts; report measured gas/code size with limits.
8. Independent scoped security/accounting review and primary verification.

Use faithful local ERC3009 fixture; it is not native public USDC evidence. Mock
controls prove failed external calls and postcondition rollback, not production
support for arbitrary assets. No populated env access or public signer needed.
Run `npm run compile`, `npm run typecheck`, `npm test` in packages/evm-core;
record counts/source hashes/gas and unresolved limits in planning/EVM_M2_RESULTS.md.
Stop at M2 REVIEW with exact next action. M3 requires M2 acceptance and its own
packet. Do not bypass failing gates or claim an audit/public proof not performed.
