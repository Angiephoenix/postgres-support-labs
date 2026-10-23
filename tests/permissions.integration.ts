import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPermissionsLab } from '../src/permissions-lab.ts';
import { inspectPermissions } from '../src/permissions-evidence.ts';

const temporary = () => readdirSync('/tmp').filter(n => n.startsWith('pslab-perm-')).sort();
const ownedServers = () => spawnSync('pgrep', ['-fa', '[p]slab-perm-'], { encoding: 'utf8' }).stdout.trim();
const at = (run: any, phase: string) => run.attempts.find((a: any) => a.phase === phase);

test('actual PostgreSQL records the missing table grant, every control and the one-statement fix, twice', { timeout: 300000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'permissions-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary();
  for (const name of ['first', 'repeat']) {
    const output = join(dir, name), { run, manifestHash } = await runPermissionsLab({ approved: true, output });
    const checked = inspectPermissions(output, manifestHash);
    assert.equal(checked.integrity, 'VALID'); assert.equal(checked.anchorChecked, true); assert.equal(checked.evidenceStatus, 'MEASURED');
    // Measured: the wrong role and the missing grant give the same SQLSTATE and error category.
    assert.deepEqual(at(run, 'wrong-role').unqualified, at(run, 'table-select-missing').unqualified);
    assert.equal(at(run, 'table-select-missing').context.currentUser, 'pslab_app'); assert.equal(at(run, 'wrong-role').context.currentUser, 'pslab_reporting');
    // Without schema USAGE the schema drops out of the effective search path, so the error matches the search-path control.
    assert.deepEqual(at(run, 'schema-usage-missing').context.searchPath, ['public']);
    assert.deepEqual(at(run, 'schema-usage-missing').unqualified, at(run, 'search-path-missing').unqualified);
    assert.equal(at(run, 'schema-usage-missing').qualified.error, 'permission-denied-schema'); assert.equal(at(run, 'search-path-missing').qualified.ok, true);
    assert.deepEqual(checked.changes.added, [{ kind: 'table', object: 'app_data.project_tasks', grantee: 'pslab_app', privilege: 'SELECT', grantable: false }]);
    assert.equal(run.privilegeChange.defaultPrivilegeEntries, 0);
    assert.equal(at(run, 'fix-applied').privileges.insert, false); assert.equal(run.cause, null); assert.equal(run.customerResolution, null);
    assert.match(run.postgresVersion, /^1[678]\./);
    for (const file of readdirSync(output)) {
      const text = readFileSync(join(output, file), 'utf8');
      // Raw PostgreSQL messages are not retained, only their SQLSTATE and a fixed category.
      assert.doesNotMatch(text, /\/tmp\/pslab-perm-|postgres:\/\/|permission denied for (table|schema) |relation "[^"]*" does not exist/, file);
      assert.equal(statSync(join(output, file)).mode & 0o077, 0, file);
    }
    const bytes = readFileSync(join(output, 'permissions-run.json'), 'utf8');
    await assert.rejects(runPermissionsLab({ approved: true, output }), /EEXIST/);
    assert.equal(readFileSync(join(output, 'permissions-run.json'), 'utf8'), bytes);
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  }
});

test('a failure after PostgreSQL starts stops the owned server and removes the cluster', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'permissions-running-failure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), bin = join(dir, 'bin'), log = join(dir, 'pg_ctl.log'); mkdirSync(bin);
  // After the real initdb, the cluster is made read-only by default, so the server starts and the first CREATE ROLE fails while it runs.
  writeFileSync(join(bin, 'initdb'), `#!/bin/sh\n"${real}/initdb" "$@" || exit $?\nfor a in "$@"; do if [ "$prev" = "-D" ]; then echo "default_transaction_read_only = on" >> "$a/postgresql.conf"; fi; prev="$a"; done\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in start|stop) echo "$a" >> "${log}";; esac; done\nexec "${real}/pg_ctl" "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'postgres'), `#!/bin/sh\nexec "${real}/postgres" "$@"\n`, { mode: 0o700 });
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runPermissionsLab({ approved: true, output: join(dir, 'run') }), /during setup.*Cleanup completed/);
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'permissions-failure.json'), 'utf8'));
    assert.equal(failure.sqlstate, '25006'); assert.equal(failure.cleanup, 'COMPLETE'); assert.equal(failure.cause, null);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start', 'stop']);
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
    assert.deepEqual(readdirSync(join(dir, 'run')).sort(), ['permissions-failure.json', 'permissions-plan.json', 'permissions-probes.json']);
  } finally { process.env.PSLAB_PG_BIN = real; }
});

test('a failed initdb is named as such, before any server starts', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'permissions-initdb-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'initdb'), `#!/bin/sh\nif [ "$1" = --version ]; then exec "${real}/initdb" "$@"; fi\nexit 3\n`, { mode: 0o700 });
  for (const tool of ['pg_ctl', 'postgres']) writeFileSync(join(bin, tool), `#!/bin/sh\nexec "${real}/${tool}" "$@"\n`, { mode: 0o700 });
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runPermissionsLab({ approved: true, output: join(dir, 'run') }), /during setup\. Cleanup completed\. A local command failed: initdb \(exit status 3\)/);
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'permissions-failure.json'), 'utf8'));
    assert.equal(failure.failedCommand, 'initdb'); assert.equal(failure.exitStatus, 3); assert.equal(failure.cleanup, 'COMPLETE');
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  } finally { process.env.PSLAB_PG_BIN = real; }
});

test('actual permissions run starts unreviewed, accepts an explicit test review and exports verifiable reviewed and gap-only bundles', { timeout: 300000 }, async t => {
  const { inspectPermissionsReview, permissionsReviewTemplate, appendPermissionsReview } = await import('../src/permissions-review.ts');
  const { validatePermissions } = await import('../src/permissions-validation.ts');
  const { exportPermissionsBundle } = await import('../src/permissions-bundle.ts');
  const { verifyAnyBundle } = await import('../src/bundle-dispatch.ts');
  const dir = mkdtempSync(join(tmpdir(), 'permissions-review-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'run'); await runPermissionsLab({ approved: true, output });
  const fresh = inspectPermissionsReview(output);
  assert.equal(fresh.status, 'READY_FOR_REVIEW'); assert.equal(fresh.reviewStatus, 'NOT_REVIEWED'); assert.equal(fresh.cause, null);
  assert.deepEqual(fresh.privilegeChange.snapshotMismatches, []);
  assert.equal(validatePermissions(output).status, 'VALIDATION_BLOCKED');
  const gapsBefore = exportPermissionsBundle(output, join(dir, 'gaps-unreviewed'), { mode: 'gaps' });
  // Automated contract check only. This is not a human assessment of any incident.
  const reviewer = 'automated-integration-test', rationale = 'Automated integration test decision against measured local evidence.';
  appendPermissionsReview(output, { ...permissionsReviewTemplate(output, 'cause'), reviewer, decision: 'accept', rationale });
  appendPermissionsReview(output, { ...permissionsReviewTemplate(output, 'remedy'), reviewer, remedy: 'grant-table-select', rationale });
  const validation = validatePermissions(output);
  assert.equal(validation.status, 'RESOLUTION_VALIDATED', JSON.stringify(validation.checks));
  assert.equal(validation.verification?.writePrivileges, false);
  const reviewed = exportPermissionsBundle(output, join(dir, 'reviewed')), gaps = exportPermissionsBundle(output, join(dir, 'gaps-accepted'), { mode: 'gaps' });
  for (const [name, e, at] of [['reviewed', reviewed, 'RESOLUTION_VALIDATED'], ['gaps-accepted', gaps, 'WITHHELD_IN_GAP_REPORT'], ['gaps-unreviewed', gapsBefore, 'WITHHELD_IN_GAP_REPORT']] as const) {
    const verified = verifyAnyBundle(join(dir, name), { expectedManifestHash: e.manifestHash }) as any;
    assert.equal(verified.integrity, 'VALID', name); assert.equal(verified.validationAtExport, at, name);
    assert.equal(verified.customerResolution, null, name); assert.equal(verified.communicationApproval, 'PENDING', name);
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 'gaps-unreviewed', 'validation.json'), 'utf8')).blockers[0], 'An applicable acceptance of the local cause is required.');
});
