import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runConnectivityLab } from '../src/connectivity-lab.ts';
import { inspectConnectivity } from '../src/connectivity-evidence.ts';

const temporary = () => readdirSync('/tmp').filter(n => n.startsWith('pslab-conn-')).sort();
const ownedServers = () => spawnSync('pgrep', ['-f', 'pslab-conn-'], { encoding: 'utf8' }).stdout.trim();
const at = (run: any, phase: string) => run.attempts.find((a: any) => a.phase === phase);

test('actual PostgreSQL with TLS records the CA failure, the fix and every control twice, without retaining secrets', { timeout: 300000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'connectivity-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary();
  for (const name of ['first', 'repeat']) {
    const output = join(dir, name), { run, manifestHash } = await runConnectivityLab({ approved: true, output });
    const checked = inspectConnectivity(output, manifestHash);
    assert.equal(checked.integrity, 'VALID'); assert.equal(checked.anchorChecked, true); assert.equal(checked.evidenceStatus, 'MEASURED');
    assert.equal(at(run, 'untrusted-ca').stages.serverAcceptedTls, 'passed'); assert.equal(at(run, 'untrusted-ca').stages.tlsVerified, 'failed');
    assert.equal(at(run, 'trusted-ca-fix').tls.authorized, true); assert.equal(at(run, 'trusted-ca-fix').tls.serverName, 'db.pslab.test');
    assert.equal(at(run, 'unknown-role').failure.sqlstate, '28P01'); assert.equal(at(run, 'wrong-database').failure.sqlstate, '3D000');
    // Measured from protocol messages: the missing database is refused after AuthenticationOk; wrong credentials never get it.
    const db = at(run, 'wrong-database');
    assert.equal(db.stages.authenticated, 'passed'); assert.equal(db.stages.sessionReady, 'failed'); assert.equal(db.failure.stage, 'sessionReady');
    assert.deepEqual(db.protocol.slice(-2), ['authenticationOk', 'errorMessage']); assert.equal(db.protocol.includes('readyForQuery'), false);
    for (const p of ['wrong-password', 'unknown-role']) {
      assert.equal(at(run, p).failure.stage, 'authenticated', p); assert.equal(at(run, p).protocol.includes('authenticationOk'), false, p);
      assert.equal(at(run, p).protocol.at(-1), 'errorMessage', p);
    }
    assert.deepEqual(at(run, 'untrusted-ca').protocol, []); assert.equal(at(run, 'untrusted-ca').failure.sqlstate, null);
    assert.equal(at(run, 'trusted-ca-fix').tls.authorizationError, null); assert.equal(at(run, 'trusted-ca-fix').protocol.at(-1), 'readyForQuery');
    assert.equal(run.keyFiles.mode, '0600'); assert.equal(run.cause, null); assert.equal(run.customerResolution, null);
    for (const file of readdirSync(output)) {
      const text = readFileSync(join(output, file), 'utf8');
      assert.doesNotMatch(text, /Lab[#@][0-9a-f]{16}|PRIVATE KEY|\/tmp\/pslab-conn-|postgres:\/\//, file);
      assert.equal(statSync(join(output, file)).mode & 0o077, 0, file);
    }
    const bytes = readFileSync(join(output, 'connectivity-run.json'), 'utf8');
    await assert.rejects(runConnectivityLab({ approved: true, output }), /EEXIST/);
    assert.equal(readFileSync(join(output, 'connectivity-run.json'), 'utf8'), bytes);
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  }
});

test('actual connectivity run starts unreviewed, accepts an explicit test review and exports a verifiable bundle', { timeout: 300000 }, async t => {
  const { inspectConnectivityReview, connectivityReviewTemplate, appendConnectivityReview } = await import('../src/connectivity-review.ts');
  const { validateConnectivity } = await import('../src/connectivity-validation.ts');
  const { exportConnectivityBundle } = await import('../src/connectivity-bundle.ts');
  const { verifyAnyBundle } = await import('../src/bundle-dispatch.ts');
  const dir = mkdtempSync(join(tmpdir(), 'connectivity-review-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'run'); await runConnectivityLab({ approved: true, output });
  const fresh = inspectConnectivityReview(output);
  assert.equal(fresh.status, 'READY_FOR_REVIEW'); assert.equal(fresh.reviewStatus, 'NOT_REVIEWED'); assert.equal(fresh.cause, null);
  assert.equal(validateConnectivity(output).status, 'VALIDATION_BLOCKED');
  // Automated contract check only. This is not a human assessment of any incident.
  const reviewer = 'automated-integration-test', rationale = 'Automated integration test decision against measured local evidence.';
  appendConnectivityReview(output, { ...connectivityReviewTemplate(output, 'cause'), reviewer, decision: 'accept', rationale });
  appendConnectivityReview(output, { ...connectivityReviewTemplate(output, 'remedy'), reviewer, remedy: 'trust-issuing-ca', rationale });
  const validation = validateConnectivity(output);
  assert.equal(validation.status, 'RESOLUTION_VALIDATED', JSON.stringify(validation.checks));
  assert.equal(validation.verification?.chainVerified, true); assert.equal(validation.verification?.hostnameCheck, 'passed');
  const exported = exportConnectivityBundle(output, join(dir, 'bundle'));
  const verified = verifyAnyBundle(join(dir, 'bundle'), { expectedManifestHash: exported.manifestHash }) as any;
  assert.equal(verified.integrity, 'VALID'); assert.equal(verified.validationAtExport, 'RESOLUTION_VALIDATED');
  assert.equal(verified.customerResolution, null); assert.equal(verified.communicationApproval, 'PENDING');
});

test('missing openssl or a process-wide TLS override stops the lab before PostgreSQL starts', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'connectivity-preflight-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), oldPath = process.env.PATH, oldTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    process.env.PATH = join(dir, 'empty'); mkdirSync(process.env.PATH);
    await assert.rejects(runConnectivityLab({ approved: true, output: join(dir, 'no-openssl') }), /openssl was not found/);
    assert.equal(existsSync(join(dir, 'no-openssl')), false);
    process.env.PATH = oldPath; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    await assert.rejects(runConnectivityLab({ approved: true, output: join(dir, 'override') }), /NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.equal(existsSync(join(dir, 'override')), false);
  } finally {
    process.env.PATH = oldPath;
    if (oldTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = oldTls;
  }
  assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
});

test('a failure after PostgreSQL starts stops the owned server and removes the cluster, keys and credentials', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'connectivity-running-failure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), bin = join(dir, 'bin'), log = join(dir, 'pg_ctl.log'); mkdirSync(bin);
  // Wrappers around the real tools. After the real initdb, the cluster is made read-only by default, so the server
  // starts normally with its TLS key in place and the first CREATE ROLE fails while it is running.
  writeFileSync(join(bin, 'initdb'), `#!/bin/sh\n"${real}/initdb" "$@" || exit $?\nfor a in "$@"; do if [ "$prev" = "-D" ]; then echo "default_transaction_read_only = on" >> "$a/postgresql.conf"; fi; prev="$a"; done\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in start|stop) echo "$a" >> "${log}";; esac; done\nexec "${real}/pg_ctl" "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'postgres'), `#!/bin/sh\nexec "${real}/postgres" "$@"\n`, { mode: 0o700 });
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runConnectivityLab({ approved: true, output: join(dir, 'run') }), /during setup.*Cleanup completed/);
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'connectivity-failure.json'), 'utf8'));
    assert.equal(failure.sqlstate, '25006'); assert.equal(failure.cleanup, 'COMPLETE'); assert.equal(failure.cause, null);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start', 'stop']);
    // The temporary directory held the cluster, private keys and certificates; none of it remains.
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
    assert.deepEqual(readdirSync(join(dir, 'run')).sort(), ['connectivity-failure.json', 'connectivity-plan.json', 'connectivity-probes.json']);
  } finally { process.env.PSLAB_PG_BIN = real; }
});

// Wrappers around the real server tools for the failure tests below. Each test changes one step.
function wrapServerTools(dir: string, real: string, overrides: { initdb?: string; pg_ctl_start?: string }) {
  const bin = join(dir, 'bin'), log = join(dir, 'pg_ctl.log'); mkdirSync(bin);
  writeFileSync(join(bin, 'initdb'), overrides.initdb ?? `#!/bin/sh\nexec "${real}/initdb" "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in start|stop) echo "$a" >> "${log}";; esac; if [ "$prev" = "-D" ]; then data="$a"; fi; if [ "$prev" = "-l" ]; then logfile="$a"; fi; prev="$a"; done\n` +
    `case " $* " in *" start "*) ${overrides.pg_ctl_start ?? ':'};; esac\nexec "${real}/pg_ctl" "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'postgres'), `#!/bin/sh\nexec "${real}/postgres" "$@"\n`, { mode: 0o700 });
  return { bin, log };
}
const failureOf = (run: string) => JSON.parse(readFileSync(join(run, 'connectivity-failure.json'), 'utf8'));

test('a server certificate signed with SHA-1 is reported as a failed pg_ctl start, with fixed log categories and complete cleanup', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'connectivity-weak-cert-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Just before the server starts, re-sign its certificate with SHA-1, as an openssl that ignores the requested digest might.
  const resign = `tls="$(dirname "$data")/tls"; openssl x509 -req -in "$tls/server.csr" -CA "$tls/issuing-ca.crt" -CAkey "$tls/issuing-ca.key" -set_serial 3 -out "$tls/server.crt" -days 1 -sha1 -extfile "$tls/server.ext" >/dev/null 2>&1`;
  const before = temporary(), { bin, log } = wrapServerTools(dir, real, { pg_ctl_start: resign });
  const real0 = process.env.PSLAB_PG_BIN;
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runConnectivityLab({ approved: true, output: join(dir, 'run') }), /during setup\. Cleanup completed\. A local command failed: pg_ctl start \(exit status \d+\)/);
    const failure = failureOf(join(dir, 'run'));
    assert.equal(failure.stage, 'setup'); assert.equal(failure.cleanup, 'COMPLETE'); assert.equal(failure.failedCommand, 'pg_ctl start');
    assert.equal(typeof failure.exitStatus, 'number'); assert.deepEqual(failure.startupLog, ['server-certificate-signature-too-weak']);
    assert.doesNotMatch(JSON.stringify(failure), /\/tmp\/pslab-conn-|BEGIN|PRIVATE|Lab[#@]/);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start']);
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  } finally { process.env.PSLAB_PG_BIN = real0; }
});

test('a failed initdb is named as such, before any server starts', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'connectivity-initdb-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), { bin, log } = wrapServerTools(dir, real, { initdb: `#!/bin/sh\nif [ "$1" = --version ]; then exec "${real}/initdb" "$@"; fi\nexit 3\n` });
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runConnectivityLab({ approved: true, output: join(dir, 'run') }), /during setup\. Cleanup completed\. A local command failed: initdb \(exit status 3\)/);
    const failure = failureOf(join(dir, 'run'));
    assert.equal(failure.failedCommand, 'initdb'); assert.equal(failure.exitStatus, 3); assert.equal(failure.cleanup, 'COMPLETE'); assert.deepEqual(failure.startupLog, []);
    assert.equal(existsSync(log), false);
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  } finally { process.env.PSLAB_PG_BIN = real; }
});

test('an openssl that ignores the requested SHA-256 digest is caught before PostgreSQL starts', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'connectivity-weak-openssl-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realOpenssl = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();
  const before = temporary(), { bin, log } = wrapServerTools(dir, real, {}), sslbin = join(dir, 'sslbin'); mkdirSync(sslbin);
  writeFileSync(join(sslbin, 'openssl'), `#!/bin/sh\nfor a in "$@"; do shift; if [ "$a" = "-sha256" ]; then set -- "$@" -sha1; else set -- "$@" "$a"; fi; done\nexec "${realOpenssl}" "$@"\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  try {
    process.env.PSLAB_PG_BIN = bin; process.env.PATH = `${sslbin}:${oldPath}`;
    await assert.rejects(runConnectivityLab({ approved: true, output: join(dir, 'run') }), /during certificates\. Cleanup completed\. certificate check: issuing CA is signed with sha1WithRSAEncryption; SHA-256 is required/);
    const failure = failureOf(join(dir, 'run'));
    assert.equal(failure.stage, 'certificates'); assert.equal(failure.cleanup, 'COMPLETE');
    assert.equal(existsSync(log), false);
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  } finally { process.env.PSLAB_PG_BIN = real; process.env.PATH = oldPath; }
});

test('if the startup log cannot be read, the original pg_ctl start failure is kept and cleanup still completes', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'connectivity-unreadable-log-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // pg_ctl start fails with exit status 1 and leaves a directory where the log file should be, so reading the log throws.
  const before = temporary(), { bin, log } = wrapServerTools(dir, real, { pg_ctl_start: 'mkdir "$logfile"; exit 1' });
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runConnectivityLab({ approved: true, output: join(dir, 'run') }), /during setup\. Cleanup completed\. A local command failed: pg_ctl start \(exit status 1\)/);
    const failure = failureOf(join(dir, 'run'));
    assert.equal(failure.failedCommand, 'pg_ctl start'); assert.equal(failure.exitStatus, 1);
    assert.deepEqual(failure.startupLog, []); assert.equal(failure.cleanup, 'COMPLETE'); assert.equal(failure.stage, 'setup');
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start']);
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  } finally { process.env.PSLAB_PG_BIN = real; }
});
