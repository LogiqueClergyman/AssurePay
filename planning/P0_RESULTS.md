# P0 Atomic-Group Spike Results

Status: NOT_STARTED

This file is the durable experimental record for `P0_ATOMIC_GROUP_SPIKE.md`. Replace placeholders with evidence; do not claim unexecuted results.

## Environment

```text
Date:
Git branch:
Git commit:
Operating system:
Node:
Package manager:
AlgoKit:
Algorand TypeScript / PuyaTs:
@algorandfoundation/algokit-utils:
@x402/core:
@x402/avm:
@x402/express:
Facilitator implementation/version:
```

## Observed x402 AVM behavior

### Payment payload shape

Pending.

### Verification and settlement path

Pending.

### Signer responsibilities

Pending.

### Group ordering/index constraints

Pending.

## LocalNet evidence

### Successful group

```text
Command:
Application ID:
Asset ID:
Group/transaction IDs:
Balance/state before:
Balance/state after:
Result:
```

### Forced-failure rollback

```text
Command:
Group/transaction IDs or rejected submission details:
Expected rejection:
Balance/state before:
Balance/state after:
Result:
```

### Negative-case matrix

| Case | Verification command/test | Result |
|---|---|---|
| Wrong provider receiver | Pending | NOT_RUN |
| Wrong premium receiver | Pending | NOT_RUN |
| Wrong asset | Pending | NOT_RUN |
| Incorrect arithmetic | Pending | NOT_RUN |
| Malformed request commitment | Pending | NOT_RUN |
| Unsafe rekey/close fields | Pending | NOT_RUN |

## x402 facilitator evidence

```text
Facilitator endpoint/implementation:
Fee abstraction enabled:
Verification command/test:
Settlement command/test:
Observed submitted group:
Success result:
Rollback result:
```

## TestNet evidence

Do not record secrets or account mnemonics.

```text
Network:
Application ID:
Asset ID:
Success group/transaction IDs:
Forced-failure submission evidence:
Relevant explorer links:
Verified final balances/state:
```

## Decision recommendation

```text
Recommendation: exact extension | assured-exact | unresolved
Evidence:
Security implications:
Required P1 interface constraints:
```

After the recommendation is supported, add or update D-010 in `DECISIONS.md`.

## Same-group stake top-up observation

```text
Feasible without material complication: yes | no | not tested
Reason:
Recommendation for D-015:
```

## Commands to reproduce

Pending.

## Files created or changed

Pending.

## Remaining blockers

Pending.

