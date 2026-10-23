# Evidence gap report

Status: EVIDENCE_REQUIRED
Issue family: schema-resolution

Customer-reported intake; observation collection is pending.

## target identity

A successful migration may have targeted another environment.

Collect: Compare the sanitized application target with the platform branch identifier. Exclude connection URIs.

Follow-up: Which branch handled the failed request, and how did you verify that target?

## effective context

Role and search path affect object resolution.

Collect: Collect current database, effective role and search path from the affected application connection; record time and scope.

Follow-up: Can you provide the effective database, role and search path from the failing connection?

## relation inventory

A visibility-limited lookup cannot establish global absence.

Collect: Collect bounded catalog metadata for the exact relation and relevant schemas, including visibility limitations.

Follow-up: What exact relation name and schema does the query use, including capitalization?

## permissions

Schema visibility and relation privileges need separate checks.

Collect: Inspect schema USAGE and required relation privileges under the application role.

Follow-up: Can the application role access the expected schema and relation?

## migration state

A reported successful command does not identify where it ran.

Collect: Collect sanitized migration identifiers and target-specific deployment evidence.

Follow-up: Which migration creates this relation, and what confirms it ran on the affected branch?

## failure observation

The failing operation must be tied to its environment and time.

Collect: Capture sanitized SQLSTATE and identifier-only query shape; omit literals and customer rows.

Follow-up: Can you share the SQLSTATE and sanitized query shape from the failed request?

Reported values remain unverified until scoped observations are collected. This report contains collection guidance only.

