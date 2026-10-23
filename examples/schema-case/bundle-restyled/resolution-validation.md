# Resolution validation

Status at export: RESOLUTION_VALIDATED
Scope: local-lab
Checked: 2026-09-29T16:14:26.822Z

- PASS: fresh-compatible-evidence; references development-target_identity, development-effective_context, development-relation_inventory, development-permissions, development-migration_state, development-failure_observation, before-target_identity, before-effective_context, before-relation_inventory, before-permissions, before-migration_state, before-failure_observation, search-path-control-target_identity, search-path-control-effective_context, search-path-control-relation_inventory, search-path-control-permissions, search-path-control-migration_state, search-path-control-failure_observation, search-path-control-failure_observation-qualified, after-target_identity, after-effective_context, after-relation_inventory, after-permissions, after-migration_state, after-failure_observation
- PASS: explicit-cause-review; references 0ab9dbdf9cd207ca423044a11d76a8333582ff85a731d9d3d626f67e0ecee891
- PASS: original-failure-reproduced; references before-failure_observation
- PASS: post-change-query-succeeds; references after-failure_observation
- PASS: expected-row-count; references after-failure_observation

Validates the recorded query and expected row count in the disposable local lab. The cluster has been removed. Customer environments and broader application behavior remain unverified.

Customer resolution: unset. Customer-message approval: pending.
