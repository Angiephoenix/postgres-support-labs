# Evidence ledger

The evidence ledger is an append-only record of what was observed during an investigation. Every entry says where it came from, which case and scope it belongs to, and when it expires. Corrections are added as new entries, so you can always see what was recorded first.

## What the ledger checks

A case owns one explicit fixture or local-lab scope. Each imported observation must match its case ID, environment, branch fingerprint, role fingerprint, connection mode and identity method. Fixture scope uses fixture-definition identity. Version-three local-lab scope uses a run marker and cluster fingerprint; this identifies a controlled local target and cannot establish a managed database branch identity.

Case and observation JSON Schemas live in `schemas/`. Runtime validation implements the schema keywords used by these files, plus semantic checks for time, references, duplicate content and corrections. Unknown fields fail validation. Timestamps must be canonical UTC strings with milliseconds.

Version-one observations contain relation name, schema name, visibility, SQLSTATE and collection limitations. Version two adds six typed payloads for the [schema-resolution evidence contract](evidence-contract.md). Provenance includes a fixture ID/version, probe ID, query hash, collector version, collection scope and redaction declaration. Imported provenance remains caller-supplied. The [native runner](native-lab.md) produces version-three measurements with local-lab source labels and run IDs.

## Commands

Run the self-cleaning demonstration:

```sh
npm run demo:ledger
```

To retain a case, first prepare configuration and observation JSON matching the bundled schemas. `scripts/ledger-demo.ts` contains a complete synthetic example and creates current timestamps on each run. Create the parent directory with `mkdir -p cases`, then use:

```sh
node src/cli.ts ledger init cases/my-case case-config.json
node src/cli.ts ledger append cases/my-case observation.json
node src/cli.ts ledger inspect cases/my-case
```

`init` refuses an existing directory. `append` scans input, checks contracts and records its admission time. `inspect` verifies history and computes freshness at the current time. All commands support a final `--dry-run`, which describes the operation without reading input or changing files.

For verification against a saved checkpoint, pass the previously saved `headHash` as the final positional argument to `inspect`. The optional anchor must be a 64-character lowercase SHA-256 hash. Exact checkpoint verification rejects additional records as well as removals or alterations; save a new anchor after an intended append.

## Files and integrity

`case.json` stores the fixed case binding. `evidence.jsonl` contains ordered entries. The first entry links to the canonical case hash. Each subsequent entry links to its predecessor and contains its own hash over the canonical entry body. Inspection also returns the raw ledger file hash and entry count as a compact integrity summary. The ledger has no manifest of its own. An exported support bundle does: its manifest records a hash for every file in the bundle, and `lab verify-bundle` checks it (see the [support bundle guide](support-bundle.md)).

The API preserves previous entry bytes and appends a new line. For this bounded implementation, it writes the complete next file to a temporary sibling, flushes the file and renames it under an exclusive writer lock. This keeps readers from seeing a partially appended line during normal execution. Records are append-only through the application API. The underlying file remains writable by its owner.

Input JSON is bounded to 64 KiB and ledger reads/writes to 8 MiB. The case directory and direct artifact file paths reject symlinks. The parent directory and local operating-system account remain trusted; this is not a sandbox against a malicious local process. New case directories use owner-only permissions and new artifact files use owner read/write permissions.

## Freshness, history and corrections

Expired observations remain in history and receive `STALE` during inspection. Admission requires collection time at or before the admission clock, and expiry strictly after admission. A clock moving behind the last admission is rejected. Historical verification evaluates whether an observation was admissible when recorded.

A correction requires an existing active target, a reason, matching probe and collection scope, the same observation subject and a collection time at least as recent as the target. Its target becomes `SUPERSEDED`. Corrections may replace expired records. A correction cannot use its superseded target as supporting evidence.

Parents must precede the new entry, be at least as old as the observation, be current at admission and retain current ancestry. Missing, stale or superseded parents block admission. If a parent later expires or is superseded, dependent observations become `PARENT_UNAVAILABLE`, including transitive descendants. This status keeps unusable lineage visible without rewriting history.

Classification remains `REPRODUCED_BEHAVIOR` with an explicit fixture or local-lab source. The taxonomy reserves supported causes and validated resolutions for the separate review and validation steps of each lab; the observation schema rejects these values. Imported labels alone cannot prove execution; the native runner records actual local measurements. Customer outcomes require separate validation.

## Failure and recovery boundaries

A pre-existing `.ledger.lock` blocks writers. A killed process may leave a lock or temporary file. Confirm no writer is running, preserve the case directory, and inspect its history before any manual recovery. Automatic stale-lock recovery is deferred.

Malformed, reordered, partially written or hash-mismatched history blocks reads and appends. Restore from a trusted copy rather than editing history to make verification pass. Filesystem power-loss durability, adversarial local processes, signed provenance and automatic repair are outside this checkpoint's guarantees.

The intake-only gap command requests all required observations. `ledger gaps` evaluates typed records against a version-two or version-three case with bound intake, retaining unsupported requirements and evidence references. Native lab collection is implemented; external database collection remains pending.
