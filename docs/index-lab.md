# Slow query and index lab

A customer says a query that looks up one customer's orders is slow. Is the table missing an index, are the planner's statistics out of date, does the value match so many rows that an index wouldn't help, or was the data just not in memory yet? This lab measures each of those on a disposable local PostgreSQL server with synthetic data, so you can see which explanation the evidence supports before you suggest a change.

A fresh run leaves the cause and the customer's resolution unset. A reviewer then records a cause decision, selects the fix to check, and exports a verifiable support bundle. See [review, validate and export](#review-validate-and-export).

## Run the experiment

Use Node.js 24+ and matching PostgreSQL 16–18 server tools. Run as your regular OS user. No external database URL or custom SQL is accepted, and PgBouncer isn't needed.

Look at the plan first. This creates no files and starts nothing:

```sh
npm run demo:index -- --dry-run
```

Set `PSLAB_PG_BIN` to the PostgreSQL server tools directory if they aren't on your PATH, for example:

```sh
export PSLAB_PG_BIN="/Applications/Postgres.app/Contents/Versions/17/bin"
```

After reading the plan:

```sh
npm run demo:index -- --approve-lab
```

The command prints the artifact directory, manifest hash and HTML path. Open `index-report.html`. Inspect the recorded JSON with:

```sh
npm run demo:index -- inspect RUN_DIRECTORY MANIFEST_HASH
```

Keep the hash somewhere separate. After one hour, inspection reports `STALE` and keeps the historical measurements.

## What the run measures

The server listens only on a private Unix socket with TCP turned off. It loads 200,000 synthetic orders. The `customer_id` column is skewed on purpose: one value matches 5 rows (the "rare" value) and another matches 60,000 rows, 30% of the table (the "common" value). Every measurement runs the same query, which filters on `customer_id`:

```sql
SELECT count(*)::int AS orders, coalesce(sum(amount_cents), 0)::bigint AS total FROM orders WHERE customer_id = $1
```

Each step records the query result and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. `EXPLAIN` shows the plan PostgreSQL chose. `ANALYZE` runs the query and adds actual row counts and timing. `BUFFERS` adds the number of 8 kB blocks the query used through PostgreSQL's shared buffers, split into blocks already in shared buffers ("hit") and blocks PostgreSQL had to read into shared buffers ("read"). A read may be served by the operating system's file cache instead of the disk, so these counts don't show physical disk activity. This lab uses shared blocks as its main measure of work, because the counts don't depend on how fast your machine is.

| Step | What changes | What it tells you |
|---|---|---|
| Rare value, no column statistics | Nothing yet | The plan and row estimate when the planner has no statistics for the column |
| Rare value, after `ANALYZE` | Statistics collected | Whether fresh statistics alone change the plan or the work |
| Same query repeated, no index | Nothing | How many blocks were already in shared buffers on a second run, and how many had to be read into them |
| Rare value with the index | `CREATE INDEX orders_customer_id_idx ON orders (customer_id)` | The plan, result and work with the fix in place |
| Same query repeated, with the index | Nothing | Whether the reduced work holds on a second run |
| Common value with the index | A value that matches 30% of rows | The plan the planner chooses when the filter isn't selective |

### How the statistics control works

PostgreSQL keeps statistics about each column, such as common values and how they're distributed, and the planner uses them to estimate how many rows a filter will match. `ANALYZE` collects them. Autovacuum normally runs `ANALYZE` in the background. For the first step the lab turns autovacuum off for the cluster and the table and doesn't run `ANALYZE` after loading, so that measurement runs on a table with no column statistics. The run records this setup in `statisticsSetup`, and each step records whether column statistics existed.

The comparison sets the planner's estimated rows beside the actual rows for both runs. In a reference run on PostgreSQL 16, the estimate went from 1,216 rows to 6 (5 actually matched), and both runs used the same sequential scan with the same number of blocks. Statistics improved the estimate. They couldn't change the plan, because there was no index to use.

### How the repeated-run check works

Each query runs twice in a row, before and after the index. The second run usually finds more blocks already in shared buffers. Comparing the two shows how many blocks PostgreSQL found in shared buffers and how many it read into them in this lab. Those reads may come from the operating system's cache, so the check doesn't show disk activity. It doesn't prove that a cold cache caused a customer's slowdown, and it doesn't rule caching out.

### How the selectivity control works

Selectivity means the share of rows a filter matches. An index helps most when it lets the query skip almost all of the table. For the common value, the lab runs the same query with the index available and current statistics, and records whichever plan the planner picks. In the same reference run it chose a bitmap heap scan using the index. The lab never forces a scan type: a sequential scan isn't labelled slow, and for a value that matches a large share of rows it can be the right plan.

### What stays the same

Across the before-and-after comparison, the data, target database, role, query and planner settings stay the same. The run checks this rather than assuming it:

- A fingerprint of every row is taken after loading and again at the end, and the two must match.
- Every step records a hash of the relevant planner settings (cost settings, scan switches, `work_mem`, `shared_buffers` and others), and the hashes must match.
- The lab role turns off parallel workers and JIT compilation, so plans stay comparable between runs. Scan choices are left to the planner.
- Every rare-value step must return the same count and total.

### Literal values

PostgreSQL can run `EXPLAIN` with bound parameters through the extended query protocol. This runner doesn't use that. As an implementation choice, it writes one of the two bundled integer values into the `EXPLAIN` text, so each plan is planned for that specific value. It then replaces the value with `$1` everywhere in the retained plan, including the `Filter`, `Index Cond` and `Recheck Cond` fields. The result query that follows runs with a bound parameter. Inspection rejects a run if a literal value remains anywhere in a retained plan, or if a stored plan summary doesn't match its plan.

### Timing

Each step records planning and execution time in milliseconds. Timing is supporting local evidence only. It varies between machines and runs, and validation doesn't require any particular speedup.

## Review, validate and export

Use the run directory printed by the experiment:

```sh
PSLAB_INDEX_RUN="cases/index-your-run-directory"
node src/cli.ts index compare "$PSLAB_INDEX_RUN"
```

The comparison shows the statistics control, the before-and-after steps, the selectivity control and the competing explanations. It reads retained files only. Its hash binds the run, manifest, probe catalog and plan.

There are two separate decisions, stored in `index-reviews.jsonl` inside the run directory:

1. **Cause review.** Accept, reject or request changes on: "Without an index on customer_id, the query scanned the whole orders table to return the few rows that matched." Acceptance is scoped to the local experiment and doesn't choose a fix.
2. **Remedy selection.** After acceptance, select `create-index`. The record binds to the exact accepted cause record and comparison. A later rejection, request for changes or re-acceptance withdraws it.

Generate a template, fill in `reviewer`, `decision` or `remedy`, and `rationale`, then record it:

```sh
node src/cli.ts index review-template "$PSLAB_INDEX_RUN" cause > "$PSLAB_INDEX_RUN/cause-input.json"
node src/cli.ts index review "$PSLAB_INDEX_RUN" "$PSLAB_INDEX_RUN/cause-input.json"
node src/cli.ts index review-template "$PSLAB_INDEX_RUN" remedy > "$PSLAB_INDEX_RUN/remedy-input.json"
node src/cli.ts index review "$PSLAB_INDEX_RUN" "$PSLAB_INDEX_RUN/remedy-input.json"
```

`index validate` checks retained plans from the completed run and makes no database connection. It requires fresh evidence, a current accepted cause and a selected fix, and then checks that:

- the data, query, role and planner settings matched before and after;
- every run returned the same result;
- the index didn't exist before;
- both indexed runs used the new index, through an index scan, an index-only scan or a bitmap heap scan;
- both indexed runs touched fewer shared blocks than the matching runs without the index.

The validation record also lists the local timings, marked as supporting evidence.

```sh
node src/cli.ts index validate "$PSLAB_INDEX_RUN"
node src/cli.ts index export "$PSLAB_INDEX_RUN" "$PSLAB_INDEX_RUN/support-bundle"
node src/cli.ts lab verify-bundle "$PSLAB_INDEX_RUN/support-bundle"
```

Use `--gaps-only` with `index export` for an unreviewed or expired run; it withholds the cause, fix and validation claims. `lab verify-bundle` uses the index verifier only for `scenario: slow-query-index` with tool version `0.1.0-index-bundle1` or `0.1.0-index-bundle2`. New exports use `0.1.0-index-bundle2`, which adds the [print layout](support-bundle.md#print-a-report) to the report and otherwise matches bundle1.

The bundle uses the same layout as the other labs: a case summary, an evidence gap report, a customer reply draft, an engineering handoff, a runbook candidate, the validation record and an HTML report. Customer resolution stays unset and customer-message approval stays pending throughout.

## What this doesn't show

The lab shows how one query behaves on synthetic data before and after one index. It doesn't show what's happening in a customer's database, and it doesn't measure the cost of keeping an extra index up to date on writes. Building an index on a large production table takes time, and a plain `CREATE INDEX` blocks writes to the table while it runs. Any change there needs its own approval and post-change check.

A second scenario, where an index exists but goes unused because of a type or function mismatch, is planned.
