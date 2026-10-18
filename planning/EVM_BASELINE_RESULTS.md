# EVM baseline cleanup results

Date: 2026-10-18. State: COMPLETE. Branch: `evm/restart`.
Packet: `planning/EVM_BASELINE_CLEANUP.md`.

## Outcome

Removed the previous implementation from the active tree: code, contracts,
tests, generated artifacts, deployment evidence, specifications, old planning
packets and stale session history. Replaced the dependency manifest/lockfile with
a dependency-free EVM baseline and removed installed packages from the workspace.

Kept three current design documents: EVM architecture, MVP and design rationale.
Removed migration-comparison material and replaced it with independent EVM
rationale/options. Rewrote repository instructions, decisions, plan and handoff.
Added a README. Only current cleanup/next-phase packets remain under planning.

The user explicitly directed that payment schemes, x402 call types and other
mechanisms be chosen on their EVM merits. M1 now compares supported alternatives
before freezing a profile. Receive authorization/custom settlement is a candidate,
not an inherited technical requirement. No EVM implementation was started.

## Recovery and local configuration

The archive ref recorded in EVM-006 and `main` remain at
`958f65002d6afd97e8cbb86bae63ecabe5abb024`. All 52 removed tracked files can be
recovered from that checkpoint. No old commit is amended or rewritten.

Private local backup: `/private/tmp/assurepay-legacy-20261018-8f9774mv`.
The directory has mode `0700` and contains the old implementation directories,
installed dependencies/lockfile, removed docs/planning and root-record snapshots.
Ignored populated configuration moved with its parent directories without being
opened. Private temporary storage is a local recovery aid, not durable backup;
retain or relocate it privately if those local credentials are still needed.
It is outside the repository and excluded from the cleanup commit.

## Verification

- Active branch and unchanged archive/main refs checked.
- Every removed tracked path resolves in the archive commit.
- Active tree has 14 files: eight root files, three EVM docs and three planning files.
- Eleven Markdown files checked for closed fences, local links and stale references;
  all eight local Markdown links resolve.
- No previous chain packages, commands, implementation directories, old packet
  references or technical requirements remain. The archive branch recovery name
  is the sole intentional chain-name reference.
- Root manifest/lockfile parse correctly, use the same project identity and contain
  no dependencies or old scripts. Installed dependency tree is absent.
- Neutral lockfile generated with
  `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund`.
  No dependency download, installation or lifecycle hook ran.
- General ignore rules cover nested environment files and generated build outputs;
  `.env.example` remains eligible for tracking.
- Staged-path/content checks exclude populated environments, keys, signed material
  and generated build data. `git diff --check` and staged whitespace checks pass.
- New focused cleanup commit on the active branch; no push or shared-history rewrite.
  Final branch/ref and clean-status checks are performed immediately after commit.

No application or contract test suite exists in this intentionally empty baseline.
Validation concerns cleanup/repository integrity only; no EVM execution, token
compatibility, gas estimate or public-network acceptance is claimed.

## Next action

Start `planning/EVM_M1_SETTLEMENT_SPIKE.md`, Gate A: compare/select the EVM
settlement mechanism, inspect/pin tooling and dependencies, freeze schemas and
hash vectors, and verify actual token behavior. M1 is READY and unstarted;
M2 financial core and later SDK/backend phases remain unstarted.
