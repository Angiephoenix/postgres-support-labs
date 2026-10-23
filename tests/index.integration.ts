import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIndexLab } from '../src/index-lab.ts';
import { inspectIndex, INDEX_QUERIES } from '../src/index-evidence.ts';

const temporary = () => readdirSync('/tmp').filter(n => n.startsWith('pslab-index-')).sort();

test('actual PostgreSQL records the statistics, index and selectivity comparisons twice with normalized plans', { timeout: 300000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'index-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary();
  for (const name of ['first', 'repeat']) {
    const output = join(dir, name), { run, manifestHash } = await runIndexLab({ approved: true, output });
    const checked = inspectIndex(output, manifestHash);
    assert.equal(checked.integrity, 'VALID'); assert.equal(checked.anchorChecked, true); assert.equal(checked.evidenceStatus, 'MEASURED');
    const [unanalyzed, analyzed, , indexed, , common] = run.observations;
    assert.equal(unanalyzed.columnStatistics, false); assert.equal(analyzed.columnStatistics, true);
    assert.equal(analyzed.summary.scanNode, 'Seq Scan'); assert.equal(indexed.summary.indexName, 'orders_customer_id_idx');
    assert.equal(common.result.orders, 60000); assert.equal(run.data.fingerprintBefore, run.data.fingerprintAfter);
    assert.equal(run.cause, null); assert.equal(run.customerResolution, null);
    const bytes = readFileSync(join(output, 'index-run.json'), 'utf8');
    for (const value of Object.values(INDEX_QUERIES.values)) assert.ok(!new RegExp(`\\b${value}\\b`).test(JSON.stringify(run.observations.map(o => o.plan))), String(value));
    assert.match(bytes, /customer_id = \$1/); assert.ok(!bytes.includes('unused-local-lab')); assert.ok(!bytes.includes('/tmp/'));
    await assert.rejects(runIndexLab({ approved: true, output }), /EEXIST/);
    assert.equal(readFileSync(join(output, 'index-run.json'), 'utf8'), bytes);
    assert.deepEqual(temporary(), before);
  }
});

test('actual index run starts unreviewed, accepts an explicit test review and exports a verifiable bundle', { timeout: 300000 }, async t => {
  const { inspectIndexReview, indexReviewTemplate, appendIndexReview } = await import('../src/index-review.ts');
  const { validateIndex } = await import('../src/index-validation.ts');
  const { exportIndexBundle } = await import('../src/index-bundle.ts');
  const { verifyAnyBundle } = await import('../src/bundle-dispatch.ts');
  const dir = mkdtempSync(join(tmpdir(), 'index-review-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'run'); await runIndexLab({ approved: true, output });
  const fresh = inspectIndexReview(output);
  assert.equal(fresh.status, 'READY_FOR_REVIEW'); assert.equal(fresh.reviewStatus, 'NOT_REVIEWED'); assert.equal(fresh.cause, null);
  assert.equal(validateIndex(output).status, 'VALIDATION_BLOCKED');
  // Automated contract check only. This is not a human assessment of any incident.
  const reviewer = 'automated-integration-test', rationale = 'Automated integration test decision against measured local evidence.';
  appendIndexReview(output, { ...indexReviewTemplate(output, 'cause'), reviewer, decision: 'accept', rationale });
  appendIndexReview(output, { ...indexReviewTemplate(output, 'remedy'), reviewer, remedy: 'create-index', rationale });
  const validation = validateIndex(output);
  assert.equal(validation.status, 'RESOLUTION_VALIDATED', JSON.stringify(validation.checks));
  const exported = exportIndexBundle(output, join(dir, 'bundle'));
  const verified = verifyAnyBundle(join(dir, 'bundle'), { expectedManifestHash: exported.manifestHash }) as any;
  assert.equal(verified.integrity, 'VALID'); assert.equal(verified.semanticConsistency, 'VALID'); assert.equal(verified.validationAtExport, 'RESOLUTION_VALIDATED');
  assert.equal(verified.customerResolution, null); assert.equal(verified.communicationApproval, 'PENDING');
});

test('an initdb failure during setup removes the temporary files before any server starts', { timeout: 120000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'index-failure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), old = process.env.PSLAB_PG_BIN;
  // Deliberate failure: server tools that report a version but cannot create a cluster.
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const name of ['initdb', 'pg_ctl', 'postgres']) writeFileSync(join(bin, name), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "postgres (PostgreSQL) 16.13"; exit 0; fi\nexit 1\n', { mode: 0o700 });
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runIndexLab({ approved: true, output: join(dir, 'run') }), /during setup.*Cleanup completed/);
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'index-failure.json'), 'utf8'));
    assert.equal(failure.stage, 'setup'); assert.equal(failure.cleanup, 'COMPLETE'); assert.equal(failure.cause, null);
    assert.deepEqual(temporary(), before);
  } finally { if (old === undefined) delete process.env.PSLAB_PG_BIN; else process.env.PSLAB_PG_BIN = old; }
});

test('a failure after PostgreSQL starts stops the owned server and removes the temporary cluster', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'index-running-failure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), bin = join(dir, 'bin'), log = join(dir, 'pg_ctl.log'); mkdirSync(bin);
  // Wrappers around the real tools. After the real initdb, the cluster is made read-only by default, so the server
  // starts normally and the lab's first write (CREATE ROLE) fails while the server is running. pg_ctl calls are logged.
  writeFileSync(join(bin, 'initdb'), `#!/bin/sh\n"${real}/initdb" "$@" || exit $?\nfor a in "$@"; do if [ "$prev" = "-D" ]; then echo "default_transaction_read_only = on" >> "$a/postgresql.conf"; fi; prev="$a"; done\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in start|stop) echo "$a" >> "${log}";; esac; done\nexec "${real}/pg_ctl" "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'postgres'), `#!/bin/sh\nexec "${real}/postgres" "$@"\n`, { mode: 0o700 });
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runIndexLab({ approved: true, output: join(dir, 'run') }), /during setup.*Cleanup completed/);
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'index-failure.json'), 'utf8'));
    assert.equal(failure.sqlstate, '25006'); assert.equal(failure.cleanup, 'COMPLETE'); assert.equal(failure.cause, null);
    // The server was started, then stopped by the runner.
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start', 'stop']);
    assert.deepEqual(temporary(), before);
    const running = spawnSync('pgrep', ['-f', 'pslab-index-'], { encoding: 'utf8' });
    assert.equal(running.stdout.trim(), '', 'no owned postgres process remains');
  } finally { process.env.PSLAB_PG_BIN = real; }
});
