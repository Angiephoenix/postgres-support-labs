import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash } from '../src/contracts.ts';
import { poolingManifest } from '../src/pooling-evidence.ts';
import { inspectPoolingReview, poolingReviewTemplate, appendPoolingReview, formatPoolingReview } from '../src/pooling-review.ts';
import { validatePooling } from '../src/pooling-validation.ts';
import { poolingCase, acceptCause, selectRemedy, TEST_REVIEWER } from './pooling-case-fixture.ts';

const TAXONOMY = ['OBSERVED_FACT','REPRODUCED_BEHAVIOR','DOCUMENTED_BEHAVIOR','UNVERIFIED_HYPOTHESIS','SUPPORTED_CAUSE','ENVIRONMENT_BLOCKER','PERMISSION_BLOCKER','NO_SIGNAL_WITHIN_SCOPE','RESOLUTION_VALIDATED'];
const reviews = (root: string) => join(root, 'pooling-reviews.jsonl');

test('comparison presents baseline, switch, controls and remedies without recording a decision', t => {
  const { root, now } = poolingCase(t), p = inspectPoolingReview(root, now);
  assert.equal(p.status, 'READY_FOR_REVIEW'); assert.equal(p.reviewStatus, 'NOT_REVIEWED');
  assert.equal(p.cause, null); assert.equal(p.remedySelection, null); assert.equal(p.customerResolution, null);
  assert.match(p.candidateText, /unavailable on the backend used by the next transaction/); assert.doesNotMatch(p.candidateText, /lost/);
  assert.equal(p.backendSwitch.next.sqlstate, '26000'); assert.equal(p.backendSwitch.next.heldBackend, p.backendSwitch.first.backend);
  assert.equal(p.controls.directReset.sqlstate, '26000'); assert.equal(p.controls.timeout.sqlstate, '57014');
  assert.ok(p.alternatives.every(a => TAXONOMY.includes(a.status)));
  assert.equal(inspectPoolingReview(root, new Date(now.getTime() + 60000)).comparisonHash, p.comparisonHash);
  assert.match(formatPoolingReview(p), /pooling-direct-reset/);
  assert.equal(existsSync(reviews(root)), false);
  const v = validatePooling(root, now);
  assert.equal(v.status, 'VALIDATION_BLOCKED'); assert.equal(v.remedy, null); assert.equal(existsSync(reviews(root)), false);
});

test('cause acceptance and remedy selection are separate records; validation claims only the selected remedy', t => {
  const { root, now } = poolingCase(t);
  const cause = acceptCause(root, now);
  let p = inspectPoolingReview(root, now);
  assert.equal(p.reviewStatus, 'ACCEPTED_LOCAL_LAB'); assert.equal(p.cause?.reviewHash, cause.hash); assert.equal(p.remedySelection, null);
  assert.equal(validatePooling(root, now).status, 'VALIDATION_BLOCKED');
  const selected = selectRemedy(root, now, 'protocol-prepared');
  p = inspectPoolingReview(root, now);
  assert.equal(p.remedySelection?.remedy, 'protocol-prepared'); assert.equal(p.remedySelection?.causeReviewHash, cause.hash);
  const v = validatePooling(root, now);
  assert.equal(v.status, 'RESOLUTION_VALIDATED'); assert.equal(v.remedy, 'protocol-prepared'); assert.equal(v.remedySelectionHash, selected.hash);
  assert.deepEqual(v.checks.find(c => c.id === 'selected-remedy-succeeds')?.evidence, ['pooling-protocol-first', 'pooling-protocol-next']);
  assert.equal(v.configuration?.maxPreparedStatements, 10); assert.match(v.basis, /Retained observations from the completed run/);
  assert.equal(v.customerResolution, null); assert.equal(v.communicationApproval, 'PENDING');
});

test('changing the remedy requires a new selection and produces a different validation; history is preserved', t => {
  const { root, now } = poolingCase(t);
  acceptCause(root, now); selectRemedy(root, now, 'protocol-prepared');
  const first = validatePooling(root, now), raw = readFileSync(reviews(root), 'utf8');
  selectRemedy(root, now, 'transaction-contained');
  const second = validatePooling(root, now);
  assert.equal(second.remedy, 'transaction-contained'); assert.notEqual(second.validationHash, first.validationHash);
  assert.deepEqual(second.checks.find(c => c.id === 'selected-remedy-succeeds')?.evidence, ['pooling-pooled-contained']);
  assert.ok(readFileSync(reviews(root), 'utf8').startsWith(raw));
  assert.equal(inspectPoolingReview(root, now).reviews.length, 3);
});

test('a later rejection withdraws the selection; re-acceptance requires a fresh remedy selection', t => {
  const { root, now } = poolingCase(t);
  acceptCause(root, now); selectRemedy(root, now);
  const raw = readFileSync(reviews(root), 'utf8');
  acceptCause(root, now, 'reject');
  let p = inspectPoolingReview(root, now);
  assert.equal(p.reviewStatus, 'REJECTED'); assert.equal(p.cause, null); assert.equal(p.remedySelection, null);
  assert.equal(validatePooling(root, now).status, 'VALIDATION_BLOCKED');
  assert.throws(() => poolingReviewTemplate(root, 'remedy', now), /Accept the cause/);
  acceptCause(root, now, 'request-changes');
  assert.equal(inspectPoolingReview(root, now).reviewStatus, 'CHANGES_REQUESTED');
  acceptCause(root, now);
  p = inspectPoolingReview(root, now);
  assert.equal(p.reviewStatus, 'ACCEPTED_LOCAL_LAB'); assert.equal(p.remedySelection, null);
  assert.equal(validatePooling(root, now).status, 'VALIDATION_BLOCKED');
  assert.ok(readFileSync(reviews(root), 'utf8').startsWith(raw)); assert.equal(p.reviews.length, 5);
});

test('remedy selection must bind to the current accepted cause record and comparison', t => {
  const { root, now } = poolingCase(t);
  const base = { schemaVersion: 1, scenario: 'pooling-session', kind: 'remedy', reviewer: TEST_REVIEWER, decision: 'select', remedy: 'protocol-prepared', rationale: 'Synthetic test remedy selection.' };
  const unreviewed = inspectPoolingReview(root, now);
  assert.throws(() => appendPoolingReview(root, { ...base, comparisonHash: unreviewed.comparisonHash, expectedReviewHead: unreviewed.reviewHead, causeReviewHash: hash('none') }, now), /accepted cause/);
  const old = acceptCause(root, now); acceptCause(root, now, 'reject'); acceptCause(root, now);
  const p = inspectPoolingReview(root, now);
  assert.throws(() => appendPoolingReview(root, { ...base, comparisonHash: p.comparisonHash, expectedReviewHead: p.reviewHead, causeReviewHash: old.hash }, now), /accepted cause/);
  assert.throws(() => appendPoolingReview(root, { ...base, comparisonHash: hash('other'), expectedReviewHead: p.reviewHead, causeReviewHash: p.cause!.reviewHash }, now), /outdated/);
  assert.throws(() => appendPoolingReview(root, { ...poolingReviewTemplate(root, 'cause', now), reviewer: TEST_REVIEWER, decision: 'accept', remedy: 'protocol-prepared', rationale: 'Mixed record kinds.' }, now), /kind does not match/);
  assert.equal(inspectPoolingReview(root, now).reviews.length, 3);
});

test('outdated templates, concurrent writers and sensitive rationale are refused before persistence', t => {
  const { root, now } = poolingCase(t);
  const stale = { ...poolingReviewTemplate(root, 'cause', now), reviewer: TEST_REVIEWER, decision: 'accept', rationale: 'Synthetic test decision.' };
  acceptCause(root, now, 'request-changes');
  assert.throws(() => appendPoolingReview(root, stale, now), /outdated/);
  const raw = readFileSync(reviews(root), 'utf8');
  const lock = openSync(join(root, '.pooling-review.lock'), 'wx');
  try { assert.throws(() => acceptCause(root, now), /locked/); } finally { closeSync(lock); unlinkSync(join(root, '.pooling-review.lock')); }
  assert.throws(() => appendPoolingReview(root, { ...poolingReviewTemplate(root, 'cause', now), reviewer: TEST_REVIEWER, decision: 'accept', rationale: 'password=private-value in the rationale' }, now), /Privacy gate/);
  assert.throws(() => appendPoolingReview(root, { ...poolingReviewTemplate(root, 'cause', now), reviewer: 'person@example.org', decision: 'accept', rationale: 'Synthetic test decision.' }, now));
  assert.equal(readFileSync(reviews(root), 'utf8'), raw);
});

test('expired evidence blocks acceptance, remedy selection and validation while preserving history', t => {
  const { root, now, expired } = poolingCase(t);
  acceptCause(root, now); selectRemedy(root, now);
  const p = inspectPoolingReview(root, expired);
  assert.equal(p.status, 'EVIDENCE_REQUIRED'); assert.equal(p.evidenceStatus, 'STALE'); assert.match(p.blockers[0], /expired/);
  assert.equal(p.reviewStatus, 'EVIDENCE_REQUIRED'); assert.equal(p.cause, null); assert.equal(p.remedySelection, null);
  assert.equal(validatePooling(root, expired).status, 'VALIDATION_BLOCKED');
  assert.throws(() => acceptCause(root, expired), /Evidence blockers/);
  assert.throws(() => poolingReviewTemplate(root, 'remedy', expired), /Accept the cause/);
  acceptCause(root, expired, 'reject');
  assert.equal(inspectPoolingReview(root, expired).reviews.length, 3);
});

test('tampered artifacts, altered catalog, mismatched context and edited history are rejected', t => {
  const cases: [string, (root: string, run: any) => void, RegExp][] = [
    ['catalog', root => writeFileSync(join(root, 'pooling-probes.json'), '{"execute":"EXECUTE other"}\n'), /integrity/],
    ['manifest', root => writeFileSync(join(root, 'pooling-manifest.json'), canonical({ ...poolingManifest({} as any), runHash: hash('x') }) + '\n'), /integrity/],
    ['plan', root => writeFileSync(join(root, 'pooling-plan.json'), '{"approved":false}\n'), /plan/],
  ];
  for (const [, change, expected] of cases) {
    const { root, run, now } = poolingCase(t); change(root, run);
    assert.throws(() => inspectPoolingReview(root, now), expected);
  }
  for (const change of [(r: any) => { r.observations[3].role = 'other_role'; }, (r: any) => { r.cleanup = 'FAILED'; }, (r: any) => { r.observations[2].runId = '22222222-2222-4222-8222-222222222222'; }, (r: any) => { r.observations[3].heldBackend = null; }]) {
    const { root, now } = poolingCase(t, change);
    assert.throws(() => inspectPoolingReview(root, now));
  }
  const { root, now } = poolingCase(t); acceptCause(root, now);
  const raw = readFileSync(reviews(root), 'utf8');
  writeFileSync(reviews(root), raw.replace('Synthetic test', 'Edited test'));
  assert.throws(() => inspectPoolingReview(root, now), /hash mismatch/);
});

test('history with a remedy record not bound to its governing acceptance is rejected on read', t => {
  const { root, now } = poolingCase(t);
  acceptCause(root, now, 'reject');
  const p = inspectPoolingReview(root, now);
  const input = { schemaVersion: 1, scenario: 'pooling-session', kind: 'remedy', comparisonHash: p.comparisonHash, expectedReviewHead: p.reviewHead,
    reviewer: TEST_REVIEWER, decision: 'select', remedy: 'protocol-prepared', causeReviewHash: p.reviews[0].hash, rationale: 'Forged remedy after a rejection.' };
  const body = { sequence: 2, runId: p.runId, recordedAt: now.toISOString(), previousHash: p.reviewHead, input };
  writeFileSync(reviews(root), readFileSync(reviews(root), 'utf8') + canonical({ ...body, hash: hash(body) }) + '\n');
  assert.throws(() => inspectPoolingReview(root, now), /not bound to an accepted cause/);
});
