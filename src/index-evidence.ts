import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { reportStyles, fontLicenses } from './report-theme.ts';

// The fixed SQL for the slow-query/index lab. The measured query takes one parameter. As an implementation
// choice, the runner writes one of the two bundled integer values below into the EXPLAIN text (EXPLAIN could
// also take a bound parameter through the extended query protocol), then replaces it with $1 everywhere in
// the retained plan.
export const INDEX_QUERIES = Object.freeze({
  identity: 'SELECT run_id::text, current_database() AS database, current_user AS role, pg_backend_pid() AS backend FROM lab_identity',
  createTable: 'CREATE TABLE orders (id bigint PRIMARY KEY, customer_id integer NOT NULL, amount_cents integer NOT NULL, note text NOT NULL) WITH (autovacuum_enabled = false)',
  load: "INSERT INTO orders SELECT g, CASE WHEN g % 10 < 3 THEN 7001 ELSE 100000 + (g % 40000) END, (g * 37) % 10000, repeat('x', 40) FROM generate_series(1, 200000) AS g",
  matches: 'SELECT count(*) FILTER (WHERE customer_id = $1)::int AS rare, count(*) FILTER (WHERE customer_id = $2)::int AS common FROM orders',
  fingerprint: "SELECT count(*)::int AS rows, md5(string_agg(id || ':' || customer_id || ':' || amount_cents, ',' ORDER BY id)) AS digest FROM orders",
  settings: "SELECT name, setting FROM pg_settings WHERE name IN ('default_statistics_target','effective_cache_size','enable_bitmapscan','enable_indexonlyscan','enable_indexscan','enable_seqscan','jit','max_parallel_workers_per_gather','random_page_cost','seq_page_cost','shared_buffers','work_mem') ORDER BY name",
  statistics: "SELECT EXISTS (SELECT 1 FROM pg_stats WHERE schemaname = 'public' AND tablename = 'orders' AND attname = 'customer_id') AS column_statistics, EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'orders' AND indexname = 'orders_customer_id_idx') AS index_present",
  explain: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ',
  measure: 'SELECT count(*)::int AS orders, coalesce(sum(amount_cents), 0)::bigint AS total FROM orders WHERE customer_id = $1',
  analyze: 'ANALYZE orders',
  createIndex: 'CREATE INDEX orders_customer_id_idx ON orders (customer_id)',
  values: Object.freeze({ rare: 100123, common: 7001 }),
});
export const INDEX_NAME = 'orders_customer_id_idx';
export const INDEX_PHASES = ['stats-unanalyzed','stats-analyzed','stats-analyzed-repeat','index-applied','index-applied-repeat','common-value'] as const;
export type IndexPhase = typeof INDEX_PHASES[number];
export const SETTING_NAMES = ['default_statistics_target','effective_cache_size','enable_bitmapscan','enable_indexonlyscan','enable_indexscan','enable_seqscan','jit','max_parallel_workers_per_gather','random_page_cost','seq_page_cost','shared_buffers','work_mem'] as const;
// The lab role turns off parallel workers and JIT so plans stay comparable. Scan choices are left to the planner.
export const ROLE_SETTINGS = Object.freeze({ max_parallel_workers_per_gather: '0', jit: 'off' });
export const STATISTICS_SETUP = 'Autovacuum was turned off for the cluster and the orders table, and ANALYZE was not run after loading, so the first measurement ran on a table with no column statistics. The lab then ran ANALYZE once, and the data did not change afterwards.';
export const DATA_SHAPE = { table: 'orders', rows: 200000, rareMatches: 5, commonMatches: 60000 } as const;
const PLAN_LIMIT = 16384;

// Which phases run the rare value, and which have the index or column statistics. Fixed by the scenario.
export const PHASE_SHAPE: Record<IndexPhase, { value: 'rare'|'common'; indexPresent: boolean; columnStatistics: boolean }> = {
  'stats-unanalyzed': { value: 'rare', indexPresent: false, columnStatistics: false },
  'stats-analyzed': { value: 'rare', indexPresent: false, columnStatistics: true },
  'stats-analyzed-repeat': { value: 'rare', indexPresent: false, columnStatistics: true },
  'index-applied': { value: 'rare', indexPresent: true, columnStatistics: true },
  'index-applied-repeat': { value: 'rare', indexPresent: true, columnStatistics: true },
  'common-value': { value: 'common', indexPresent: true, columnStatistics: true },
};

export type PlanSummary = { scanNode: string; indexName: string|null; estimatedRows: number; actualRows: number; rowsRemovedByFilter: number|null;
  sharedHitBlocks: number; sharedReadBlocks: number; planningMs: number; executionMs: number };
export type IndexObservation = { phase: IndexPhase; value: 'rare'|'common'; runId: string; database: string; role: string; backend: number;
  collectedAt: string; queryHash: string; settingsHash: string; columnStatistics: boolean; indexPresent: boolean;
  result: { orders: number; total: string }; summary: PlanSummary; plan: unknown[] };
export type IndexRun = { schemaVersion: 1; scenario: 'slow-query-index'; runId: string; profile: 'local-lab'; collectedAt: string; expiresAt: string;
  postgresVersion: string; clusterFingerprint: string; settings: Record<string, string>; roleSettings: typeof ROLE_SETTINGS;
  statisticsSetup: string; data: { table: 'orders'; rows: number; rareMatches: number; commonMatches: number; fingerprintBefore: string; fingerprintAfter: string };
  index: { name: string; definition: string }; cleanup: 'COMPLETE'; observations: IndexObservation[];
  classification: 'REPRODUCED_BEHAVIOR'; cause: null; customerResolution: null; reviewStatus: 'NOT_REVIEWED' };

// Replaces the bundled literal values with $1 in every string of a plan, including Filter, Index Cond and Recheck Cond.
const literal = new RegExp(`(?<![0-9.])(${INDEX_QUERIES.values.rare}|${INDEX_QUERIES.values.common})(?![0-9.])`, 'g');
export function normalizePlan(value: unknown, depth = 0): unknown {
  if (depth > 40) fail('Plan is nested too deeply.');
  if (typeof value === 'string') return value.replace(literal, () => '$1');
  if (Array.isArray(value)) return value.map(v => normalizePlan(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizePlan(v, depth + 1)]));
  return value;
}
function literalsRemain(value: unknown): boolean {
  if (typeof value === 'string') { literal.lastIndex = 0; return literal.test(value); }
  if (Array.isArray(value)) return value.some(literalsRemain);
  if (value && typeof value === 'object') return Object.values(value).some(literalsRemain);
  return false;
}

const number = (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail('Plan value is missing or invalid.'); return v; };
// Reads the scan of orders and the query's total buffer counts from an EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) result.
export function planSummary(plan: unknown): PlanSummary {
  if (!Array.isArray(plan) || plan.length !== 1 || !plan[0] || typeof plan[0] !== 'object') fail('Plan has an unexpected shape.');
  const root = plan[0] as any, top = root.Plan;
  let scan: any = null;
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 20) fail('Plan has an unexpected shape.');
    if (node['Relation Name'] === 'orders') { if (scan) fail('Plan scans orders more than once.'); scan = node; }
    for (const child of node.Plans ?? []) visit(child, depth + 1);
  };
  visit(top, 0);
  if (!scan || typeof scan['Node Type'] !== 'string') fail('Plan does not scan orders.');
  const bitmapIndex = scan['Node Type'] === 'Bitmap Heap Scan' ? (scan.Plans ?? []).find((p: any) => p['Node Type'] === 'Bitmap Index Scan') : null;
  const indexName = scan['Index Name'] ?? bitmapIndex?.['Index Name'] ?? null;
  return { scanNode: scan['Node Type'], indexName: typeof indexName === 'string' ? indexName : null,
    estimatedRows: number(scan['Plan Rows']), actualRows: number(scan['Actual Rows']) * number(scan['Actual Loops']),
    rowsRemovedByFilter: scan['Rows Removed by Filter'] === undefined ? null : number(scan['Rows Removed by Filter']),
    sharedHitBlocks: number(top['Shared Hit Blocks']), sharedReadBlocks: number(top['Shared Read Blocks']),
    planningMs: number(root['Planning Time']), executionMs: number(root['Execution Time']) };
}

const str = { type: 'string', minLength: 1, maxLength: 100 };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const md5 = { type: 'string', pattern: '^[a-f0-9]{32}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const date = { type: 'string', format: 'date-time' };
const count = { type: 'number' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const summarySchema = object({ scanNode: { enum: ['Seq Scan','Index Scan','Index Only Scan','Bitmap Heap Scan'] }, indexName: { type: ['string','null'], maxLength: 63 },
  estimatedRows: count, actualRows: count, rowsRemovedByFilter: { type: ['number','null'] }, sharedHitBlocks: count, sharedReadBlocks: count, planningMs: count, executionMs: count });
const observationSchema = object({ phase: { enum: [...INDEX_PHASES] }, value: { enum: ['rare','common'] }, runId: uuid, database: { const: 'pslab_index' },
  role: { const: 'pslab_app' }, backend: count, collectedAt: date, queryHash: digest, settingsHash: digest, columnStatistics: { type: 'boolean' },
  indexPresent: { type: 'boolean' }, result: object({ orders: count, total: { type: 'string', pattern: '^[0-9]{1,15}$' } }), summary: summarySchema,
  plan: { type: 'array', minItems: 1, maxItems: 1 } });
const schema = object({ schemaVersion: { const: 1 }, scenario: { const: 'slow-query-index' }, runId: uuid, profile: { const: 'local-lab' },
  collectedAt: date, expiresAt: date, postgresVersion: str, clusterFingerprint: digest,
  settings: object(Object.fromEntries(SETTING_NAMES.map(n => [n, { type: 'string', maxLength: 40 }]))),
  roleSettings: object({ max_parallel_workers_per_gather: { const: '0' }, jit: { const: 'off' } }), statisticsSetup: { const: STATISTICS_SETUP },
  data: object({ table: { const: 'orders' }, rows: { const: DATA_SHAPE.rows }, rareMatches: { const: DATA_SHAPE.rareMatches }, commonMatches: { const: DATA_SHAPE.commonMatches },
    fingerprintBefore: md5, fingerprintAfter: md5 }),
  index: object({ name: { const: INDEX_NAME }, definition: { const: INDEX_QUERIES.createIndex } }), cleanup: { const: 'COMPLETE' },
  classification: { const: 'REPRODUCED_BEHAVIOR' }, cause: { const: null }, customerResolution: { const: null }, reviewStatus: { const: 'NOT_REVIEWED' },
  observations: { type: 'array', minItems: 6, maxItems: 6, items: observationSchema } });

export function checkIndexRun(value: unknown, now = new Date()) {
  validateArtifact(value, schema);
  const run = value as IndexRun;
  if (!Number.isFinite(now.getTime())) fail('Invalid index evidence clock.');
  const start = Date.parse(run.collectedAt), end = Date.parse(run.expiresAt);
  if (start > now.getTime() || end - start !== 3600000) fail('Invalid index evidence collection window.');
  if (run.settings.max_parallel_workers_per_gather !== '0' || run.settings.jit !== 'off') fail('Recorded planner settings differ from the lab role settings.');
  if (run.data.fingerprintBefore !== run.data.fingerprintAfter) fail('The data changed during the experiment.');
  const settingsHash = hash(run.settings);
  let previous = start;
  for (let i = 0; i < INDEX_PHASES.length; i++) {
    const phase = INDEX_PHASES[i], o = run.observations[i], shape = PHASE_SHAPE[phase];
    if (o.phase !== phase || o.runId !== run.runId || !Number.isSafeInteger(o.backend) || o.backend < 1) fail('Index observation identity or order mismatch.');
    const time = Date.parse(o.collectedAt);
    if (time < previous || time > now.getTime() || time >= end) fail('Invalid index observation time.');
    previous = time;
    if (o.value !== shape.value || o.indexPresent !== shape.indexPresent || o.columnStatistics !== shape.columnStatistics) fail('Index observation differs from the scenario phases.');
    if (o.queryHash !== hash(INDEX_QUERIES.measure) || o.settingsHash !== settingsHash) fail('The query or planner settings changed between measurements.');
    if (o.result.orders !== (o.value === 'rare' ? run.data.rareMatches : run.data.commonMatches)) fail('Index result differs from the loaded data.');
    if (canonical(o.plan).length > PLAN_LIMIT || literalsRemain(o.plan)) fail('Retained plan is too large or still contains a literal value.');
    if (canonical(planSummary(o.plan)) !== canonical(o.summary)) fail('Plan summary differs from the retained plan.');
    if (o.summary.actualRows !== o.result.orders) fail('Plan row count differs from the query result.');
    if (!o.indexPresent && (o.summary.scanNode !== 'Seq Scan' || o.summary.indexName !== null)) fail('A scan used an index before the index existed.');
  }
  const rare = run.observations.filter(o => o.value === 'rare');
  if (rare.some(o => o.result.total !== rare[0].result.total)) fail('The rare-value result changed between measurements.');
  return { run, evidenceStatus: now.getTime() >= end ? 'STALE' : 'MEASURED', reviewStatus: 'NOT_REVIEWED' as const };
}

export function indexManifest(run: IndexRun) {
  return { schemaVersion: 1, scenario: 'slow-query-index', runHash: hash(run), catalogHash: hash(INDEX_QUERIES) };
}
export function inspectIndex(dir: string, expectedHash?: string, now = new Date()) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular index run directory.');
  const result = checkIndexRun(readJson(join(dir, 'index-run.json')), now);
  const manifest = readJson(join(dir, 'index-manifest.json'));
  if (canonical(manifest) !== canonical(indexManifest(result.run)) || canonical(readJson(join(dir, 'index-probes.json'))) !== canonical(INDEX_QUERIES)) fail('Index artifact integrity mismatch.');
  const manifestHash = hash(manifest);
  if (expectedHash !== undefined && expectedHash !== manifestHash) fail('Index manifest differs from the supplied anchor.');
  return { ...result, integrity: 'VALID', anchorChecked: expectedHash !== undefined, manifestHash };
}

export const PHASE_LABELS: Record<IndexPhase, string> = {
  'stats-unanalyzed': 'Rare value, no index, no column statistics', 'stats-analyzed': 'Rare value, no index, after ANALYZE',
  'stats-analyzed-repeat': 'Same query repeated, no index', 'index-applied': 'Rare value with the index',
  'index-applied-repeat': 'Same query repeated, with the index', 'common-value': 'Common value with the index',
};
export const blocks = (s: PlanSummary) => s.sharedHitBlocks + s.sharedReadBlocks;
export const ms = (n: number) => n < 1 ? n.toFixed(3) : n.toFixed(1);
export const plan = (s: PlanSummary) => s.indexName ? `${s.scanNode} on ${s.indexName}` : s.scanNode;
// Describes the statistics control from its measurements: estimates against actual rows, and the work each run did.
export function statisticsSentence(u: PlanSummary, a: PlanSummary) {
  const closer = Math.abs(a.estimatedRows - a.actualRows) < Math.abs(u.estimatedRows - u.actualRows);
  return `Without column statistics the planner estimated ${u.estimatedRows} matching rows; ${u.actualRows} matched. After ANALYZE it estimated ${a.estimatedRows}. ` +
    `${closer ? 'Fresh statistics brought the estimate closer to the actual count' : 'Fresh statistics did not bring the estimate closer to the actual count'}, ` +
    `and both runs used ${u.scanNode === a.scanNode ? 'the same plan, ' + plan(a) : `${plan(u)} and then ${plan(a)}`}, reading ${blocks(u)} and ${blocks(a)} shared blocks.`;
}

export function indexMarkdown(run: IndexRun, now = new Date()) {
  const checked = checkIndexRun(run, now), o = Object.fromEntries(run.observations.map(x => [x.phase, x])) as Record<IndexPhase, IndexObservation>;
  const before = o['stats-analyzed'].summary, after = o['index-applied'].summary, u = o['stats-unanalyzed'].summary, c = o['common-value'].summary;
  return `# Slow query and index investigation\n\nEvidence: ${checked.evidenceStatus}. Review: NOT_REVIEWED.\n\n` +
    `This disposable local experiment loads ${run.data.rows} synthetic orders. One customer value matches ${run.data.rareMatches} rows and another matches ${run.data.commonMatches}. The same query filters on customer_id each time.\n\n` +
    '| Check | Plan | Estimated rows | Actual rows | Shared blocks (hit + read) | Execution ms |\n|---|---|---|---|---|---|\n' +
    run.observations.map(x => `| ${PHASE_LABELS[x.phase]} | ${plan(x.summary)} | ${x.summary.estimatedRows} | ${x.summary.actualRows} | ${blocks(x.summary)} (${x.summary.sharedHitBlocks} + ${x.summary.sharedReadBlocks}) | ${ms(x.summary.executionMs)} |`).join('\n') +
    `\n\n${statisticsSentence(u, before)}\n\n` +
    `With the index, the planner chose ${plan(after)}. The result was unchanged, and the query read ${blocks(after)} shared blocks instead of ${blocks(before)}. Repeating each query shows how many blocks were already in PostgreSQL's shared buffers and how many had to be read into them. Those reads may be served by the operating system's cache, so they don't show disk activity, and they don't prove or rule out a cold cache.\n\n` +
    `For the common value, which matches ${run.data.commonMatches} of ${run.data.rows} rows, the planner chose ${plan(c)} with the index available and current statistics. No scan type was forced.\n\n` +
    `Timing is local supporting evidence and will differ on other machines. Parallel workers and JIT were off for the lab role so plans stay comparable.\n\n` +
    'Next questions: What does EXPLAIN (ANALYZE, BUFFERS) show for the slow query in the affected environment? How many rows match the value used? Which indexes exist on the filtered columns, and when was the table last analyzed? Is the slowdown constant, or only on some runs?\n\n' +
    'Scope: synthetic local PostgreSQL. Human cause review, customer resolution and message approval remain pending. Review decisions, validation and support-bundle export are separate steps that start with index compare on this run directory.\n';
}
function lede(run: IndexRun) {
  const o = Object.fromEntries(run.observations.map(x => [x.phase, x.summary])) as Record<IndexPhase, PlanSummary>;
  const before = o['stats-analyzed'], after = o['index-applied'];
  return `In this local test, a query for one customer’s orders read ${blocks(before)} shared blocks to return ${before.actualRows} rows without an index, using ${plan(before)}. With an index on the filtered column it returned the same result using ${plan(after)} and read ${blocks(after)} shared blocks.`;
}
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
export function indexHtml(run: IndexRun, now = new Date()) {
  const checked = checkIndexRun(run, now);
  const paragraphs = indexMarkdown(run, now).split('\n\n').filter(p => !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('Evidence:'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'"><title>Slow query and index investigation | Postgres Support Lab</title><style>${reportStyles}

/* Below 480px each check gets its own line, with its values in aligned columns underneath. Explicit roles keep table semantics when rows use grid layout. */
@media(max-width:480px){.results,.results thead,.results tbody{display:block}.results tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-bottom:1px solid var(--line)}.results th,.results td{border-bottom:0;padding:8px 10px;overflow-wrap:anywhere}.results tr>:first-child{grid-column:1/-1;padding-bottom:0}}</style></head><body><a class="skip" href="#results">Skip to results</a><aside><div class="brand"><span class="brand-mark">P</span>Postgres Support Lab</div><p class="tag">Local PostgreSQL investigation</p><nav><a href="#results">Measured results</a><a href="#interpretation">Interpretation</a><a href="#evidence">Evidence</a></nav></aside><main><header><p class="eyebrow">Query plans / indexes</p><h1>Why does this query read the whole table?</h1><p class="lede">${escape(lede(run))} Nobody has reviewed these results yet.</p><p class="status">${checked.evidenceStatus} · HUMAN REVIEW PENDING</p><p class="meta">Run ${escape(run.runId)}<br>Evidence collected ${escape(run.collectedAt)}<br>Freshness window ends ${escape(run.expiresAt)}<br>This page is a snapshot. Re-run inspection to check freshness.</p></header><section class="panel" id="results"><h2>Measured results</h2><div class="table-wrap"><table class="results" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Check</th><th role="columnheader" scope="col">Plan</th><th role="columnheader" scope="col">Estimated rows</th><th role="columnheader" scope="col">Actual rows</th><th role="columnheader" scope="col">Shared blocks</th><th role="columnheader" scope="col">Execution ms</th></tr></thead><tbody role="rowgroup">${run.observations.map(o => `<tr role="row"><th role="rowheader" scope="row">${escape(PHASE_LABELS[o.phase])}</th><td role="cell">${escape(plan(o.summary))}</td><td role="cell">${o.summary.estimatedRows}</td><td role="cell">${o.summary.actualRows}</td><td role="cell">${blocks(o.summary)}</td><td role="cell">${ms(o.summary.executionMs)}</td></tr>`).join('')}</tbody></table></div></section><section class="panel document" id="interpretation"><h2>What the comparison tells us</h2>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</section><section class="panel" id="evidence"><h2>Evidence and limitations</h2><p>PostgreSQL ${escape(run.postgresVersion)}. TCP disabled. Cleanup complete. ${escape(run.statisticsSetup)}</p><p>Literal values are replaced with $1 throughout the retained plans. Hashes check consistency against a separately retained anchor. They cannot authenticate a collector or detect a complete unanchored rewrite. HTML and Markdown are derived views; inspect the JSON artifacts for verification.</p><details><summary>Measured observations</summary><pre>${escape(JSON.stringify(run, null, 2))}</pre></details></section><footer>Independent project. Customer cause and resolution remain unset.${fontLicenses.map(l => `<details class="license"><summary>${escape(l.name)} font license</summary><pre>${escape(l.text)}</pre></details>`).join('')}</footer></main></body></html>`;
}
