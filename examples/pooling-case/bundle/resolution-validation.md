# Resolution validation

Status at export: RESOLUTION_VALIDATED
Scope: local-lab
Remedy: protocol-prepared
Checked: 2026-09-29T20:22:48.408Z

Retained observations from the completed run. No database connection is made during validation.

- PASS: fresh-compatible-evidence; references pooling-direct-first, pooling-direct-next, pooling-pooled-first, pooling-pooled-next, pooling-direct-reset, pooling-pooled-contained, pooling-protocol-first, pooling-protocol-next, pooling-timeout-control
- PASS: explicit-cause-review; references 86835af2306a43a31ab225fae9bdd46095f37828826b3ca92c53ffcf4c089887
- PASS: remedy-selected; references a5b579f909b9a9ff2cdd782f8de40cb287272cc136b6ad0eef15fbe3460707ed
- PASS: original-failure-after-measured-switch; references pooling-pooled-first, pooling-pooled-next
- PASS: selected-remedy-succeeds; references pooling-protocol-first, pooling-protocol-next
- PASS: expected-row-count; references pooling-protocol-first, pooling-protocol-next

Validates the selected remedy for this SQL prepared-statement workflow in the recorded local experiment. The servers have been removed. Arbitrary application behavior, other session features and customer environments remain unverified.

Customer resolution: unset. Customer-message approval: pending.
