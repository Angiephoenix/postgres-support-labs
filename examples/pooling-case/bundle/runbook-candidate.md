# Prepared statement unavailable through a pool: runbook candidate

DRAFT: publication and reuse review pending.

Source run: 915d109e-7dc7-435e-8cfa-cf04fb2b251b
Evidence status: RESOLUTION_VALIDATED (local-lab, protocol-prepared)

## Qualifying symptom

An application reports SQLSTATE 26000 (prepared statement does not exist) while connected through a pooler. Capture the exact error, statement name and time.

## Investigation steps

1. Identify which endpoint handled the failing request and the pool mode.
2. Determine whether the connector uses SQL PREPARE or protocol-level prepared statements.
3. Check whether the application or connector resets sessions (for example DEALLOCATE ALL or DISCARD).
4. Compare the same operation on a direct connection with the same role and database.
5. Reproduce in an isolated lab with a direct baseline, a reset control and a timeout control.
6. Review the evidence before selecting a cause.
7. Choose a remedy that matches the application workflow, approve it for its environment, then repeat the original operation.

## Confounders

Session resets produce the same 26000 without a pool. A port number alone does not prove the connection mode. Timeouts produce a different error (57014).

## Validation boundary

This source bundle validates only its selected remedy in the local experiment when the review and freshness gates pass. Customer resolution requires customer-scoped post-change evidence.
