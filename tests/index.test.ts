import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from '../src/contracts.ts';
import { checkIndexRun, normalizePlan, planSummary, indexMarkdown, indexHtml, inspectIndex, indexManifest, PHASE_LABELS, INDEX_QUERIES } from '../src/index-evidence.ts';
import { inspectIndexReview, formatIndexReview, appendIndexReview, indexReviewTemplate } from '../src/index-review.ts';
import { validateIndex } from '../src/index-validation.ts';
import { exportIndexBundle, verifyIndexBundle } from '../src/index-bundle.ts';
import { verifyAnyBundle } from '../src/bundle-dispatch.ts';
import { indexFixture, indexCase, fixturePlan, resummarize, acceptIndexCause, selectIndexRemedy, TEST_REVIEWER } from './index-fixture.ts';

const NOW = new Date('2026-10-04T12:30:00.000Z');
const temp = (t: any) => { const dir = mkdtempSync(join(tmpdir(), 'index-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const reviewed = (t: any, change?: Parameters<typeof indexCase>[1]) => { const c = indexCase(t, change); acceptIndexCause(c.root, c.now); selectIndexRemedy(c.root, c.now); return c; };
const check = (v: ReturnType<typeof validateIndex>, id: string) => v.checks.find(c => c.id === id)!.passed;

test('literal values are replaced with $1 in every plan string, including Filter, Index Cond and Recheck Cond', () => {
  const raw = [{ Plan: { 'Node Type': 'Aggregate', Plans: [{ 'Node Type': 'Bitmap Heap Scan', 'Recheck Cond': '(customer_id = 7001)',
    Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Cond': '(customer_id = 7001)' }] }, { 'Node Type': 'Seq Scan', Filter: '((customer_id = 100123) AND (id > 1001234))' }] }, 'Execution Time': 100123 }];
  const plan = normalizePlan(raw) as any;
  assert.equal(plan[0].Plan.Plans[0]['Recheck Cond'], '(customer_id = $1)');
  assert.equal(plan[0].Plan.Plans[0].Plans[0]['Index Cond'], '(customer_id = $1)');
  // Only exact bundled literals change; other numbers in strings and numeric fields stay as they are.
  assert.equal(plan[0].Plan.Plans[1].Filter, '((customer_id = $1) AND (id > 1001234))');
  assert.equal(plan[0]['Execution Time'], 100123);
});

test('the fixture run passes, and its reports follow the measurements without calling a sequential scan slow', () => {
  const run = indexFixture(), checked = checkIndexRun(run, NOW);
  assert.equal(checked.evidenceStatus, 'MEASURED');
  assert.equal(checkIndexRun(run, new Date('2026-10-04T13:00:00.000Z')).evidenceStatus, 'STALE');
  for (const label of Object.values(PHASE_LABELS)) assert.doesNotMatch(label, /slow|fast/i);
  const md = indexMarkdown(run, NOW);
  assert.match(md, /estimated 1216 matching rows; 5 matched\. After ANALYZE it estimated 6\. Fresh statistics brought the estimate closer/);
  assert.match(md, /read 7 shared blocks instead of 2273/);
  assert.match(md, /may be served by the operating system's cache, so they don't show disk activity, and they don't prove or rule out a cold cache/);
  assert.match(md, /planner chose Bitmap Heap Scan on orders_customer_id_idx with the index available and current statistics\. No scan type was forced/);
  assert.doesNotMatch(md, /Seq Scan[^.\n]*slow/i);
  const html = indexHtml(run, NOW);
  assert.match(html, /read 2273 shared blocks to return 5 rows without an index/); assert.ok(!html.includes('100123') && !html.includes('7001'));
});

test('the run contract rejects literals, edited summaries and inconsistent comparisons', () => {
  const cases: [(run: any) => void, RegExp][] = [
    [r => { r.observations[0].plan[0].Plan.Plans[0].Filter = '(customer_id = 100123)'; }, /still contains a literal/],
    [r => { r.observations[3].summary.sharedReadBlocks = 0; }, /summary differs/],
    [r => { r.settings.random_page_cost = '1.1'; }, /planner settings changed/],
    [r => { r.observations[4].settingsHash = hash({ other: true }); }, /planner settings changed/],
    [r => { r.observations[4].queryHash = hash('SELECT 1'); }, /query or planner settings changed/],
    [r => { r.data.fingerprintAfter = '0'.repeat(32); }, /data changed/],
    [r => { r.observations[1].plan = fixturePlan('Index Scan', { index: 'orders_customer_id_idx', estimated: 6, actual: 5, hit: 3, read: 4, executionMs: 0.1 }); resummarize(r); }, /before the index existed/],
    [r => { r.observations[4].result.total = '1'; }, /rare-value result changed/],
    [r => { r.observations[5].result.orders = 59999; }, /differs from the loaded data/],
    [r => { r.observations[2].plan[0].Plan.Plans[0]['Actual Rows'] = 6; resummarize(r); }, /row count differs/],
    [r => { [r.observations[1], r.observations[2]] = [r.observations[2], r.observations[1]]; }, /identity or order/],
    [r => { r.observations[0].columnStatistics = true; }, /differs from the scenario phases/],
    [r => { r.roleSettings.jit = 'on'; }, /constant mismatch/],
    [r => { r.settings.jit = 'on'; for (const o of r.observations) o.settingsHash = hash(r.settings); }, /differ from the lab role settings/],
    [r => { r.observations[0].plan[0].Plan.Plans[0]['Relation Name'] = 'customers'; }, /does not scan orders/],
  ];
  for (const [change, message] of cases) { const run = indexFixture(); change(run); assert.throws(() => checkIndexRun(run, NOW), message); }
});

test('run inspection checks the probe catalog and manifest anchor', t => {
  const c = indexCase(t), anchor = hash(indexManifest(c.run));
  assert.equal(inspectIndex(c.root, anchor, c.now).anchorChecked, true);
  assert.throws(() => inspectIndex(c.root, '0'.repeat(64), c.now), /anchor/);
  writeFileSync(join(c.root, 'index-probes.json'), JSON.stringify({ ...INDEX_QUERIES, measure: 'SELECT 1' }));
  assert.throws(() => inspectIndex(c.root, undefined, c.now), /integrity/);
});

test('the comparison keeps controls separate and needs explicit cause and remedy decisions before validation', t => {
  const c = indexCase(t);
  let p = inspectIndexReview(c.root, c.now);
  assert.equal(p.status, 'READY_FOR_REVIEW'); assert.equal(p.reviewStatus, 'NOT_REVIEWED'); assert.equal(p.cause, null);
  assert.deepEqual(p.alternatives.map(a => a.status), ['NO_SIGNAL_WITHIN_SCOPE', 'NO_SIGNAL_WITHIN_SCOPE', 'NO_SIGNAL_WITHIN_SCOPE', 'UNVERIFIED_HYPOTHESIS']);
  assert.match(p.alternatives[2].detail, /^Repeated-run check\..*read 704 blocks into PostgreSQL's shared buffers.*do not establish physical disk activity or a cold cache\..*do not rule caching out\.$/);
  assert.match(formatIndexReview(p), /## Statistics control[\s\S]*## Before and after the index[\s\S]*## Selectivity control/);
  let v = validateIndex(c.root, c.now);
  assert.equal(v.status, 'VALIDATION_BLOCKED'); assert.match(v.blockers.join(' '), /acceptance of the local cause/);
  assert.throws(() => indexReviewTemplate(c.root, 'remedy', c.now), /Accept the cause/);
  acceptIndexCause(c.root, c.now);
  v = validateIndex(c.root, c.now);
  assert.equal(v.status, 'VALIDATION_BLOCKED'); assert.match(v.blockers.join(' '), /Select the remedy/);
  selectIndexRemedy(c.root, c.now);
  v = validateIndex(c.root, c.now);
  assert.equal(v.status, 'RESOLUTION_VALIDATED'); assert.equal(v.remedy, 'create-index'); assert.ok(v.checks.every(x => x.passed));
  assert.deepEqual(v.timing, { beforeMs: [15.8, 10.3], afterMs: [0.053, 0.032], scope: 'local-lab' });
  assert.equal(validateIndex(c.root, c.expired).status, 'VALIDATION_BLOCKED');
  // A new cause decision withdraws the earlier remedy selection.
  acceptIndexCause(c.root, c.now, 'reject');
  p = inspectIndexReview(c.root, c.now); assert.equal(p.reviewStatus, 'REJECTED'); assert.equal(p.remedySelection, null);
  assert.throws(() => appendIndexReview(c.root, { ...indexReviewTemplate(c.root, 'cause', c.now), reviewer: TEST_REVIEWER, decision: 'accept', rationale: '           ok' }, c.now), /substantive/);
});

test('validation accepts index and bitmap plans, and blocks when the index is unused, work does not drop or the result changes', t => {
  const bitmap = reviewed(t, r => { for (const i of [3, 4]) r.observations[i].plan = fixturePlan('Bitmap Heap Scan', { index: 'orders_customer_id_idx', estimated: 6, actual: 5, hit: 9, read: 0, executionMs: 0.06 }); resummarize(r); });
  assert.equal(validateIndex(bitmap.root, bitmap.now).status, 'RESOLUTION_VALIDATED');
  const unused = reviewed(t, r => { for (const i of [3, 4]) r.observations[i].plan = fixturePlan('Seq Scan', { estimated: 6, actual: 5, removed: 199995, hit: 2000, read: 0, executionMs: 9 }); resummarize(r); });
  let v = validateIndex(unused.root, unused.now);
  assert.equal(v.status, 'VALIDATION_BLOCKED'); assert.equal(check(v, 'selected-index-used-after'), false); assert.equal(check(v, 'less-work-after'), true);
  const heavier = reviewed(t, r => { r.observations[4].plan = fixturePlan('Index Scan', { index: 'orders_customer_id_idx', estimated: 6, actual: 5, hit: 2273, read: 1, executionMs: 0.04 }); resummarize(r); });
  v = validateIndex(heavier.root, heavier.now);
  assert.equal(check(v, 'less-work-after'), false); assert.equal(check(v, 'selected-index-used-after'), true);
  // Timing is supporting evidence only: a slower indexed run still validates when the plan and work checks pass.
  const slower = reviewed(t, r => { r.observations[3].plan[0]['Execution Time'] = 99; resummarize(r); });
  assert.equal(validateIndex(slower.root, slower.now).status, 'RESOLUTION_VALIDATED');
});

test('reviewed and gap-only bundles export, verify through the dispatcher and reject edits', t => {
  const c = reviewed(t), dir = temp(t);
  const exported = exportIndexBundle(c.root, join(dir, 'bundle'), { now: c.now });
  assert.equal(exported.scenario, 'slow-query-index'); assert.equal(exported.remedy, 'create-index');
  const verified = verifyAnyBundle(join(dir, 'bundle'), { expectedManifestHash: exported.manifestHash, now: c.now }) as any;
  assert.equal(verified.integrity, 'VALID'); assert.equal(verified.validationAtExport, 'RESOLUTION_VALIDATED'); assert.equal(verified.currentEvidenceStatus, 'RESOLUTION_VALIDATED');
  assert.equal(verifyIndexBundle(join(dir, 'bundle'), { now: c.expired }).currentEvidenceStatus, 'VALIDATION_BLOCKED');
  const reply = readFileSync(join(dir, 'bundle', 'customer-reply.md'), 'utf8');
  assert.match(reply, /DRAFT: human communication approval pending/); assert.match(reply, /read the whole table, 2273 shared blocks, to return 5 rows/);
  assert.match(reply, /changed the planner’s row estimate but not the plan/); assert.match(reply, /timing on your system will differ/);
  const html = readFileSync(join(dir, 'bundle', 'support-bundle.html'), 'utf8');
  for (const id of ['plan-stats-unanalyzed', 'plan-index-applied', 'plan-common-value']) assert.ok(html.includes(`id="${id}"`) && html.includes(`href="#${id}"`), id);
  assert.ok(!html.includes('100123') && !html.includes('customer_id = 7001'));
  writeFileSync(join(dir, 'bundle', 'customer-reply.md'), reply.replace('DRAFT', 'FINAL'));
  assert.throws(() => verifyAnyBundle(join(dir, 'bundle'), { now: c.now }));
  const gaps = exportIndexBundle(c.root, join(dir, 'gaps'), { mode: 'gaps', now: c.now });
  const gv = verifyAnyBundle(join(dir, 'gaps'), { expectedManifestHash: gaps.manifestHash, now: c.now }) as any;
  assert.equal(gv.validationAtExport, 'WITHHELD_IN_GAP_REPORT'); assert.equal(gaps.remedy, null);
  const unreviewed = indexCase(t);
  assert.throws(() => exportIndexBundle(unreviewed.root, join(dir, 'refused'), { now: unreviewed.now }), /Reviewed export requires/);
});

test('index CLI commands follow the same usage and dry-run rules as the other labs', t => {
  const c = indexCase(t), cli = resolve('src/cli.ts');
  const dry = spawnSync(process.execPath, [cli, 'index', 'export', c.root, join(c.root, 'out'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0); assert.deepEqual(JSON.parse(dry.stdout), { operation: 'index export', network: false, database: false, writes: false, wouldWrite: true, readsInput: false });
  const bad = spawnSync(process.execPath, [cli, 'index', 'review-template', c.root, 'other'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Usage: index compare/);
});
