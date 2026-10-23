# Prepared statements through PgBouncer

A short explanation of the [PgBouncer examples](../../examples/pooling-case/README.md): what was tested, what it shows and what it doesn't.

## The problem

"The connection works, but one step in the app fails." PgBouncer is a connection pooler. In transaction mode, it lends the app a PostgreSQL server connection for one transaction at a time, so the next transaction may run on a different one. Anything stored on the server connection, such as a statement prepared with SQL `PREPARE`, may not be there in the next transaction.

## What we tested

One synthetic database and one PgBouncer in transaction mode with two server connections. We ran the same prepared-statement steps:

1. Directly against PostgreSQL, across two transactions.
2. Through PgBouncer, while a second client held the first server connection so the next transaction had to use another one.
3. Directly again, after clearing the statement with `DEALLOCATE ALL`. This control removes the statement with no pooler involved.
4. With a deliberate statement timeout, a control that fails in a different way.
5. With two fixes: keeping all the steps in one transaction, and using the driver's own named prepared statements (protocol-level preparation).

## What the results show

- Through PgBouncer, after switching server connections, `EXECUTE` failed with `26000` ("prepared statement does not exist").
- Clearing the statement on a direct connection gave the same `26000`. So the error code alone doesn't prove the pooler is involved.
- Both fixes worked in this setup.

## What's still unknown

- Whether a real customer's failure has this cause. That needs evidence from their setup: whether the app connects directly or through a pooler, the pool mode, and whether their driver uses SQL `PREPARE` or its own named prepared statements.
- How PlanetScale or any managed pooler behaves. This test was local only.
- Other things stored on a session, such as advisory locks, `SET` values or temporary tables. They weren't tested.

## Cause versus fix

The lab records two separate decisions. The **cause review** asks whether the evidence supports this explanation for the local test: the SQL prepared statement was unavailable on the server connection used by the next transaction. The **remedy selection** then picks which fix the local check should cover. Both fixes worked here, and they suit different apps. Keeping the steps in one transaction changes the app's SQL. Using the driver's named prepared statements depends on the driver and on PgBouncer's `max_prepared_statements` setting, which lets the pooler make those statements available on whichever server connection runs the next transaction. A new cause decision withdraws the earlier fix selection, so a fix is never checked against a cause that's no longer accepted.

## Key points

1. **Transaction pooling.** In transaction mode, one app connection to PgBouncer can use different PostgreSQL server connections from one transaction to the next.
2. **Controls.** Clearing the statement on a direct connection gives the same error with no pooler at all, so you need evidence of which path the failing request took.
3. **SQL versus driver preparation.** A statement made with SQL `PREPARE` lives on one server connection. The driver's named prepared statements kept working across the switch because PgBouncer's `max_prepared_statements` setting tracks them.
4. **Scope.** A local result shows what can cause the problem. It doesn't prove what happened in a customer's environment.
5. **Cause versus fix.** Accepting a cause doesn't choose a fix, and the local check covers exactly one selected fix.
