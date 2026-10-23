# Engineering handoff draft

Internal draft. Escalation need has not been established.

Local PostgreSQL lab with synthetic data. Customer environment unverified. Customer resolution pending.

The reviewer accepted the missing-migration explanation for the local reproduction.

Recorded query outcome: error before the migration, success afterward. Recorded matching rows after the migration: 1.

## Recorded comparison

- migration applied: false -> true
- relation present: false -> true
- relation visible: false -> true
- relation SELECT: null -> true
- query outcome: "error" -> "success"
- SQLSTATE: "42P01" -> null
- matching rows: null -> 1

## Context held constant

- target fingerprint: "d5375c5c6948a8af82f9bebee53d65e9998a1f0ab6f997c03ce78995eb4cc654"
- role fingerprint: "c905a111f58020f68632f0c0f62d5025cf89e989198f66d482221f4c6f54c15b"
- connection mode: "direct"
- query shape hash: "45edcebd892dd8472a1ce3af18b669b4f91354cde1d34bbd12b4e37e0201ccf8"
- search path: ["app_data","public"]
- schema USAGE: true

## Alternative explanation

Search-path control: SQLSTATE 42P01; migration applied true; relation present true; visible false; qualified matching rows 1.

## Evidence references

- development: development-target_identity, development-effective_context, development-relation_inventory, development-permissions, development-migration_state, development-failure_observation; ledger head 8f5ed08e39043428a9f337e72e6b2fc2ba922b65db566a3ab1e1e4644918bf2a
- before: before-target_identity, before-effective_context, before-relation_inventory, before-permissions, before-migration_state, before-failure_observation; ledger head 9d20efd8b936d4a4f6efe36512118781f650f0bcea8e52908f5a016503f36e3f
- search-path-control: search-path-control-target_identity, search-path-control-effective_context, search-path-control-relation_inventory, search-path-control-permissions, search-path-control-migration_state, search-path-control-failure_observation, search-path-control-failure_observation-qualified; ledger head 000d76827ddba72ae43323d13fafadf07a25d6827d55d8ec1ca90bb76c094541
- after: after-target_identity, after-effective_context, after-relation_inventory, after-permissions, after-migration_state, after-failure_observation; ledger head 515703bc708a498cb27ef6d54ace104971fd987b53e64ba2c5e49aa6673c0e1f

Comparison: 65e23efdc45adeb4b34fedc1c2349751776b2f12a2bfca61abb92db9253bcff8
Review head: 0ab9dbdf9cd207ca423044a11d76a8333582ff85a731d9d3d626f67e0ecee891
Validation: 71638630f5b6e4fef6e80d391868711b9f833b70cece07e99a00bf4cdb2de120

## Remaining uncertainty

Customer target state, business impact, production behavior and the need for escalation remain unverified.
