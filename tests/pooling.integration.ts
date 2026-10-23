import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPoolingLab } from '../src/pooling-lab.ts';
import { inspectPooling } from '../src/pooling-evidence.ts';

test('actual PgBouncer distinguishes SQL session state, protocol preparation, reset and timeout twice', { timeout: 120000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const temporary = () => readdirSync('/tmp').filter(n => n.startsWith('pslab-pool-')).sort();
  const before = temporary();
  for (const name of ['first','repeat']) {
    const output = join(dir, name), { run, manifestHash } = await runPoolingLab({ approved: true, output });
    const checked = inspectPooling(output, manifestHash);
    assert.equal(checked.integrity, 'VALID'); assert.equal(checked.anchorChecked, true); assert.equal(checked.evidenceStatus, 'MEASURED');
    assert.equal(run.observations[3].sqlstate, '26000'); assert.equal(run.observations[4].sqlstate, '26000');
    assert.equal(run.observations[7].count, 1); assert.equal(run.observations[8].sqlstate, '57014');
    assert.equal(run.cause, null); assert.equal(run.customerResolution, null);
    const bytes = readFileSync(join(output, 'pooling-run.json'), 'utf8');
    assert.ok(!bytes.includes('unused-local-lab')); assert.ok(!bytes.includes('/tmp/'));
    await assert.rejects(runPoolingLab({ approved: true, output }), /EEXIST/);
    assert.equal(readFileSync(join(output, 'pooling-run.json'), 'utf8'), bytes);
    assert.deepEqual(temporary(), before);
  }
});

test('pool startup failure stops the already-started owned PostgreSQL cluster', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-failure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const temporary = () => readdirSync('/tmp').filter(n => n.startsWith('pslab-pool-')).sort();
  const before = temporary(), stub = join(dir, 'startup-failure');
  // Deliberate process failure after the version check, without starting a pooler.
  writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "PgBouncer 1.22.0"; exit 0; fi\nexit 1\n', { mode: 0o700 });
  const old = process.env.PSLAB_PGBOUNCER_BIN;
  try {
    process.env.PSLAB_PGBOUNCER_BIN = stub;
    await assert.rejects(runPoolingLab({ approved: true, output: join(dir, 'run') }), /pool-startup.*Cleanup completed/);
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'pooling-failure.json'), 'utf8'));
    assert.equal(failure.cleanup, 'COMPLETE'); assert.equal(failure.cause, null);
    assert.deepEqual(temporary(), before);
  } finally {
    if (old === undefined) delete process.env.PSLAB_PGBOUNCER_BIN; else process.env.PSLAB_PGBOUNCER_BIN = old;
  }
});

test('actual pooling run starts unreviewed, accepts an explicit test review and exports a verifiable bundle', { timeout: 120000 }, async t => {
  const { inspectPoolingReview, poolingReviewTemplate, appendPoolingReview } = await import('../src/pooling-review.ts');
  const { validatePooling } = await import('../src/pooling-validation.ts');
  const { exportPoolingBundle } = await import('../src/pooling-bundle.ts');
  const { verifyAnyBundle } = await import('../src/bundle-dispatch.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pool-review-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'run'); await runPoolingLab({ approved: true, output });
  const fresh = inspectPoolingReview(output);
  assert.equal(fresh.status, 'READY_FOR_REVIEW'); assert.equal(fresh.reviewStatus, 'NOT_REVIEWED'); assert.equal(fresh.cause, null); assert.equal(fresh.remedySelection, null);
  assert.equal(validatePooling(output).status, 'VALIDATION_BLOCKED');
  // Automated contract check only. This is not a human assessment of any incident.
  const reviewer = 'automated-integration-test', rationale = 'Automated integration test decision against measured local evidence.';
  appendPoolingReview(output, { ...poolingReviewTemplate(output, 'cause'), reviewer, decision: 'accept', rationale });
  appendPoolingReview(output, { ...poolingReviewTemplate(output, 'remedy'), reviewer, remedy: 'protocol-prepared', rationale });
  const validation = validatePooling(output);
  assert.equal(validation.status, 'RESOLUTION_VALIDATED'); assert.equal(validation.remedy, 'protocol-prepared');
  const exported = exportPoolingBundle(output, join(dir, 'bundle'));
  const verified = verifyAnyBundle(join(dir, 'bundle'), { expectedManifestHash: exported.manifestHash }) as any;
  assert.equal(verified.integrity, 'VALID'); assert.equal(verified.semanticConsistency, 'VALID'); assert.equal(verified.validationAtExport, 'RESOLUTION_VALIDATED');
  assert.equal(verified.customerResolution, null); assert.equal(verified.communicationApproval, 'PENDING');
  const second = join(dir, 'second'); await runPoolingLab({ approved: true, output: second });
  assert.equal(inspectPoolingReview(second).reviewStatus, 'NOT_REVIEWED');
});
