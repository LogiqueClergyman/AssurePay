# M1 settlement feasibility results

Date: 2026-10-18. Branch: `evm/restart`.
Starting commit: `0026c60` — clean EVM baseline.
Packet: `planning/EVM_M1_SETTLEMENT_SPIKE.md`.
M1 state: IN_PROGRESS. Gates A/B: COMPLETE. Gate C: NEXT; public proof not started.

## Gate A scope and delegation

The user authorized beginning implementation and explicitly requested Luna
agents with high reasoning for delegated work while the primary agent verifies.
Three such agents handled mechanism comparison, intent parsing/hashing and
read-only token preflight. The primary inspected the pinned SDK sources,
reviewed the implementations, added wire/profile integration, corrected issues,
ran the combined checks and performed the public read-only probes.

No full financial core, HTTP service, Solidity contract, backend or public
transaction was built/run. The user subsequently authorized checkpoint commits; Gate A is being committed
before Gate B begins. The security skill was read in preparation
for contract work; no Solidity audit is claimed because no Solidity exists yet.

## Mechanism selection

EVM-007 selects an experimental x402 v2 `assured-exact` profile with
`assurepay-evm-v1`, ATM `assured-eip3009-receive` and upfront-only flow.
The pinned standard exact path signs/executes transfer authorization rather
than invoking the proposed receive/split/coverage function. Changing its ATM
label alone does not replace that implementation. Permit2, up-to, batch and
direct-wallet execution were compared against exact gross, atomic admission,
EOA gas/approval UX and the smallest demonstrable dependency surface.

Important discovery: standard exact defaults to authorization/settlement after
the resource handler. Our server explicitly supports only `upfront` so coverage
must exist before paid service execution. The installed SDK supports custom
registration and that flow declaration. Successful actual settlement is not
proven merely by SDK registration.

Upstream research revision: `faa1c694c66a3732aaabbce93bdae140e521a67d`.
Installed releases are separately pinned by package tarball integrity, lockfile
and selected installed-source SHA-256 digests in `toolchain.json`.

## Implemented checkpoint

All implementation paths are under `spikes/evm-m1/`:

- Exact package/lockfile and strict TypeScript configuration.
- `src/intent.ts`: strict twelve-field canonical intent parsing, trusted binding,
  uint256 and exclusive-time-window bounds, ABI hash and token receive typed data.
- `src/profile.ts`: exact requirements/payload validation and upfront-only real
  SDK server interface; accepted terms checked against independent configuration.
- `src/preflight.ts` and `scripts/preflight.ts`: signer-free, bounded public
  token checks at one consistent block, with fixed failure codes and no raw RPC output.
- `test/`: success/negative coverage and real SDK scheme discovery/negotiation.
- `vectors/intent-v1.json`: synthetic unsigned golden type/hash/nonce vector;
  Solidity parity remains Gate B work.
- `evidence/token-preflight.json`: compact public metadata and compatibility result.
- README: exact schema, commands, errors, comparison and proof limits.

Profile tests intentionally use a rejecting, unimplemented facilitator to
verify registration/requirements only. They do not satisfy Gate C settlement.
Signature encoding is checked now; cryptographic verification and Core
execution remain later gates.

## Review corrections

- Supplied typed-data nonce must equal the recomputed intent hash.
- Decimal input is bounded before BigInt parsing; zero/noncanonical trusted
  gross and malformed trusted addresses fail closed.
- Trusted checksummed EVM addresses are normalized while wire JSON remains
  canonical lowercase; the actual public token constant is covered by a regression test.
- Receive probe must use the payee as `eth_call` sender. A zero-r/s dummy probe
  hit an earlier rejection on the deployed token. Two read-only diagnostic calls
  at block 48276798 established that v=27/r=1/s=1 reaches the exact expected
  token invalid-signature check. The probe now uses those nonsensitive scalars.
- Endpoint credentials/fragments are rejected and endpoint errors stay sanitized.
  Node's tsx import loader avoids the sandbox IPC bind required by the tsx CLI.

These corrections were reviewed and covered before the final combined run.

## Verification

Run from `spikes/evm-m1`:

```text
npm run typecheck             PASS
npm test                      PASS: 21 tests, 0 failures
npm run preflight             PASS with public network access
```

Installed package/integrity and inspected-source checks passed. Compiler
availability checked as `0.8.30+commit.73712a01.Emscripten.clang`, planned Cancun
target and optimizer runs 200. No Solidity compilation/execution occurred.
Node 24.18.0/npm 11.16.0, Forge/Anvil 1.7.1 are recorded; dependencies include
core/evm 2.28.0, viem 2.57.7, OpenZeppelin 5.6.1, TS 5.9.3 and tsx 4.20.6.
Dependencies were installed inside the spike only, with lifecycle scripts disabled.

The first sandboxed public preflight returned `rpc_unavailable`. Read-only
network-enabled execution observed chain 84532 and native USDC at
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, block **48276820**,
hash `0x477b7c33b2cb7c3c7aaa50f04a3fb3f4c46170d23f09c805694a6bb83022d688`.
Observed decimals **6**, token EIP-712 name **USDC**, version **2**, matching
domain separator, unused diagnostic nonce and recognized v/r/s receive ABI
rejection. No payer signature, funded balance, successful transfer, deployed
Core or public settlement is established by this read-only result.

Final checks also cover Markdown references/fences, JSON parsing, unchanged
root package/lockfile and archive refs, ignored dependency paths, absent populated
environments and `git diff --check`. No `/docs` or private backup was accessed.

## Historical Gate A next action

Start Gate B real EVM execution: implement only the minimal fixed-economics
spike Core plus a faithful ERC-3009 fixture and tests. Prove TS/Solidity hash
parity, valid receive authorization, every altered intent binding, replay and
nested token/state/nonce rollback. Keep the full provider/policy/stake/pool/claim
system for M2. Gate C then needs actual registered settlement and an authorized,
funded bounded public run; no public mutation authorization was consumed here.


## Gate B — Real local execution checkpoint

State: COMPLETE. Gate A checkpoint commit: `5126ccf`.
The user authorized checkpoint commits, sequential progress and Luna(high)
delegation. Core and token fixture were implemented by separate Luna agents;
a third execution-test agent hit its usage limit before producing a file, so
its work was reassigned. Primary built the compiler/Anvil harness, reviewed all
code/tests, corrected masked failure paths and ran the actual EVM suite.

### Implemented and reviewed

- `AssuranceCoreSpike.sol` and receive interface implement EVM-008, fixed100/93/7,
  immutable demo terms, exact deltas, strict timing, replay, non-reentrancy and
  explicit admission/post-transfer failure fixtures.
- `AuthorizationTokenMock.sol` is a faithful signed ERC-3009 test token with
  cancellation, false-return/fee/callback fixtures. No public-token proof is implied.
- `src/call.ts` recovers the EOA receive signer, enforces canonical v/low-s,
  prepares only fixed Core calldata, and revalidates exact bytes before submission.
- `src/relay.ts` records a locally derived hash before one broadcast attempt,
  coalesces concurrent calls and recovers through 1–10 read-only receipt checks.
  Wrong-hash receipt/mismatch/revert fail closed; state remains process-local.
- `test/helpers/evm.ts` uses pinned solc-js/Cancun/optimizer200 and isolated
  Anvil84532 with no default unlocked accounts. Test wallets are generated in
  memory and raw errors/signatures/keys are not emitted.

### Primary verification

`npm run compile` and `npm run typecheck` pass. Network-permitted local
`npm test` passes **44/44** tests, including **9 actual Anvil execution tests**.
Local loopback permission was required; no public mutation occurred.

Actual execution proves TypeScript/Solidity vector parity; exact successful
payer/Core/provider deltas; nonce/coverage/event accounting; all12 field
substitutions with unchanged original signature; wrong signer/domain/type;
replay/cancellation/extraction; 300-second and exact timestamp boundaries;
admin restrictions; and guard-specific reentry rejection. False-return, fee,
and forced-after-transfer failures restore balances, nonce, coverage/count/
reserve. Included reverts charge exactly gasUsed*effectiveGasPrice to relayer.

Review fixed missing independent Core time checks and tests whose disabled
admission/accumulated balances could mask later failure cases. Each rollback
case now uses new contracts and funded payer. Reentry checks the exact guard
error selector, not just a generic failed callback. The final passing run
exercised these corrections. A scoped implementation review was performed;
this is not a production security audit or financial-core acceptance.

### Exact next action

Commit this verified checkpoint, then begin Gate C's actual registered x402
client/server/facilitator settlement on Anvil. Prepare the signer-safe public
runner/verifier and configuration-only preflight. Actual public native USDC
proof still requires explicit bounded run scope and funded runtime wallets;
no such wallet configuration was provisioned. Do not start M2 before M1's
required public gate is accepted.
