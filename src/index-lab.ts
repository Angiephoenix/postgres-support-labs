import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { canonical, hash, fail, LedgerError } from './contracts.ts';
import { INDEX_QUERIES as Q, ROLE_SETTINGS, STATISTICS_SETUP, DATA_SHAPE, INDEX_NAME, checkIndexRun, indexManifest, indexHtml, indexMarkdown, normalizePlan, planSummary } from './index-evidence.ts';
import type { IndexRun, IndexObservation, IndexPhase } from './index-evidence.ts';

export function indexPlan() {
  return { profile: 'local-lab', approvalRequired: true, network: false, connection: 'private Unix socket; TCP disabled',
    operations: ['Create a disposable PostgreSQL cluster with 200,000 synthetic orders and autovacuum turned off',
      'Measure one customer filter before and after ANALYZE, with EXPLAIN (ANALYZE, BUFFERS)', 'Repeat the query to compare blocks found in shared buffers with blocks read into them',
      'Create the bundled index on customer_id and measure the same query twice', 'Measure a common customer value with the index available',
      'Replace literal values with $1 in every retained plan', 'Stop the owned server and remove temporary server files'],
    retained: ['versioned observations with normalized plans', 'probe catalog', 'anchorable manifest', 'HTML and Markdown experiment reports'],
    reviewStatus: 'NOT_REVIEWED', cause: null, customerResolution: null };
}
const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
function executable(name: string, directory?: string) {
  for (const dir of directory ? [directory] : (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { const file = join(dir, name); accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* next directory */ }
  }
  return fail('PostgreSQL server tools were not found. Set PSLAB_PG_BIN to their bin directory.');
}
function command(file: string, args: string[]) {
  const result = spawnSync(file, args, { env: env(), encoding: 'utf8', timeout: 60000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) fail('A local server command failed. Raw process output is withheld.');
  return result.stdout;
}
function write(path: string, value: unknown) { writeFileSync(path, canonical(value) + '\n', { flag: 'wx', mode: 0o600 }); }
function one(rows: any[]) { if (rows.length !== 1) fail('Unexpected bounded probe row count.'); return rows[0]; }
function sqlstate(e: unknown) { const code = (e as { code?: string })?.code; return typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : null; }

export async function runIndexLab(options: { approved: boolean; output: string }) {
  if (options.approved !== true) fail('Index lab execution requires --approve-lab.');
  // Refuse to run unless this lab's pack matches its bundled probe catalog.
  (await import('./lab-packs.ts')).requireWorkingPack('slow-query-index');
  if (!['linux','darwin'].includes(process.platform)) fail('Use macOS or Linux for the native index lab.');
  if (process.getuid?.() === 0) fail('Run the lab as a regular user, without sudo.');
  const bins = Object.fromEntries(['initdb','pg_ctl','postgres'].map(n => [n, executable(n, process.env.PSLAB_PG_BIN)]));
  const majors = Object.values(bins).map(b => Number(command(b, ['--version']).match(/\(PostgreSQL\) (\d+)/)?.[1]));
  if (!majors.every(m => m === majors[0] && m >= 16 && m <= 18)) fail('Use matching PostgreSQL 16, 17 or 18 server tools.');
  mkdirSync(options.output, { mode: 0o700 });
  const output = realpathSync(options.output), runId = randomUUID(), collectedAt = new Date().toISOString();
  write(join(output, 'index-plan.json'), { ...indexPlan(), runId, approved: true });
  write(join(output, 'index-probes.json'), Q);
  const root = mkdtempSync('/tmp/pslab-index-'), data = join(root, 'data'), socket = join(root, 'pg');
  mkdirSync(socket, { mode: 0o700 });
  let failure: unknown, stage = 'setup', clusterFingerprint = '', postgresVersion = '', cleanup = 'PENDING';
  const clients = new Set<Client>(), observations: IndexObservation[] = [];
  const interrupt = () => { failure ??= new Error('interrupted'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const check = () => { if (failure) fail('Index experiment interrupted or a connection was lost.'); };
  async function connect(database = 'pslab_index', user = 'pslab_app') {
    check();
    const client = new Client({ host: socket, port: 5432, database, user, password: 'unused-local-lab', ssl: false, options: '',
      application_name: 'pslab-index', client_encoding: 'UTF8', connectionTimeoutMillis: 1500, query_timeout: 30000 });
    client.on('error', () => { failure ??= new Error('connection'); });
    try { await client.connect(); clients.add(client); return client; }
    catch (e) { await client.end().catch(() => {}); throw e; }
  }
  async function close(c: Client) { clients.delete(c); await c.end(); }
  async function fingerprint(c: Client) {
    const f = one((await c.query(Q.fingerprint)).rows);
    if (f.rows !== DATA_SHAPE.rows || !/^[a-f0-9]{32}$/.test(f.digest)) fail('Loaded data differs from the scenario.');
    return f.digest as string;
  }
  async function observe(c: Client, phase: IndexPhase, value: 'rare'|'common') {
    check();
    const id = one((await c.query(Q.identity)).rows), time = new Date().toISOString();
    if (id.run_id !== runId || id.database !== 'pslab_index' || id.role !== 'pslab_app') fail('Index target identity mismatch.');
    const settings = Object.fromEntries((await c.query(Q.settings)).rows.map(r => [r.name, r.setting]));
    const state = one((await c.query(Q.statistics)).rows);
    // Implementation choice: the bundled integer is written into the EXPLAIN text so the plan is made for that value.
    // normalizePlan replaces it with $1 again. The result query uses a bound parameter.
    const explained = one((await c.query(Q.explain + Q.measure.replace('$1', String(Q.values[value])))).rows)['QUERY PLAN'];
    const result = one((await c.query(Q.measure, [Q.values[value]])).rows);
    const plan = normalizePlan(explained) as unknown[];
    observations.push({ phase, value, runId, database: id.database, role: id.role, backend: id.backend, collectedAt: time,
      queryHash: hash(Q.measure), settingsHash: hash(settings), columnStatistics: state.column_statistics, indexPresent: state.index_present,
      result: { orders: result.orders, total: String(result.total) }, summary: planSummary(plan), plan });
    return settings;
  }
  let settings: Record<string, string> = {}, before = '', after = '';
  try {
    command(bins.initdb, ['-D', data, '-U', 'pslab_owner', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\nport = 5432\nmax_connections = 8\nshared_buffers = '16MB'\nautovacuum = off\n`);
    command(bins.pg_ctl, ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '15', 'start']);
    const owner = await connect('postgres', 'pslab_owner');
    const system = one((await owner.query("SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version, system_identifier::text AS identifier FROM pg_control_system()")).rows);
    if (realpathSync(system.directory) !== realpathSync(data)) fail('Owned PostgreSQL directory mismatch.');
    clusterFingerprint = hash(system.identifier); postgresVersion = system.version;
    await owner.query(`CREATE ROLE pslab_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; ALTER ROLE pslab_app SET statement_timeout = '20s'; ALTER ROLE pslab_app SET max_parallel_workers_per_gather = ${ROLE_SETTINGS.max_parallel_workers_per_gather}; ALTER ROLE pslab_app SET jit = ${ROLE_SETTINGS.jit}`);
    await owner.query('CREATE DATABASE pslab_index'); await close(owner);
    stage = 'load';
    const setup = await connect('pslab_index', 'pslab_owner');
    await setup.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE TABLE lab_identity (run_id uuid NOT NULL); ${Q.createTable}; ${Q.load}; GRANT SELECT ON lab_identity, orders TO pslab_app`);
    await setup.query('INSERT INTO lab_identity VALUES ($1)', [runId]);
    const matches = one((await setup.query(Q.matches, [Q.values.rare, Q.values.common])).rows);
    if (matches.rare !== DATA_SHAPE.rareMatches || matches.common !== DATA_SHAPE.commonMatches) fail('Loaded data differs from the scenario.');
    before = await fingerprint(setup); await close(setup);
    stage = 'statistics-control';
    const app = await connect();
    settings = await observe(app, 'stats-unanalyzed', 'rare');
    const maintain = await connect('pslab_index', 'pslab_owner');
    await maintain.query(Q.analyze);
    await observe(app, 'stats-analyzed', 'rare'); await observe(app, 'stats-analyzed-repeat', 'rare');
    stage = 'index';
    await maintain.query(Q.createIndex);
    if (!one((await maintain.query("SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid = 'orders'::regclass AND NOT indisprimary")).rows).name.endsWith(INDEX_NAME)) fail('Bundled index was not created.');
    await observe(app, 'index-applied', 'rare'); await observe(app, 'index-applied-repeat', 'rare');
    stage = 'selectivity-control';
    await observe(app, 'common-value', 'common');
    after = await fingerprint(maintain);
    check();
  } catch (error) { failure ??= error; }
  finally {
    for (const c of clients) await c.end().catch(() => {});
    if (existsSync(join(data, 'postmaster.pid'))) {
      try { command(bins.pg_ctl, ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop']); } catch { cleanup = 'FAILED'; failure ??= new Error('postgres cleanup'); }
    }
    if (cleanup !== 'FAILED') { rmSync(root, { recursive: true, force: true }); cleanup = 'COMPLETE'; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (failure) {
    write(join(output, 'index-failure.json'), { runId, stage, cleanup, sqlstate: sqlstate(failure), cause: null });
    fail(cleanup === 'FAILED' ? `Index lab cleanup failed. Owned temporary files remain at ${root}.` : `Index lab failed during ${stage}. Cleanup completed. ${failure instanceof LedgerError ? failure.message : 'Check the retained failure summary.'}`);
  }
  const run: IndexRun = { schemaVersion: 1, scenario: 'slow-query-index', runId, profile: 'local-lab', collectedAt,
    expiresAt: new Date(Date.parse(collectedAt) + 3600000).toISOString(), postgresVersion, clusterFingerprint, settings, roleSettings: ROLE_SETTINGS,
    statisticsSetup: STATISTICS_SETUP, data: { table: 'orders', rows: DATA_SHAPE.rows, rareMatches: DATA_SHAPE.rareMatches, commonMatches: DATA_SHAPE.commonMatches, fingerprintBefore: before, fingerprintAfter: after },
    index: { name: INDEX_NAME, definition: Q.createIndex }, cleanup: 'COMPLETE', observations,
    classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED' };
  // Retain unexpected measurements for investigation; only a passing contract gets a manifest and report.
  write(join(output, 'index-run.json'), run);
  checkIndexRun(run);
  const manifest = indexManifest(run); write(join(output, 'index-manifest.json'), manifest);
  writeFileSync(join(output, 'index-report.md'), indexMarkdown(run), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(output, 'index-report.html'), indexHtml(run), { flag: 'wx', mode: 0o600 });
  return { run, manifestHash: hash(manifest) };
}
