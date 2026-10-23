# Reproduce the local investigation

Requires Node.js 24, pinned dependencies and PostgreSQL 16, 17 or 18 server tools. Run from the project checkout as a regular OS user.

```sh
npm ci
npm run demo:postgres -- --dry-run
npm run demo:postgres -- --approve-lab
```

The command creates a new disposable cluster with synthetic data, executes the bundled scenario, retains new evidence and removes the cluster. It requires explicit approval because setup and the migration write to that owned lab.

Recorded query outcome: error before the migration, success afterward. Recorded matching rows after the migration: 1.

Recorded cleanup: COMPLETE. No additional database execution occurs during bundle export.

Exact baseline, migration and probe SQL: sources/probes.json. The review decision must be made separately for each new run.
