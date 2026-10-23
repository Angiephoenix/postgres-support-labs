import { exportBundle, verifyBundle } from '../src/support-bundle.ts';
import { validateLab } from '../src/lab-validation.ts';
import { inspectLabReview, reviewTemplate, appendLabReview } from '../src/lab-review.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeLab } from '../src/native-lab.ts';
import { inspectLedger } from '../src/ledger.ts';
import { investigationGaps } from '../src/investigation-gaps.ts';
import { guideLabReview } from '../src/guided.ts';

test('actual PostgreSQL distinguishes two 42P01 failures and records the migration result', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pslab-integration-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const beforeTemps = readdirSync('/tmp').filter(s => s.startsWith('pslab-')).sort();
  const output = join(root, 'evidence');
  const report = await runNativeLab({ approved: true, output });
  const s = report.snapshots;
  assert.equal(report.cleanup, 'COMPLETE'); assert.equal(report.status, 'COMPLETE');
  assert.equal(s.before.sqlstate, '42P01'); assert.equal(s['search-path-control'].sqlstate, '42P01');
  assert.equal(s.before.migrationApplied, false); assert.equal(s.before.relationPresent, false);
  assert.equal(s['search-path-control'].migrationApplied, true); assert.equal(s['search-path-control'].relationPresent, true);
  assert.equal(s['search-path-control'].relationVisible, false); assert.equal(s['search-path-control'].qualifiedRows, 1);
  assert.equal(s.development.outcome, 'success'); assert.equal(s.after.outcome, 'success');
  assert.equal(s.after.matchingRows, 1); assert.equal(s.after.migrationApplied, true);
  assert.equal(s.before.branchFingerprint, s.after.branchFingerprint);
  assert.equal(s.before.roleFingerprint, s.after.roleFingerprint);
  assert.equal(s.before.queryShapeHash, s.after.queryShapeHash);
  assert.deepEqual(s.before.searchPath, s.after.searchPath);
  assert.notEqual(s.before.branchFingerprint, s.development.branchFingerprint);
  assert.equal(report.cause, null); assert.equal(report.resolution, null);
  for (const [phase, snapshot] of Object.entries(s)) {
    const ledger = inspectLedger(join(output, phase), new Date(), snapshot.headHash);
    assert.equal(ledger.entryCount, phase === 'search-path-control' ? 7 : 6); assert.equal(ledger.integrity, 'VALID');
    assert.ok(ledger.observations.every(o => o.source.type === 'local-lab'));
  }
  assert.equal(investigationGaps(join(output, 'before')).satisfied, 6);
  assert.equal(investigationGaps(join(output, 'after')).satisfied, 5);
  const comparison = inspectLabReview(output);
  assert.equal(comparison.status, 'READY_FOR_REVIEW');
  assert.equal(comparison.reviewStatus, 'NOT_REVIEWED');
  assert.equal(comparison.cause, null);
  assert.equal(comparison.evidence.flatMap(e => e.artifactIds).length, 25);
  // Automated test input exercises persistence; the runner never creates a review.
  appendLabReview(output, { ...reviewTemplate(output), reviewer: 'integration-test', decision: 'accept',
    rationale: 'Automated contract test of explicit input against actual measured lab evidence.' });
  assert.equal(inspectLabReview(output).reviewStatus, 'ACCEPTED_LOCAL_LAB');
  assert.equal(inspectLabReview(output).resolution, null);
  assert.equal(validateLab(output).status, 'RESOLUTION_VALIDATED');
  const bundle = join(root, 'bundle');
  const exported = exportBundle(output, bundle);
  const verified = verifyBundle(bundle, { expectedManifestHash: exported.manifestHash });
  assert.equal(verified.integrity, 'VALID');
  assert.equal(verified.currentEvidenceStatus, 'RESOLUTION_VALIDATED');
  assert.equal(verified.customerResolution, null);
  assert.equal(verified.communicationApproval, 'PENDING');
  assert.match(readFileSync(join(bundle, 'support-bundle.html'), 'utf8'), /before-failure_observation/);
  const serialized = readFileSync(join(output, 'run.json'), 'utf8');
  assert.ok(!serialized.includes('unused-local-lab')); assert.ok(!serialized.includes('Synthetic label'));
  assert.deepEqual(readdirSync('/tmp').filter(s => s.startsWith('pslab-')).sort(), beforeTemps);
  await assert.rejects(runNativeLab({ approved: true, output }), /EEXIST/);
  assert.equal(readFileSync(join(output, 'run.json'), 'utf8'), serialized);
  const second = await runNativeLab({ approved: true, output: join(root, 'repeat') });
  assert.notEqual(second.runId, report.runId);
  assert.equal(inspectLabReview(join(root, 'repeat')).reviewStatus, 'NOT_REVIEWED');
  for (const phase of Object.keys(s)) {
    for (const key of ['outcome', 'sqlstate', 'migrationApplied', 'relationPresent', 'matchingRows', 'qualifiedRows'])
      assert.equal(second.snapshots[phase][key], s[phase][key]);
  }
  const replies = ['review','accept','integration-test',
    'Automated interaction test against the measured before and after lab evidence.',
    'yes','yes','reviewed','yes'];
  const transcript: string[] = [];
  await guideLabReview({say(text) { transcript.push(text); }, async ask(prompt) {
    assert.ok(replies.length, 'Unexpected guided question: ' + prompt); return replies.shift()!;
  }},join(root,'repeat'));
  assert.equal(replies.length,0);
  const guidedDir = readdirSync(join(root,'repeat')).find(n => n.startsWith('support-bundle-'))!;
  const guidedHash = transcript.find(s => s.startsWith('Manifest hash: '))!.split('\n')[0].slice('Manifest hash: '.length);
  const guidedResult = verifyBundle(join(root,'repeat',guidedDir),{expectedManifestHash:guidedHash});
  assert.equal(guidedResult.anchorChecked,true); assert.equal(guidedResult.validationAtExport,'RESOLUTION_VALIDATED');
  assert.equal(guidedResult.customerResolution,null);
  assert.deepEqual(readdirSync('/tmp').filter(s => s.startsWith('pslab-')).sort(), beforeTemps);
});
