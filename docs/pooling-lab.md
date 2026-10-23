# PgBouncer session experiment

This lab checks what happens to a SQL prepared statement when PgBouncer, in transaction mode, runs the next transaction on a different PostgreSQL server connection. It compares a direct connection with a pooled one, keeps a competing explanation visible and tries two fixes. A fresh run leaves the cause and the customer's resolution unset. A reviewer can then record an explicit cause decision, select one remedy for local validation, and export a verifiable support bundle. See [review, validate and export](#review-validate-and-export).

## Run the experiment

Use Node.js 24+, matching PostgreSQL 16–18 server tools, and PgBouncer 1.21+ within major version 1. Run as your regular OS user. No external database URL or custom SQL is accepted.

Inspect the plan without creating files or finding binaries:

```sh
npm run demo:pooling -- --dry-run
```

Set `PSLAB_PG_BIN` to the PostgreSQL server tools directory. The existing Postgres.app setting still applies:

```sh
export PSLAB_PG_BIN="/Applications/Postgres.app/Contents/Versions/17/bin"
```

Check PgBouncer availability with `command -v pgbouncer` and `pgbouncer --version`. If it is outside PATH, set `PSLAB_PGBOUNCER_BIN` to its complete executable path. Installation is a separate prerequisite; the dry run needs neither server.

After reading the plan:

```sh
npm run demo:pooling -- --approve-lab
```

The command prints the artifact directory, manifest hash and HTML path. Open `pooling-report.html`. Inspect the recorded JSON with:

```sh
npm run demo:pooling -- inspect RUN_DIRECTORY MANIFEST_HASH
```

Replace both placeholders with the values from your run. Retain the hash separately. After one hour inspection reports `STALE`, preserving the historical measurements.

## Review, validate and export

Use the run directory printed by the experiment. Set it once in your terminal:

```sh
PSLAB_POOL_RUN="cases/pooling-your-run-directory"
node src/cli.ts pooling compare "$PSLAB_POOL_RUN"
```

The comparison shows the direct baseline, the measured backend switch, the reset and timeout controls, both remedies and the competing explanations. It reads retained files only. Its hash binds the run, manifest, probe catalog and plan.

The guided workflow is the easiest way to decide. Run `npm run guide`, choose 2 and pick a run labelled "PgBouncer session". Choose 5 to run a new experiment first; it requires the same explicit approval phrase.

There are two separate decisions, stored in `pooling-reviews.jsonl` inside the run directory:

1. **Cause review.** Accept, reject or request changes on: "The SQL prepared statement was unavailable on the backend used by the next transaction after the measured backend switch." Acceptance is scoped to the local experiment and never chooses a remedy.
2. **Remedy selection.** After acceptance, select `transaction-contained` or `protocol-prepared`. The record binds to the exact accepted cause record and comparison. A later rejection, request for changes or re-acceptance withdraws it; re-accepting requires a fresh selection. Selecting a different remedy appends a new record, and validation then claims only the newest one.

For scripted use, generate a template, fill in `reviewer`, `decision` or `remedy`, and `rationale`, then record it:

```sh
node src/cli.ts pooling review-template "$PSLAB_POOL_RUN" cause > "$PSLAB_POOL_RUN/cause-input.json"
node src/cli.ts pooling review "$PSLAB_POOL_RUN" "$PSLAB_POOL_RUN/cause-input.json"
node src/cli.ts pooling review-template "$PSLAB_POOL_RUN" remedy > "$PSLAB_POOL_RUN/remedy-input.json"
node src/cli.ts pooling review "$PSLAB_POOL_RUN" "$PSLAB_POOL_RUN/remedy-input.json"
```

Outdated templates, concurrent writers, expired evidence and recognized sensitive text are refused before anything is written. Earlier records are never changed.

`pooling validate` checks retained observations from the completed run; it makes no database connection. It requires fresh evidence, a current accepted cause and a selected remedy. It confirms the original 26000 after the measured switch and the selected remedy's evidence with a count of one. For `protocol-prepared` it also checks that success held across the measured backend switch with the recorded transaction pool and `max_prepared_statements=10`.

```sh
node src/cli.ts pooling validate "$PSLAB_POOL_RUN"
node src/cli.ts pooling export "$PSLAB_POOL_RUN" "$PSLAB_POOL_RUN/support-bundle"
node src/cli.ts lab verify-bundle "$PSLAB_POOL_RUN/support-bundle"
```

Use `--gaps-only` with `pooling export` for an unreviewed or expired run; it withholds the cause, remedy and validation claims. `lab verify-bundle` reads the manifest and uses the pooling verifier only for `scenario: pooling-session` with tool version `0.1.0-pooling-bundle1`, `0.1.0-pooling-bundle2` or `0.1.0-pooling-bundle3`. New exports use `0.1.0-pooling-bundle3`, which adds the [print layout](support-bundle.md#print-a-report) to the report and otherwise matches bundle2. Other scenario or version values are refused. See the [support bundle guide](support-bundle.md#pgbouncer-session-bundles) for the file inventory.

Customer resolution stays unset and customer-message approval stays pending throughout.

## Controlled comparison

The owned pool uses transaction mode, two server connections, `max_prepared_statements=10`, LIFO reuse and no forced reset after each transaction. Actual settings and routing are checked through the PgBouncer admin console. Each transaction verifies the run marker, database and application role. Both servers use private Unix sockets with TCP disabled.

| Check | Required observation |
|---|---|
| Direct baseline | SQL PREPARE and EXECUTE succeed across transactions on the same backend. |
| Transaction pool | Client B holds A's original backend. A's next transaction verifies another backend and EXECUTE returns 26000. |
| Direct reset control | DEALLOCATE ALL removes the statement; EXECUTE returns 26000 on the original direct backend. |
| Transaction-contained remedy | PREPARE, EXECUTE and DEALLOCATE ALL succeed in one pooled transaction. |
| Driver preparation | A named protocol-level prepared query succeeds before and after a controlled backend switch. |
| Timeout control | A bounded statement timeout produces 57014 on a direct connection. |

Unexpected measurements remain in `pooling-run.json` but get no passing manifest. Process failures write a sanitized failure summary when possible. Existing output directories are refused. Cleanup stops only owned processes. Failed cleanup retains the temporary server files and reports their directory.

## Evidence and interpretation

The manifest binds the versioned run artifact and fixed probe catalog. Inspection checks shape, run identity, phase order, target/role, timestamps, query hashes, outcomes and backend continuity. A separately retained hash detects consistent rewrites. Hashes cannot authenticate the collector. HTML and Markdown are derived views outside this verification claim.

The direct reset control shows why error 26000 alone is insufficient. Ask which endpoint handled the operation, whether the connector uses SQL or protocol-level preparation, whether sessions reset, and which pool mode/settings applied. Compare the exact operation on a direct connection with the same role and database before extending the finding to a customer environment.

## Documentation and PlanetScale profile

[PgBouncer configuration](https://www.pgbouncer.org/config.html#max_prepared_statements), checked on 28 September 2026: a non-zero `max_prepared_statements` tracks protocol-level named prepared statements across server connections, while SQL `PREPARE` and `EXECUTE` are passed straight to PostgreSQL. The experiment tests both paths.

### The PlanetScale connection profile

`profiles/planetscale-postgres.v1.json` records what PlanetScale documents about pooling, TLS and connection strings. Each fact keeps the exact passage it comes from, the page URL, the time it was retrieved and a sha256 hash of both the passage and the page. The facts are classed as `DOCUMENTED_BEHAVIOR`. None of them was tested against PlanetScale.

Sources, retrieved on 4 October 2026:

- [Connections overview](https://planetscale.com/docs/postgres/connecting)
- [PgBouncer](https://planetscale.com/docs/postgres/connecting/pgbouncer)

The passages were taken from the Markdown version of each page (the same URL ending in `.md`), and each one was also checked against the rendered page. To recheck them later, download both Markdown pages into a folder as `connecting.md` and `pgbouncer.md`, then run:

```sh
node src/cli.ts profile check-sources FOLDER
```

It reports each page with one of four statuses:

- `UNCHANGED`: the downloaded page has the same sha256 hash as the recorded one, and every quoted passage is on it.
- `PAGE_CHANGED_PASSAGES_PRESENT`: the page has changed, but every quoted passage is still on it word for word.
- `PASSAGES_CHANGED`: at least one quoted passage is not on the page. `missingPassages` lists the facts affected. A missing passage requires review even when the page hash matches.
- `MISSING`: no downloaded copy was found, so its passages were not checked. `missingPassages` is `null`.

Two summary fields sit beside those statuses:

- `allPassagesPresent` is true when every quoted passage was found. It says only that the words are still there.
- `sourceReviewRequired` is true when any page has changed or is missing. A retained passage can still mean something different if the text around it changed, so a person needs to read the changed page and decide whether each fact still holds. The tool does not interpret the change.

The command exits with status 0 only when every page is unchanged. It exits with status 1 whenever review is required, including when every passage is still present.

### Comparing a run with the profile

```sh
node src/cli.ts pooling profile-check DIR
```

This sets a run beside the profile in three separate groups:

1. **What the local run measured.** Shown only while the run's evidence is still fresh and a person has accepted the cause, the same rules that review and validation follow. Otherwise this group is withheld and the reasons are listed.
2. **What PlanetScale documents**, with the source of each fact.
3. **What to ask the customer**, such as which port the app used and whether its driver prepares statements with SQL or at the protocol level.

Where a local setting and a documented fact concern the same thing, the check places them side by side. For example, the local run used `max_prepared_statements=10`, while PlanetScale documents a default of 200. That's a comparison, not a test: the check never connects to PlanetScale or a customer environment and never claims to have done so.

## Verification

`npm test` covers contract mutations, expiry, trusted anchors, symlinks, bounded reads, escaping and execution approval. `npm run test:pooling` executes the real experiment twice and checks cleanup and overwrite refusal. CI installs PostgreSQL 16 and PgBouncer on Ubuntu 24.04. A macOS walkthrough (PostgreSQL 17, PgBouncer 1.25) completed on 29 September 2026. See the [example run](../examples/pooling-run/README.md).
