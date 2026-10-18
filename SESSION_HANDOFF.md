# Session handoff

Date: 2026-10-18. Branch: `evm/restart`.
Current phase: baseline cleanup — COMPLETE.
Packet: `planning/EVM_BASELINE_CLEANUP.md`.
Results: `planning/EVM_BASELINE_RESULTS.md`.
Next phase: M1 settlement feasibility — READY, not started.
Next packet: `planning/EVM_M1_SETTLEMENT_SPIKE.md`.

## Current state

The user approved an EVM restart and removal of previous implementation and
planning history from the active branch. Current tree contains EVM architecture,
MVP/rationale, self-contained planning, concise root state and dependency-free
package metadata. No contracts or application code have been implemented.

The user explicitly directed independent EVM technical choices: do not preserve
a payment scheme, call type, storage layout or mechanism solely because history
used it. Read `DECISIONS.md`; EVM-003 through EVM-005 are candidates to validate.
Base is accepted as the initial target, with Base Sepolia/native test USDC first.

The archive ref named in EVM-006 and `main` preserve the prior checkpoint.
Ignored local configuration and build data were moved to a private external
backup without opening populated environments; its location is in the cleanup
results. Do not import private files, old dependencies or technical requirements
back into this project. No network transaction, deployment or push occurred.

## Exact next action

Start M1 Gate A. Compare EVM payment/settlement options against atomic coverage,
intent binding, payer UX and actual x402/token support. Inspect available tools,
pin compatible versions in the isolated `spikes/evm-m1/` project, and freeze
schemas/hash vectors only after selecting the supported mechanism. Verify actual
native USDC code, domain and receive ABI if pursuing that candidate.

Then prove real local execution/rollback and registered x402 integration. Public
proof must have a bounded authorized run and funded payer/relayer; none was
provisioned in cleanup. Record blockers instead of substituting a mock or
independent post-payment coverage transaction.

Do not start M2 full financial contracts, provider SDKs or evidence backend
before M1 acceptance. Do not read `/docs` unless the user/active packet names
material in scope; M1 is self-contained. Never manually read populated environments.

## Verification and open items

Cleanup verification covers archive refs, removed-path recoverability, current
file/link consistency, neutral dependency metadata, absence of staged secrets
and clean Git status after the requested cleanup commit. No runnable tests exist
in this baseline. Exact tooling, selected settlement/profile, token compatibility,
gas/cost and confirmation policy remain M1 work; no EVM acceptance is claimed.
