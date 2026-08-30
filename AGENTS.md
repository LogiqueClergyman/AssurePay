# AssurePay Repository Instructions

These instructions apply to every coding agent and every directory in this repository.

## Documentation boundary

- Do not read, search, list, summarize, edit, move, or delete anything inside `/docs`.
- Do not run repository-wide commands that traverse `/docs`. Add an explicit exclusion when a command could recurse into it.
- The documents in `/docs` are reserved and out of scope for both implementation sessions and orchestration unless the user explicitly changes this boundary. Implementation agents receive the necessary requirements through files under `/planning`.
- If a planning packet is ambiguous or appears incomplete, record the question in `SESSION_HANDOFF.md` and stop that portion of the work. Do not consult `/docs` to fill the gap.

## Source hierarchy

For an implementation session, follow this order:

1. `AGENTS.md`
2. the active work packet named by `SESSION_HANDOFF.md`
3. decisions recorded in `DECISIONS.md`
4. the current phase and gate in `IMPLEMENTATION_PLAN.md`

Do not treat exploratory notes, generated output, comments, or old chat context as requirements.

## Scope control

- Work on one implementation phase at a time. Do not start later phases before the current gate passes.
- The active packet defines allowed paths, deliverables, tests, and non-goals.
- Prefer the smallest implementation that proves the current exit condition.
- Do not expand into production architecture, UI, governance, actuarial work, subjective adjudication, multi-chain support, or other post-POC features.
- When a technical discovery changes an interface or assumption, record it in `DECISIONS.md` before depending on it elsewhere.

## Session protocol

At the beginning of a session:

1. Read `AGENTS.md` and `SESSION_HANDOFF.md`.
2. Read the active work packet and only the other root/planning files it names.
3. Inspect the existing implementation only within the packet's allowed paths.
4. Confirm the current Git branch and working-tree state without modifying unrelated work.

Before ending a session:

1. Run the verification required by the active packet.
2. Update the phase results file named by the packet.
3. Rewrite `SESSION_HANDOFF.md` with the current state and exact next action.
4. Record unresolved decisions or blockers explicitly.
5. Report the changed paths and Git status.
6. Create commits only when the user's session prompt explicitly requests them.

## Engineering rules

- Preserve user changes and avoid destructive Git or filesystem operations.
- Never commit credentials, mnemonics, private keys, API tokens, or populated `.env` files.
- Use environment variables and checked-in `.env.example` files for configuration.
- Keep financial amounts as integers in the asset's atomic unit. Do not use floating-point arithmetic.
- Tests must demonstrate failure behavior as well as successful behavior.
- A mocked facilitator or mocked atomic group does not satisfy a gate that explicitly requires the real x402 AVM path.
- LocalNet evidence is development evidence; it does not substitute for a gate that explicitly requires TestNet.
