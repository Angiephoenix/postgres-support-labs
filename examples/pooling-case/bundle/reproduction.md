# Reproduce the local experiment

Requires Node.js 24, pinned dependencies, PostgreSQL 16, 17 or 18 server tools and PgBouncer 1.21 or later within major version 1. Run from the project checkout as a regular OS user.

```sh
npm ci
npm run demo:pooling -- --dry-run
npm run demo:pooling -- --approve-lab
```

The command starts disposable PostgreSQL and PgBouncer processes on private Unix sockets, runs the fixed probes, retains new evidence and removes the servers. It requires explicit approval.

Recorded switch: pooling-pooled-first ran on backend 4140; pooling-pooled-next ran on backend 4141 while backend 4140 was held, and EXECUTE returned SQLSTATE 26000.

Recorded cleanup: COMPLETE. No database execution occurs during bundle export or validation.

Exact probe SQL: sources/pooling-probes.json. Each new run needs its own review decisions.
