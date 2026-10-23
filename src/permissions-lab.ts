import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { delimiter, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { canonical, hash, fail, LedgerError } from './contracts.ts';
import { PERMISSIONS_QUERIES as Q, PERMISSIONS_PHASES, PERMISSIONS_ROLES, PHASE_SPECS, ROLE_SEARCH_PATHS, errorCategory, checkPermissionsRun, permissionsManifest, permissionsMarkdown, permissionsHtml } from './permissions-evidence.ts';
import type { PermissionsRun, Attempt, PermissionsPhase, QueryResult, Grant, RoleRecord } from './permissions-evidence.ts';

const require = createRequire(import.meta.url);
function packageVersion(name: string) {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) { const p = JSON.parse(readFileSync(file, 'utf8')); if (p.name === name) return String(p.version); }
  }
  return fail(`Could not read the installed ${name} version.`);
}

export function permissionsPlan() {
  return { profile: 'local-lab', approvalRequired: true, network: false, connection: 'private Unix socket; TCP turned off',
    operations: ['Create a disposable PostgreSQL cluster with synthetic roles that have no passwords',
      'Give the application role SELECT on every table that exists, then add a table in a later migration that grants nothing',
      'Connect as each role and run fixed read-only checks: role, search path, catalog, privileges and the same count query with and without the schema name',
      'Grant SELECT on the one new table to the application role, recording before and after the grants on the lab schemas and their tables, with grant options, and each lab role\'s attributes',
      'Repeat the checks, then stop the owned server and remove the cluster'],
    retained: ['role names, search paths, privilege flags and SQLSTATEs with fixed error categories', 'schema and table grants with grant options, and role attributes, before and after the change', 'anchorable manifest', 'HTML and Markdown experiment reports'],
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
// A failed command is reported by a fixed label and its exit status. Its output can hold paths, so it is withheld.
export class CommandFailure extends LedgerError {
  readonly label: string; readonly exitStatus: number|null;
  constructor(label: string, exitStatus: number|null) {
    super(`A local command failed: ${label}${exitStatus === null ? '' : ` (exit status ${exitStatus})`}. Raw process output is withheld.`);
    this.label = label; this.exitStatus = exitStatus;
  }
}
function command(file: string, args: string[], label: string) {
  const result = spawnSync(file, args, { env: env(), encoding: 'utf8', timeout: 60000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new CommandFailure(label, typeof result.status === 'number' ? result.status : null);
  return result.stdout;
}
function write(path: string, value: unknown) { writeFileSync(path, canonical(value) + '\n', { flag: 'wx', mode: 0o600 }); }
function one(rows: any[]) { if (rows.length !== 1) fail('Unexpected bounded probe row count.'); return rows[0]; }
const sqlstateOf = (e: any) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e?.severity === 'string' ? e.code : null;
// Environment names that could change a PostgreSQL client. Every setting is passed explicitly, so these are recorded by name only.
const WATCHED_ENV = ['NODE_OPTIONS', 'PGDATABASE', 'PGHOST', 'PGHOSTADDR', 'PGOPTIONS', 'PGPASSFILE', 'PGPASSWORD', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGUSER'];
const DATABASE = 'pslab_perm';

export async function runPermissionsLab(options: { approved: boolean; output: string }) {
  if (options.approved !== true) fail('Permissions lab execution requires --approve-lab.');
  (await import('./lab-packs.ts')).requireWorkingPack('permissions');
  if (!['linux','darwin'].includes(process.platform)) fail('Use macOS or Linux for the native permissions lab.');
  if (process.getuid?.() === 0) fail('Run the lab as a regular user, without sudo.');
  const bins = Object.fromEntries(['initdb','pg_ctl','postgres'].map(n => [n, executable(n, process.env.PSLAB_PG_BIN)]));
  const majors = Object.values(bins).map(b => Number(command(b, ['--version'], `${b.split('/').pop()} --version`).match(/\(PostgreSQL\) (\d+)/)?.[1]));
  if (!majors.every(m => m === majors[0] && m >= 16 && m <= 18)) fail('Use matching PostgreSQL 16, 17 or 18 server tools.');
  mkdirSync(options.output, { mode: 0o700 });
  const output = realpathSync(options.output), runId = randomUUID(), collectedAt = new Date().toISOString();
  write(join(output, 'permissions-plan.json'), { ...permissionsPlan(), runId, approved: true });
  write(join(output, 'permissions-probes.json'), Q);
  // /tmp keeps the Unix socket path below platform limits, including macOS's shorter limit.
  const root = mkdtempSync('/tmp/pslab-perm-'), data = join(root, 'data'), socket = join(root, 'sock'), logPath = join(root, 'postgres.log');
  mkdirSync(socket, { mode: 0o700 });
  let failure: unknown, stage = 'setup', clusterFingerprint = '', postgresVersion = '', cleanup = 'PENDING';
  let privilegeChange: PermissionsRun['privilegeChange'] | undefined;
  const clients = new Set<Client>(), attempts: Attempt[] = [];
  const interrupt = () => { failure ??= new Error('interrupted'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const check = () => { if (failure) fail('Permissions experiment interrupted.'); };
  async function connect(user: string, database = DATABASE) {
    check();
    const client = new Client({ host: socket, port: 5432, database, user, password: 'unused-local-lab', ssl: false, options: '', application_name: 'pslab-permissions',
      client_encoding: 'UTF8', connectionTimeoutMillis: 5000, query_timeout: 6000, statement_timeout: 5000, lock_timeout: 1000 } as any);
    client.on('error', () => { failure ??= new Error('connection lost'); });
    clients.add(client);
    try { await client.connect(); return client; } catch { clients.delete(client); await client.end().catch(() => {}); return fail(`Permissions lab could not connect as ${user}.`); }
  }
  async function close(client: Client) { clients.delete(client); await client.end().catch(() => {}); }
  async function count(client: Client, sql: string): Promise<QueryResult> {
    try { const rows = (await client.query(sql)).rows; return { ok: true, rowCount: Number(one(rows).row_count), sqlstate: null, error: null }; }
    catch (e: any) {
      const sqlstate = sqlstateOf(e);
      if (sqlstate === null) throw e;
      return { ok: false, rowCount: null, sqlstate, error: errorCategory(sqlstate, String(e.message ?? '')) };
    }
  }
  async function attempt(phase: PermissionsPhase): Promise<Attempt> {
    const spec = PHASE_SPECS[phase], client = await connect(spec.role);
    try {
      const ctx = one((await client.query(Q.context)).rows);
      if (ctx.run_id !== runId) fail('Permissions target identity mismatch.');
      const found = (await client.query(Q.catalog, [spec.table])).rows;
      if (found.length > 1) fail('Unexpected bounded probe row count.');
      const oid = found[0]?.oid ?? null;
      const p = one((await client.query(Q.privileges, [oid])).rows);
      const result: Attempt = { phase, runId, collectedAt: new Date().toISOString(), role: spec.role, table: spec.table,
        context: { currentUser: ctx.role_name, sessionUser: ctx.login_role, searchPath: ctx.search_path, currentSchema: ctx.current_schema },
        catalog: { exists: oid !== null, visible: found[0]?.visible ?? null },
        privileges: { schemaUsage: p.schema_usage, schemaCreate: p.schema_create, select: p.can_select, insert: p.can_insert, update: p.can_update, delete: p.can_delete, truncate: p.can_truncate },
        unqualified: await count(client, Q.unqualified[spec.table]), qualified: await count(client, Q.qualified[spec.table]) };
      return result;
    } finally { await close(client); }
  }
  async function snapshot(client: Client) {
    const grants: Grant[] = (await client.query(Q.grants)).rows.map((r: any) => ({ kind: r.kind, object: r.object, grantee: r.grantee, privilege: r.privilege, grantable: r.grantable }));
    const roles: RoleRecord[] = (await client.query(Q.roles)).rows.map((r: any) => ({ name: r.name, superuser: r.superuser, inherit: r.inherit, createRole: r.create_role, createDb: r.create_db, bypassRls: r.bypass_rls, memberships: r.memberships }));
    return { grants, roles, defaultPrivileges: Number(one((await client.query(Q.defaultPrivileges)).rows).entries) };
  }
  try {
    command(bins.initdb, ['-D', data, '-U', 'pslab_owner', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'], 'initdb');
    appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\nport = 5432\nmax_connections = 12\nshared_buffers = '16MB'\n`);
    writeFileSync(join(data, 'pg_hba.conf'), Q.hba.join('\n') + '\n');
    command(bins.pg_ctl, ['-D', data, '-l', logPath, '-w', '-t', '15', 'start'], 'pg_ctl start');
    const owner = await connect('pslab_owner', 'postgres');
    const system = one((await owner.query("SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version, system_identifier::text AS identifier FROM pg_control_system()")).rows);
    if (realpathSync(system.directory) !== realpathSync(data)) fail('Owned PostgreSQL directory mismatch.');
    clusterFingerprint = hash(system.identifier); postgresVersion = system.version;
    for (const role of PERMISSIONS_ROLES) await owner.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await owner.query(`CREATE DATABASE ${DATABASE}`);
    await owner.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
    await owner.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${PERMISSIONS_ROLES.join(', ')}`);
    for (const role of PERMISSIONS_ROLES) await owner.query(`ALTER ROLE ${role} IN DATABASE ${DATABASE} SET search_path = ${ROLE_SEARCH_PATHS[role]}`);
    await close(owner);
    const setup = await connect('pslab_owner');
    for (const sql of Q.setup) await setup.query(sql);
    await setup.query('INSERT INTO lab_meta.identity VALUES ($1)', [runId]);
    for (const sql of [...Q.migration, ...Q.controls]) await setup.query(sql);
    stage = 'checks before the fix';
    const before = PERMISSIONS_PHASES.filter(p => !PHASE_SPECS[p].afterFix), after = PERMISSIONS_PHASES.filter(p => PHASE_SPECS[p].afterFix);
    for (const phase of before) attempts.push(await attempt(phase));
    stage = 'privilege change';
    const s1 = await snapshot(setup);
    await setup.query(Q.fix);
    const s2 = await snapshot(setup);
    privilegeChange = { statement: Q.fix, grantsBefore: s1.grants, grantsAfter: s2.grants, rolesBefore: s1.roles, rolesAfter: s2.roles, defaultPrivilegeEntries: s2.defaultPrivileges };
    await close(setup);
    stage = 'checks after the fix';
    for (const phase of after) attempts.push(await attempt(phase));
    check();
  } catch (error) { failure ??= error; }
  finally {
    for (const c of clients) await c.end().catch(() => {});
    if (existsSync(join(data, 'postmaster.pid'))) {
      try { command(bins.pg_ctl, ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop'], 'pg_ctl stop'); } catch { cleanup = 'FAILED'; failure ??= new Error('postgres cleanup'); }
    }
    if (cleanup !== 'FAILED') { rmSync(root, { recursive: true, force: true }); cleanup = existsSync(root) ? 'FAILED' : 'COMPLETE'; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (failure) {
    write(join(output, 'permissions-failure.json'), { runId, stage, cleanup, sqlstate: sqlstateOf(failure), cause: null,
      failedCommand: failure instanceof CommandFailure ? failure.label : null, exitStatus: failure instanceof CommandFailure ? failure.exitStatus : null });
    fail(cleanup === 'FAILED' ? `Permissions cleanup failed. Owned temporary files remain at ${root}.` : `Permissions lab failed during ${stage}. Cleanup completed. ${failure instanceof LedgerError ? failure.message : 'Check the retained failure summary.'}`);
  }
  const run: PermissionsRun = { schemaVersion: 1, scenario: 'table-privilege', runId, profile: 'local-lab', collectedAt,
    expiresAt: new Date(Date.parse(collectedAt) + 3600000).toISOString(), postgresVersion, clusterFingerprint, versions: { node: process.version, pg: packageVersion('pg') },
    environment: { namesPresent: WATCHED_ENV.filter(n => process.env[n] !== undefined) }, privilegeChange: privilegeChange!,
    cleanup: 'COMPLETE', attempts, classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED' };
  // Retain unexpected measurements for investigation; only a passing contract gets a manifest and report.
  write(join(output, 'permissions-run.json'), run);
  checkPermissionsRun(run);
  const manifest = permissionsManifest(run); write(join(output, 'permissions-manifest.json'), manifest);
  writeFileSync(join(output, 'permissions-report.md'), permissionsMarkdown(run), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(output, 'permissions-report.html'), permissionsHtml(run), { flag: 'wx', mode: 0o600 });
  return { run, manifestHash: hash(manifest) };
}
