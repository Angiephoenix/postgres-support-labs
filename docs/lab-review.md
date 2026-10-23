# Compare and review a local PostgreSQL investigation

After the PostgreSQL lab runs, the comparison shows what changed once the migration was applied and checks that nothing else that matters changed: the same database, role, query and search path. The development check and the search-path control stay visible alongside the evidence behind each line. Then a person decides whether the evidence supports the explanation.

This command supports the bundled missing-migration reproduction and its current artifact protocol. General comparison across arbitrary investigations remains planned.

## Read the comparison

Use the artifact directory printed by `npm run demo:postgres -- --approve-lab`. Replace `RUN_DIRECTORY` below with that directory, for example `cases/native-<run-id>`.

```sh
node src/cli.ts lab compare RUN_DIRECTORY
node src/cli.ts lab compare RUN_DIRECTORY --json
```

Both commands read retained files and print to stdout. They make no database connection. The Markdown report includes changed and unchanged observations, the same-error control, ledger references, evidence blockers and any recorded reviews. JSON includes the full comparison and review history.

The comparison verifies the case and observation contracts, ledger chains, run identity, query hashes, fixed probe catalog, declared migration, successful cleanup and agreement between cached run summaries and observations. It requires all four snapshots and the additional qualified-query control. Any noncurrent observation blocks acceptance. Before-and-after scope, intake, effective schema, server version and search path must agree. The required result pattern must also hold.

`READY_FOR_REVIEW` means those comparison checks passed. Cause remains unset until explicit acceptance. The lab's one-hour evidence expiry is evaluated each time the comparison is read. An expired run remains readable with blockers; run the lab again for fresh evidence before accepting a finding.

## Record a decision

Generate a template inside the ignored run directory:

```sh
node src/cli.ts lab review-template RUN_DIRECTORY > RUN_DIRECTORY/review-input.json
```

Open `review-input.json` in your editor. Keep `schemaVersion`, `comparisonHash` and `expectedReviewHead` as generated. Fill in:

- `reviewer`: a name or local identifier, without an email address.
- `decision`: `accept`, `reject` or `request-changes`.
- `rationale`: your reason, including which observations support or challenge the finding and any remaining limitation.

The blank template cannot be submitted. Read the comparison before choosing a decision. Acceptance means you find the recorded local evidence sufficient to support the missing-migration explanation for this reproduction.

```sh
node src/cli.ts lab review RUN_DIRECTORY RUN_DIRECTORY/review-input.json
node src/cli.ts lab compare RUN_DIRECTORY
```

The write command appends a hashed record to `reviews.jsonl`, with your identifier, decision, rationale, comparison hash, timestamp and preceding review hash. It refuses an outdated template, concurrent writer lock or acceptance with evidence blockers. Every lab command supports `--dry-run`; that mode reads no input and writes nothing.

To revise your decision, generate a new template, edit it and submit it. Each new record preserves earlier bytes. The most recent applicable decision determines the current review status. Rejection and requests for changes leave cause unset. Acceptance exposes `SUPPORTED_CAUSE` scoped to `local-lab`; customer resolution remains unset. If evidence expires, its accepted cause loses current support while the review record remains in history.

The lab runner never submits a review. Human cause review, validation of a customer environment and approval of outgoing messages are separate steps.

## Trust and limits

The recorded reviewer is caller-supplied. There is no sign-in, signature or identity authentication. Consistency checks cannot prove who ran a collector or prevent a file owner from rewriting all records and recomputing hashes. The comparison records each evidence ledger's head, case hash and file digest, while reviews form their own hash chain. Keep trusted copies of those hashes outside the writable output directory for independent comparison. Deleting a complete suffix of review records cannot be detected from that file alone.

Review input uses the project's existing privacy checks. They reject recognized patterns and do not guarantee detection of every secret or personal detail. Use sanitized rationale. Evidence and review files have size bounds. Direct symlink files and directories are rejected; this is a local single-user workflow rather than a hardened service for hostile shared storage.

A successful local query and an accepted local cause leave customer resolution pending. The [support bundle workflow](support-bundle.md) provides local validation, customer and engineering drafts, a runbook candidate and an HTML report. Customer post-fix validation and communication approval remain pending.

## Verification

`npm test` covers comparison reconstruction, fixed controls, changing context, stale evidence, explicit acceptance and revision, outdated templates, edited artifacts, cross-run records, privacy rejection, writer locks, symlink handling and read-only CLI behavior. These unit tests simulate the native artifact protocol and execute no PostgreSQL queries.

`npm run test:postgres` runs the actual native lab twice. It checks that measured artifacts produce a reviewable comparison, tests explicit review persistence with an automated test identifier, and verifies that a fresh run stays unreviewed. This automated acceptance tests the contract; it supplies no human assessment of a customer incident.
