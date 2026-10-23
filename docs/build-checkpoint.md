# Build checkpoints

## Goal and delivery contract

Postgres Support Lab's version-one scope includes all six labs. The missing-table investigation is the first end-to-end foundation, and the [delivery scope](delivery-scope.md) tracks what remains.

Checkpoints are listed newest first. Older entries describe the project as it was at that point and are kept as history. Commit identifiers and counts in these records refer to the project's development history, which isn't included in this release.

Checkpoint 14 (22 October 2026, `main` at `4b88770`) recorded the state at that point. Later changes are described in the guides: for example, new exports now use the bundle versions with the print layout listed in the [support bundle guide](support-bundle.md#print-a-report). At checkpoint 14, each of the six labs had one working, scoped case:

| Lab | Working case | Bundle version |
|---|---|---|
| Missing tables and schema drift | A missing migration, with a search-path control that gives the same `42P01` | `0.1.0-bundle4` |
| Session behavior through PgBouncer | A SQL `PREPARE` lost when the next transaction runs on a different server connection, with reset and timeout controls and two fixes | `0.1.0-pooling-bundle2` |
| Slow queries and indexes | A missing index on a selective filter, with statistics, repeated-run and selectivity controls | `0.1.0-index-bundle1` |
| SSL, authentication and connection strings | A client that doesn't trust the issuing CA, with host-name, `sslmode`, server-refusal, credential, encoding and closed-port controls | `0.1.0-connectivity-bundle3` |
| Permissions and search path | A table created after a grant on all tables, with wrong-role, schema `USAGE` and search-path controls | `0.1.0-permissions-bundle1` |
| Application pool exhaustion | A handler that keeps its pool client after a query error, with demand, slow-query, long-transaction and server-refusal controls | `0.1.0-pool-exhaustion-bundle1` |

After a run, a person generates a review template, edits it by hand and submits a cause decision. In the other five labs, a second template selects the fix to check; the schema lab checks its one bundled migration. Validation reads only the retained evidence and needs fresh evidence and an accepted cause, plus a selected fix where the lab has one. Reviewed and gap-only bundles export with customer, engineering and runbook drafts, and `lab verify-bundle` checks them against a saved manifest hash. Customer resolution stays unset and customer-message approval stays pending in every bundle. `npm run check:packs` reports all six lab packs as valid and working.

This checkpoint doesn't finish version one. Each lab still has cases to add, and the shared work in the [delivery scope](delivery-scope.md) remains: general comparisons, a live PlanetScale connection policy, a SQL parser, broader privacy and hardening tests, Docker, a recorded approval step for customer messages, and a guided workflow for the four newer labs. The clean-checkout check has now passed on Linux and on macOS (both tables below). Browser coverage is still partial. The lab guides record Chromium checks at 390px and 1280px, a Safari spot check on a physical iPhone of connectivity reports on 12 October, and the Safari check on a Mac below. A check of every report on a physical phone, in print and for accessibility is still pending.

Verification on 22 October 2026, from a fresh clone of `4b88770` on Linux (Ubuntu 24.04.4), run as a regular user with Node 24.21.0, npm 10.9.7, pg 8.23.0, pg-pool 3.14.0, PostgreSQL 16.13, PgBouncer 1.22.0 and OpenSSL 3.0.13:

| Check | Result |
|---|---|
| `npm ci` | 14 packages added, exit 0 |
| `npm test` | 236 passed, 0 failed, 0 skipped |
| `npm run check:packs` | all 6 lab pack files valid |
| `test:postgres`, `test:pooling`, `test:index`, `test:connectivity`, `test:permissions`, `test:pool-exhaustion` | 1, 3, 4, 8, 4 and 5 passed, none failed or skipped |
| The three committed example bundles, with the hashes in their READMEs | `integrity: VALID`, `anchorChecked: true`; their evidence has expired, as expected for historical examples |
| The committed PgBouncer example run, with its hash | `integrity: VALID`, `anchorChecked: true` |

CI on `4b88770` passed the PostgreSQL 16 job and the PostgreSQL 17 and 18 jobs, which run the permissions and pool-exhaustion suites.

Angie repeated the check on macOS on 22 October 2026, from a fresh clone of `4b88770`. The setup was macOS 12.7.6 (x86_64), Node 24.13.1, npm 11.8.0, PostgreSQL 17.11 (Postgres.app), PgBouncer 1.25.2 (MacPorts) and OpenSSL 3.6.4 (MacPorts, first on PATH):

| Check | Result |
|---|---|
| `npm ci` | 14 packages added, exit 0 |
| `npm test` | 236 passed, 0 failed, 0 skipped |
| `npm run check:packs` | all 6 lab pack files valid |
| `test:postgres`, `test:pooling`, `test:index`, `test:connectivity`, `test:permissions`, `test:pool-exhaustion` | 1, 3, 4, 8, 4 and 5 passed, none failed or skipped |
| `git status --short` after the integration suites | no changes |
| The three committed example bundles and the PgBouncer example run, with the hashes in their READMEs | `integrity: VALID`, `anchorChecked: true`, and `semanticConsistency: VALID` for each bundle |
| A new pool-exhaustion run | cleanup `COMPLETE` |
| A gap-only bundle exported from that run, checked with its export hash | `integrity` and `semanticConsistency` `VALID`, `anchorChecked: true` |

In Safari on that Mac, the comparison tables of the schema example report and the new pool-exhaustion gap-only report were checked at desktop width and in a narrower window. Nothing was clipped or overlapping in those views. The exact widths and the Safari version weren't recorded. The check didn't cover the rest of those reports, a physical iPhone, print or accessibility.

Checkpoint 13 (1 October 2026) updates the generated reports. New schema bundles use version `0.1.0-bundle4` and new PgBouncer bundles use `0.1.0-pooling-bundle2`, with plain-language headings, neutral wording for gap-only reports and revised customer-reply drafts. Earlier versions keep their exact wording and still verify. The schema example has a restyled copy for the README screenshot, with its original evidence, export time and review unchanged. The project is also licensed under MIT.

Checkpoint 12 (1 October 2026) is a documentation update. The README and guides now start with the practical problem in plain language, the delivery scope replaces the earlier readiness page, and the publication checklist becomes a general [release checklist](release-checklist.md). No application behavior changed.

Checkpoint 11 connects the PgBouncer scenario to explicit review, local validation and support-bundle export. Cause acceptance and remedy selection are separate appended records; validation claims only the selected remedy and checks retained observations. Pooling bundles use their own manifest version and verifier. Customer resolution and message approval remain pending. See the [pooling guide](pooling-lab.md#review-validate-and-export).

Checkpoint 10 is a presentation update. It adds a completed schema example bundle, a measured PgBouncer example run, screenshots, short explainers and a publication checklist, now the [release checklist](release-checklist.md). No application behavior changed. See [examples](../examples/).

Checkpoint 9 adds the native PgBouncer experiment: measured backend switches, SQL versus protocol preparation, direct-reset and timeout controls, two remedy paths, scoped artifacts and an offline report using the existing bright theme. At that point, shared review and support-bundle integration were still to come; checkpoint 11 added them. Guided schema review now explains the available decisions and hidden input before asking for judgment. See the [pooling guide](pooling-lab.md).

Checkpoint 8 adds guided terminal intake and local run selection, review and verified export. Acceptance still requires explicit judgment and current evidence. Intake records remain separate from synthetic lab cases. See the [delivery scope](delivery-scope.md) for the remaining version-one scope.

Checkpoint 7 adds the Signal report design, embedded offline fonts, readable handoff documents and historical bundle restyling. Earlier bundle verification remains supported.

Checkpoint 6 adds local resolution validation and portable support bundles. The HTML report links comparison, review, validation and 25 observation records. Customer, engineering and runbook drafts use the same captured evidence. Customer resolution and message approval remain pending.

## Decisions

| Decision | Choice and reason |
|---|---|
| Runtime | TypeScript and Node.js; Node 24 currently tested. |
| Storage | Append-only JSONL artifacts; add an index only if lookup measurements justify it. Fixture storage is implemented; native support-bundle manifests are implemented; general scenario formats remain pending. |
| CLI | Keep the existing dispatcher and use Node readline for guided input. Defer a CLI framework until command complexity warrants another dependency. |
| SQL execution | Fixed bundled SQL in the owned native lab only. Parser selection and live safety gates must precede any external SQL input. |
| HTML bundle | Static escaped HTML from the captured native investigation, with no scripts or network resources. |
| Local environment | Native PostgreSQL and PgBouncer runners; Docker remains pending. Integration tests require a regular OS user and installed server tools. |
| Review | Explicit reviewer identifier, decision, rationale, evidence references and timestamp; signatures are optional future work. |
| Documentation | URL, retrieval date, relevant section, content hash and source-version notes in a reference artifact. |
| Public database | Optional smoke profile; exact queries and access behavior need verification before implementation. |
| Query evidence | Define the import contract before the query-plan scenario; no API integration assumed. |
| AI | Deterministic guidance and outputs in version one; AI drafting deferred. |
| License | MIT, added on 1 October 2026 (see `LICENSE`). Embedded fonts keep their SIL Open Font License notices. Repository visibility is a separate decision. |

## Contract clarifications

1. Lab validation is scoped to the lab. A customer case remains unresolved until post-fix evidence exists for its affected environment.
2. A database name or port cannot establish branch identity. Record declared and verified identity separately, plus the method used to verify it.
3. An incomplete case can export a clearly labeled gap report. Supported-cause and completed-resolution exports require stronger gates.
4. Fixture runs remain visibly synthetic throughout every artifact and output.
5. Human cause review and customer-message approval are separate recorded actions.
6. Scenario-controlled changes require explicit lab execution approval. Production-facing collectors stay read-only.
7. Hashes detect accidental changes when anchored to a trusted manifest. Files on a writable disk cannot provide absolute immutability or authenticated provenance alone.
8. A complete minimum evidence contract permits evaluation. It cannot automatically establish a cause.

## Profiles and execution policy

| Profile | Intended permissions | Current implementation |
|---|---|---|
| Fixture | Synthetic replay and no external network | Intake, ledger and six-requirement evidence demos |
| Local lab | Approved bounded setup, fault, fix and cleanup | Native disposable cluster, missing migration and search-path control, retained evidence |
| Public read-only | Verified allowlisted metadata; bounded queries | Pending |
| Customer read-only | Explicit opt-in after safety hardening | Future scope, as in brief |

## Evidence contracts to implement

General artifact schemas remain part of the [delivery scope](delivery-scope.md). Intake, fixture case binding and six typed schema-resolution observation payloads are included. The native collector payloads and a versioned review-input schema are also implemented. Native comparison, hypotheses, finding, validation and export views are implemented with a versioned manifest. General comparison artifacts and customer validation remain pending.

Evidence must bind case, source, environment, verified branch where applicable, effective role, connection mode, probe hash, collection time, expiry, collection scope, collector version, redaction outcome and parent references. Corrections append superseding records. Freshness must be evaluated at use time. Comparison must declare its changed dimension and require equality for the other relevant scope fields.

The evidence taxonomy keeps intake reports as customer assertions. Documentation, fixture output and live observations keep distinct provenance. Supported causes require explicit human review and sufficient evidence; validated resolutions require post-action observations scoped to the original failure.

## Threats and gates

Credential leakage: block recognized sensitive input before printing or persistence; expand adversarial coverage before live use. Current regex checks have known limits.

Wrong environment: require verified identity before collecting or comparing; local fault runner must refuse a production profile and validate its lab target independently.

Unsafe SQL: expose only reviewed probe identifiers initially. Introduce AST parsing and statement allowlists before SQL-input features. Read-only role, transaction controls, timeouts and bounded outputs supplement query policy.

Overclaiming: keep intake and observations separate; retain competing explanations, contradictions and scope limitations. Prevent documentation from satisfying an observation requirement.

Evidence tampering: schema validation, append-only writes, hash chain, manifest integrity checks and explicit supersession; disclose the local filesystem trust boundary.

Export leakage: schema-selected fields, secret gate and audience-specific templates. Escape HTML and reject path traversal. Do not interpolate untrusted input into shell commands.

## Flagship acceptance tests

- A vague schema report produces targeted questions without a cause.
- Missing migration and incorrect search path produce the same initial symptom; independent evidence distinguishes them.
- Wrong target, quoted identifiers and missing privileges remain alternatives until tested.
- Development and affected-environment comparisons show changed and unchanged facts with provenance.
- Local PostgreSQL actually reproduces the failure and successful correction; synthetic fixture output stays labeled.
- The human review gate cannot be skipped by demo mode.
- Lab success leaves customer resolution pending.
- Only fresh, matching post-fix evidence can validate the affected environment.
- Customer reply, engineering escalation and playbook share the reviewed evidence base.
- Offline fixture demo, lab cleanup and complete bundle verification succeed from a clean checkout.

## Delivery board

Statuses updated at checkpoint 14.

| Brief slice | Status | Exit evidence |
|---|---|---|
| 0: Contracts and boundaries | Started | Decisions, policy, threats, intake schema; remaining artifact schemas pending |
| 1: Intake and redaction | Started | Guided and JSON intake, ledger-backed gap guidance and initial privacy rejection tests; broader classification and hardening pending |
| 2: Ledger and manifest | Started | Fixture ledger, bound intake, typed payloads, integrity, scope/freshness/conflict/correction tests; native export manifest implemented; broader format support pending |
| 3: Connectivity | Started | pg collector via private lab socket; untrusted-CA lab with a TLS-only local server, connection stages, controls, review and export; client certificates, public CAs, external targets and platform identity pending |
| 4: Local fault lab | Started | Synthetic project/label tables, migration, disposable reset and cleanup; native PgBouncer runner added in checkpoint 9; Docker pending |
| 5: Flagship | Started | Native reproduction, local cause review, scoped validation and portable bundle; customer validation pending |
| 6: Differential replay | Started | Fixed migration comparison with scope checks and controls; general comparisons pending |
| 7: PgBouncer | Started | Measured native experiment with controls; explicit cause review, remedy selection, local validation and verified bundle export; broader workflow cases and valid-operation/routing boundaries pending |
| 8: Query and index | Started | Missing-index case with `EXPLAIN (ANALYZE, BUFFERS)` before and after, controls, review and export; unused-index case pending |
| 9: Remaining packs | Started | Connectivity, permissions and pool-exhaustion packs working for one case each, with review and export; further cases per lab pending |
| 10: Review and outputs | Started | Guided local review/export, explicit review history, consistent audience drafts and runbook candidate; communication approval and publication workflow pending |
| 11: Public release | Started | CI on PostgreSQL 16 to 18 and clean-checkout checks on Linux and macOS (checkpoint 14); adversarial gates, remaining browser and phone checks, user feedback, a demo recording and a case study pending |

Implement minimal review and export paths inside the flagship slice, then extend them in Slice 10. This resolves the brief's dependency overlap without moving them out of the foundation release.

## Next implementation step

Finish the remaining browser and phone checks. After that, add the remaining cases to each lab and the shared work in the [delivery scope](delivery-scope.md): general comparisons, safety hardening, a recorded approval step for customer messages and release materials. Connecting to a customer's own database remains a future opt-in feature, planned after the policy and redaction work; a paid PlanetScale account is optional.

## Key points

- A migration command reporting success doesn't tell you which database it changed. You need evidence from the database the app actually uses.
- If a catalog query can't see a table, that only shows what the querying role can see. The table may still exist in a schema it can't access.
- A fix that works in a local lab doesn't close a production incident. That needs evidence from the affected environment.
- A missing migration and a search-path problem produce the same error. Migration state, relation inventory and a schema-qualified query tell them apart.

## Writing standard

- Start with the practical problem and what the reader can do about it.
- Use familiar words and complete, natural sentences. Keep technical terms where they help, and explain unfamiliar ones the first time they matter.
- Avoid marketing language, dramatic fragments, slogans, em dashes and "not X, but Y" phrasing. A little humour is fine when it fits naturally.
- Keep local findings, customer evidence and unverified assumptions clearly separate.
- Describe only what runs today in the present tense. Planned work belongs in the delivery scope.

## Sources checked

- Branch isolation and schema workflow: https://planetscale.com/docs/postgres/branching
- PgBouncer reference opened: https://planetscale.com/docs/postgres/connecting/pgbouncer ; detailed implementation verification remains pending.

These sources were opened on 22 September 2026. The branching documentation describes isolated deployments and per-branch schema changes. No platform adapter has been implemented from these references yet.

## Checkpoint 6 verification

The tests exercise actual temporary files and CLI commands, including rejected writes, correction history, integrity failures, trusted-head mismatch and transitive parent invalidation. The evidence-contract tests also exercise incomplete coverage, scope matching, conflicts, corrections, expiry, bound-intake tampering and the read-only reporting command. Run `npm test` for current results and `npm run demo:evidence` to inspect the synthetic coverage workflow. See [the ledger guide](evidence-ledger.md) for storage and recovery limitations.

`npm run test:postgres` exercises actual PostgreSQL execution, both same-symptom cases, unchanged before/after scope, retained ledger integrity, refused output reuse, repeatability and cleanup. The GitHub Actions workflow runs the regular suite and this integration test separately. At that checkpoint, native execution wasn't possible in the build container because it ran as root, and PostgreSQL's refusal to run as root was kept. Later checkpoints ran the labs there as a regular user.

The comparison and review tests cover fresh versus expired support, exact comparison binding, revised decisions, changed context, inconsistent cached results, mixed runs and privacy rejection. See [the review guide](lab-review.md). The actual PostgreSQL integration also checks comparison and explicit test review persistence. Angie reported a successful checkpoint 4 run on macOS with PostgreSQL 17: all 64 default tests passed, both failures returned `42P01`, the post-migration query succeeded and cleanup completed. That user-reported result predates the checkpoint 5 additions.

Checkpoint 6 adds bundle inventory and semantic consistency tests, trusted manifest checks, scoped validation gates, expiry-aware historical verification, privacy rejection and HTML escaping. The real PostgreSQL integration now validates and exports the measured result after an explicit test review. The static report labels all statuses as an export-time snapshot.

Checkpoint 7 verifies legacy rendering, anchored restyling, unchanged source bytes, retained expiry, gap-only withholding, escaped document views, embedded font digests and the restyle CLI.

Checkpoint 8 tests guided intake, cancellation, declined writes, explicit lab approval, numbered run selection, privacy rejection, concurrent review changes, evidence expiry during input, and anchored export. The actual PostgreSQL integration also exercises the guided review/export sequence against measured evidence. See the [guided workflow](guided-workflow.md).
