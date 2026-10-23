# Engineering handoff draft

Internal draft. Escalation need has not been established.

Local PostgreSQL and PgBouncer experiment with synthetic data. Customer environment unverified. Customer resolution pending.

The reviewer accepted this explanation for the local experiment: The SQL prepared statement was unavailable on the backend used by the next transaction after the measured backend switch.

Recorded switch: pooling-pooled-first ran on backend 4140; pooling-pooled-next ran on backend 4141 while backend 4140 was held, and EXECUTE returned SQLSTATE 26000.

Selected remedy: protocol-prepared. Use driver-level (protocol) named prepared statements with PgBouncer max_prepared_statements enabled.

## Direct baseline

- pooling-direct-first: direct backend 4139: success, count 1
- pooling-direct-next: direct backend 4139: success, count 1

## Controls

- pooling-direct-reset: direct backend 4139: SQLSTATE 26000
- pooling-timeout-control: direct backend 4139: SQLSTATE 57014

## Remedy evidence

- transaction-contained: pooling-pooled-contained: transaction backend 4140: success, count 1
- protocol-prepared: pooling-protocol-first: transaction backend 4140: success, count 1
- protocol-prepared: pooling-protocol-next: transaction backend 4141 while backend 4140 was held: success, count 1

## Configuration

Pool mode transaction; max_prepared_statements 10; PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1); PgBouncer 1.22.0; cleanup COMPLETE.

## Competing explanations

- The connector or application reset the session (REPRODUCED_BEHAVIOR): DEALLOCATE ALL on a direct connection produced the same 26000 on the original backend without any pool. A customer case needs evidence of which endpoint handled the request and whether sessions reset.
- A timeout was mistaken for a pooling limitation (NO_SIGNAL_WITHIN_SCOPE): The bounded timeout control produced 57014, a different error from the 26000 recorded after the backend switch.
- The prepared operation itself is invalid (NO_SIGNAL_WITHIN_SCOPE): The same PREPARE and EXECUTE succeeded twice on one direct backend.
- A customer application sent this workflow through a transaction pool (UNVERIFIED_HYPOTHESIS): Customer endpoint, pool mode, connector preparation method and session resets have not been observed.

## Evidence references

- pooling-direct-first: direct-first; query hash 59128d4724b5ac2f505620e980548eb3953827fadf7885f27a04cd876cac534d
- pooling-direct-next: direct-next; query hash 59128d4724b5ac2f505620e980548eb3953827fadf7885f27a04cd876cac534d
- pooling-pooled-first: pooled-first; query hash 59128d4724b5ac2f505620e980548eb3953827fadf7885f27a04cd876cac534d
- pooling-pooled-next: pooled-next; query hash 59128d4724b5ac2f505620e980548eb3953827fadf7885f27a04cd876cac534d
- pooling-direct-reset: direct-reset; query hash 59128d4724b5ac2f505620e980548eb3953827fadf7885f27a04cd876cac534d
- pooling-pooled-contained: pooled-contained; query hash 59128d4724b5ac2f505620e980548eb3953827fadf7885f27a04cd876cac534d
- pooling-protocol-first: protocol-first; query hash 2a39c0460e6eac2716a8d86a9272b4e4ad26cb27888759df263b399fba70dc45
- pooling-protocol-next: protocol-next; query hash 2a39c0460e6eac2716a8d86a9272b4e4ad26cb27888759df263b399fba70dc45
- pooling-timeout-control: timeout-control; query hash 14c0c4f58bebb7cde1faf498332cf56fd81c308d80212a73facf86b8d0a2146b

Source manifest: de03f781bfe88179944c0a26ffccbbe853995ee8e53eb4afe90645749a269d4e
Comparison: abc00e6477dc319a48c9d1daaa912b0050fde44443b6030a22107ee4815d5920
Review head: a5b579f909b9a9ff2cdd782f8de40cb287272cc136b6ad0eef15fbe3460707ed
Validation: 2050451a51abf3fa89e9ef520138e2aa52f29a6218181a71969595b3189959e0

## Remaining uncertainty

Customer endpoint, pool mode, connector behavior, business impact and the need for escalation remain unverified.
