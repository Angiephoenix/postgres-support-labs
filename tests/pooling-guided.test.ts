import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGuided, guidePoolingReview } from '../src/guided.ts';
import { inspectPoolingReview } from '../src/pooling-review.ts';
import { poolingCase } from './pooling-case-fixture.ts';

function ioFor(answers: (string | null)[]) {
  const output: string[] = [], remaining = [...answers];
  return { output, remaining, say(text: string) { output.push(text); }, async ask(prompt: string) {
    output.push(prompt); assert.ok(remaining.length, 'Unexpected question: ' + prompt); return remaining.shift()!;
  } };
}
const reviewer = 'Guided test reviewer', causeWhy = 'Synthetic guided test: the switch and controls support the local explanation.', remedyWhy = 'Synthetic guided test: protocol preparation matches the driver path.';
const bundles = (root: string) => readdirSync(root).filter(n => n.startsWith('support-bundle-'));

test('guided pooling review records cause, then remedy, then exports and verifies a reviewed bundle', async t => {
  const f = poolingCase(t), io = ioFor(['review-cause', 'accept', reviewer, causeWhy, 'yes', 'protocol-prepared', reviewer, remedyWhy, 'yes', 'reviewed', 'yes']);
  await guidePoolingReview(io, f.root, () => f.now);
  const p = inspectPoolingReview(f.root, f.now);
  assert.equal(p.reviewStatus, 'ACCEPTED_LOCAL_LAB'); assert.equal(p.remedySelection?.remedy, 'protocol-prepared'); assert.equal(p.reviews.length, 2);
  assert.equal(bundles(f.root).length, 1); assert.equal(io.remaining.length, 0);
  const text = io.output.join('\n');
  assert.match(text, /typing is hidden/); assert.match(text, /does not choose a remedy/); assert.match(text, /"integrity": "VALID"/);
  assert.match(text, /Local validation: RESOLUTION_VALIDATED for protocol-prepared/);
});

test('cancelling remedy selection keeps the confirmed cause review and records nothing else', async t => {
  const f = poolingCase(t), root = join(mkdtempSync(join(tmpdir(), 'pool-guided-')), 'cases'); t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
  mkdirSync(root); cpSync(f.root, join(root, 'pooling-saved'), { recursive: true });
  const io = ioFor(['2', '1', 'review-cause', 'accept', reviewer, causeWhy, 'yes', 'protocol-prepared', reviewer, '/cancel']);
  await runGuided(io, { casesRoot: root, now: () => f.now });
  const p = inspectPoolingReview(join(root, 'pooling-saved'), f.now);
  assert.equal(p.reviews.length, 1); assert.equal(p.reviewStatus, 'ACCEPTED_LOCAL_LAB'); assert.equal(p.remedySelection, null);
  assert.equal(bundles(join(root, 'pooling-saved')).length, 0);
  assert.ok(io.output.some(s => s.includes('pooling-saved (PgBouncer session)')));
  assert.match(io.output.join('\n'), /Previously saved records are retained/);
});

test('declining, backing out or cancelling before confirmation records no decision or export', async t => {
  for (const answers of [['review-cause', 'accept', reviewer, causeWhy, 'no'], ['review-cause', 'back'], ['back'], ['review-cause', 'accept', reviewer, null]]) {
    const f = poolingCase(t);
    try { await guidePoolingReview(ioFor(answers), f.root, () => f.now); } catch { /* cancellation surfaces to runGuided */ }
    assert.equal(existsSync(join(f.root, 'pooling-reviews.jsonl')), false); assert.equal(bundles(f.root).length, 0);
  }
  const f = poolingCase(t);
  await guidePoolingReview(ioFor(['review-cause', 'accept', reviewer, causeWhy, 'yes', 'back']), f.root, () => f.now);
  assert.equal(inspectPoolingReview(f.root, f.now).reviews.length, 1); assert.equal(bundles(f.root).length, 0);
  await guidePoolingReview(ioFor(['select-remedy', 'transaction-contained', reviewer, remedyWhy, 'no']), f.root, () => f.now);
  assert.equal(inspectPoolingReview(f.root, f.now).reviews.length, 1);
});

test('expired pooling evidence offers only rejection, changes or a gap export', async t => {
  const f = poolingCase(t), io = ioFor(['export', 'gaps', 'yes']);
  await guidePoolingReview(io, f.root, () => f.expired);
  assert.match(io.output.join('\n'), /Reviewed export is blocked/);
  const [bundle] = bundles(f.root);
  assert.equal(JSON.parse(readFileSync(join(f.root, bundle, 'findings.json'), 'utf8')).finding, null);
  const denied = ioFor(['review-cause', 'accept', 'back']);
  await guidePoolingReview(denied, f.root, () => f.expired);
  assert.match(denied.output.join('\n'), /Acceptance is blocked/); assert.match(denied.output.join('\n'), /Choose a listed value/);
  assert.equal(existsSync(join(f.root, 'pooling-reviews.jsonl')), false); assert.equal(denied.remaining.length, 0);
});

test('a new PgBouncer lab needs the exact approval phrase and starts unreviewed', async t => {
  const f = poolingCase(t), root = join(mkdtempSync(join(tmpdir(), 'pool-guided-')), 'cases'); t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
  let called = 0;
  const io = ioFor(['5', 'yes', 'run lab', 'back', '4']);
  await runGuided(io, { casesRoot: root, now: () => f.now, runPoolingLab: async options => {
    called++; assert.equal(options.approved, true); cpSync(f.root, options.output, { recursive: true }); return { run: f.run, manifestHash: 'test' } as any;
  } });
  assert.equal(called, 1);
  const [dir] = readdirSync(root).filter(n => n.startsWith('pooling-'));
  assert.equal(inspectPoolingReview(join(root, dir), f.now).reviewStatus, 'NOT_REVIEWED');
  assert.equal(existsSync(join(root, dir, 'pooling-reviews.jsonl')), false);
});
