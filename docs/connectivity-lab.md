# Connection strings, authentication and TLS lab

An app can't connect to PostgreSQL. The error says the certificate can't be verified, or the connection is refused, or the password is wrong. Each of those happens at a different point in the connection, and some different causes share the same error. This lab reproduces them on a disposable local server and records the stage at which each one stops, so you can tell them apart before suggesting a change.

The reviewed scenario is one problem: the client doesn't trust the certificate authority (CA) that issued the server's certificate. Every other failure in the run is a control.

A fresh run leaves the cause and the customer's resolution unset. A reviewer records a cause decision, selects the fix to check, and exports a verifiable support bundle. See [review, validate and export](#review-validate-and-export).

## Run the experiment

Use Node.js 24+, matching PostgreSQL 16–18 server tools, and `openssl` on your PATH. Run as your regular OS user. No external database URL or custom connection string is accepted.

**Tested platforms:**
- **Tested:** Linux with OpenSSL 3.0, the reference run below.
- **Tested:** macOS with OpenSSL 3.6.4 as `openssl`, PostgreSQL 17.11 (Postgres.app) and Node 24.13.1. On 6 October 2026, the default tests, the experiment, cause review, remedy selection, validation, export and anchored bundle verification all ran on this setup. Cleanup reported `COMPLETE`, and every attempt had the same result, stage and protocol messages as the Linux reference run.
- **Tested:** macOS 12.7.6 with LibreSSL 2.8.3 as `/usr/bin/openssl` (first on PATH), PostgreSQL 17.11 (Postgres.app, linked to OpenSSL 3) and Node 24.13.1, at development commit `2ab5cc5`. On 12 October 2026 the default tests passed (174 of 174), all 16 connection attempts completed, the run recorded `LibreSSL 2.8.3`, the lab exited with status 0, and cleanup reported `COMPLETE` with no temporary directory or lab server left. That run hasn't been reviewed.
- **Earlier failed attempt, kept as history:** the same Mac and versions, on `main` at development commit `dc4bb2f`. The run stopped during setup with "A local command failed", before any connection attempt, and cleanup reported completed. That version of the runner didn't say which command failed. The suspected cause is a server certificate signed with SHA-1: in a test here, PostgreSQL built with OpenSSL 3 refused to start with such a certificate ("ca md too weak"). On that Mac, LibreSSL's default commands, the same ones that runner used, produced a SHA-256 signed CA and a SHA-1 signed server certificate. That supports the suspected cause, but it doesn't prove which command failed in that run. The runner now names the failing command, asks for SHA-256 explicitly and checks the certificates before starting PostgreSQL.
- **Not tested:** other LibreSSL versions. macOS ships LibreSSL as `/usr/bin/openssl`, and the lab uses whichever `openssl` comes first on your PATH. Run `openssl version` to see which one that is. The lab uses `openssl` only to create the temporary certificates; the connections themselves use Node.js's TLS.

**On a phone.** On 12 October 2026, Safari on a physical iPhone displayed these clearly: the run report's heading and measured-results table, and a gap-only bundle's heading, status summary, finding and an expanded evidence card. The bundle was exported before `0.1.0-connectivity-bundle3`. This was a visual spot check of those sections, not a complete browser or accessibility review.

Each run records the first line of `openssl version` in full, up to 200 characters, so you can tell OpenSSL from LibreSSL. Earlier runs, including the 6 October macOS run, kept only the first 60 characters.

Look at the plan first. This creates no files and starts nothing:

```sh
npm run demo:connectivity -- --dry-run
```

Set `PSLAB_PG_BIN` to the PostgreSQL server tools directory if they aren't on your PATH. After reading the plan:

```sh
npm run demo:connectivity -- --approve-lab
```

The command prints the artifact directory, manifest hash and HTML path. Open `connectivity-report.html`. Inspect the recorded JSON with:

```sh
npm run demo:connectivity -- inspect RUN_DIRECTORY MANIFEST_HASH
```

Keep the hash somewhere separate. After one hour, inspection reports `STALE` and keeps the historical measurements.

## How the lab is isolated

PostgreSQL only uses TLS over TCP, so unlike the other labs this server listens on TCP. It's restricted like this:

- **Address and port.** It listens only on `127.0.0.1`, at a random free port. Setup still uses a private Unix socket.
- **Connection rules.** The server's rules (`pg_hba.conf`) accept only TLS connections from `127.0.0.1` with SCRAM passwords, and refuse every connection without TLS.
- **Exposure.** Other users on the same machine could reach the port while the run lasts. They would still need TLS and a password.
- **Credentials.** Each run makes fresh random passwords for three synthetic roles. One password contains `#` and `@`, so encoding can be tested. Passwords are never written to retained files.
- **Certificates.** Before PostgreSQL starts, `openssl` creates three certificates, each valid for one day:
  - an issuing CA;
  - a server certificate for `db.pslab.test`, signed by that CA;
  - a second, untrusted CA.

  The certificates are signed with SHA-256 and carry set extensions: the CAs are marked as CAs, and the server certificate is for TLS server use with `DNS:db.pslab.test`. The runner gives `openssl` its own small config file, so the system `openssl.cnf` and the installed version's defaults don't change the result. Before PostgreSQL starts, the runner checks each certificate's signature algorithm, that the CAs are marked as CAs, and that the server certificate was issued by the issuing CA for `db.pslab.test`.

  If `openssl` is missing or fails, or a certificate fails those checks, the run stops before any server starts.
- **Private files.** The private keys are mode `0600`, inside a private directory with mode `0700`. The run checks both.
- **Cleanup.** At the end the runner stops the server and removes the whole temporary directory: cluster, keys, certificates and credentials. If an error happens after the server has started, the same cleanup runs and a failure summary is kept. An integration test covers that case. Cleanup doesn't cover every interruption; see [cleanup limits](#cleanup-limits).

### Host names without DNS

Connection strings name hosts under `.pslab.test`. The runner never looks those names up and doesn't change system DNS or `/etc/hosts`:

- It always opens TCP to `127.0.0.1`.
- It passes the connection string's host name as the TLS server name, so the certificate is checked against that name.
- This is like libpq's separate `host` and `hostaddr` settings.

The recorded TLS result includes the server name actually used and the certificate's names.

**One driver detail.** With the tested versions (Node 24.21.0, pg 8.23.0), the driver sets the TLS server name only when the host is a name, not an IP address. With an IP address, Node checked the certificate against `localhost` instead. The lab connects by name and sets the server name explicitly, so it doesn't depend on that behaviour.

### Settings that can't be overridden

The driver merges settings from several places:
- A connection string's TLS options replace a TLS object passed in code.
- Environment variables such as `PGSSLMODE` fill in anything left unset.

To keep each attempt exactly as intended, the runner:
1. Parses each connection string itself, with the same parser the driver uses.
2. Adds the TLS server name.
3. Passes a complete, explicit set of settings to the driver.
4. Reads the effective settings back before connecting:
   - destination;
   - port;
   - whether certificate checks are on;
   - TLS server name;
   - which CA is in use;
   - whether any custom identity check is set.
5. Refuses to run if they differ from the plan, or if `NODE_TLS_REJECT_UNAUTHORIZED` is set to turn off certificate checks for the whole process.

The names of other related environment variables that were present are recorded. Their values aren't.

## What the run measures

Each attempt records which stages passed, which failed, which weren't reached, and which weren't requested:

1. Connection-string parsing.
2. TCP connection.
3. The TLS request to the server.
4. TLS certificate verification, covering both the certificate chain and the host name.
5. PostgreSQL authentication: passes when the server sends `AuthenticationOk`, meaning it accepted the role and password.
6. Session startup: passes when the server then sends `ReadyForQuery`, after opening the requested database.
7. The query.

These stages come from client events, errors and the PostgreSQL protocol messages the client received, not from the server log. Each attempt keeps the startup messages in order, for example `authenticationSASL > authenticationSASLContinue > authenticationSASLFinal > authenticationOk > backendKeyData > readyForQuery` for a successful connection.

**Consistency checks.** The run is rejected if its records contradict each other. For example:
- a parsing, TCP or certificate failure that carries a PostgreSQL SQLSTATE or any protocol message (these are decided on the client before PostgreSQL replies);
- a certificate failure without a TLS verification code;
- a TLS result marked verified that also carries an authorization error, or one marked unverified without an error;
- a completed handshake that wasn't verified while certificate checks were on;
- a server error code that differs from its SQLSTATE, or a SQLSTATE without an `ErrorResponse` from the server;
- an authentication failure whose SQLSTATE isn't class 28, or a session-startup failure whose SQLSTATE is;
- a passed authentication or session-startup stage without the matching `AuthenticationOk` or `ReadyForQuery`.

**Server log.** The server log is read as supporting evidence and recorded only as fixed categories, such as `connection-received` or `tls-error-logged`. A missing log entry is reported as inconclusive. It never shows on its own that a server wasn't reached.

**Steps measured in a reference run on PostgreSQL 16.13, Node 24.21.0, pg 8.23.0, pg-connection-string 2.14.0 and OpenSSL 3.0.13:**

| Step | What changes | Measured result |
|---|---|---|
| Baseline | `sslmode=verify-full`, issuing CA, host `db.pslab.test` | Connected, chain and host name verified |
| Same connection without the issuing CA | No `sslrootcert`, so the default trust store | Failed at certificate verification, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, after the server agreed to TLS |
| Same connection after supplying the issuing CA | Only the trusted CA changes | Connected, chain and host name verified |
| A different, untrusted CA | `sslrootcert` points to the wrong CA | Same code as no CA |
| Host name not on the certificate | Host `wrong.pslab.test` | Failed at certificate verification, `ERR_TLS_CERT_ALTNAME_INVALID` |
| `sslmode=require` | This driver turns certificate checks on | Same failure as no CA |
| `sslmode=require` with `uselibpqcompat=true` | Certificate checks off | Connected and encrypted, certificate not verified. A control, never a fix. |
| TLS turned off | `sslmode=disable` | Refused by the server with SQLSTATE `28000` |
| Wrong password | | Failed at authentication, `28P01`, after certificate verification passed. No `AuthenticationOk` |
| Role that doesn't exist | | Also `28P01` at authentication; only the server log differed |
| Database that doesn't exist | | Authentication passed (`AuthenticationOk`), then failed at session startup with `3D000` |
| `#` in the password, not encoded | | Failed to parse, `ERR_INVALID_URL` |
| `@` in the password, not encoded | | Parsed and connected |
| `#` and `@`, not encoded | | Failed to parse, `ERR_INVALID_URL` |
| The same password, percent-encoded | | Parsed and connected |
| Port with nothing listening | | Failed at TCP connection, `ECONNREFUSED` |

**What else to note:**
- **Certificate failures still reached the server.** TCP connected and the server agreed to TLS before the client rejected the certificate.
- **The parser warning is printed once per process.** With `sslmode=require`, pg-connection-string prints a warning that it treats `require` as `verify-full`, but only once per process. The lab relies on the effective settings and the failure instead, and records the warning only when it appears.
- **Credentials accepted, database missing.** The recorded messages were `authenticationSASL > authenticationSASLContinue > authenticationSASLFinal > authenticationOk`, then an `ErrorResponse` with `3D000`. For the wrong password and the unknown role they were `authenticationSASL > authenticationSASLContinue`, then an `ErrorResponse` with `28P01`. So a `3D000` shows the role and password were accepted, and a `28P01` doesn't say whether the role exists.
- **Password parsing is recorded as observed.** These results are for this parser version only.

## Review, validate and export

Use the run directory printed by the experiment:

```sh
PSLAB_CONN_RUN="cases/connectivity-your-run-directory"
node src/cli.ts connectivity compare "$PSLAB_CONN_RUN"
```

The comparison shows three attempts together: the baseline, the failure and the fix. Every control and competing explanation follows. It reads retained files only.

There are two separate decisions, stored in `connectivity-reviews.jsonl`:

1. **Cause review.** Accept, reject or request changes on: "The client checked the server certificate against a trust store that did not contain the CA that issued it, so certificate-chain verification failed before PostgreSQL authentication."
2. **Remedy selection.** After acceptance, select `trust-issuing-ca`.

```sh
node src/cli.ts connectivity review-template "$PSLAB_CONN_RUN" cause > "$PSLAB_CONN_RUN/cause-input.json"
node src/cli.ts connectivity review "$PSLAB_CONN_RUN" "$PSLAB_CONN_RUN/cause-input.json"
node src/cli.ts connectivity review-template "$PSLAB_CONN_RUN" remedy > "$PSLAB_CONN_RUN/remedy-input.json"
node src/cli.ts connectivity review "$PSLAB_CONN_RUN" "$PSLAB_CONN_RUN/remedy-input.json"
```

`connectivity validate` reads retained attempts and makes no connection. It requires fresh evidence, an accepted cause and the selected fix, and then checks that:

- the baseline was a verified success;
- the failure stopped at certificate-chain verification, after the server agreed to TLS, with certificate checks on and the default trust store;
- only the trusted CA changed between the failure and the fix;
- after the fix:
  - certificate checks were on, with no custom identity check;
  - the chain was verified;
  - the host-name check passed for `db.pslab.test`;
  - the peer was the lab server's certificate;
  - the session was encrypted;
- the fix used the same role and database as the baseline.

Encryption alone never counts. The `uselibpqcompat` attempt is encrypted but unverified, and it can't satisfy validation.

```sh
node src/cli.ts connectivity validate "$PSLAB_CONN_RUN"
node src/cli.ts connectivity export "$PSLAB_CONN_RUN" "$PSLAB_CONN_RUN/support-bundle"
node src/cli.ts lab verify-bundle "$PSLAB_CONN_RUN/support-bundle"
```

Use `--gaps-only` with `connectivity export` for an unreviewed or expired run. `lab verify-bundle` uses the connectivity verifier only for `scenario: tls-trust` with tool version `0.1.0-connectivity-bundle1`, `0.1.0-connectivity-bundle2`, `0.1.0-connectivity-bundle3` or `0.1.0-connectivity-bundle4`.

**Bundle versions.** New exports use `0.1.0-connectivity-bundle4`. It keeps the bundle3 wording and adds the [print layout](support-bundle.md#print-a-report) to the report.

`0.1.0-connectivity-bundle3` kept everything `0.1.0-connectivity-bundle2` added, and changed two things:
- **Gap-only exports make no validation claim.** The finding is shown as a proposed explanation awaiting review, and the report and `resolution-validation.md` say that no remedy is validated. Validation checks and their results are withheld, even when the run's cause was accepted. Reviewed exports are unchanged.
- **The reproduction note** says the lab was tested with OpenSSL 3 and, on macOS 12.7.6, with LibreSSL 2.8.3, and that other LibreSSL versions haven't been verified.

`0.1.0-connectivity-bundle2` changed the wording of the drafts and the report table, and the report's layout:
- **Requested and reached TLS are kept apart.** An attempt that failed before TLS, such as a connection string that couldn't be parsed, is shown as "sslmode verify-full requested, TLS not reached", not "TLS not requested". Only `sslmode=disable` is shown as not requesting TLS.
- **The `uselibpqcompat` host name.** With certificate checks off, the host-name result is a check the lab ran on the certificate afterwards. Nothing enforced it on that connection, and the drafts now say so.
- **Layout.** Result tables switch to one block per attempt whenever the table itself has less than 760px, including beside the sidebar, so ordinary words aren't split across lines. When printed, each attempt row and each draft title stays with its content.

`0.1.0-connectivity-bundle1`, `0.1.0-connectivity-bundle2` and `0.1.0-connectivity-bundle3` exports keep their original wording and layout and still verify. The comparison and review records are the same in every version, so existing decisions stay valid.

**The drafts:**
- **Customer reply:** asks for the client library and version, `sslmode`, `sslrootcert`, the host name and the exact error, without passwords or full connection strings.
- **Engineering handoff:** says escalation hasn't been established. It lists what would make escalation worth considering, and says a `28000` refusal on its own isn't enough.

## PlanetScale documentation

The [PlanetScale profile](pooling-lab.md#the-planetscale-connection-profile) records what PlanetScale's documentation says. None of it was tested here:
- `ssl-required`: TLS is required for every connection.
- `ssl-example-parameters`: the documented example connection strings use `sslnegotiation=direct`, `sslmode=verify-full` and `sslrootcert=system`.

This lab uses its own temporary CA, the standard TLS negotiation and no system trust store. Its results are local observations and don't show how a PlanetScale connection behaves.

## What this doesn't show

**Not covered by this lab:**
- client certificates and `sslmode=verify-ca`;
- public CAs and `sslrootcert=system`;
- direct TLS negotiation;
- other client libraries;
- a customer's network path;
- the certificate a customer's server presents.

**Driver behaviour may differ.** How the driver treats `sslmode=require`, and how it parses passwords, are specific to the recorded versions.

### Cleanup limits

Cleanup runs inside the same Node.js process as the experiment. It covers a normal finish, an error during setup or connections, and a first `SIGINT` or `SIGTERM`: the runner stops at its next checkpoint, between connection attempts, and runs the same cleanup. Only the error after the server starts is covered by an integration test; the signal path isn't tested.

**Not covered:**
- **Abrupt termination.** If the process is killed with `SIGKILL`, receives a second `SIGINT` or `SIGTERM` before cleanup finishes, crashes, or the machine stops, no cleanup runs. The PostgreSQL server can keep listening on `127.0.0.1`, and the temporary directory under `/tmp/pslab-conn-*`, with the private keys, certificates and the cluster holding the synthetic roles, stays until removed by hand or by the system's temporary-file cleanup.
- **A failed stop.** If `pg_ctl stop` fails, the runner deliberately keeps the temporary directory, because the server may still be using it. It reports the path and records `cleanup: FAILED` in the failure summary. Nothing stops that server or removes the directory later.

In both cases the leftovers are private to your user (mode `0700` and `0600`) and the server listens only on loopback, but they outlive the experiment. There's no recovery command yet. To clean up by hand, check the directory is one this lab created and that its `postmaster.pid` belongs to your user, then run `pg_ctl -D <directory>/data stop` and remove the directory. Don't delete every matching `/tmp/pslab-conn-*` directory without checking, because another run may still be using one.

**When a run fails,** `connectivity-failure.json` records:
- the stage;
- the failed command by a fixed label, such as `initdb`, `pg_ctl start` or `openssl: server certificate`, with its exit status;
- the cleanup result;
- for a failed `pg_ctl start`, the reason from the server log as fixed categories, such as `server-certificate-signature-too-weak`, `address-in-use` (only when the log says the address is already in use) or `bind-failed` (any other bind error).

Raw command output and log lines are never kept, because they can contain paths.
