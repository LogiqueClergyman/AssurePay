# AssurePay client consumer example

This plain Node.js example consumes only `@assurepay/client-sdk`'s package root
and the documented viem account helper. It previews a request, asks for one
explicit host decision, authorizes and sends only with `--approve`, then shows
the anchored state. It also supports retrieval by the original request ID and
the payer evidence/claim methods. Retrieval and reads do not load a payer key.

Copy `.env.example` into the shell environment, provide a local-mode config and
an opaque 32-byte storage key, and set `ASSUREPAY_PAYER_PRIVATE_KEY` only for a
new authorization or claim action. Configuration and key files must remain out
of source control. The example prints safe IDs, amounts and transaction hashes;
it never prints key material, signatures, headers or private storage paths.
Set `ASSUREPAY_MAX_GROSS`, `ASSUREPAY_MAX_TOTAL_GROSS`, and
`ASSUREPAY_MAX_PAYMENTS` explicitly; they are bound to the persistent session.

Run `npm install` and `npm run demo -- --preview` to inspect a request without
signing. `npm run demo -- --approve` authorizes one new request for this single
invocation. Use `--retrieve <requestId>`, `--state <coverageId>`, `--evidence
<coverageId> <file>`, or `--claim <coverageId> <evidenceHash> --approve` for
payer-only follow-up actions.
