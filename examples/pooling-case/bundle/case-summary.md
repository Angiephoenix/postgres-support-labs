# Case summary

Exported: 2026-09-29T20:22:48.408Z
Status at export: RESOLUTION_VALIDATED (local-lab, protocol-prepared)
Run: 915d109e-7dc7-435e-8cfa-cf04fb2b251b

Local PostgreSQL and PgBouncer experiment with synthetic data. Customer environment unverified. Customer resolution pending.

The reviewer accepted this explanation for the local experiment: The SQL prepared statement was unavailable on the backend used by the next transaction after the measured backend switch.

Recorded switch: pooling-pooled-first ran on backend 4140; pooling-pooled-next ran on backend 4141 while backend 4140 was held, and EXECUTE returned SQLSTATE 26000.

Selected remedy: protocol-prepared. Use driver-level (protocol) named prepared statements with PgBouncer max_prepared_statements enabled.

Business impact: unknown.

Comparison: abc00e6477dc319a48c9d1daaa912b0050fde44443b6030a22107ee4815d5920
Review head: a5b579f909b9a9ff2cdd782f8de40cb287272cc136b6ad0eef15fbe3460707ed

Communication approval: pending.
