import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { reportStyles, fontLicenses } from './report-theme.ts';

export const POOLING_QUERIES = Object.freeze({
  identity: 'SELECT run_id::text, current_database() AS database, current_user AS role, pg_backend_pid() AS backend FROM lab_identity',
  prepare: 'PREPARE pslab_count AS SELECT count(*)::int AS count FROM projects',
  execute: 'EXECUTE pslab_count',
  protocol: 'SELECT count(*)::int AS count FROM projects',
  reset: 'DEALLOCATE ALL',
  timeout: 'SELECT pg_sleep(1)',
});
export const POOLING_PHASES = ['direct-first','direct-next','pooled-first','pooled-next','direct-reset','pooled-contained','protocol-first','protocol-next','timeout-control'] as const;
export type Phase = typeof POOLING_PHASES[number];
export type Observation = { phase: Phase; endpoint: 'direct'|'transaction'; backend: number; database: string; role: string;
  runId: string; collectedAt: string; queryHash: string; sqlstate: string|null; count: number|null; heldBackend: number|null };
export type PoolingRun = { schemaVersion: 1; scenario: 'pooling-session'; runId: string; profile: 'local-lab';
  collectedAt: string; expiresAt: string; postgresVersion: string; pgbouncerVersion: string; clusterFingerprint: string;
  poolMode: 'transaction'; maxPreparedStatements: 10; cleanup: 'COMPLETE'; observations: Observation[];
  classification: 'REPRODUCED_BEHAVIOR'; cause: null; customerResolution: null; reviewStatus: 'NOT_REVIEWED' };

const str = { type: 'string', minLength: 1, maxLength: 100 };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const date = { type: 'string', format: 'date-time' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const observationSchema = object({ phase: { enum: [...POOLING_PHASES] }, endpoint: { enum: ['direct','transaction'] },
  backend: { type: 'number' }, database: { const: 'pslab_pooling' }, role: { const: 'pslab_app' }, runId: uuid, collectedAt: date,
  queryHash: digest, sqlstate: { enum: [null,'26000','57014'] }, count: { enum: [null,1] }, heldBackend: { type: ['number','null'] } });
const schema = object({ schemaVersion: { const: 1 }, scenario: { const: 'pooling-session' }, runId: uuid, profile: { const: 'local-lab' },
  collectedAt: date, expiresAt: date, postgresVersion: str, pgbouncerVersion: str, clusterFingerprint: digest,
  poolMode: { const: 'transaction' }, maxPreparedStatements: { const: 10 }, cleanup: { const: 'COMPLETE' },
  classification: { const: 'REPRODUCED_BEHAVIOR' }, cause: { const: null }, customerResolution: { const: null }, reviewStatus: { const: 'NOT_REVIEWED' },
  observations: { type: 'array', minItems: 9, maxItems: 9, items: observationSchema } });

export function checkPoolingRun(value: unknown, now = new Date()) {
  validateArtifact(value, schema);
  const run = value as PoolingRun;
  if (!Number.isFinite(now.getTime())) fail('Invalid pooling evidence clock.');
  const start = Date.parse(run.collectedAt), end = Date.parse(run.expiresAt);
  if (start > now.getTime() || end - start !== 3600000) fail('Invalid pooling evidence collection window.');
  const phases = Object.fromEntries(run.observations.map(o => [o.phase, o])) as Record<Phase, Observation>;
  let previous = start;
  for (let i = 0; i < POOLING_PHASES.length; i++) {
    const phase = POOLING_PHASES[i], o = run.observations[i];
    if (o.phase !== phase || o.runId !== run.runId || !Number.isSafeInteger(o.backend) || o.backend < 1) fail('Pooling observation identity or order mismatch.');
    const time = Date.parse(o.collectedAt);
    if (time < previous || time > now.getTime() || time >= end) fail('Invalid pooling observation time.');
    previous = time;
    const pooled = phase.startsWith('pooled') || phase.startsWith('protocol');
    if (o.endpoint !== (pooled ? 'transaction' : 'direct')) fail('Pooling endpoint evidence mismatch.');
    const expectedQuery = phase.startsWith('protocol') ? POOLING_QUERIES.protocol : phase === 'timeout-control' ? POOLING_QUERIES.timeout : POOLING_QUERIES.execute;
    const expectedError = ['pooled-next','direct-reset'].includes(phase) ? '26000' : phase === 'timeout-control' ? '57014' : null;
    if (o.queryHash !== hash(expectedQuery) || o.sqlstate !== expectedError || o.count !== (expectedError ? null : 1)) fail('Pooling result differs from the scenario contract.');
    if (!['pooled-next','protocol-next'].includes(phase) && o.heldBackend !== null) fail('Unexpected held backend.');
  }
  if (phases['direct-first'].backend !== phases['direct-next'].backend || phases['direct-reset'].backend !== phases['direct-first'].backend) fail('Direct session continuity was not established.');
  for (const prefix of ['pooled','protocol']) {
    const first = phases[`${prefix}-first`], next = phases[`${prefix}-next`];
    if (next.heldBackend !== first.backend || next.backend === first.backend) fail('The original backend was not held while measuring a backend change.');
  }
  return { run, evidenceStatus: now.getTime() >= end ? 'STALE' : 'MEASURED', reviewStatus: 'NOT_REVIEWED' as const };
}

export function poolingManifest(run: PoolingRun) {
  return { schemaVersion: 1, scenario: 'pooling-session', runHash: hash(run), catalogHash: hash(POOLING_QUERIES) };
}
export function inspectPooling(dir: string, expectedHash?: string, now = new Date()) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular pooling run directory.');
  const value = readJson(join(dir, 'pooling-run.json'));
  const result = checkPoolingRun(value, now);
  const manifest = readJson(join(dir, 'pooling-manifest.json'));
  if (canonical(manifest) !== canonical(poolingManifest(result.run)) || canonical(readJson(join(dir, 'pooling-probes.json'))) !== canonical(POOLING_QUERIES)) fail('Pooling artifact integrity mismatch.');
  const manifestHash = hash(manifest);
  if (expectedHash !== undefined && expectedHash !== manifestHash) fail('Pooling manifest differs from the supplied anchor.');
  return { ...result, integrity: 'VALID', anchorChecked: expectedHash !== undefined, manifestHash };
}

const descriptions: Record<Phase, string> = {
  'direct-first': 'Direct: prepare and execute', 'direct-next': 'Direct: execute in the next transaction',
  'pooled-first': 'Pooled: prepare and execute', 'pooled-next': 'Pooled: execute after a measured backend change',
  'direct-reset': 'Direct control: execute after DEALLOCATE ALL', 'pooled-contained': 'Pooled remedy: prepare, execute and deallocate in one transaction',
  'protocol-first': 'Driver prepared statement: first transaction', 'protocol-next': 'Driver prepared statement: changed backend',
  'timeout-control': 'Direct control: bounded statement timeout',
};
export function poolingMarkdown(run: PoolingRun, now = new Date()) {
  const checked = checkPoolingRun(run, now);
  return `# PgBouncer session investigation\n\nEvidence: ${checked.evidenceStatus}. Review: NOT_REVIEWED.\n\n` +
    `This disposable local experiment follows a SQL PREPARE statement across transactions. A second client holds the original server connection so the next transaction must use another backend.\n\n` +
    '| Check | Backend | SQLSTATE | Count |\n|---|---|---|---|\n' + run.observations.map(o => `| ${descriptions[o.phase]} | ${o.backend} | ${o.sqlstate ?? 'none'} | ${o.count ?? 'unavailable'} |`).join('\n') +
    '\n\nThe pooled SQL EXECUTE failed after a measured backend change. The direct reset control produced the same error on the same backend. Error 26000 alone cannot identify the connection mode or cause. The timeout control produced a different error, 57014.\n\n' +
    'The direct session preserved the SQL statement across transactions. The pooled transaction-contained workflow also succeeded. Driver-level named prepared statements succeeded across the measured backend change with max_prepared_statements=10. Choose a remedy that matches the application workflow and verify it in the affected environment.\n\n' +
    'Next questions: Which endpoint handled the failing operation? Does the connector use SQL PREPARE or protocol-level preparation? Does it reset sessions? Which pooling mode and prepared-statement setting were active? Can the same operation be compared on a direct connection with matching role and database?\n\n' +
    'Scope: synthetic local PostgreSQL and PgBouncer. Human cause review, customer resolution and message approval remain pending. This report records the measured experiment only. Review decisions, validation and support-bundle export are separate steps that start with pooling compare on this run directory.\n';
}
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function poolingHtml(run: PoolingRun, now = new Date()) {
  const checked = checkPoolingRun(run, now);
  const paragraphs = poolingMarkdown(run, now).split('\n\n').filter(p => !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('Evidence:'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'"><title>PgBouncer session investigation | Postgres Support Lab</title><style>${reportStyles}

/* Below 480px each check gets its own line, with its three values in aligned columns underneath. Explicit roles keep table semantics when rows use grid layout. */
@media(max-width:480px){.results,.results thead,.results tbody{display:block}.results tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--line)}.results th,.results td{border-bottom:0;padding:8px 10px;overflow-wrap:anywhere}.results tr>:first-child{grid-column:1/-1;padding-bottom:0}}</style></head><body><a class="skip" href="#results">Skip to results</a><aside><div class="brand"><span class="brand-mark">P</span>Postgres Support Lab</div><p class="tag">Local PostgreSQL investigation</p><nav><a href="#results">Measured results</a><a href="#interpretation">Interpretation</a><a href="#evidence">Evidence</a></nav></aside><main><header><p class="eyebrow">PgBouncer / session behavior</p><h1>Why can’t the next transaction find the prepared statement?</h1><p class="lede">In this local test, PgBouncer ran the next transaction on a different PostgreSQL server connection, and the statement prepared earlier wasn’t there. The same steps worked on a direct connection. We also got the same error with no pooler at all by clearing the statement ourselves, so the error code alone doesn’t prove the pooler is involved. Nobody has reviewed these results yet.</p><p class="status">${checked.evidenceStatus} · HUMAN REVIEW PENDING</p><p class="meta">Run ${escape(run.runId)}<br>Evidence collected ${escape(run.collectedAt)}<br>Freshness window ends ${escape(run.expiresAt)}<br>This page is a snapshot. Re-run inspection to check freshness.</p></header><section class="panel" id="results"><h2>Measured results</h2><div class="table-wrap"><table class="results" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Check</th><th role="columnheader" scope="col">Backend</th><th role="columnheader" scope="col">SQLSTATE</th><th role="columnheader" scope="col">Count</th></tr></thead><tbody role="rowgroup">${run.observations.map(o => `<tr role="row"><th role="rowheader" scope="row">${escape(descriptions[o.phase])}</th><td role="cell">${o.backend}</td><td role="cell">${o.sqlstate ?? 'none'}</td><td role="cell">${o.count ?? 'unavailable'}</td></tr>`).join('')}</tbody></table></div></section><section class="panel document" id="interpretation"><h2>What the comparison tells us</h2>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</section><section class="panel" id="evidence"><h2>Evidence and limitations</h2><p>PostgreSQL ${escape(run.postgresVersion)}. PgBouncer ${escape(run.pgbouncerVersion)}. TCP disabled. Cleanup complete.</p><p>Hashes check consistency against a separately retained anchor. They cannot authenticate a collector or detect a complete unanchored rewrite. HTML and Markdown are derived views; inspect the JSON artifacts for verification.</p><details><summary>Measured observations</summary><pre>${escape(JSON.stringify(run, null, 2))}</pre></details></section><footer>Independent project. Customer cause and resolution remain unset.${fontLicenses.map(l => `<details class="license"><summary>${escape(l.name)} font license</summary><pre>${escape(l.text)}</pre></details>`).join('')}</footer></main></body></html>`;
}
