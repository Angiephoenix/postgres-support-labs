# PgBouncer session investigation

Evidence: MEASURED. Review: NOT_REVIEWED.

This disposable local experiment follows a SQL PREPARE statement across transactions. A second client holds the original server connection so the next transaction must use another backend.

| Check | Backend | SQLSTATE | Count |
|---|---|---|---|
| Direct: prepare and execute | 1397 | none | 1 |
| Direct: execute in the next transaction | 1397 | none | 1 |
| Pooled: prepare and execute | 1398 | none | 1 |
| Pooled: execute after a measured backend change | 1399 | 26000 | unavailable |
| Direct control: execute after DEALLOCATE ALL | 1397 | 26000 | unavailable |
| Pooled remedy: prepare, execute and deallocate in one transaction | 1398 | none | 1 |
| Driver prepared statement: first transaction | 1398 | none | 1 |
| Driver prepared statement: changed backend | 1399 | none | 1 |
| Direct control: bounded statement timeout | 1397 | 57014 | unavailable |

The pooled SQL EXECUTE failed after a measured backend change. The direct reset control produced the same error on the same backend. Error 26000 alone cannot identify the connection mode or cause. The timeout control produced a different error, 57014.

The direct session preserved the SQL statement across transactions. The pooled transaction-contained workflow also succeeded. Driver-level named prepared statements succeeded across the measured backend change with max_prepared_statements=10. Choose a remedy that matches the application workflow and verify it in the affected environment.

Next questions: Which endpoint handled the failing operation? Does the connector use SQL PREPARE or protocol-level preparation? Does it reset sessions? Which pooling mode and prepared-statement setting were active? Can the same operation be compared on a direct connection with matching role and database?

Scope: synthetic local PostgreSQL and PgBouncer. Human cause review, customer resolution and message approval remain pending. This checkpoint records a measured experiment; integration with the shared review and support-bundle workflow remains pending.
