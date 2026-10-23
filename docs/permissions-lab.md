# Permissions and search path lab

The table exists, but the app can't query it. The error says permission denied, or that the relation doesn't exist. Several different causes produce those same errors: the app connecting as a different role than expected, a role without access to the schema, a role without access to the table, or a search path that leaves out the table's schema. This lab reproduces each one on a disposable local server and records the role, search path, catalog entry and privileges behind each error, so you can tell them apart before suggesting a change.

The scenario is one problem. The application role was given `SELECT ON ALL TABLES IN SCHEMA app_data`. A later migration created `app_data.project_tasks` and granted nothing. A grant on all tables covers only the tables that exist when it runs, so the application role can find the new table but can't read it. Every other check in the run is a control.

A fresh run leaves the cause and the customer's resolution unset. A reviewer records a cause decision, selects the fix to check, and exports a verifiable support bundle. See [review, validate and export](#review-validate-and-export).

## Run the experiment

Use Node.js 24+ and matching PostgreSQL 16–18 server tools. Run as your regular OS user. No external database URL, custom SQL or connection string is accepted.

Look at the plan first. This creates no files and starts nothing:

```sh
npm run demo:permissions -- --dry-run
```

Set `PSLAB_PG_BIN` to the PostgreSQL server tools directory if they aren't on your PATH. After reading the plan:

```sh
npm run demo:permissions -- --approve-lab
```

The command prints the artifact directory, manifest hash and HTML path. Open `permissions-report.html`. Inspect the recorded JSON with:

```sh
npm run demo:permissions -- inspect RUN_DIRECTORY MANIFEST_HASH
```

The server listens only on a private Unix socket, with TCP turned off. The synthetic roles have no passwords. Every statement the lab runs is fixed in `src/permissions-evidence.ts` and copied into `permissions-probes.json`.

## What each check does

Each check opens a new connection as one role and runs the same fixed read-only queries: the session's role and effective search path, a catalog lookup for the table, the role's privileges on the schema and table, and one count query, first without the schema name and then with it.

| Check | Role | What it shows |
|---|---|---|
| Baseline | `pslab_app` | The application role reads `app_data.projects`, which existed when it was given access. Its connection, role and schema access work. |
| The failure | `pslab_app` | The same role queries `project_tasks`. It has USAGE on `app_data`, the schema is in its search path and the catalog lists the table; only SELECT on the table is missing. Both forms of the query return SQLSTATE `42501`, permission denied for the table. |
| Wrong role | `pslab_reporting` | A different role returns the same SQLSTATE and the same kind of message. Only the session's `current_user` tells the two apart. |
| No schema USAGE | `pslab_nousage` | A role with SELECT on the table but no USAGE on the schema. PostgreSQL leaves the schema out of the effective search path, so the query without the schema name returns `42P01`, relation does not exist, as if the table were missing. With the schema name it is refused at the schema. |
| Search path | `pslab_path` | A role with schema and table access whose search path is only `public`. The query without the schema name also returns `42P01`, but the schema-qualified query works. |
| After the fix | `pslab_app` | After `GRANT SELECT ON app_data.project_tasks TO pslab_app`, the same query by the same role succeeds. INSERT, UPDATE, DELETE and TRUNCATE on the table and CREATE on the schema stay unavailable. |
| Wrong role after the fix | `pslab_reporting` | Still refused, so the grant reached only the intended role. |

Before and after the fix, the lab records the grants on the `app_data`, `lab_meta` and `public` schemas and on the tables in `app_data` and `lab_meta`, each with its grant option. Grants to the owner role, database-level grants such as `CONNECT`, column grants and grants on other schemas are not collected. It also records each lab role's attributes and number of role memberships, and the database's count of default-privilege entries. The run is accepted only if the single difference is an ordinary SELECT on `app_data.project_tasks` for `pslab_app`, without the grant option, so it cannot be granted onward. Each check's recorded privileges, search path and current schema must also match what these snapshots say for its role.

Error messages are not retained. Each failed query keeps its SQLSTATE and one of a few fixed categories: permission denied for a table, permission denied for a schema, relation does not exist, or other.

## The smallest change, and what it leaves out

The fix is one statement: `GRANT SELECT ON app_data.project_tasks TO pslab_app`. Broader changes would also make the error go away, but they aren't fixes: granting `ALL`, granting a superuser or owner role, or connecting as the table owner.

The run also records how many default-privilege entries the database has (none, in this lab). `ALTER DEFAULT PRIVILEGES` could give tables created later the same access. It is a suggestion for the engineering follow-up only; this lab doesn't test it.

## Review, validate and export

Use the run directory printed by the experiment:

```sh
PSLAB_PERM_RUN="cases/permissions-your-run-directory"
node src/cli.ts permissions compare "$PSLAB_PERM_RUN"
```

The comparison shows the baseline, the failure and the fix together, then each control, the grant change and the competing explanations. It reads retained files only.

There are two separate decisions, stored in `permissions-reviews.jsonl` on the same review chain the other labs use:

1. **Cause review.** Accept, reject or request changes on: "The application role could find app_data.project_tasks but had no SELECT on it. It had USAGE on app_data and the schema was in its search path. The table was created after SELECT was granted on all tables in the schema, and a grant on all tables covers only the tables that exist when it runs."
2. **Remedy selection.** After acceptance, select `grant-table-select`. A later rejection or request for changes withdraws the selection.

Each template is generated, edited by hand and then submitted. The templates start with safe defaults, so nothing is accepted or selected until you change the fields yourself. The lab never records a decision for you.

**Step 1: cause review.** Generate the cause template:

```sh
node src/cli.ts permissions review-template "$PSLAB_PERM_RUN" cause > "$PSLAB_PERM_RUN/cause-input.json"
```

Edit `cause-input.json`:

- set `reviewer` to your name or handle;
- set `rationale` to the reason for your decision, at least 10 characters;
- set `decision` to `accept`, `reject` or `request-changes`. The template starts at `request-changes`, so an acceptance must be chosen deliberately;
- leave `remedy` and `causeReviewHash` as `null`.

Then submit it:

```sh
node src/cli.ts permissions review "$PSLAB_PERM_RUN" "$PSLAB_PERM_RUN/cause-input.json"
```

Continue to remedy selection only if you accepted the cause.

**Step 2: remedy selection.** After the acceptance is recorded, generate a fresh remedy template. Don't reuse an earlier one: the cause review moved the review head, and the remedy template is refused until the cause is accepted.

```sh
node src/cli.ts permissions review-template "$PSLAB_PERM_RUN" remedy > "$PSLAB_PERM_RUN/remedy-input.json"
```

Edit `remedy-input.json`:

- set `reviewer` and `rationale` as above;
- set `remedy` to `"grant-table-select"`. The template starts at `null`, which is refused, so the remedy must be chosen deliberately;
- keep `decision` as `select`.

Then submit it:

```sh
node src/cli.ts permissions review "$PSLAB_PERM_RUN" "$PSLAB_PERM_RUN/remedy-input.json"
```

**In both templates, keep the generated values** of `comparisonHash`, `expectedReviewHead` and, in the remedy template, `causeReviewHash`. They bind your decision to the comparison and review history you inspected. If they no longer match, the review is refused and you need a fresh template.

`permissions validate` reads the retained checks and grant snapshots and makes no database connection. It requires fresh evidence, an accepted cause and the selected fix, and then checks that:

- the baseline read the existing table as the application role;
- the failure was the application role, with schema USAGE and the schema in its search path, refused with `42501` for the table with and without the schema name;
- the controls separate a different role, a missing schema USAGE and a search path without the schema;
- the only grant added was SELECT on `app_data.project_tasks` for `pslab_app`, without the grant option, with nothing removed, role attributes and memberships unchanged, and no default privileges;
- every check's privileges, search path and current schema agree with the grant snapshots;
- the same query by the same role succeeded after the fix, with no INSERT, UPDATE, DELETE, TRUNCATE or schema CREATE;
- the different role was still refused after the fix.

```sh
node src/cli.ts permissions validate "$PSLAB_PERM_RUN"
node src/cli.ts permissions export "$PSLAB_PERM_RUN" "$PSLAB_PERM_RUN/support-bundle"
node src/cli.ts lab verify-bundle "$PSLAB_PERM_RUN/support-bundle"
```

Use `--gaps-only` with `permissions export` for an unreviewed or expired run, or whenever no fix should be claimed. A gap-only export, including one from a run whose cause was accepted:

- presents the cause as "Proposed explanation, awaiting review";
- says "No remedy is validated in this gap-only export" in the report, `resolution-validation.md` and the runbook draft;
- leaves the checks, their results, the verification details and the cause and remedy references out of `validation.json`, and the validation hash out of the engineering draft;
- keeps the blockers, because they name what is still missing.

`lab verify-bundle` uses the permissions verifier only for `scenario: table-privilege` with tool version `0.1.0-permissions-bundle1` or `0.1.0-permissions-bundle2`. New exports use `0.1.0-permissions-bundle2`, which adds the [print layout](support-bundle.md#print-a-report) to the report and says in the reproduction note that the lab has also been tested on macOS 12.7.6 with PostgreSQL 17.11. `0.1.0-permissions-bundle1` exports keep their original text, including "macOS has not been tested", and still verify. The export holds the same drafts as the other labs: a case summary, an evidence gap report, a customer reply, an engineering handoff and a runbook candidate. Customer resolution stays unset and customer-message approval stays pending in every one.

## Tested platforms

- **Tested locally:** Linux with PostgreSQL 16.13. The integration test runs the experiment twice, checks every recorded result against the contract above, and checks that no temporary cluster or server is left.
- **Tested in Linux CI:** PostgreSQL 16, 17 and 18, at development commit `13aab49`. Version 16 comes from Ubuntu's packages, and 17 and 18 from the PostgreSQL apt repository. For each version, the three permissions integration tests passed, with no failures or skips. The CI logs don't record the exact minor versions of 17 and 18.
- **Tested on macOS:** macOS 12.7.6 (x86_64) with PostgreSQL 17.11 (Postgres.app) and Node 24.13.1, from a fresh clone of `main` at development commit `4b88770`. On 22 October 2026 the four permissions integration tests passed, with no failures or skips.

The review, validation and export steps were added after that CI run. Their test results are reported with the change that added them.

**Report rendering.** The run report, a reviewed bundle report and a gap-only bundle report were checked in Chromium at 390px and 1280px wide, with every evidence section and draft expanded, and showed no horizontal overflow or clipping. This was not a check in other browsers, on a physical phone, in print or for accessibility.

## Limits

Each check is one synthetic role in one disposable local database. It doesn't cover row-level security, column privileges, roles that inherit access through group roles, PlanetScale or a customer environment. Customer resolution stays unset and customer-message approval stays pending.
