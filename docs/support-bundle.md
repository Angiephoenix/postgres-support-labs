# Validate the local result and export a support bundle

A support bundle is a folder that someone else can read without running anything. It brings together the original report, the recorded evidence, the comparison, the reviewer's decision, a local check of the fix, and draft messages for the customer and for engineering. An HTML report links all of it, and a manifest lists every file with its hash. The verifier checks the files against the manifest and recorded evidence. To check that the whole bundle still matches the copy you originally trusted, also provide its separately saved manifest hash. Someone who controls all the files could rewrite them and recompute every hash, which is why the separately saved hash matters.

This checkpoint supports the native missing-migration scenario and its search-path control. General scenario exports and customer-environment validation remain planned.

## Validate the recorded local result

Use the run directory printed by the native lab. In these commands, set `PSLAB_RUN` to your actual directory first:

```sh
PSLAB_RUN="cases/native-your-run-directory"
node src/cli.ts lab validate "$PSLAB_RUN"
```

Validation reads retained evidence. It makes no connection to PostgreSQL and executes no new query. The native runner already captured the original failure and post-migration query. Validation checks those records against the accepted comparison and their current freshness.

`RESOLUTION_VALIDATED` is scoped to `local-lab`. It requires an accepted local cause, current compatible evidence, the original `42P01` failure, a successful post-change query and the expected count of one matching row. The result links the original and post-change observations, ledger heads, comparison, review head, declared migration and target scope. Its `validationHash` binds the full validation record.

The disposable cluster has been removed. The claim concerns the recorded local query and its expected result. Broader application correctness and customer resolution remain unverified. Customer-message approval stays pending.

## Export and open the report

Choose a new output directory whose parent already exists:

```sh
PSLAB_BUNDLE="$PSLAB_RUN/support-bundle"
node src/cli.ts lab export "$PSLAB_RUN" "$PSLAB_BUNDLE"
node src/cli.ts lab verify-bundle "$PSLAB_BUNDLE"
```

On macOS, open the report with:

```sh
open "$PSLAB_BUNDLE/support-bundle.html"
```

The HTML uses local links and native expandable evidence records. Roboto Mono and Inter are embedded in the HTML, with their license notices. The report has no JavaScript or network resources. Handoff documents appear within the same styled report, with links to their Markdown sources. Keep the whole directory together when moving it so the linked documents remain available.

Default export requires fresh, accepted local evidence. An unreviewed, rejected or expired case can export an explicitly incomplete bundle:

```sh
node src/cli.ts lab export "$PSLAB_RUN" "$PSLAB_RUN/gap-bundle" --gaps-only
```

Gap-only export withholds supported-cause and resolution-validation claims. It retains observations, limitations and follow-up questions. Every command supports `--dry-run`; dry runs read no input and write nothing.

## Print a report

Open `support-bundle.html` in a browser and print it, or save it as a PDF from the print dialog. Reports in these bundle versions use print revision 1: `0.1.0-bundle5`, `0.1.0-pooling-bundle3`, `0.1.0-index-bundle2`, `0.1.0-connectivity-bundle4`, `0.1.0-permissions-bundle2` and `0.1.0-pool-exhaustion-bundle2`. New exports use them.

**By default the printout is compact.** The Evidence section lists each record with its summary, collection time and other details, but without the record's JSON. A note at the start of that section says how to include the full records.

**To include every record in full,** add `#full-evidence` to the end of the report's address and press Return, for example `.../support-bundle.html#full-evidence`. A note appears above the evidence cards to confirm the choice. Then print. The full records can make the printout long: a pool-exhaustion report printed to 79 to 82 A4 pages in Chromium, compared with 21 to 24 pages without them. To go back to the compact printout, remove `#full-evidence` from the address. The same records are also in `evidence.jsonl`.

**Layout.** Safari PDFs of earlier reports showed headings separated from their content, short blocks split across pages and closed evidence cards printed as titles only. The earlier layout relied on `break-after: avoid` and on printing the contents of closed `<details>` elements. The PDFs suggest Safari applied neither, but the exact cause isn't confirmed. Print revision 1 doesn't rely on either:

- A section that fits on one page is printed whole, starting a new page if needed.
- Other headings reserve room below themselves, so they move to the next page with the content they introduce.
- Table rows, code blocks and list items aren't split where they fit on a page, and a longer table breaks only between rows.
- Each handoff draft's title carries its rule and reserves room for the draft's own heading and first text, so the title moves to the next page with them.
- The evidence cards are replaced in print by a copy laid out without `<details>`. Each record is kept whole where it fits on a page. A record whose JSON is too long for one page starts on a new page and then flows across pages.

**Links to evidence.** Links such as `phase-leak-reproduced` point to the evidence item, whose copy is printed, so they still have a target in a PDF. Because each record is kept whole or starts a new page, the link's destination is the page where the record starts. In earlier reports they pointed to the card itself, which print revision 1 would hide.

**The screen view is unchanged,** apart from the note that appears when `#full-evidence` is in the address.

**Page headers and footers come from the browser.** Browsers can add the page title, the date, the file's local path and page numbers. They aren't part of the report. Safari's print dialog has an option to print headers and footers, and Chrome has one under "More settings". Clear it to leave them out.

**Older bundles keep their original print layout.** Chromium printed their evidence cards in full in our check. Safari printed only the titles of closed cards, so open each card before printing in Safari. For a schema-resolution bundle, `lab restyle-bundle` creates a copy in the current version, with print revision 1, and keeps the evidence and review unchanged (see below). The other labs have no restyle command.

**What has been checked.** Print revision 1 has been checked by printing to A4 PDFs in Chromium 141, covering the compact and full printouts, the page breaks and the PDF link destinations. These checks also used copies with `break-after: avoid` and the closed-`<details>` print rule removed. Safari 17.6 has been used for the full printouts of an earlier draft of this revision. They included every record, had no browser headers or footers when that option was off, and kept the main comparison, validation and handler blocks together. The same PDFs showed draft titles split from their contents, short evidence JSON split across pages and one evidence link whose destination was the page before its record. This version addresses those three, and has not yet been printed in Safari. Other browsers, a physical printer and accessibility have not been checked.

## What the bundle contains

| File | Purpose |
|---|---|
| `case-summary.md` | Export-time status, scope, outcome and unknown impact |
| `intake.json` | Bound synthetic report |
| `evidence-gap-report.md` | Evidence or review blockers and customer follow-up questions |
| `probe-plan.json` | Approved local setup, collection, migration and cleanup plan |
| `evidence.jsonl` | Combined `{phase, entry}` index of the four original ledgers |
| `timeline.json` | Recorded collection and review events |
| `reproduction.md` | Requirements, commands, recorded outcome and cleanup |
| `comparison.json` | Changed and unchanged observations, controls and review history |
| `hypotheses.json` | Local explanation, separate search-path control and customer uncertainty |
| `findings.json` | Scoped reviewed cause, or an empty finding for a gap report |
| `validation.json` | Machine-readable validation with evidence references and hash |
| `resolution-validation.md` | Human-readable checks and scope |
| `customer-reply.md` | Customer response draft without internal identifiers or review notes |
| `engineering-escalation.md` | Internal handoff draft with comparison and evidence references |
| `runbook-candidate.md` | Troubleshooting draft awaiting publication review |
| `support-bundle.html` | Navigable offline report with expandable observations |
| `sources/` | Captured run, plan, probe catalog, reviews and original case/ledger files |
| `manifest.json` | Fixed inventory, byte sizes, SHA-256 digests, versions and scope |

The combined `evidence.jsonl` is an index, not a new merged hash chain. Original chains and bytes remain under `sources/<phase>/evidence.jsonl`. The migration ran between the before and after collections; the runner did not capture a separate action timestamp. Timeline output preserves that limit.

All audience views come from one captured source snapshot. Customer replies remain drafts. Export does not approve or send them. A local supported cause does not establish that an engineering escalation is needed. Runbook candidates require review before publication.

## Verify integrity and current support

Export prints a `manifestHash`. Keep that hash separately and pass it to the verifier when you need to check against a trusted checkpoint:

```sh
node src/cli.ts lab verify-bundle "$PSLAB_BUNDLE" SAVED_MANIFEST_HASH
```

Replace `SAVED_MANIFEST_HASH` with the printed 64-character value. Verification checks the exact file inventory, byte sizes and digests, validates the retained source ledgers and reviews, then regenerates every output at the recorded export time. It rejects a changed response or validation claim even if someone updates that file's manifest entry to match.

The verifier reports two separate results:

- `validationAtExport`: what the recorded evidence supported when exported.
- `currentEvidenceStatus`: whether the retained evidence still supports validation now.

After the one-hour evidence window, an unchanged historical bundle can retain `integrity: VALID` while `currentEvidenceStatus` becomes `VALIDATION_BLOCKED`. The HTML labels itself as an export-time snapshot. It cannot refresh its own state; run the verifier before relying on current support.

Verification covers the captured bundle. Later decisions or changes in the original case are outside that snapshot. Re-export to capture them. A file owner who rewrites all source artifacts and recomputes their hashes can create a different internally consistent bundle. A separately trusted manifest hash is needed to detect a complete rewrite.

## File and privacy boundaries

Output directories must be new. Export captures only fixed source filenames and ignores working files such as `review-input.json`. It validates the captured sources before creating the destination. The manifest is written last; a partial folder without a valid manifest is unusable. Failed writes clean up the directory created by that export.

Direct symlink files and source directories are rejected. Verification refuses unexpected files, directories and paths. This is a local single-user workflow, with no protection claimed against an attacker controlling ancestor directories or replacing paths concurrently.

Recognized sensitive patterns are checked across captured input. The SQL catalog is accepted only when it exactly matches the bundled synthetic catalog; arbitrary SQL or added catalog text is refused. This permits the known synthetic SQL literals while retaining the normal privacy gate for other input. Pattern checks have false positives and gaps, so they cannot guarantee that every personal detail or secret is absent.

The complete bundle contains internal review notes and evidence. Share the customer draft separately after reviewing and approving it. The exporter escapes dynamic HTML text and serves no executable scripts. Supported artifact and output sizes are bounded; bundle verification selects the renderer recorded in the manifest. The frozen `0.1.0-bundle1` renderer continues to verify earlier exports. The first Signal design remains supported as `0.1.0-bundle2`. `0.1.0-bundle3` added larger, brighter text. New exports use `0.1.0-bundle4`, which keeps that design, uses a plain-language report heading and customer reply, and switches both to neutral wording in gap-only bundles. A restyled bundle gets the new heading but keeps its original drafts, because restyling only changes presentation. Version 4 manifests record a `draftRevision` (1 for the original wording, 2 for the plain-language drafts), restyling copies it from the source, and the verifier rebuilds the drafts from it. All four versions use the same evidence protocol.

## Checks

Default tests cover fresh versus expired validation, review gating, portable source capture, original ledger bytes, audience consistency, trusted manifest hashes, rehashed output tampering, traversal, duplicate paths, added files, symlinks, privacy and HTML escaping. Test fixtures simulate the native protocol; they are not live database observations.

The actual PostgreSQL integration runs the lab and checks the complete comparison, explicit test review, validation, export and verification flow. The automated test reviewer exercises the contract and does not supply a human customer assessment.

## PgBouncer session bundles

`pooling export` creates a separate bundle type for the PgBouncer scenario. Its manifest records `scenario: pooling-session` and a tool version. `0.1.0-pooling-bundle1` is the first version. `0.1.0-pooling-bundle2` added a plain-language heading, neutral wording for gap-only bundles and a clearer sentence about the validated fix in the customer reply. New exports use `0.1.0-pooling-bundle3`, which keeps that wording and adds the [print layout](#print-a-report). Each version keeps its own wording so earlier bundles still verify. `lab verify-bundle` reads that field and uses the matching verifier; schema-resolution bundles keep their original path and versions, and other combinations are refused. See the [pooling guide](pooling-lab.md#review-validate-and-export) for the review steps.

| File | Purpose |
|---|---|
| `case-summary.md` | Export-time status, selected remedy and scope |
| `evidence-gap-report.md` | Remaining blockers and customer evidence still required |
| `probe-plan.json` | Approved experiment plan |
| `evidence.jsonl` | The nine measured observations with stable identifiers |
| `timeline.json` | Collection time and every cause and remedy decision |
| `reproduction.md` | Commands and requirements for a new run |
| `comparison.json` | Baseline, backend switch, controls, remedies, competing explanations and decision history |
| `hypotheses.json` | The candidate cause and competing explanations with their classifications |
| `findings.json` | Scoped cause and remedy selection, or empty values in a gap report |
| `validation.json`, `resolution-validation.md` | Remedy-specific checks against retained observations |
| `customer-reply.md`, `engineering-escalation.md`, `runbook-candidate.md` | Audience drafts from the same snapshot |
| `support-bundle.html` | Offline report in the Signal design |
| `sources/` | The captured run, probe catalog, plan, run manifest and decision history |
| `manifest.json` | Inventory, digests, bindings and selected remedy |

Verification checks the exact inventory, sizes and digests, validates the captured run against its own manifest, catalog and plan, and rebuilds every output at the recorded export time. A draft, finding or validation that disagrees with the captured evidence is rejected even when its manifest digest was recomputed. As with schema bundles, `validationAtExport` stays fixed while `currentEvidenceStatus` becomes `VALIDATION_BLOCKED` after the one-hour window.

## Restyle an existing bundle

`lab restyle-bundle` creates a separate copy with the current design. Set `PSLAB_BUNDLE` to the existing bundle directory, then choose a new sibling directory:

```sh
node src/cli.ts lab restyle-bundle "$PSLAB_BUNDLE" "${PSLAB_BUNDLE}-signal"
node src/cli.ts lab verify-bundle "${PSLAB_BUNDLE}-signal"
open "${PSLAB_BUNDLE}-signal/support-bundle.html"
```

For an anchored check, add your saved manifest hash as the final argument to `restyle-bundle`. The result returns both the source hash and the new manifest hash. Keep the new hash separately for future verification.

The command captures and verifies all original bundle files before writing the new copy. It preserves the original export time, evidence, review history and audience text. Only the HTML presentation and manifest change. The new manifest records the source manifest hash and restyle time. This records derivation; validating the original source still requires that original bundle and its trusted hash.

Expired evidence stays expired. A reviewed historical bundle retains its export-time finding while current validation remains blocked. Restyling a gap-only bundle keeps its claims withheld. The existing bundle is unchanged, and output inside that bundle is refused to preserve its fixed inventory. No PostgreSQL rerun, review decision or customer-message approval occurs.

The [design guide](design-system.md) defines the shared colours, typography and presentation rules. JSON and Markdown retain their portable formats; styled reading happens in the HTML report.
