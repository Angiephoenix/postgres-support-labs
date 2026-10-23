# Guided investigation

The guided workflow asks you questions in the terminal instead of making you edit JSON files. You can record a support report and see what evidence is missing, review a recorded lab run, or start a new lab.

Run from the repository directory after `npm ci`:

```sh
npm run guide
```

The terminal offers three workflows and an exit option. Input is hidden while typing to keep unvalidated material out of terminal scrollback. Validated intake and review answers are displayed before saving. Use sanitized descriptions, omit credentials, and press Enter for `unknown` on optional intake questions. Type `/cancel`, press Ctrl+C, or send EOF to finish at a prompt. Earlier saved records remain available.

## Create an intake

Choose **1**. Describe the report and expected behavior, then answer the context questions. The tool displays the intake and missing-evidence questions before asking whether to save them.

A confirmed save creates a new `cases/intake-...` directory with `intake.json` and `evidence-gap-report.md`. No database is contacted. This is reported context awaiting evidence collection. It does not create a verified environment binding or attach the report to an existing lab case. Schema-resolution reports receive the current six-requirement guidance; other symptoms receive clarification until their scenario contracts are implemented.

## Review an existing lab run

Choose **2**, then select a numbered run. The tool checks the selected run and displays its comparison, controls, evidence references, blockers and review history.

Choose `review` to enter a decision, reviewer identifier and rationale. Acceptance is offered only when evidence is ready. Review is recorded after confirmation. A review changed by another process, or evidence that expires while you type, prevents an outdated acceptance. The recorded name is a caller-supplied identifier and does not authenticate the reviewer.

Choose `export` to use the existing review. A reviewed bundle requires accepted, current local evidence and successful local validation. Otherwise the tool offers a `gaps` bundle that withholds a supported finding. Export checks the comparison and review history against what was displayed.

Each export gets a new directory. Verification uses the hash returned by that export automatically. The final output includes the HTML path and manifest hash. Keep the hash separately if you need a trusted reference for later checks; a hash stored alongside a writable bundle cannot authenticate its owner.

## Run and review the synthetic lab

With PostgreSQL server tools installed, set their location if needed. For the tested Postgres.app setup:

```sh
export PSLAB_PG_BIN="/Applications/Postgres.app/Contents/Versions/17/bin"
npm run guide
```

Choose **3**. Read the setup, collection, migration and cleanup plan. Type `run lab` to approve those operations in a new disposable cluster. The workflow continues to comparison, human review and export after cleanup.

The bundled lab uses its own synthetic intake. It does not connect to the environment described in a separately saved report. Customer resolution and customer-message approval remain pending throughout this workflow.

## Limits and recovery

- Guided mode requires an interactive terminal. The existing JSON commands remain available for scripts.
- Confirmations default to `no`; review decisions have no default.
- EOF or cancellation discards unconfirmed input. Completed writes remain recorded.
- Expired evidence remains historical. Run a new approved lab to collect fresh observations, or export the earlier run as a gap report.
- If a run or export fails, the tool stops. Restart the guide to select a previously saved run. No existing bundle is overwritten.
- Recognized secret patterns are blocked. These bounded checks do not establish that arbitrary text is safe.
- Mobile layout and browser navigation are separate report checks; this guide changes the terminal workflow.

To inspect the entry point without reading files, prompting, or starting a database:

```sh
npm run guide -- --dry-run
```
