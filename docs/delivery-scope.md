# Delivery scope

This page tracks what version one of Postgres Support Lab includes, what works today and what's still to build. Version one is six labs plus the shared tooling they rely on. The core stays vendor-neutral, and PlanetScale Postgres is the first platform it plans to support.

## Where things stand

The missing-table lab works end to end on a local machine: it reproduces the failure, runs a control that produces the same error for a different reason, compares the before and after states, records a person's review, checks the fix locally and exports a support bundle with customer and engineering drafts. The guided workflow covers intake, choosing a run, review and export. A support report you enter stays separate from the lab's own synthetic case.

The PgBouncer lab measures what happens to a SQL prepared statement when PgBouncer runs the next transaction on a different PostgreSQL server connection. It includes reset and timeout controls and two possible fixes. A person records a cause decision and, separately, which fix to check, and the lab exports a verifiable bundle. The experiment has also been run on macOS 12 with PostgreSQL 17 (Postgres.app) and PgBouncer 1.25 (MacPorts), based on terminal output and screenshots from that run on 29 September 2026.

The slow-query lab measures one customer filter on 200,000 synthetic rows with `EXPLAIN (ANALYZE, BUFFERS)`: without column statistics, after `ANALYZE`, and before and after an index, with each query repeated and a common value checked with the index in place. Literal values are replaced with `$1` throughout the retained plans. A person records a cause decision and selects the fix, and validation compares plans, results and shared blocks; timing is supporting evidence only.

The connectivity lab starts a TLS-only server on 127.0.0.1 with temporary certificates and records the stage at which each connection attempt stops. The reviewed scenario is a client that doesn't trust the issuing CA: the same connection fails certificate verification, then succeeds with chain and host-name checks passing once only the trusted CA changes. Other failures serve as controls. Passwords, keys and paths are not retained. The experiment, review and export have also been run on macOS with PostgreSQL 17.11 (Postgres.app) and OpenSSL 3.6.4, and the exported bundle verified against its anchor, on 6 October 2026. On 12 October 2026 the experiment also completed on macOS with LibreSSL 2.8.3; that run hasn't been reviewed.

The permissions lab measures a table the application role can find but not read, because it was created after a grant on all tables in its schema. Controls connect as a different role, a role without schema `USAGE` and a role whose search path leaves out the schema, and a single `GRANT SELECT` on the one table is checked by comparing the grants on the lab schemas and their tables, with grant options, before and after. A person records a cause decision and, separately, selects that grant; validation then checks the retained evidence, and the lab exports a verifiable bundle. The experiment has been tested locally on Linux with PostgreSQL 16.13, and in Linux CI on PostgreSQL 16, 17 and 18. On 22 October 2026 its integration tests also passed on macOS 12.7.6 with PostgreSQL 17.11 (Postgres.app).

The pool-exhaustion experiment runs an in-process request handler against a small `pg` pool. A handler that releases its client only on success leaks a client for each failing query, and later requests time out even with no load. Controls exhaust the same pool through demand, a query held on the server, open transactions and a pool larger than the server allows. Each recovers once its load ends, except server refusal, which fails on connect with SQLSTATE `53300`. The same request plan with a handler that releases in `finally` leaves no client checked out. A person records a cause decision and, separately, selects that fix; validation then checks the retained evidence, and the lab exports a verifiable bundle. It has been tested locally on Linux with PostgreSQL 16.13; CI runs it on 16, 17 and 18. On 22 October 2026 its integration tests also passed on macOS 12.7.6 with PostgreSQL 17.11 (Postgres.app), and a new run there exported a gap-only bundle that verified against its anchor.

All six labs remain part of version one.

## The six labs

| Lab | Working today | Still to build | What it exercises |
|---|---|---|---|
| Missing tables and schema drift | Local missing migration, a working fix, a same-error search-path control, review and export | Wrong-target and name-casing cases, general branch comparison and a standalone practice pack | Schema changes, SQL and evidence-based debugging |
| Session behavior through PgBouncer | SQL versus driver-level prepared statements, measured server-connection switches, reset and timeout controls, two fixes, review and export | More workflows, including cases where the operation itself is invalid and routing boundaries | Connection pooling and driver behavior |
| SSL, authentication and connection strings | An untrusted issuing CA: controlled failures by connection stage, labelled connection shapes without secrets, a verified before-and-after check, review and export | Client certificates and `verify-ca`, public CAs and `sslrootcert=system`, direct TLS negotiation and a guided workflow | Connectivity and deployment troubleshooting |
| Permissions and search path | A table created after a grant on all tables: wrong-role, schema `USAGE` and search-path controls, a measured one-table `GRANT SELECT`, with the lab schemas' and tables' grants compared before and after; tested locally on PostgreSQL 16.13, in Linux CI on 16, 17 and 18 and on macOS with 17.11; review, a local check of the fix and export | Row-level security, column privileges, roles that inherit access and a guided workflow | PostgreSQL permissions and which role an app really uses |
| Slow queries and indexes | A missing index on a selective filter: skewed synthetic data, normalized `EXPLAIN` JSON, statistics, repeated-run and selectivity controls, a before-and-after index check, review and export | An index that exists but goes unused because of a type or function mismatch, and a guided workflow | Query plans and performance |
| Application pool exhaustion | A handler that leaks its pool client when a query fails: checkouts recorded by request, client and backend PID and cross-checked against pool events, counters and server sessions; demand, slow-query, long-transaction and server-refusal controls; the same request plan replayed with a release-in-`finally` fix; tested locally on PostgreSQL 16.13, with CI on 16, 17 and 18 and on macOS with 17.11; review, a local check of the fix and export | A leak inside an aborted transaction, an idle-in-transaction timeout control, a CHECK-violation trigger and a guided workflow | Debugging across the application and the database |

## Shared work still in version one

| Area | What's still needed |
|---|---|
| Contracts | General artifact schemas, full classification coverage, stable case fingerprints and versioned documentation references beyond the PlanetScale profile. A first [guide for writing new labs](writing-a-lab.md) exists. |
| Collection and safety | A PlanetScale-aware connection and identity policy (the documented connection profile exists; no live connection yet), an optional public read-only smoke test, bounded import and redaction rules, and a proper SQL parser before the lab accepts any SQL input |
| Reproduction | A Docker setup alongside the native one, a fuller synthetic project-tracker dataset, and repeatable setup, reset and cleanup for every lab |
| Comparisons | General comparisons across branch, role, connection mode, query plan and successive runs |
| Communication | A recorded approval step for customer messages, reviewed runbook publication and consistent drafts across all labs |
| Hardening | Broader tests for secrets, SQL and scope, secret scanning, recovery from interrupted runs and clean-checkout checks |
| Ready for new users | Walkthroughs, remaining browser and phone checks, more finished examples, architecture and contribution docs, a short demo and a case study |

Connecting to a customer's own database is a future opt-in feature, planned only after the policy and redaction work is done. A paid PlanetScale account is optional. Neither should become a requirement for finishing the local version-one labs, and the optional public smoke test must never block ordinary CI.

## Order of work

1. Guided intake and local review and export, keeping explicit human judgment and evidence checks. (Done for the first two labs.)
2. Reusable lab packs, starting with PgBouncer and a documented PlanetScale connection profile. (Packs for all six labs, shared review, validation and export code, and a documented profile of pooling, TLS and connection-string facts are in place. A live PlanetScale connection is not part of this step.)
3. Query and index evidence (the missing-index case is in place), then the connectivity (the untrusted-CA case is in place), permissions (the table-grant case is in place) and pool-exhaustion labs. Each one includes a competing explanation, a measured fix, a local check and support drafts.
4. Shared hardening, communication and documentation, then a clean-checkout check and feedback from real users.
5. A demonstration and case study based on what actually runs.

There's no percentage or finish date here. The labs differ in size, and much of the evidence tooling is shared. Progress is measured by what can be demonstrated, and one polished lab doesn't count as finishing all six.

## What the current results do and don't show

The labs show scoped PostgreSQL reproductions, catalog and permission checks, controlled comparisons, recorded human reviews and consistent support drafts. The PgBouncer work is a local prepared-statement experiment with controls, a recorded review and a check of one selected fix. None of it shows how a managed platform behaves or what happened in a real customer's environment. The slow-query work is a local comparison of one query on synthetic data, with a recorded review and a check of one index. The connectivity work uses a local server and temporary certificates; it doesn't test PlanetScale or a customer network. The permissions work is a local experiment with synthetic roles, a recorded review and a check of one grant; it doesn't test PlanetScale or a customer's roles. The pool-exhaustion work is a local experiment with a synthetic handler, a recorded review and a check of one code change; it doesn't test PlanetScale or a customer's application. A live PlanetScale connection is still planned.
