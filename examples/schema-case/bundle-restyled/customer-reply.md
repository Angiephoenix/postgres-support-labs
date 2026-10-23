# Customer reply draft

DRAFT: human communication approval pending.

We reproduced the reported missing-relation error in a separate local test database. The migration and relation were absent in that test. After applying the bundled migration, the same query succeeded.

The local result does not confirm the state of your environment. Please confirm which target and role handled the failed request, the effective search path, and whether the relevant migration ran on that target. Share sanitized identifiers and results; omit connection strings, credentials and customer rows.

Any change in your environment needs its own approval and post-change validation.
