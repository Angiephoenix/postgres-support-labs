# Customer reply draft

DRAFT: human communication approval pending.

We reproduced a prepared-statement error (SQLSTATE 26000) in a separate local test with PgBouncer in transaction mode. A statement prepared with SQL PREPARE was unavailable when the next transaction ran on a different server connection. The same workflow succeeded on a direct connection. In that test we validated one approach: use driver-level (protocol) named prepared statements with PgBouncer max_prepared_statements enabled.

The local result does not confirm the state of your environment. The same error can also appear when a session is reset. Please confirm which endpoint handled the failing request, the pool mode, whether your driver uses SQL PREPARE or protocol-level prepared statements, and whether it resets sessions. Share sanitized settings and error output; omit connection strings, credentials and customer rows.

Any change in your environment needs its own approval and post-change validation.
