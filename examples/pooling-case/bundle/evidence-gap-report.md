# Evidence gap report

Local PostgreSQL and PgBouncer experiment with synthetic data. Customer environment unverified. Customer resolution pending.

- No local evidence gaps at export.

## Customer evidence still required

- Identify which endpoint (direct or pooled) handled the failing request, and the pool mode in use.
- Determine whether the connector uses SQL PREPARE or protocol-level prepared statements, and whether it resets sessions.
- Compare the same operation on a direct connection with the same role and database.
- Collect post-change results after an approved customer change.
- Obtain customer-message approval before sending a response.
