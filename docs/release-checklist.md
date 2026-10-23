# Release checklist

Use this before sharing a new version of the repository, or before making it more widely visible. None of these steps changes the repository by itself.

## Before a release

1. **CI is green on `main`.** The workflow runs the default tests and the real PostgreSQL and PgBouncer integration tests.
2. **The examples still verify.** Run each command from the example READMEs and check that every bundle reports `integrity: VALID` against its recorded hash. Expired evidence is expected to show as no longer current; that's fine for historical examples.
3. **Read the example files yourself.** They should contain only synthetic data, run IDs, process IDs and hashes. Look for anything that resembles a real hostname, home-folder path, email address or credential.
4. **Scan the history for secrets.** Pattern searches miss things, so treat a clean result as a minimum, and consider a dedicated scanner and GitHub's secret scanning as well.
5. **Keep third-party notices.** Roboto Mono and Inter are embedded in the HTML reports. Their SIL Open Font License notices stay in `docs/roboto-mono-LICENSE.txt`, `docs/inter-LICENSE.txt` and inside each report, whatever license the project's own code uses.
6. **Read the README as a newcomer.** It should explain the problem in the first two sentences, describe only what runs today, and keep planned work in the [delivery scope](delivery-scope.md).
7. **Check the license file** matches the project's chosen license.

GitHub shows Markdown files formatted, but `.html` files appear as source code. Readers can use the Markdown reports and screenshots directly, or download an HTML report to open it in a browser.

The records below are kept as history. Commit identifiers and counts in these records refer to the project's development history, which isn't included in this release.

## Scan record: 29 September 2026

This records a scan made before checkpoint 11. It's kept here as history.

**Scope:** all 21 commits reachable from any branch at that time, including every file version ever committed, plus the example folders added in checkpoint 10.

**Patterns searched:** PostgreSQL connection URIs with credentials, private key headers, AWS-style access keys, GitHub, Slack and OpenAI-style tokens, PlanetScale-style `pscale_` tokens, `password=` assignments, email addresses, and home-folder paths.

**Findings:**

| Match | Location | Assessment |
|---|---|---|
| Fake URIs, `AKIA1234567890123456`, `-----BEGIN RSA PRIVATE KEY-----`, `example.org` addresses | `tests/*.test.ts` | Deliberate test data that checks the privacy gate rejects them |
| `password: 'unused-local-lab'` | `src/native-lab.ts`, `src/pooling-lab.ts` | A placeholder for temporary local servers on private sockets, not a real credential |
| Home-folder paths, hostnames | None found in tracked files or example files | |

**Limits:** this was pattern matching. It can't recognize every secret format, personal name or free-text detail, and no dedicated secret scanner was used.

## Scan record: 30 September 2026

A repeat scan after checkpoint 11 covered all 28 commits and the new `examples/pooling-case/` folder, with the same patterns. It found the same test data and placeholder as above, and no new findings. The only `/Users/` match was this checklist's own description of what it searched for. The same limits apply.

## Release check: 22 October 2026

This check followed the pool-exhaustion review and export work. It used a fresh clone of `main` at development commit `4b88770`, on Linux as a regular user. The [build checkpoint](build-checkpoint.md) records the tool versions and test results.

1. **CI:** passed on `4b88770` for the PostgreSQL 16 job and the 17 and 18 jobs.
2. **Examples:** the three example bundles and the PgBouncer example run report `integrity: VALID` with `anchorChecked: true` against the hashes in their READMEs. Their evidence has expired, which is expected.
3. **Example files:** checked by pattern search and a hostname search, not read line by line. The only domain found was `scripts.sil.org` in the font licenses, and the only "Desktop" matches were screenshot captions.
4. **History scan:** see below.
5. **Font notices:** both license files are present, and each example report embeds both notices.
6. **README:** the introduction now lists all six labs and says that version one isn't finished.
7. **License:** `LICENSE` is MIT, matching `package.json`.

**macOS repeat:** Angie repeated items 1 and 2 on macOS 12.7.6 with PostgreSQL 17.11 (Postgres.app), from a fresh clone of `4b88770`. All default tests, pack checks and integration suites passed, and every example verified against its published hash. The [build checkpoint](build-checkpoint.md) has the details.

**Scan scope:** every file version in all 84 commits reachable from any branch, plus commit metadata and messages. This includes the six labs, the PlanetScale profile and the example folders.

**Patterns searched:** the same as before, with `/home/<name>/` and `C:\Users` paths added.

**Findings:**

| Match | Location | Assessment |
|---|---|---|
| Fake URIs, `AKIA1234567890123456`, `-----BEGIN RSA PRIVATE KEY-----`, `password=private-value`, a `pscale_pw_` value, and `example.org`, `example.com`, `example.invalid` and `db.pslab.test` addresses | `tests/*.ts` | Deliberate test data that checks the privacy gates reject them |
| `password: 'unused-local-lab'` | Each lab's runner in `src/` | A placeholder for temporary local servers on private sockets, not a real credential |
| `postgres://${role}:${password}@...` | `src/connectivity-lab.ts` | Built at run time for temporary lab roles with generated passwords; no value is stored |
| `pscale_pw_` | `profiles/planetscale-postgres.v1.json` | A quoted documentation passage describing the prefix, not a token |
| The patterns themselves | This checklist and its earlier name, `docs/publication-checklist.md` | The checklist describing its own search |
| Home-folder paths, hostnames, GitHub, Slack or OpenAI-style tokens | None found | |

No unexpected secret or personal path was found.

**Limits:** this was pattern matching. It can't recognize every secret format, personal name or free-text detail. It covers only branches on GitHub at the time of the clone, and no dedicated secret scanner was used.
