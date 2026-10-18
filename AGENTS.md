# AssurePay repository instructions

These instructions apply throughout this repository.

## Active direction

AssurePay is an EVM assurance protocol for x402 services. Start with Base
Sepolia and native test USDC. Evaluate EVM mechanisms on their merits; prior
implementation history is not a technical requirement. Payment scheme,
authorization, settlement, storage and lifecycle choices can change when a
better approach is demonstrated and recorded.

## Source hierarchy and scope

1. `AGENTS.md`
2. Active work packet named by `SESSION_HANDOFF.md`
3. `DECISIONS.md`
4. Current phase and gate in `IMPLEMENTATION_PLAN.md`

Work on one phase at a time. Do not start dependent phases before their gates
pass. The packet defines allowed paths, deliverables, tests and non-goals.
Prefer the smallest implementation that proves the current exit condition.
Do not expand into production UI, governance, actuarial models, subjective
adjudication, commerce integrations or multiple chains/assets without scope.

## Documentation boundary

Implementation packets under `/planning` must be self-contained. Do not read,
search, list, edit or delete `/docs` unless the user or active packet explicitly
names the material in scope. Exclude `/docs` from recursive commands otherwise.
Record requirements gaps in `SESSION_HANDOFF.md` and stop the affected portion
instead of importing requirements from history, exploratory notes or comments.

## Session protocol

At session start, read these instructions, handoff, active packet and its named
references; confirm branch and working-tree state. Inspect implementation only
within allowed paths. Record an interface/assumption change in `DECISIONS.md`
before another component depends on it. Distinguish proposals from proven facts.

At session end, run the packet's required verification, update its results,
rewrite handoff with exact next action and blockers, and report changed paths
and Git status. Create commits only when explicitly requested. Do not amend
shared history or push without authorization. Preserve unrelated user work.

## Engineering rules

- Never read populated environments manually, print secrets or commit keys,
  mnemonics, tokens, signatures, signed blobs or populated environment files.
- Use runtime environment variables and checked-in `.env.example` templates.
- Use integer atomic token units throughout; no floating-point money arithmetic.
- Tests must demonstrate failure behavior as well as successful execution.
- Financial gates require actual EVM contract execution and invariant checks;
  a model or source-string check alone is insufficient.
- A mocked token/facilitator cannot satisfy a gate requiring actual USDC/x402.
- Local/fork/simulation evidence does not replace required public testnet proof.
- Public mutations must stay within the session's authorized scope and budget.
- Do not infer settlement failure from an RPC timeout; reconcile public state
  before retrying and never create a second payment merely to recover a response.
