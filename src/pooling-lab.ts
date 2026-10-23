import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { canonical, hash, fail, LedgerError } from './contracts.ts';
import { POOLING_QUERIES as Q, checkPoolingRun, poolingManifest, poolingHtml, poolingMarkdown } from './pooling-evidence.ts';
import type { PoolingRun, Observation, Phase } from './pooling-evidence.ts';

export function poolingPlan() {
  return { profile: 'local-lab', approvalRequired: true, network: false, connection: 'private Unix sockets; TCP disabled',
    operations: ['Create a disposable PostgreSQL cluster with one synthetic project', 'Start an owned PgBouncer process in transaction mode',
      'Compare SQL and driver prepared statements across measured backend changes', 'Run direct reset and bounded timeout controls',
      'Check direct-session and transaction-contained remedies', 'Stop both owned processes and remove temporary server files'],
    retained: ['versioned observations', 'probe catalog', 'anchorable manifest', 'HTML and Markdown experiment reports'],
    reviewStatus: 'NOT_REVIEWED', cause: null, customerResolution: null };
}
const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
function executable(name: string, directory?: string) {
  for (const dir of directory ? [directory] : (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { const file = join(dir, name); accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* next directory */ }
  }
  return fail(name === 'pgbouncer' ? 'PgBouncer was not found. Set PSLAB_PGBOUNCER_BIN to its executable path.' : 'PostgreSQL server tools were not found. Set PSLAB_PG_BIN to their bin directory.');
}
function command(file: string, args: string[]) {
  const result = spawnSync(file, args, { env: env(), encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) fail('A local server command failed. Raw process output is withheld.');
  return result.stdout;
}
function write(path: string, value: unknown) { writeFileSync(path, canonical(value) + '\n', { flag: 'wx', mode: 0o600 }); }
function one(rows: any[]) { if (rows.length !== 1) fail('Unexpected bounded probe row count.'); return rows[0]; }
function sqlstate(e: unknown) { const code = (e as { code?: string })?.code; return typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : null; }
async function stopPool(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  // Only signal the ChildProcess created by this invocation.
  child.kill('SIGTERM');
  for (let n = 0; n < 50 && child.exitCode === null && child.signalCode === null; n++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    for (let n = 0; n < 30 && child.exitCode === null && child.signalCode === null; n++) await delay(100);
  }
  if (child.exitCode === null && child.signalCode === null) fail('Owned PgBouncer process did not stop.');
}

export async function runPoolingLab(options: { approved: boolean; output: string }) {
  if (options.approved !== true) fail('Pooling lab execution requires --approve-lab.');
  // Refuse to run unless every pack file is valid and this lab's pack matches its bundled probe catalog.
  (await import('./lab-packs.ts')).requireWorkingPack('pgbouncer-session');
  if (!['linux','darwin'].includes(process.platform)) fail('Use macOS or Linux for the native pooling lab.');
  if (process.getuid?.() === 0) fail('Run the lab as a regular user, without sudo.');
  const bins = Object.fromEntries(['initdb','pg_ctl','postgres'].map(n => [n, executable(n, process.env.PSLAB_PG_BIN)]));
  const majors = Object.values(bins).map(b => Number(command(b, ['--version']).match(/\(PostgreSQL\) (\d+)/)?.[1]));
  if (!majors.every(m => m === majors[0] && m >= 16 && m <= 18)) fail('Use matching PostgreSQL 16, 17 or 18 server tools.');
  const poolBin = process.env.PSLAB_PGBOUNCER_BIN ? realpathSync(process.env.PSLAB_PGBOUNCER_BIN) : executable('pgbouncer');
  accessSync(poolBin, constants.X_OK);
  const poolVersion = command(poolBin, ['--version']).match(/PgBouncer (\d+\.\d+(?:\.\d+)?)/i)?.[1];
  const [major, minor] = (poolVersion ?? '').split('.').map(Number);
  if (major !== 1 || minor < 21) fail('This scenario requires PgBouncer 1.21 or later within major version 1.');
  mkdirSync(options.output, { mode: 0o700 });
  const output = realpathSync(options.output), runId = randomUUID(), collectedAt = new Date().toISOString();
  write(join(output, 'pooling-plan.json'), { ...poolingPlan(), runId, approved: true });
  write(join(output, 'pooling-probes.json'), Q);
  const root = mkdtempSync('/tmp/pslab-pool-'), data = join(root, 'data'), socket = join(root, 'pg'), pooledSocket = join(root, 'pool');
  mkdirSync(socket, { mode: 0o700 }); mkdirSync(pooledSocket, { mode: 0o700 });
  let pool: ChildProcess | undefined, failure: unknown, stage = 'setup', clusterFingerprint = '', postgresVersion = '', cleanup = 'PENDING';
  const clients = new Set<Client>(), observations: Observation[] = [];
  const interrupt = () => { failure ??= new Error('interrupted'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const check = () => { if (failure) fail('Pooling experiment interrupted or a connection was lost.'); };
  async function connect(endpoint: 'direct'|'transaction', database = 'pslab_pooling', user = 'pslab_app') {
    check();
    const client = new Client({ host: endpoint === 'direct' ? socket : pooledSocket, port: endpoint === 'direct' ? 5432 : 6432,
      database, user, password: 'unused-local-lab', ssl: false, options: '', application_name: 'pslab-pooling', client_encoding: 'UTF8',
      connectionTimeoutMillis: 1500, query_timeout: 6000 });
    client.on('error', () => { failure ??= new Error('connection'); });
    try { await client.connect(); clients.add(client); return client; }
    catch (e) { await client.end().catch(() => {}); throw e; }
  }
  async function close(c: Client) { clients.delete(c); await c.end(); }
  async function identity(c: Client) {
    check(); const id = one((await c.query(Q.identity)).rows);
    if (id.run_id !== runId || id.database !== 'pslab_pooling' || id.role !== 'pslab_app') fail('Pooling target identity mismatch.');
    return id;
  }
  async function observe(c: Client, phase: Phase, endpoint: 'direct'|'transaction', heldBackend: number|null = null) {
    const id = await identity(c), time = new Date().toISOString();
    const query = phase.startsWith('protocol') ? Q.protocol : phase === 'timeout-control' ? Q.timeout : Q.execute;
    let code: string|null = null, count: number|null = null;
    try {
      const response = await c.query(phase.startsWith('protocol') ? { name: 'pslab_protocol_count', text: query } : query);
      if (phase !== 'timeout-control') count = one(response.rows).count;
    } catch (e) { code = sqlstate(e); if (!code) throw e; }
    observations.push({ phase, endpoint, backend: id.backend, database: id.database, role: id.role, runId,
      collectedAt: time, queryHash: hash(query), sqlstate: code, count, heldBackend });
  }
  try {
    command(bins.initdb, ['-D', data, '-U', 'pslab_owner', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\nport = 5432\nmax_connections = 12\nshared_buffers = '16MB'\n`);
    command(bins.pg_ctl, ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '15', 'start']);
    const owner = await connect('direct', 'postgres', 'pslab_owner');
    const system = one((await owner.query("SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version, system_identifier::text AS identifier FROM pg_control_system()")).rows);
    if (realpathSync(system.directory) !== realpathSync(data)) fail('Owned PostgreSQL directory mismatch.');
    clusterFingerprint = hash(system.identifier); postgresVersion = system.version;
    await owner.query("CREATE ROLE pslab_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; ALTER ROLE pslab_app SET statement_timeout = '5s'; ALTER ROLE pslab_app SET idle_in_transaction_session_timeout = '15s'");
    await owner.query('CREATE DATABASE pslab_pooling'); await close(owner);
    const setup = await connect('direct', 'pslab_pooling', 'pslab_owner');
    await setup.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE TABLE lab_identity (run_id uuid NOT NULL); CREATE TABLE projects (id integer PRIMARY KEY); INSERT INTO projects VALUES (1); GRANT SELECT ON lab_identity, projects TO pslab_app');
    await setup.query('INSERT INTO lab_identity VALUES ($1)', [runId]); await close(setup);
    writeFileSync(join(root, 'users.txt'), '"pslab_app" "unused-local-lab"\n', { mode: 0o600, flag: 'wx' });
    const config = `[databases]\npslab_pooling = host=${socket} port=5432 dbname=pslab_pooling\n[pgbouncer]\nlisten_addr =\nlisten_port = 6432\nunix_socket_dir = ${pooledSocket}\nunix_socket_mode = 0700\nauth_type = trust\nauth_file = ${join(root, 'users.txt')}\nadmin_users = pslab_app\npool_mode = transaction\ndefault_pool_size = 2\nmax_client_conn = 8\nmax_prepared_statements = 10\nserver_round_robin = 0\nserver_reset_query_always = 0\nquery_wait_timeout = 5\nserver_connect_timeout = 5\nlog_connections = 0\nlog_disconnections = 0\n`;
    writeFileSync(join(root, 'pgbouncer.ini'), config, { mode: 0o600, flag: 'wx' });
    stage = 'pool-startup';
    pool = spawn(poolBin, [join(root, 'pgbouncer.ini')], { env: env(), stdio: 'ignore' });
    pool.on('error', () => { failure ??= new Error('pool startup'); });
    let admin: Client | undefined;
    for (let n = 0; n < 40; n++) {
      check(); if (pool.exitCode !== null || pool.signalCode !== null) fail('Owned PgBouncer exited during startup.');
      try { admin = await connect('transaction', 'pgbouncer'); break; } catch { await delay(100); }
    }
    if (!admin) fail('Owned PgBouncer did not become ready.');
    const settings = Object.fromEntries((await admin.query('SHOW CONFIG')).rows.map(r => [r.key, r.value]));
    if (settings.pool_mode !== 'transaction' || settings.max_prepared_statements !== '10' || settings.listen_addr !== '' || settings.unix_socket_dir !== pooledSocket || settings.server_round_robin !== '0' || settings.server_reset_query_always !== '0') fail('Actual PgBouncer settings differ from the scenario.');
    const db = (await admin.query('SHOW DATABASES')).rows.find(r => r.name === 'pslab_pooling');
    if (!db || db.host !== socket || Number(db.port) !== 5432 || db.database !== 'pslab_pooling') fail('Actual PgBouncer database route differs from the owned target.');
    await close(admin);
    stage = 'direct-control';
    const direct = await connect('direct');
    await direct.query('BEGIN'); await direct.query(Q.prepare); await observe(direct, 'direct-first', 'direct'); await direct.query('COMMIT');
    await direct.query('BEGIN'); await observe(direct, 'direct-next', 'direct'); await direct.query('COMMIT');
    stage = 'backend-switch';
    const a = await connect('transaction'), b = await connect('transaction');
    await a.query('BEGIN'); await a.query(Q.prepare); await observe(a, 'pooled-first', 'transaction'); await a.query('COMMIT');
    await b.query('BEGIN'); const held = await identity(b);
    await a.query('BEGIN'); await observe(a, 'pooled-next', 'transaction', held.backend); await a.query('ROLLBACK'); await b.query('ROLLBACK');
    stage = 'reset-control';
    await direct.query(Q.reset); await direct.query('BEGIN'); await observe(direct, 'direct-reset', 'direct'); await direct.query('ROLLBACK');
    stage = 'contained-remedy';
    await a.query('BEGIN'); await a.query(Q.reset); await a.query(Q.prepare); await observe(a, 'pooled-contained', 'transaction'); await a.query(Q.reset); await a.query('COMMIT');
    stage = 'protocol-control';
    await a.query('BEGIN'); await observe(a, 'protocol-first', 'transaction'); await a.query('COMMIT');
    await b.query('BEGIN'); const protocolHeld = await identity(b);
    await a.query('BEGIN'); await observe(a, 'protocol-next', 'transaction', protocolHeld.backend); await a.query('COMMIT'); await b.query('ROLLBACK');
    stage = 'timeout-control';
    await direct.query("BEGIN; SET LOCAL statement_timeout = '50ms'"); await observe(direct, 'timeout-control', 'direct'); await direct.query('ROLLBACK');
    check();
  } catch (error) { failure ??= error; }
  finally {
    for (const c of clients) await c.end().catch(() => {});
    try { if (pool) await stopPool(pool); } catch { cleanup = 'FAILED'; failure ??= new Error('pool cleanup'); }
    if (existsSync(join(data, 'postmaster.pid'))) {
      try { command(bins.pg_ctl, ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop']); } catch { cleanup = 'FAILED'; failure ??= new Error('postgres cleanup'); }
    }
    if (cleanup !== 'FAILED') { rmSync(root, { recursive: true, force: true }); cleanup = 'COMPLETE'; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (failure) {
    write(join(output, 'pooling-failure.json'), { runId, stage, cleanup, sqlstate: sqlstate(failure), cause: null });
    fail(cleanup === 'FAILED' ? `Pooling cleanup failed. Owned temporary files remain at ${root}.` : `Pooling lab failed during ${stage}. Cleanup completed. ${failure instanceof LedgerError ? failure.message : 'Check the retained failure summary.'}`);
  }
  const run: PoolingRun = { schemaVersion: 1, scenario: 'pooling-session', runId, profile: 'local-lab', collectedAt,
    expiresAt: new Date(Date.parse(collectedAt) + 3600000).toISOString(), postgresVersion, pgbouncerVersion: poolVersion!, clusterFingerprint,
    poolMode: 'transaction', maxPreparedStatements: 10, cleanup: 'COMPLETE', observations,
    classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED' };
  // Retain unexpected measurements for investigation; only a passing contract gets a manifest and report.
  write(join(output, 'pooling-run.json'), run);
  checkPoolingRun(run);
  const manifest = poolingManifest(run); write(join(output, 'pooling-manifest.json'), manifest);
  writeFileSync(join(output, 'pooling-report.md'), poolingMarkdown(run), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(output, 'pooling-report.html'), poolingHtml(run), { flag: 'wx', mode: 0o600 });
  return { run, manifestHash: hash(manifest) };
}
