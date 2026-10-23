# Missing-relation investigation: runbook candidate

DRAFT: publication and reuse review pending.

Source run: 2667abe9-4c4a-444a-a263-d8b51dbb933f
Evidence status: RESOLUTION_VALIDATED (local-lab)

## Qualifying symptom

An application reports relation-not-found. Capture the original SQLSTATE and exact relation identifier.

## Investigation steps

1. Verify the failing connection target and effective role.
2. Inspect search path, exact schema and identifier casing.
3. Collect bounded relation and privilege observations.
4. Check migration history on that same target.
5. Test alternatives in an isolated lab. A schema-qualified control can help investigate visibility.
6. Review the evidence before selecting a cause.
7. Approve any change for its declared environment, then repeat the original query and expected-behavior checks.

## Confounders

Wrong target, quoted identifiers, search path and missing privileges can affect interpretation. A successful migration command alone does not establish target state.

## Validation boundary

This source bundle validates only its declared local query when the local review and freshness gates pass. Customer resolution requires customer-scoped post-action evidence.
