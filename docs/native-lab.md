# Native PostgreSQL lab

This lab reproduces the "table doesn't exist" error on a temporary PostgreSQL server it creates for itself, using synthetic data and the Node.js `pg` driver. It records four checks: a working development database, an affected database with the migration missing, a control where the table exists but sits outside the search path, and the affected database again after the migration is applied.

## Setup and execution

Use Node.js 24 or later and matching `initdb`, `pg_ctl` and `postgres` tools from PostgreSQL 16, 17 or 18. Run as your ordinary operating-system user. PostgreSQL refuses root execution, and the runner preserves that restriction.

On a Mac with the PostgreSQL 17 edition of Postgres.app:

```sh
npm ci
export PSLAB_PG_BIN="/Applications/Postgres.app/Contents/Versions/17/bin"
npm run demo:postgres -- --dry-run
npm run demo:postgres -- --approve-lab
```

The dry run displays the plan without discovering server tools, creating files or connecting. Execution requires the explicit flag. It creates synthetic databases, grants privileges, applies the bundled lab migration and cleans up its cluster. Output is written to a new directory under `cases/` and its location is printed on success. Installation and macOS application permission prompts are handled outside the runner.

On Linux, set `PSLAB_PG_BIN` to the installed server binary directory. For example, Ubuntu's PostgreSQL 16 package normally places it at `/usr/lib/postgresql/16/bin`. Without that variable, the runner searches PATH for a directory containing all three tools.

## Isolation and limits

The runner creates an owner-only directory under `/tmp`, a fresh data directory and a private Unix socket. TCP listeners are disabled. The socket's port number is local to its unique directory; an existing server listening on TCP 5432 is outside this connection path. PostgreSQL environment targets are excluded from child processes and the pg client receives explicit connection settings. No database URL, remote host or user-provided SQL is accepted.

Only setup and migration use the cluster owner. Evidence comes from the dedicated `pslab_app` role, with schema USAGE and table SELECT permissions. Database TEMP and public schema CREATE privileges are revoked. Collection uses a read-only repeatable-read transaction, fixed statements, connection/statement/lock timeouts and bounded metadata results. Collected application query output consists of row counts. The retained probe catalog includes the reviewed synthetic seed SQL.

The owner verifies the running server's data directory and cluster system identifier. Each application connection verifies the randomly generated run marker in its database. The recorded target fingerprint binds the cluster fingerprint, database and marker. This is local lab identity; it is not PlanetScale branch verification. The local operating-system account, installed binaries and repository code remain trusted.

## Expected observations

| Snapshot | Application query | Migration | Relation inventory |
|---|---|---|---|
| `development` | Success with one matching label | Applied | Present and visible |
| `before` | SQLSTATE `42P01` | Absent | Absent in the bounded lookup |
| `search-path-control` | SQLSTATE `42P01` | Applied | Present but outside the effective search path |
| `after` | Success with one matching label | Applied | Present and visible |

The search-path control also executes the schema-qualified query and checks that it returns one matching label. The affected database retains the same target fingerprint, role, query shape and search path before and after the migration. Each snapshot receives its own bound case and six required observations. The search-path control also records the qualified-query observation in its ledger, preserving history without describing a real state change as a correction of bad evidence.

## Retained evidence

The output directory contains:

- `plan.json`: the approved operations and run identifier.
- `probes.json`: bundled SQL, synthetic application parameters and migration text.
- One case directory for each snapshot, with `case.json` and `evidence.jsonl`.
- `run.json`: bounded results, evidence IDs, snapshot head hashes and cleanup status.

Version-three case and observation schemas separate measured local-lab records from imported fixtures. A local-lab observation cannot enter a fixture case, and fixture records cannot satisfy a local-lab case. Query hashes cover the exact bundled SQL text using the project's canonical JSON hashing function. Parameters are not included in that query hash. Observations expire after one hour; history remains inspectable afterward.

`ledger gaps` can read each version-three snapshot. The failure snapshots can cover all six requirements. Successful development and post-change snapshots leave the original failure requirement open because they do not reproduce that error. The run report preserves those successful observations for the future comparison and validation workflow.

The local migration check is a measured result. Cause acceptance, human review and customer resolution remain unset. Source labels and hashes make artifacts inspectable but do not authenticate their author. An owner can rewrite local files, including the run report and stored hashes. This is not yet a complete independently anchored support bundle.

## Cleanup and failures

Normal completion stops this run's server before removing its temporary directory. Catchable errors also attempt cleanup and retain available case artifacts. A failed stop leaves the temporary directory intact and reports its path. Inspect that directory and use its exact `data` path with `pg_ctl` before removing anything.

SIGINT and SIGTERM request cancellation between bounded operations. A forced kill or machine shutdown can leave files or a server behind; automatic orphan recovery is pending. Existing output directories are refused. An interrupted run may contain only partial artifacts and must not be treated as a completed reproduction.

## Verification

```sh
npm test
npm run test:postgres
```

The default suite covers the fixture workflow, schemas, provenance separation, dry runs and CLI refusal of external inputs. The integration command requires actual PostgreSQL tools and runs two independent clusters to check repeatability, both failure modes, post-migration results, evidence integrity, refused output reuse and cleanup. It fails when server prerequisites are missing; it never reports a skipped database test as a pass.

The GitHub Actions workflow runs the integration command on Ubuntu with PostgreSQL 16. When this runner was added, a development CI run passed all 64 default tests and the real-database integration test. The Mac path targets Postgres.app 17. On 22 October 2026 the integration test also passed on macOS 12.7.6 with PostgreSQL 17.11 (Postgres.app); the [build checkpoint](build-checkpoint.md) records that run and the current Linux results.

## Implementation references

Consulted on 27 September 2026:

- [node-postgres Client configuration and queries](https://node-postgres.com/apis/client)
- [PostgreSQL initdb](https://www.postgresql.org/docs/17/app-initdb.html)
- [PostgreSQL pg_ctl](https://www.postgresql.org/docs/17/app-pg-ctl.html)
- [Connection and Unix socket configuration](https://www.postgresql.org/docs/17/runtime-config-connection.html)
- [Read-only transactions](https://www.postgresql.org/docs/17/sql-set-transaction.html)
- [Session, privilege and visibility functions](https://www.postgresql.org/docs/17/functions-info.html)
