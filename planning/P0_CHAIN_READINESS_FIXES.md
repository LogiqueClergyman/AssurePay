# P0 Correction Packet — Chain-Ready `assured-exact`

## Mission

Make the existing `assured-exact` spike cryptographically correct and capable of constructing transactions that invoke the compiled Algorand ABI contract. Complete its negative tests before attempting LocalNet execution.

Continue in the existing spike. Do not redesign the POC, begin P1, or access `/docs`.

## Gate A — Cryptographic transaction validation

The raw application-call fallback currently accepts any signature with length 64. Replace this with actual Ed25519 verification over the canonical Algorand transaction signing bytes and the decoded sender public key.

Requirements:

- Cryptographically verify all three payer-owned transaction signatures.
- Reject missing, truncated, wrong-key, and bit-flipped signatures.
- Reject malformed signed wrappers instead of treating them as valid raw calls.
- Support only the signature form required by this P0; explicitly reject unsupported multisig or logic-signature wrappers.
- Return stable `invalid_assured_exact_*` responses rather than throwing.

## Gate B — Real ABI method construction and validation

The contract is an `@abimethod`. Plain-text arguments such as `openCoverage`, `100`, and `7` do not match its compiled ABI routing.

Use the generated ARC-56/ABI metadata or supported AlgoKit ABI transaction-composer/client APIs to construct the application call for:

```text
openCoverage(uint64,uint64,byte[],bool)void
```

The successful call uses `reject = false`; the rollback case uses `reject = true` or another deliberately failing ABI-valid invocation.

The facilitator must validate the actual ABI method selector and canonical ABI-decoded values for gross, premium, 32-byte commitment, and rejection flag. It must reject:

- wrong selector;
- malformed ABI encoding;
- wrong gross or premium;
- wrong commitment;
- unexpected rejection flag for a payment intended to succeed;
- unexpected extra application arguments.

Do not maintain a second invented text encoding beside the on-chain ABI.

## Gate C — Settlement correctness

- Obtain a real Algorand transaction ID from the decoded signed provider transfer and pass that ID to `waitForConfirmation()`.
- Prepare and copy the exact signed group once per verification/settlement operation.
- Ensure asynchronous simulation cannot be followed by submission of mutated payload bytes.
- Test mutation during the simulation callback and prove submitted bytes remain the verified prepared bytes.
- Distinguish simulation failure, submission failure, and confirmation failure with stable error codes.
- Include the verified payer in successful and failed responses where the x402 interface permits it.

## Gate D — Input and dependency hygiene

- Move every untrusted decimal/BigInt and ABI decode behind guarded parsing so malformed inputs return structured validation failures.
- Enforce canonical unsigned decimal strings: no sign, whitespace, exponent, decimal point, or leading ambiguity beyond the explicitly selected zero representation.
- Validate required `extra` fields before using them.
- `algorand-msgpack` is currently imported directly but supplied transitively. Either add the exact compatible version as a direct dependency or remove the direct import in favor of a declared public dependency API.
- Keep `npm run test:p0` as the sole canonical test entry point.

## Gate E — Complete the mocked facilitator matrix

Add tests that mutate actual signed transaction bytes and/or requirements, not merely the logical mirror. At minimum cover:

1. happy path verifies, simulates, submits, and confirms;
2. simulation rejection submits nothing;
3. submitted bytes remain identical to the prepared/verified bytes despite payload mutation during simulation;
4. wrong provider receiver;
5. wrong premium receiver;
6. wrong ASA in provider transfer;
7. wrong ASA in premium transfer;
8. provider/premium/application payer mismatch;
9. wrong provider-net, premium, gross, or arithmetic relationship;
10. wrong application ID;
11. wrong ABI selector and malformed ABI arguments;
12. missing, short, or wrong request commitment;
13. missing or inconsistent group ID;
14. wrong role indices, role substitution, extra member, or reordered member;
15. missing, corrupt, or wrong-key signature for each payer-owned transaction;
16. rekey on any role and asset close on either transfer;
17. malformed numeric requirement fields return validation failures without rejection/throwing;
18. submission and confirmation errors return correct distinct codes;
19. registration and settlement through the installed `@x402/core` interface;
20. stock `exact` regression remains documented.

Tests must say `mocked` when the network signer is mocked. None of these count as LocalNet evidence.

## Gate F — Resolve facilitator fee compatibility

Resolve D-017 using the actual facilitator path intended for the hackathon POC:

- If callers can pay Algorand transaction fees directly in the selected path, record evidence and keep D-016 as the P0 base profile.
- If the selected facilitator requires or is expected to provide fee abstraction, supersede D-016 with an explicit fee-payer transaction position and update contract, client, facilitator, and tests together.
- Do not declare fee abstraction out of scope solely to avoid the fourth group member.

Current package behavior or official/upstream facilitator documentation may be inspected. Do not use the local `/docs` directory.

## Gate G — LocalNet

Only after Gates A–F pass:

1. Install the official AlgoKit CLI using a currently supported distribution; do not guess an npm package name.
2. Start LocalNet and record the versions and commands.
3. Deploy the compiled disposable contract through a reproducible script.
4. Create, distribute, and opt accounts/application into a disposable local ASA.
5. Execute a successful settlement through the registered `assured-exact` scheme.
6. Record public transaction IDs plus before/after provider, application, and payer balances and contract marker state.
7. Execute an ABI-valid forced rejection through the same scheme.
8. Prove both asset transfers rolled back and marker state did not change.

If installing tooling or starting the daemon requires user approval, request it normally. If the environment remains unavailable, record the exact supported install/start command and blocker after Gates A–F pass.

## TestNet remains the P0 completion gate

After LocalNet succeeds, the same profile must run on TestNet. Never commit or log secrets. Record only public application, asset, account, group/transaction, and explorer identifiers.

P0 remains `IN_PROGRESS` until local work is exhausted. It becomes `BLOCKED` only when the remaining step genuinely requires unavailable external credentials, funds, opt-ins, or network state.

## Required updates before handoff

- `planning/P0_RESULTS.md`: add correction verification and clearly separated mocked/LocalNet/TestNet evidence.
- `DECISIONS.md`: resolve D-017 and supersede D-016 if required.
- `IMPLEMENTATION_PLAN.md`: update only the P0 row.
- `SESSION_HANDOFF.md`: record final HEAD after commits, exact test counts, public chain evidence, blockers, and next action.
- Commit implementation and handoff changes in focused commits and leave a clean worktree.
