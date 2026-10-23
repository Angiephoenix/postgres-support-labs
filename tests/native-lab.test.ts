import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { investigationFixture } from '../examples/investigation-fixture.ts';
import { parseCase, parseObservation, hash } from '../src/contracts.ts';
import { createCase, appendObservation } from '../src/ledger.ts';
import { investigationGaps } from '../src/investigation-gaps.ts';
import { labPlan, runNativeLab } from '../src/native-lab.ts';

function localFixture() {
  const now = new Date();
  const fixture = investigationFixture(now);
  const scope = { ...fixture.config.scope, environment: 'local-lab', identityMethod: 'lab-marker' };
  const config = { ...fixture.config, schemaVersion: 3, profile: 'local-lab', scope,
    intake: { ...fixture.config.intake, environment: 'local-lab' } };
  const observations = fixture.observations.map(o => ({ ...o, schemaVersion: 3, scope,
    source: { ...o.source, type: 'local-lab', runId: '12345678-1234-1234-1234-123456789abc' },
    result: o.kind === 'target_identity' ? { ...o.result, method: 'lab-marker', serverVersion: '170011', clusterFingerprint: hash('synthetic-cluster') }
      : o.kind === 'relation_inventory' ? { ...o.result, present: false, coverage: 'visible-to-role' }
      : o.kind === 'failure_observation' ? { ...o.result, matchingRows: null }
      : o.kind === 'permissions' ? { ...o.result, relationSelect: null } : o.result }));
  return { config, observations };
}
test('native execution requires approval before creating files or discovering binaries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lab-approval-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'new');
  await assert.rejects(runNativeLab({ approved: false, output }), /approve-lab/);
  assert.equal(existsSync(output), false);
});
test('dry run creates no case and ignores inherited database targets', t => {
  const root = mkdtempSync(join(tmpdir(), 'lab-dry-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new URL('../scripts/postgres-demo.ts', import.meta.url);
  const r = spawnSync(process.execPath, [script.pathname, '--dry-run'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PGHOST: 'secret-target', PGPASSWORD: 'must-not-print', PSLAB_PG_BIN: '/missing-tools' } });
  assert.equal(r.status, 0); assert.deepEqual(readdirSync(root), []);
  assert.match(r.stdout, /private Unix socket/); assert.ok(!r.stdout.includes('must-not-print'));
});
test('CLI refuses external URLs, arbitrary SQL and contradictory execution flags', () => {
  for (const args of [['postgres://private-user:secret@host/db'], ['SELECT 1'], ['--dry-run', '--approve-lab']]) {
    const r = spawnSync(process.execPath, ['scripts/postgres-demo.ts', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.ok(!r.stderr.includes('private-user')); assert.ok(!r.stderr.includes('SELECT 1'));
  }
});
test('local-lab contracts require execution identity and retain unknown privilege state', () => {
  const { config, observations } = localFixture();
  assert.equal(parseCase(config).profile, 'local-lab');
  for (const o of observations) parseObservation(o);
  const o = observations[0];
  assert.throws(() => parseObservation({ ...o, source: { type: 'fixture', id: 'schema-drift', version: '1' } }));
  assert.throws(() => parseObservation({ ...o, scope: { ...o.scope, environment: 'production' } }));
  assert.throws(() => parseObservation({ ...o, scope: { ...o.scope, connectionMode: 'pooled' } }));
  assert.throws(() => parseObservation({ ...o, result: { ...o.result, method: 'fixture-definition' } }));
});
test('fixture and measured-lab records cannot be mixed in either direction', t => {
  const root = mkdtempSync(join(tmpdir(), 'lab-provenance-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const lab = localFixture(), fixture = investigationFixture(new Date());
  createCase(join(root, 'lab'), lab.config); createCase(join(root, 'fixture'), fixture.config);
  assert.throws(() => appendObservation(join(root, 'lab'), fixture.observations[0]), /cannot be mixed/);
  assert.throws(() => appendObservation(join(root, 'fixture'), lab.observations[0]), /cannot be mixed/);
});
test('six local-lab records are labeled separately and leave human decisions pending', t => {
  const root = mkdtempSync(join(tmpdir(), 'lab-coverage-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'case'), { config, observations } = localFixture(); createCase(dir, config);
  for (const o of observations) appendObservation(dir, o);
  const report = investigationGaps(dir);
  assert.equal(report.status, 'LOCAL_LAB_EVIDENCE_COMPLETE'); assert.equal(report.satisfied, 6);
  assert.equal(report.cause, null); assert.equal(report.resolution, null); assert.equal(report.reviewStatus, 'NOT_REVIEWED');
});
test('the execution plan makes writes, cleanup and retained evidence explicit', () => {
  const plan = labPlan(); assert.equal(plan.network, false); assert.equal(plan.approvalRequired, true);
  assert.ok(plan.operations.some(s => s.includes('migration'))); assert.ok(plan.operations.some(s => s.includes('Stop')));
});
