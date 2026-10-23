# Writing a new lab

Each lab answers one support question by reproducing a problem locally, running controls that rule other explanations in or out, and producing a reviewed support bundle. The working labs share the code that records review decisions, validates a fix and exports a bundle. A new lab reuses that code and writes only the parts specific to its problem.

## What a new lab reuses

| Shared code | What it does | Used by the working labs |
|---|---|---|
| `src/review-chain.ts` | Stores review decisions as an append-only list, where each record includes the hash of the one before it. A new decision must name the latest record it was based on, so a decision made on stale information is refused. | Yes, all six |
| `src/validation-core.ts` | Builds the validation record: named checks against retained evidence, any blockers, and fixed statements that customer resolution and message approval are still open. | Yes, all six |
| `src/bundle-core.ts` | Reads the run's files into a bundle, blocks recognized secrets, refuses any probe catalog other than the one bundled in code, writes the export with the manifest last, and checks an export's manifest, trusted hash, file list and digests. | Yes, all six |
| `src/lab-packs.ts` | Loads and checks pack files. A lab's runner calls `requireWorkingPack` before it starts any server, which checks only that lab's pack and the bundled code it pins. CI runs `npm run check:packs` to check all six. | Yes, all six |
| `src/report-theme.ts` | Shared report styles and embedded fonts. | Yes, all six |

## What each lab writes for itself

1. **Pack file** in `packs/`, with the lab's question, phases, controls, fixes and bundle versions. It never contains SQL.
2. **Probe catalog and runner.** The fixed SQL lives in code. The runner needs explicit approval, uses disposable local servers on private sockets, and cleans up after itself.
3. **Evidence contract.** A versioned run file and a checker that rejects anything unexpected, including the wrong order of phases and evidence older than its freshness window.
4. **Comparison.** Lines up the baseline, the failure and each control, and lists the competing explanations with their status.
5. **Validation checks** for each possible fix, using only retained observations.
6. **Bundle outputs.** The drafts, the HTML report and a manifest schema. Rendered text is frozen per bundle version so older bundles keep verifying.

To register a working lab, add an entry to `IMPLEMENTATIONS` in `src/lab-packs.ts` pointing at its probe catalog, phases, control phases, fixes and manifest schema, then change its pack's status to `working`. The pack must list each of those controls exactly once, with no others. The runner then checks that its pack and the code agree every time the lab runs, and CI checks every pack on each pull request.

## Rules every lab keeps

- Only bundled SQL runs. No lab accepts SQL from a pack file, a user or a bundle.
- A person records the cause decision. A fix is validated only after that decision, and only against evidence that is still fresh.
- Local findings, documented platform behavior and customer evidence stay separate. A lab never claims to have tested a managed platform or a customer environment.
- Committed examples are never edited. New behavior gets a new bundle version.
