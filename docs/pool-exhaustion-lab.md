# Application pool exhaustion lab

Requests hang waiting for a database connection, then fail with a pool timeout. The application might be leaking connections, failing to return them to its pool. It might also simply be busy, running slow queries, holding transactions open, or hitting PostgreSQL's connection limit. This lab reproduces a leak and each of those alternatives on a disposable local server. For every checkout it records which request took which client and backend, so you can tell them apart before suggesting a change.

The scenario is one problem. An in-process request handler checks a client out of a [`pg`](https://node-postgres.com/) pool, runs one query and releases the client only when the query succeeds:

```js
const client = await pool.connect();
const result = await client.query(request.sql, request.params);
client.release();
return result.rows;
```

A request whose input divides by zero fails with SQLSTATE `22012` and never reaches `client.release()`. Every other phase in the run is a control.

A fresh run leaves the cause and the customer's resolution unset. A reviewer records a cause decision, selects the fix to check, and exports a verifiable support bundle. See [review, validate and export](#review-validate-and-export).

## Run the experiment

Use Node.js 24+ and matching PostgreSQL 16–18 server tools. Run as your regular OS user. No external database URL, custom SQL or connection string is accepted.

Look at the plan first. This creates no files and starts nothing:

```sh
npm run demo:pool-exhaustion -- --dry-run
```

Set `PSLAB_PG_BIN` to the PostgreSQL server tools directory if they aren't on your PATH. After reading the plan:

```sh
npm run demo:pool-exhaustion -- --approve-lab
```

The command prints the artifact directory, manifest hash and HTML path. Open `pool-exhaustion-report.html`. Inspect the recorded JSON with:

```sh
npm run demo:pool-exhaustion -- inspect RUN_DIRECTORY MANIFEST_HASH
```

The server listens only on a private Unix socket, with TCP turned off. It has 8 connection slots, 2 of them reserved for superusers. The synthetic application role has no password. Every statement and both handlers are fixed in `src/pool-exhaustion-evidence.ts` and copied into `pool-exhaustion-probes.json`, so the manifest binds the code that ran.

## What each phase does

Each phase uses a new pool, with 3 clients and an 800 ms checkout timeout, unless the table says otherwise. Idle clients are kept, so the pool's counts change only through requests. A phase starts only when the server shows no sessions left from earlier phases.

| Phase | Code path | What it shows |
|---|---|---|
| Baseline | original handler | Valid requests alone check out and release normally. The leak needs a failing request. |
| The leak | original handler | 3 failing requests, then a valid probe, a quiet period of 1 s with no load, then a valid recovery request. The failing requests keep their clients, the probe and the recovery request both time out, and nothing recovers on its own. |
| Demand beyond capacity | original handler | 12 requests that each hold a client for at least 400 ms. The pool is exhausted, some requests get the same checkout timeout as the leak, and once the load ends every client is released and the next request succeeds. |
| Slow query | original handler | 3 queries are held running on the server by an advisory lock the lab holds. A probe times out. When the lab releases the lock, the queries finish and the pool recovers. |
| Long transaction | transaction harness for the held transactions; original handler for warm-up, probe and recovery | 3 transactions are left open by the application between `BEGIN` and `COMMIT`. The server shows them as idle in transaction. A probe times out, and the pool recovers when they commit. The harness is control code and always releases its client. |
| Server refusal | original handler | A pool that allows 8 clients against a server with 5 free ordinary slots. Connections open one at a time, each held by the lab's lock, so exactly the free slots are taken. Every later connection is refused by PostgreSQL with SQLSTATE `53300`. A new pool connects again once this one closes. |
| After the fix | fixed handler | The same failing requests, probe, quiet period and recovery request as the leak, in the same order. |
| Demand after the fix | fixed handler | The same demand plan. Checkout timeouts still occur, so the fix does not address capacity. |

The leak and fix phases share one request plan, and so do the two demand phases. The run records a hash of each plan, and the checker rejects a run where the requests differ.

## How it is measured

- **Leases.** The handler gets the pool through a thin wrapper that records which request each checkout belongs to. A lease runs from pg-pool's `acquire` event to its `release` event and keeps the request, the client and the client's backend PID. The handler code itself is unchanged.
- **Pool events.** Every `connect`, `acquire`, `release` (with or without an error) and `remove` event is numbered in the order pg-pool emitted it.
- **Pool counters.** `totalCount`, `idleCount` and `waitingCount`, read at each checkpoint.
- **Server sessions.** At each checkpoint a separate superuser connection reads `pg_stat_activity` for the phase's own `application_name`: PID, state, wait event and whether a transaction is open.
- **Client errors.** Every client and pool `error` event is recorded in order. A run with any error event during measurement is rejected.
- **Checkpoints.** A quiescent checkpoint waits until nothing is in flight, no client is connecting or being removed, and the server shows one session per pool client. A live checkpoint waits for its own condition, for example every client checked out with requests waiting. Both give up after 5 s, and an unreached checkpoint fails the run.

The checker rebuilds each pool's history from its events and requires the leases, counters and sessions at every checkpoint to agree with it. In particular:

- Each phase must match its own bundled plan, not only the phase that replays it: the requests in order, with their step, kind and code path, and the checkpoints, each with its kind and pool.
- Every event, lease, client error and checkpoint must name a pool its plan uses: pool 1, plus pool 2 for the server-refusal recovery.
- Every lease a request names must exist and belong to that request, its pool and its client.
- Each acquire and release event belongs to exactly one lease, and a lease ends at its client's next release.
- Clients connected at the same time can't share a backend PID.
- Nothing is recorded after a phase's last checkpoint.
- At every checkpoint, live or quiescent, the pool's counters and the server's sessions must match the connected and checked-out clients rebuilt from the events. No checkpoint falls while a client is connecting or being removed, and the runner waits for that before taking one.
- Sessions at quiescent checkpoints must be idle outside a transaction.
- Teardown must account for every client the phase connected.

It does not require exact counts that depend on the machine, such as how many demand requests succeed. It requires each control to show exhaustion and then recovery.

## What shows a leak, and what doesn't

A leak is supported only when all of these hold together:

1. With nothing in flight and no request waiting, the failing requests' leases are still open. There is one for each failing request, and none was released.
2. Each open lease's backend session is `idle` on the server, not running a query and not in a transaction.
3. After a quiet period longer than the checkout timeout, the same leases are still open on the same idle sessions, and a new valid request still times out.
4. The same request plan with the fixed handler leaves no lease open.

Each of these is inconclusive on its own:
- a checkout timeout: demand, a slow query and a long transaction all produce exactly the same error;
- requests waiting, or every client in use;
- idle server sessions, which an idle pool also shows;
- `idle in transaction`, which the long-transaction control also shows;
- any timing.

Without per-request checkout records, which most customer reports won't have, server sessions can suggest a leak but not show one. Other applications sharing the role, or PgBouncer in transaction mode, break the link between a server session and an application checkout. PgBouncer is out of scope here.

## Errors and their categories

Error messages are not retained. Each failed request keeps its SQLSTATE, if any, and a fixed category.

| Category | Source | SQLSTATE |
|---|---|---|
| Division by zero | the failing request's query | `22012` |
| Pool checkout timeout | pg-pool gave up waiting for a client to be released | none |
| Pool connection timeout | pg-pool gave up opening a new connection | none |
| Remaining slots reserved | PostgreSQL refused a non-superuser because only reserved slots were left | `53300` |
| Too many clients | PostgreSQL had no slots left at all | `53300` |
| Role connection limit | the role reached its own connection limit | `53300` |

These were measured on PostgreSQL 16.13 with pg 8.23.0 and pg-pool 3.14.0: division by zero, pool checkout timeout and remaining slots reserved during lab runs, and too many clients and role connection limit in a separate prototype. Pool connection timeout comes from reading pg-pool's code and wasn't reproduced. The lab's own phases expect only division by zero, pool checkout timeout and remaining slots reserved.

## The fix, and what it leaves out

The fix releases in `finally` and passes the error when the query failed, so pg-pool discards a client that may be in an unknown state instead of reusing it:

```js
const client = await pool.connect();
let failure;
try {
  const result = await client.query(request.sql, request.params);
  return result.rows;
} catch (error) {
  failure = error;
  throw error;
} finally {
  client.release(failure);
}
```

The query, the pool configuration and the request plan are the same before and after. Only the handler's release handling changes.

Two other options, neither of them checked by this lab:
- `pool.query()` releases its client on both paths and suits code that runs a single statement. It is a suggestion only.
- A larger pool may meet a genuine need for more capacity. The demand control shows the same timeout with no leak, but a larger pool doesn't fix a leak: leaked clients would still accumulate until it too is exhausted.

## Cleanup and its limits

Shutdown never waits without a limit. In a prototype, pg-pool's `end()` never resolved while clients were leaked. Also, a leaked client without an `error` listener crashed Node when the server was stopped, before the prototype's cleanup could run. So the lab works this way:

- **Error listeners:** every client gets one as soon as it connects.
- **Bounded shutdown:** each client is ended directly with a 2 s limit, then the pool with a 2 s limit.
- **Teardown kept separate:** forced cleanup happens only after a phase's measurement is closed. It is recorded separately in `teardown`, with the number of leases it found open, and is never counted as a release by the code under test.
- **Confirmed stop:** the owned server is stopped with `pg_ctl stop` (`fast`, then `immediate`). Its directory is removed only after `pg_ctl status` reports no server and the PID file is gone. If the stop can't be confirmed, the directory is kept, cleanup is reported as failed and the error names the directory.

The integration tests check cleanup after a failure while leaked leases are open, and the case where the server can't be stopped. A process killed with `SIGKILL`, or a machine that loses power, still leaves the cluster and its directory behind.

## Review, validate and export

Use the run directory printed by the experiment:

```sh
PSLAB_POOL_RUN="cases/pool-exhaustion-your-run-directory"
node src/cli.ts pool-exhaustion compare "$PSLAB_POOL_RUN"
```

The comparison shows the baseline, the leak and the fix together, then each control, the handler change and the competing explanations. It reads retained files only and is rebuilt from a run that passes the evidence checks above.

There are two separate decisions, stored in `pool-exhaustion-reviews.jsonl` on the same review chain the other labs use:

1. **Cause review.** Accept, reject or request changes on: "The request handler released its pool client only when its query succeeded. Each request whose query failed kept its client checked out on an idle server session, so once the failed requests equalled the pool size, later requests waited for a client and timed out, even with no load."
2. **Remedy selection.** After acceptance, select `release-in-finally`. A later rejection or request for changes withdraws the selection, and a new acceptance needs a new selection.

Each template is generated, edited by hand and then submitted. The templates start with safe defaults, so nothing is accepted or selected until you change the fields yourself. The lab never records a decision for you.

**Step 1: cause review.** Generate the cause template:

```sh
node src/cli.ts pool-exhaustion review-template "$PSLAB_POOL_RUN" cause > "$PSLAB_POOL_RUN/cause-input.json"
```

Edit `cause-input.json`:

- set `reviewer` to your name or handle;
- set `rationale` to the reason for your decision, at least 10 characters;
- set `decision` to `accept`, `reject` or `request-changes`. The template starts at `request-changes`, so an acceptance must be chosen deliberately;
- leave `remedy` and `causeReviewHash` as `null`.

Then submit it:

```sh
node src/cli.ts pool-exhaustion review "$PSLAB_POOL_RUN" "$PSLAB_POOL_RUN/cause-input.json"
```

Continue to remedy selection only if you accepted the cause.

**Step 2: remedy selection.** After the acceptance is recorded, generate a fresh remedy template. Don't reuse an earlier one: the cause review moved the review head, and the remedy template is refused until the cause is accepted.

```sh
node src/cli.ts pool-exhaustion review-template "$PSLAB_POOL_RUN" remedy > "$PSLAB_POOL_RUN/remedy-input.json"
```

Edit `remedy-input.json`:

- set `reviewer` and `rationale` as above;
- set `remedy` to `"release-in-finally"`. The template starts at `null`, which is refused, so the remedy must be chosen deliberately;
- keep `decision` as `select`.

Then submit it:

```sh
node src/cli.ts pool-exhaustion review "$PSLAB_POOL_RUN" "$PSLAB_POOL_RUN/remedy-input.json"
```

**In both templates, keep the generated values** of `comparisonHash`, `expectedReviewHead` and, in the remedy template, `causeReviewHash`. They bind your decision to the comparison and review history you inspected. If they no longer match, the review is refused and you need a fresh template. Expired evidence blocks both decisions, and an acceptance stops counting once the evidence expires.

`pool-exhaustion validate` reads the retained pool events, checkouts, counters and server sessions and makes no database connection. It requires fresh evidence, an accepted cause and the selected fix, and then checks that:

- the baseline's valid requests all succeeded and left no checkout open;
- with the original handler, every failing request's checkout was still open on an idle session after the quiet period, and the probe and recovery request timed out;
- demand, slow queries and open transactions each timed out a request and then recovered, and the server-refusal control got `53300` on connect and no pool timeout;
- the leak and fix phases ran the same request plan, pool configuration and server settings;
- the only change between the handlers is the release handling: `client.release();` replaced by a `try`, `catch` and `finally` ending in `client.release(failure);`;
- with the fixed handler, every failing request released its client with the error before the next checkpoint, no checkout was left open, and the probe and recovery request succeeded;
- the demand control still timed out with the fixed handler, so the fix does not change capacity;
- the clients closed by forced cleanup match the leaked checkouts and were not counted as released.

```sh
node src/cli.ts pool-exhaustion validate "$PSLAB_POOL_RUN"
node src/cli.ts pool-exhaustion export "$PSLAB_POOL_RUN" "$PSLAB_POOL_RUN/support-bundle"
node src/cli.ts lab verify-bundle "$PSLAB_POOL_RUN/support-bundle"
```

Use `--gaps-only` with `pool-exhaustion export` for an unreviewed or expired run, or whenever no fix should be claimed. A gap-only export, including one from a run whose cause was accepted:

- presents the cause as "Proposed explanation, awaiting review";
- says "No remedy is validated in this gap-only export" in the report, `resolution-validation.md` and the runbook draft;
- leaves the checks, their results, the verification details and the cause and remedy references out of `validation.json`, the remedy out of the manifest and findings, and the validation hash out of the engineering draft;
- keeps the blockers, because they name what is still missing.

`lab verify-bundle` uses the pool-exhaustion verifier only for `scenario: connection-leak` with tool version `0.1.0-pool-exhaustion-bundle1` or `0.1.0-pool-exhaustion-bundle2`. It rebuilds every output from the bundle's sources. New exports use `0.1.0-pool-exhaustion-bundle2`, which adds the [print layout](support-bundle.md#print-a-report) to the report and says in the reproduction note that the lab has also been tested on macOS 12.7.6 with PostgreSQL 17.11. `0.1.0-pool-exhaustion-bundle1` exports keep their original text, including "macOS has not been tested", and still verify. The export holds the same drafts as the other labs: a case summary, an evidence gap report, a customer reply, an engineering handoff and a runbook candidate. Customer resolution stays unset and customer-message approval stays pending in every one. `pool.query()` appears only as an unvalidated suggestion, and a larger pool only as a possible answer to genuine demand, never as a fix for a leak.

## Where it has been tested

Tested locally on Linux with PostgreSQL 16.13, Node 24.21.0, pg 8.23.0 and pg-pool 3.14.0. CI runs the integration tests on PostgreSQL 16, 17 and 18.

On 22 October 2026 the lab was also tested on macOS 12.7.6 (x86_64) with PostgreSQL 17.11 (Postgres.app) and Node 24.13.1, from a fresh clone of `main` at development commit `4b88770`. The five integration tests passed, with no failures or skips. A new run completed with cleanup `COMPLETE`, and its gap-only bundle verified with `integrity` and `semanticConsistency` both `VALID` and `anchorChecked: true`. That run wasn't reviewed.

In Safari on that Mac, the comparison table of a gap-only bundle report was checked at desktop width and in a narrower window. Nothing was clipped or overlapping in those views. The exact widths and the Safari version weren't recorded, and this wasn't a check of the whole report, on a physical phone, in print or for accessibility.

## Not yet built

- A guided terminal workflow.
- Deferred: a control for `idle_in_transaction_session_timeout`, a leak inside an aborted transaction, and a failing request that violates a CHECK constraint.
