# EVM baseline cleanup

Date: 2026-10-18. State: COMPLETE.

## Authority

The user explicitly requested removing the previous chain's code, contracts,
specifications, tooling and handoff/planning records from the latest EVM branch
commit. The user also directed that EVM technical choices be evaluated on their
own merits. This packet supersedes the prior design-session preservation rules
for this cleanup only. It authorizes the necessary documentation access and a
new cleanup commit on `evm/restart`; do not amend shared history or push.

## Scope

- Verify `archive/algorand-p1` and `main` retain the accepted checkpoint.
- Remove previous implementation, generated artifacts, tests, public evidence,
  old specifications and P0/P1 planning packets from the active tree.
- Remove obsolete dependency manifest/lock data and installed packages.
- Preserve ignored local configuration/build data by moving it to a private
  local backup outside the repository. Never open populated environments.
- Preserve and clean the EVM architecture/MVP; replace comparison-heavy migration
  material with EVM design rationale. No inherited technical requirements.
- Rewrite instructions, decisions, implementation plan, handoff and ignore rules
  for the EVM baseline. Keep next-phase packet self-contained.
- Add a short README and dependency-free root package metadata/lockfile.
- Record outcomes in `planning/EVM_BASELINE_RESULTS.md`.

No contract implementation, dependency installation, public-chain action, remote
branch mutation, credential inspection or later-phase work.

## Verification

1. Archive/main refs unchanged; active branch is `evm/restart`.
2. Deleted tracked material exists at the archive commit.
3. Only current EVM docs/planning and root metadata remain in the active tree.
4. No obsolete chain packages, commands, file references or technical constraints
   remain; the one archive-branch recovery reference is intentional.
5. Relative Markdown/backtick file references and fences are consistent.
6. Root manifest/lockfile are valid and contain no dependencies or old scripts.
7. No populated environment, credential or build-output path is staged.
8. `git diff --check`, staged diff review, new focused commit, clean Git status.

There is no runnable application/test suite after the intentionally removed
implementation. Do not claim execution tests or EVM acceptance. End with this
cleanup COMPLETE and the settlement-feasibility packet as exact next action.
