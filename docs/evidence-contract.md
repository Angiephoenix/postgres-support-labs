# Schema-resolution evidence contract

Before anyone explains a missing-table error, six questions need answers: which database handled the request, which role and search path it used, whether the table exists, whether the role can use it, whether the migration ran there, and what exactly failed. The evidence report tracks which questions have a usable answer. The fixture path uses imported synthetic observations. Version-three cases can also use measured observations from the [native PostgreSQL lab](native-lab.md).

## Run the demonstration

```sh
npm run demo:evidence
```

The demonstration moves from 0/6 requirements covered to 6/6, introduces conflicting inventory evidence, appends a correction and reevaluates the records after their expiry. It creates temporary files, performs no database queries and cleans up afterward. `examples/investigation-fixture.ts` supplies the complete fixture and generates fresh timestamps. Its observations expire after 60 seconds to make freshness behavior visible.

For a persistent version-two fixture or version-three local-lab case, run:

```sh
node src/cli.ts ledger gaps cases/my-case
node src/cli.ts ledger gaps cases/my-case --json
```

The command reads one validated ledger snapshot and writes its report to stdout. It does not modify the case. `--dry-run` describes the operation without reading case files. The report records its evaluation time and ledger head hash.

## Case binding

`schemas/case.v2.json` adds the original synthetic intake and a fixed investigation subject: relation, schema, migration identifier, query-shape hash and expected branch fingerprint. Known intake environment, relation and connection mode must agree with the case. The first evidence entry links to the complete case hash, including its intake.

Each observation must match the case's environment, observed branch, effective role and connection mode. Its result must also match the relevant investigation subject before it can satisfy a requirement. An observed branch that differs from the expected affected branch leaves downstream requirements open. The identity observation can still record that mismatch.

## Required observation types

| Requirement | Required result | Subject matching |
|---|---|---|
| `target_identity` | Expected and observed branch fingerprints, fixture identity method | Expected branch |
| `effective_context` | Database, effective role fingerprint, search path, current schema | Case scope; role must agree with provenance |
| `relation_inventory` | Relation, schema, visibility, coverage boundary | Exact relation and schema |
| `permissions` | Relation, schema, schema USAGE and relation SELECT results | Exact relation and schema |
| `migration_state` | Migration identifier, target branch, applied state | Exact migration identifier; target must agree with provenance |
| `failure_observation` | Relation, schema, SQLSTATE, query-shape hash, outcome | Exact relation, schema and query shape; error must match known intake SQLSTATE |

All results require a limitations field. The permissions payload currently describes SELECT access; broader operation-specific privilege contracts remain pending. A role-limited inventory observation can cover the collection requirement while retaining its visibility limitation. It cannot establish that a relation is globally absent.

## Coverage states

| State | Meaning |
|---|---|
| `MISSING` | No typed record was supplied for the requirement. |
| `UNUSABLE` | Supplied records cannot cover it because of scope, subject, freshness, ancestry or failure mismatch. |
| `CONFLICTING` | Current relevant records disagree on result fields. |
| `SATISFIED` | At least one current matching observation is usable and no current result conflict remains. |

Excluded records keep their IDs and reasons. Supporting records retain source, collection time, expiry and limitations. Legacy observations appear separately as unmapped evidence.

Conflict detection compares the typed result fields within each requirement, excluding the limitations text. It is deliberately conservative: a newer record does not silently replace an older current record. Use an explicit correction for an erroneous observation. A genuine change over time needs the future comparison workflow. Cross-requirement diagnosis and semantic conflict analysis remain pending.

Superseded records stay in history. Stale records and records with unavailable parents cannot satisfy coverage. Expiry is reevaluated when the report runs, so a previously complete report can become incomplete.

## Completeness and review

The overall status becomes `FIXTURE_EVIDENCE_COMPLETE` only when all six requirements are satisfied. Cause and resolution remain null, and review remains `NOT_REVIEWED`. A complete fixture contract means the required imported synthetic observations are available for further evaluation. It does not establish a cause, verify a live target or validate a correction in a customer environment.

Version-one cases remain readable through `ledger inspect`, and the original intake-only `gaps` command remains available. Create a new version-two case to use bound-intake reporting. There is no automatic history migration or relabeling of legacy evidence. Version-two observations require a version-two case.

The [ledger guide](evidence-ledger.md) describes hashing, trusted checkpoints and filesystem limits. This reporting command checks internal consistency without an external anchor; use `ledger inspect DIR HEAD_HASH` when comparing against a separately saved trusted checkpoint. Owners can rewrite local files and recompute their hashes. Native PostgreSQL collection is implemented for an owned temporary cluster. Independent provenance authentication and external database collectors remain pending.

For version-three local-lab cases, complete coverage uses `LOCAL_LAB_EVIDENCE_COMPLETE`. The relation inventory also records whether the relation was present in its bounded lookup. Relation SELECT permission is null when the relation is absent. Failure observations retain a bounded matching-row count for successful probes. Fixture and local-lab cases reject each other's observation versions.
