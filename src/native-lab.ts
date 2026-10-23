import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { canonical, hash, fail, LedgerError } from './contracts.ts';
import type { InvestigationCase, TypedObservation, Kind } from './contracts.ts';
import { createCase, appendObservation, inspectLedger } from './ledger.ts';
import { investigationGaps } from './investigation-gaps.ts';

const MIGRATION = '002_project_labels';
const DATABASES = ['pslab_development', 'pslab_affected', 'pslab_search_path'] as const;
type Database = typeof DATABASES[number];
const APPLICATION_QUERY = 'SELECT count(*)::int AS matching_rows FROM project_labels WHERE project_id = $1';
const QUALIFIED_QUERY = 'SELECT count(*)::int AS matching_rows FROM app_data.project_labels WHERE project_id = $1';
const PARAMETERS = [1];
export const PROBES = Object.freeze({
  target_identity: 'SELECT run_id, marker, current_database() AS database FROM lab_meta.identity LIMIT 2',
  effective_context: 'SELECT current_database() AS database, current_user AS role, current_schemas(false)::text[] AS search_path, current_schema() AS current_schema, current_setting(\'server_version_num\') AS server_version',
  relation_inventory: `SELECT c.oid::text AS oid, pg_catalog.pg_table_is_visible(c.oid) AS visible
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r' LIMIT 2`,
  permissions: `SELECT pg_catalog.has_schema_privilege(current_user, $1, 'USAGE') AS schema_usage,
    CASE WHEN $2::oid IS NULL THEN NULL ELSE pg_catalog.has_table_privilege(current_user, $2::oid, 'SELECT') END AS relation_select`,
  migration_state: 'SELECT EXISTS (SELECT 1 FROM lab_meta.migrations WHERE id = $1) AS applied',
  failure_observation: APPLICATION_QUERY,
});
const SCHEMA = `
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  CREATE SCHEMA app_data;
  CREATE SCHEMA lab_meta;
  CREATE TABLE lab_meta.identity (run_id uuid NOT NULL, marker uuid NOT NULL);
  CREATE TABLE lab_meta.migrations (id text PRIMARY KEY);
  CREATE TABLE app_data.projects (id integer PRIMARY KEY, name text NOT NULL);
  INSERT INTO app_data.projects VALUES (1, 'Synthetic project');
  GRANT USAGE ON SCHEMA app_data, lab_meta TO pslab_app;
  GRANT SELECT ON ALL TABLES IN SCHEMA lab_meta, app_data TO pslab_app;
`;
const MIGRATION_SQL = `
  CREATE TABLE app_data.project_labels (project_id integer REFERENCES app_data.projects(id), label text NOT NULL);
  INSERT INTO app_data.project_labels VALUES (1, 'Synthetic label');
  INSERT INTO lab_meta.migrations VALUES ('002_project_labels');
  GRANT SELECT ON app_data.project_labels TO pslab_app;
`;
const limitations = 'Measured on a disposable local PostgreSQL cluster with synthetic data. No customer environment was inspected.';

export function labCatalog() {
  return { schemaVersion: 1, queries: PROBES, qualifiedQuery: QUALIFIED_QUERY,
    parameters: PARAMETERS, migration: MIGRATION_SQL, baseline: SCHEMA };
}

export function labPlan() {
  return { profile: 'local-lab', approvalRequired: true, network: false,
    connection: 'private Unix socket; TCP disabled',
    operations: ['Create a new temporary cluster', 'Create three synthetic databases and an application role',
      'Collect fixed read-only probes', 'Apply the bundled migration to the affected lab database',
      'Collect post-change observations', 'Stop the owned server and remove temporary cluster files'],
    retained: ['case ledgers', 'probe catalog', 'run report'],
    cause: null, resolution: null };
}

function binaryDirectory(): string {
  const candidates = process.env.PSLAB_PG_BIN ? [process.env.PSLAB_PG_BIN] : (process.env.PATH ?? '').split(delimiter);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      for (const bin of ['initdb', 'pg_ctl', 'postgres']) accessSync(join(candidate, bin), constants.X_OK);
      return realpathSync(candidate);
    } catch { /* Try the next installed binary directory. */ }
  }
  return fail('PostgreSQL server tools were not found. Set PSLAB_PG_BIN to their bin directory.');
}
// Child processes receive no inherited PostgreSQL target, password, service or startup configuration.
function childEnvironment() { return { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }; }
function command(bin: string, args: string[], stage: string, timeout = 30000) {
  const r = spawnSync(bin, args, { env: childEnvironment(), encoding: 'utf8', timeout, maxBuffer: 65536 });
  if (r.error || r.status !== 0) fail(`Local lab ${stage} failed. No raw process output is included.`);
  return r.stdout;
}
function writeArtifact(path: string, value: unknown) {
  writeFileSync(path, canonical(value) + '\n', { flag: 'wx', mode: 0o600 });
}
function one(rows: Record<string, any>[]) {
  if (rows.length !== 1) fail('A bounded lab probe returned an unexpected row count.');
  return rows[0];
}
function errorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

export async function runNativeLab(options: { approved: boolean; output: string }) {
  if (options.approved !== true) fail('Local lab execution requires --approve-lab.');
  // Refuse to run unless every pack file is valid and this lab's pack matches its bundled probe catalog.
  (await import('./lab-packs.ts')).requireWorkingPack('schema-drift');
  if (!['darwin', 'linux'].includes(process.platform)) fail('The native lab requires macOS or Linux.');
  if (process.getuid?.() === 0) fail('PostgreSQL must run as a regular user. Do not run this command with sudo.');
  const bin = binaryDirectory();
  const versions = ['initdb', 'pg_ctl', 'postgres'].map(name => command(join(bin, name), ['--version'], 'version check'));
  const majors = versions.map(v => Number(v.match(/\(PostgreSQL\) (\d+)/)?.[1]));
  if (!majors.every(v => v === majors[0] && v >= 16 && v <= 18)) fail('Use matching PostgreSQL 16, 17 or 18 server binaries.');
  // Refuse existing output paths before creating a server or making any database changes.
  mkdirSync(options.output, { mode: 0o700 });
  const output = realpathSync(options.output);
  const runId = randomUUID();
  writeArtifact(join(output, 'plan.json'), { ...labPlan(), runId, approved: true });
  writeArtifact(join(output, 'probes.json'), labCatalog());
  // /tmp keeps Unix socket paths below platform limits, including macOS's shorter limit.
  const root = mkdtempSync('/tmp/pslab-');
  const data = join(root, 'data');
  const socket = join(root, 'socket');
  mkdirSync(socket, { mode: 0o700 });
  let started = false;
  let clusterFingerprint = '';
  let failure: unknown;
  let cleanup = 'PENDING';
  let stage = 'initialization';
  const markers = new Map<Database, string>();
  const snapshots: Record<string, any> = {};
  const interrupt = () => { failure = new Error('interrupted'); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  function checkInterrupted() { if (failure) fail('Local lab interrupted.'); }
  async function connect(database: string, user = 'pslab_owner') {
    checkInterrupted();
    const client = new Client({ host: socket, port: 5432, database, user, password: 'unused-local-lab',
      ssl: false, options: '', application_name: 'postgres-support-lab', client_encoding: 'UTF8',
      connectionTimeoutMillis: 5000, query_timeout: 6000, statement_timeout: 5000,
      lock_timeout: 1000, idle_in_transaction_session_timeout: 10000 });
    client.on('error', () => { failure = new Error('connection lost'); });
    try { await client.connect(); return client; }
    catch { await client.end().catch(() => {}); return fail('Local lab connection failed.'); }
  }
  async function admin(database: string, action: (client: Client) => Promise<void>) {
    stage = 'setup-or-migration';
    const client = await connect(database);
    try {
      const state = one((await client.query('SELECT current_setting(\'data_directory\') AS directory, system_identifier::text AS identifier FROM pg_control_system()')).rows);
      if (realpathSync(state.directory) !== realpathSync(data)) fail('Local lab data-directory identity mismatch.');
      const fingerprint = hash(state.identifier);
      if (clusterFingerprint && clusterFingerprint !== fingerprint) fail('Local lab cluster identity mismatch.');
      clusterFingerprint = fingerprint;
      await action(client);
    } finally { await client.end(); }
  }
  async function collect(database: Database, phase: string, expectedOutcome: 'error'|'success') {
    stage = 'collection-' + phase;
    const client = await connect(database, 'pslab_app');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const identity = one((await client.query(PROBES.target_identity)).rows);
      if (identity.run_id !== runId || identity.marker !== markers.get(database) || identity.database !== database) fail('Local lab marker identity mismatch.');
      const context = one((await client.query(PROBES.effective_context)).rows);
      if (context.role !== 'pslab_app' || context.database !== database) fail('Local lab application context mismatch.');
      const observedAt = new Date();
      const scope = { environment: 'local-lab', branchFingerprint: hash({ clusterFingerprint, database, marker: identity.marker }),
        roleFingerprint: hash(context.role), connectionMode: 'direct' as const, identityMethod: 'lab-marker' as const };
      const config: InvestigationCase = { schemaVersion: 3, caseId: phase, profile: 'local-lab', scope,
        subject: { relation: 'project_labels', schema: 'app_data', migrationId: MIGRATION,
          queryShapeHash: hash(APPLICATION_QUERY), expectedBranchFingerprint: scope.branchFingerprint },
        intake: { schemaVersion: 1, report: 'Synthetic application cannot resolve project_labels.', expectedBehavior: 'The application can count project labels.', sqlstate: '42P01',
          relation: 'project_labels', environment: 'local-lab', connectionMode: 'direct', dataSensitivity: 'synthetic' } };
      const dir = join(output, phase);
      createCase(dir, config);
      const recorded: TypedObservation[] = [];
      async function record(kind: Kind, result: unknown, control = false) {
        stage = `collection-${phase}-${kind}`;
        const observation = { schemaVersion: 3, kind, artifactId: `${phase}-${kind}${control ? "-qualified" : ""}`, caseId: phase,
          classification: 'REPRODUCED_BEHAVIOR', source: { type: 'local-lab', id: 'schema-drift', version: '1', runId }, scope,
          probeId: control ? "qualified_control" : kind, queryHash: hash(control ? QUALIFIED_QUERY : PROBES[kind]), collectionScope: 'single-lab-connection',
          collectedAt: observedAt.toISOString(), expiresAt: new Date(observedAt.getTime() + 3600000).toISOString(),
          collectorVersion: 'native-lab-1', redactionStatus: 'synthetic-reviewed',
          parents: kind === 'target_identity' ? [] : [`${phase}-target_identity`], supersedes: null, correctionReason: null, result };
        appendObservation(dir, observation);
        recorded.push(observation as TypedObservation);
      }
      await record('target_identity', { expectedBranchFingerprint: scope.branchFingerprint, observedBranchFingerprint: scope.branchFingerprint,
        method: 'lab-marker', serverVersion: context.server_version, clusterFingerprint, limitations });
      await record('effective_context', { database, roleFingerprint: scope.roleFingerprint,
        searchPath: context.search_path, currentSchema: context.current_schema, limitations });
      const inventory = (await client.query(PROBES.relation_inventory, ['app_data', 'project_labels'])).rows;
      if (inventory.length > 1) fail('Relation inventory exceeded its bound.');
      await record('relation_inventory', { relation: 'project_labels', schema: 'app_data', present: inventory.length === 1,
        visible: inventory[0]?.visible ?? false, coverage: 'visible-to-role', limitations });
      const permissions = one((await client.query(PROBES.permissions, ['app_data', inventory[0]?.oid ?? null])).rows);
      await record('permissions', { relation: 'project_labels', schema: 'app_data', schemaUsage: permissions.schema_usage,
        relationSelect: permissions.relation_select, limitations });
      const migration = one((await client.query(PROBES.migration_state, [MIGRATION])).rows);
      await record('migration_state', { migrationId: MIGRATION, targetBranchFingerprint: scope.branchFingerprint, applied: migration.applied, limitations });
      await client.query('SAVEPOINT application_probe');
      let sqlstate: string | null = null;
      let rows: number | null = null;
      try { rows = one((await client.query(APPLICATION_QUERY, PARAMETERS)).rows).matching_rows; }
      catch (error) { sqlstate = errorCode(error); if (!sqlstate) fail('Application probe failed without a PostgreSQL SQLSTATE.'); }
      await client.query('ROLLBACK TO SAVEPOINT application_probe');
      const outcome = sqlstate ? 'error' : 'success';
      await record('failure_observation', { relation: 'project_labels', schema: 'app_data', sqlstate,
        queryShapeHash: hash(APPLICATION_QUERY), outcome, matchingRows: rows === null ? null : String(rows), limitations });
      let qualifiedRows: number | null = null;
      if (database === 'pslab_search_path') {
        qualifiedRows = one((await client.query(QUALIFIED_QUERY, PARAMETERS)).rows).matching_rows;
        await record('failure_observation', { relation: 'project_labels', schema: 'app_data', sqlstate: null,
          queryShapeHash: hash(QUALIFIED_QUERY), outcome: 'success', matchingRows: String(qualifiedRows), limitations }, true);
      }
      await client.query('ROLLBACK');
      if (outcome !== expectedOutcome || outcome === 'error' && sqlstate !== '42P01' || outcome === 'success' && rows !== 1) fail('The actual lab outcome differs from the scenario contract.');
      if (database === 'pslab_search_path' && qualifiedRows !== 1) fail('The qualified search-path control did not succeed.');
      const summary = inspectLedger(dir);
      snapshots[phase] = { caseId: phase, database, outcome, sqlstate, matchingRows: rows, qualifiedRows,
        migrationApplied: migration.applied, relationPresent: inventory.length === 1,
        relationVisible: inventory[0]?.visible ?? false, searchPath: context.search_path,
        branchFingerprint: scope.branchFingerprint, roleFingerprint: scope.roleFingerprint,
        queryShapeHash: config.subject.queryShapeHash, evidenceIds: recorded.map(o => o.artifactId), headHash: summary.headHash,
        coverage: investigationGaps(dir).satisfied, collectedAt: observedAt.toISOString() };
    } finally { await client.end(); }
  }
  try {
    command(join(bin, 'initdb'), ['-D', data, '-U', 'pslab_owner', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'], 'initialization');
    appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\nport = 5432\nmax_connections = 12\nshared_buffers = '16MB'\n`);
    command(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'server.log'), '-w', '-t', '15', 'start'], 'startup', 20000);
    started = true;
    await admin('postgres', async client => {
      await client.query('CREATE ROLE pslab_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT');
      for (const database of DATABASES) {
        await client.query(`CREATE DATABASE ${database}`);
        await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
        await client.query(`GRANT CONNECT ON DATABASE ${database} TO pslab_app`);
        await client.query(`ALTER ROLE pslab_app IN DATABASE ${database} SET search_path = ${database === 'pslab_search_path' ? 'public' : 'app_data, public'}`);
      }
    });
    for (const database of DATABASES) await admin(database, async client => {
      const marker = randomUUID(); markers.set(database, marker);
      await client.query(SCHEMA);
      await client.query('INSERT INTO lab_meta.identity VALUES ($1, $2)', [runId, marker]);
      if (database !== 'pslab_affected') await client.query(MIGRATION_SQL);
    });
    await collect('pslab_development', 'development', 'success');
    await collect('pslab_affected', 'before', 'error');
    await collect('pslab_search_path', 'search-path-control', 'error');
    await admin('pslab_affected', async client => { await client.query(MIGRATION_SQL); });
    await collect('pslab_affected', 'after', 'success');
    checkInterrupted();
  } catch (error) { failure = error; }
  finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    // A timed-out startup can still leave a process. Check only this run's newly created directory.
    if (started || existsSync(join(data, 'postmaster.pid'))) {
      try { command(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop'], 'cleanup', 15000); }
      catch { cleanup = 'FAILED'; failure ??= new Error('cleanup'); }
    }
    if (cleanup !== 'FAILED') {
      rmSync(root, { recursive: true, force: true });
      cleanup = 'COMPLETE';
    }
  }
  const report = { schemaVersion: 1, runId, profile: 'local-lab', status: failure ? 'FAILED' : 'COMPLETE', cleanup, failedStage: failure ? stage : null,
    snapshots, migrationHash: hash(MIGRATION_SQL), clusterFingerprint,
    cause: null, resolution: null, reviewStatus: 'NOT_REVIEWED',
    note: 'Actual PostgreSQL execution with synthetic data. The migration check is scoped to this local lab. Human cause review and customer resolution remain pending.' };
  writeArtifact(join(output, 'run.json'), report);
  if (failure) fail(cleanup === 'FAILED' ? `Lab cleanup failed. Temporary cluster retained at ${root}; use pg_ctl with its data directory to inspect and stop it.` : `Local lab failed during ${stage}${errorCode(failure) ? ' (SQLSTATE ' + errorCode(failure) + ')' : ''}. Cleanup completed. ${failure instanceof LedgerError ? failure.message : 'Inspect retained case artifacts before retrying.'}`);
  return report;
}
