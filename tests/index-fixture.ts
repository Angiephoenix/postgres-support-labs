import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hash } from '../src/contracts.ts';
import { INDEX_PHASES, INDEX_QUERIES as Q, INDEX_NAME, PHASE_SHAPE, ROLE_SETTINGS, STATISTICS_SETUP, DATA_SHAPE, SETTING_NAMES, indexManifest, planSummary } from '../src/index-evidence.ts';
import type { IndexRun, IndexObservation, IndexPhase } from '../src/index-evidence.ts';
import { indexPlan } from '../src/index-lab.ts';
import { indexReviewTemplate, appendIndexReview } from '../src/index-review.ts';

// Contract-test fixture only. These plans imitate the JSON shape of EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON);
// no database was queried to produce them, and decisions use clearly labeled test reviewers.
export function fixturePlan(node: string, options: { index?: string; estimated: number; actual: number; removed?: number; hit: number; read: number; executionMs: number }) {
  const cond = '(customer_id = $1)';
  const scan: Record<string, unknown> = { 'Node Type': node, 'Parent Relationship': 'Outer', 'Relation Name': 'orders', Alias: 'orders',
    'Plan Rows': options.estimated, 'Actual Rows': options.actual, 'Actual Loops': 1, 'Shared Hit Blocks': options.hit, 'Shared Read Blocks': options.read };
  if (node === 'Seq Scan') Object.assign(scan, { Filter: cond, 'Rows Removed by Filter': options.removed ?? 0 });
  if (node === 'Index Scan' || node === 'Index Only Scan') Object.assign(scan, { 'Index Name': options.index, 'Index Cond': cond });
  if (node === 'Bitmap Heap Scan') Object.assign(scan, { 'Recheck Cond': cond, Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Parent Relationship': 'Outer', 'Index Name': options.index, 'Index Cond': cond, 'Actual Rows': options.actual, 'Actual Loops': 1 }] });
  return [{ Plan: { 'Node Type': 'Aggregate', Strategy: 'Plain', 'Plan Rows': 1, 'Actual Rows': 1, 'Actual Loops': 1, 'Shared Hit Blocks': options.hit, 'Shared Read Blocks': options.read, Plans: [scan] },
    'Planning Time': 0.1, Triggers: [], 'Execution Time': options.executionMs }];
}

const PLANS: Record<IndexPhase, ReturnType<typeof fixturePlan>> = {
  'stats-unanalyzed': fixturePlan('Seq Scan', { estimated: 1216, actual: 5, removed: 199995, hit: 1473, read: 800, executionMs: 10.9 }),
  'stats-analyzed': fixturePlan('Seq Scan', { estimated: 6, actual: 5, removed: 199995, hit: 1569, read: 704, executionMs: 15.8 }),
  'stats-analyzed-repeat': fixturePlan('Seq Scan', { estimated: 6, actual: 5, removed: 199995, hit: 1633, read: 640, executionMs: 10.3 }),
  'index-applied': fixturePlan('Index Scan', { index: INDEX_NAME, estimated: 6, actual: 5, hit: 3, read: 4, executionMs: 0.053 }),
  'index-applied-repeat': fixturePlan('Index Scan', { index: INDEX_NAME, estimated: 6, actual: 5, hit: 7, read: 0, executionMs: 0.032 }),
  'common-value': fixturePlan('Bitmap Heap Scan', { index: INDEX_NAME, estimated: 59840, actual: 60000, hit: 1152, read: 1173, executionMs: 16.8 }),
};
export const fixtureSettings = () => Object.fromEntries(SETTING_NAMES.map(n => [n, n === 'jit' ? 'off' : n === 'max_parallel_workers_per_gather' ? '0' : n.startsWith('enable_') ? 'on' : '4']));

export function indexFixture(): IndexRun {
  const runId = '22222222-2222-4222-8222-222222222222', collectedAt = '2026-10-04T12:00:00.000Z', settings = fixtureSettings();
  return { schemaVersion: 1, scenario: 'slow-query-index', runId, profile: 'local-lab', collectedAt, expiresAt: '2026-10-04T13:00:00.000Z',
    postgresVersion: '16.13', clusterFingerprint: hash('synthetic-test-cluster'), settings, roleSettings: { ...ROLE_SETTINGS }, statisticsSetup: STATISTICS_SETUP,
    data: { table: 'orders', rows: DATA_SHAPE.rows, rareMatches: DATA_SHAPE.rareMatches, commonMatches: DATA_SHAPE.commonMatches,
      fingerprintBefore: '77bf59ed0b5efc1a5dde785fef32c780', fingerprintAfter: '77bf59ed0b5efc1a5dde785fef32c780' },
    index: { name: INDEX_NAME, definition: Q.createIndex }, cleanup: 'COMPLETE', classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED',
    observations: INDEX_PHASES.map((phase, i) => {
      const shape = PHASE_SHAPE[phase], plan = structuredClone(PLANS[phase]);
      return { phase, value: shape.value, runId, database: 'pslab_index', role: 'pslab_app', backend: 200, collectedAt: `2026-10-04T12:00:0${i}.000Z`,
        queryHash: hash(Q.measure), settingsHash: hash(settings), columnStatistics: shape.columnStatistics, indexPresent: shape.indexPresent,
        result: shape.value === 'rare' ? { orders: 5, total: '22755' } : { orders: 60000, total: '299920000' }, summary: planSummary(plan), plan } as IndexObservation;
    }) };
}
// Recomputes each summary after a test edits a plan, so the edit reaches the contract's other checks.
export function resummarize(run: IndexRun) { for (const o of run.observations) o.summary = planSummary(o.plan); }

export function indexCase(t: any, change?: (run: IndexRun) => void) {
  const root = mkdtempSync(join(tmpdir(), 'index-case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = indexFixture(); change?.(run);
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), canonical(value) + '\n');
  write('index-run.json', run); write('index-manifest.json', indexManifest(run));
  write('index-probes.json', Q); write('index-plan.json', { ...indexPlan(), runId: run.runId, approved: true });
  return { root, run, now: new Date('2026-10-04T12:30:00.000Z'), expired: new Date('2026-10-04T13:00:00.000Z') };
}
export const TEST_REVIEWER = 'automated-test-reviewer';
export function acceptIndexCause(root: string, now: Date, decision = 'accept') {
  return appendIndexReview(root, { ...indexReviewTemplate(root, 'cause', now), reviewer: TEST_REVIEWER, decision,
    rationale: 'Synthetic test decision recorded by the automated suite.' }, now);
}
export function selectIndexRemedy(root: string, now: Date) {
  return appendIndexReview(root, { ...indexReviewTemplate(root, 'remedy', now), reviewer: TEST_REVIEWER, remedy: 'create-index',
    rationale: 'Synthetic test remedy selection recorded by the automated suite.' }, now);
}
