# "Relation does not exist" after a migration

A short explanation of the [missing-table example](../../examples/schema-case/README.md): what was tested, what it shows and what it doesn't.

## The problem

"The feature works in development. Production says `relation "project_labels" does not exist`, and the migration command said it succeeded." That error (code `42P01`) has several possible causes. The migration might never have run on that database, the app might be connected somewhere else, the table might sit in a schema outside the search path, the name's capitalization might differ, or the app's role might not be able to see the schema. The search path is the list of schemas PostgreSQL checks when a query doesn't name one.

## What we tested

A temporary local PostgreSQL server with synthetic data, checked at four points:

1. **Development:** the migration was applied and the query worked.
2. **Affected database, before the fix:** the migration was missing and the query failed with `42P01`.
3. **Search-path control:** the migration was applied and the table existed, but its schema wasn't on the search path. The query failed with the same `42P01`. Naming the schema in the query made it work.
4. **Affected database, after the fix:** with the migration applied, the same query worked and returned one row.

The comparison checks that only the migration changed between "before" and "after". The database, role, connection, query, search path and schema access all stayed the same.

## What the results show

- In this local test, the missing migration explains the failure. Applying it changed the result, and nothing else that matters changed.
- The search-path control shows that `42P01` alone can't tell you the cause. It happened there even though the table existed.
- A person made the cause decision. The lab never accepts a cause by itself.

## What's still unknown

- Which cause applies to a real customer. That needs evidence from their affected database: which one the app used, its role, its search path and its migration history.
- The wrong-database and name-casing explanations are listed but haven't been reproduced as separate cases yet.
- Whether the customer's problem is fixed. A local fix doesn't close a production incident.

## Key points

1. **Reported versus observed.** "The migration succeeded" doesn't tell you which database it ran on. You need evidence from the database the app actually uses.
2. **Same error, different causes.** The search-path control produces the identical error with the table present, so the error message alone can't settle it.
3. **Change one thing at a time.** The before and after checks must match on everything except the migration. Otherwise you can't tell what made the difference.
4. **Fresh, local, and separate.** Evidence expires after an hour so stale results don't support new decisions, and a local check is kept separate from confirming the customer's fix.
