import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { reportStyles, fontLicenses } from './report-theme.ts';

// The permissions lab starts a disposable PostgreSQL cluster on a private Unix socket with TCP turned off. A later
// migration adds app_data.project_tasks after the application role was given SELECT on every table that existed then,
// so the application can see the table but cannot read it. Controls connect as other synthetic roles that fail in
// ways that look alike: a different role, a role without schema USAGE, and a role whose search_path leaves out app_data.
export const APP_ROLE = 'pslab_app';
export const PERMISSIONS_PHASES = ['baseline-existing-table', 'table-select-missing', 'wrong-role', 'schema-usage-missing', 'search-path-missing',
  'fix-applied', 'wrong-role-after-fix'] as const;
export type PermissionsPhase = typeof PERMISSIONS_PHASES[number];
export const PERMISSIONS_ROLES = ['pslab_app', 'pslab_reporting', 'pslab_nousage', 'pslab_path'] as const;
export type PermissionsRole = typeof PERMISSIONS_ROLES[number];
export const LAB_TABLES = ['projects', 'project_tasks'] as const;
export type LabTable = typeof LAB_TABLES[number];
export type PhaseSpec = { role: PermissionsRole; table: LabTable; afterFix: boolean };
export const PHASE_SPECS: Record<PermissionsPhase, PhaseSpec> = {
  'baseline-existing-table': { role: 'pslab_app', table: 'projects', afterFix: false },
  'table-select-missing': { role: 'pslab_app', table: 'project_tasks', afterFix: false },
  'wrong-role': { role: 'pslab_reporting', table: 'project_tasks', afterFix: false },
  'schema-usage-missing': { role: 'pslab_nousage', table: 'project_tasks', afterFix: false },
  'search-path-missing': { role: 'pslab_path', table: 'project_tasks', afterFix: false },
  'fix-applied': { role: 'pslab_app', table: 'project_tasks', afterFix: true },
  'wrong-role-after-fix': { role: 'pslab_reporting', table: 'project_tasks', afterFix: true },
};
// The search_path each role is given for the lab database. Only pslab_path leaves out app_data.
export const ROLE_SEARCH_PATHS: Record<PermissionsRole, string> = { pslab_app: 'app_data, public', pslab_reporting: 'app_data, public', pslab_nousage: 'app_data, public', pslab_path: 'public' };

// Every statement the lab runs. Nothing here comes from a user, a pack or a bundle.
export const PERMISSIONS_QUERIES = Object.freeze({
  setup: Object.freeze([
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
    'CREATE SCHEMA app_data', 'CREATE SCHEMA lab_meta',
    'CREATE TABLE lab_meta.identity (run_id uuid NOT NULL)',
    'CREATE TABLE app_data.projects (id integer PRIMARY KEY, name text NOT NULL)',
    "INSERT INTO app_data.projects VALUES (1, 'Synthetic project')",
    'GRANT USAGE ON SCHEMA lab_meta TO pslab_app, pslab_reporting, pslab_nousage, pslab_path',
    'GRANT SELECT ON lab_meta.identity TO pslab_app, pslab_reporting, pslab_nousage, pslab_path',
    'GRANT USAGE ON SCHEMA app_data TO pslab_app, pslab_reporting, pslab_path',
    // Covers only the tables that exist at this point.
    'GRANT SELECT ON ALL TABLES IN SCHEMA app_data TO pslab_app',
    'GRANT SELECT ON app_data.projects TO pslab_reporting',
  ]),
  // The later migration. It creates the table and grants nothing to the application role.
  migration: Object.freeze([
    'CREATE TABLE app_data.project_tasks (project_id integer NOT NULL REFERENCES app_data.projects (id), title text NOT NULL)',
    "INSERT INTO app_data.project_tasks VALUES (1, 'Synthetic task')",
  ]),
  // Control roles get table access, so each one is missing only what its control is about.
  controls: Object.freeze(['GRANT SELECT ON app_data.project_tasks TO pslab_nousage, pslab_path']),
  fix: 'GRANT SELECT ON app_data.project_tasks TO pslab_app',
  context: 'SELECT (SELECT run_id::text FROM lab_meta.identity) AS run_id, current_user::text AS role_name, session_user::text AS login_role,current_schemas(false)::text[] AS search_path, current_schema()::text AS current_schema',
  catalog: "SELECT c.oid::text AS oid, pg_catalog.pg_table_is_visible(c.oid) AS visible FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app_data' AND c.relname = $1 AND c.relkind = 'r'",
  privileges: "SELECT pg_catalog.has_schema_privilege(current_user, 'app_data', 'USAGE') AS schema_usage, pg_catalog.has_schema_privilege(current_user, 'app_data', 'CREATE') AS schema_create, " +
    "pg_catalog.has_table_privilege(current_user, $1::oid, 'SELECT') AS can_select, pg_catalog.has_table_privilege(current_user, $1::oid, 'INSERT') AS can_insert, " +
    "pg_catalog.has_table_privilege(current_user, $1::oid, 'UPDATE') AS can_update, pg_catalog.has_table_privilege(current_user, $1::oid, 'DELETE') AS can_delete, " +
    "pg_catalog.has_table_privilege(current_user, $1::oid, 'TRUNCATE') AS can_truncate",
  unqualified: Object.freeze({ projects: 'SELECT count(*)::int AS row_count FROM projects', project_tasks: 'SELECT count(*)::int AS row_count FROM project_tasks' }),
  qualified: Object.freeze({ projects: 'SELECT count(*)::int AS row_count FROM app_data.projects', project_tasks: 'SELECT count(*)::int AS row_count FROM app_data.project_tasks' }),
  // Read by the owner role before and after the fix: grants on the app_data, lab_meta and public schemas and on the tables in
  // app_data and lab_meta, with their grant option. Grants to the owner role itself, database-level grants and column grants are not read.
  grants: "SELECT 'schema' AS kind, n.nspname::text AS object, COALESCE(r.rolname::text, 'PUBLIC') AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable " +
    "FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee " +
    "WHERE n.nspname IN ('app_data', 'lab_meta', 'public') AND COALESCE(r.rolname, 'PUBLIC') <> 'pslab_owner' " +
    "UNION ALL SELECT 'table', n.nspname || '.' || c.relname, COALESCE(r.rolname::text, 'PUBLIC'), a.privilege_type, a.is_grantable " +
    "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee " +
    "WHERE n.nspname IN ('app_data', 'lab_meta') AND c.relkind = 'r' AND COALESCE(r.rolname, 'PUBLIC') <> 'pslab_owner' ORDER BY 1, 2, 3, 4, 5",
  roles: "SELECT rolname::text AS name, rolsuper AS superuser, rolinherit AS inherit, rolcreaterole AS create_role, rolcreatedb AS create_db, rolbypassrls AS bypass_rls, " +
    "(SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships FROM pg_catalog.pg_roles r WHERE rolname IN ('pslab_app', 'pslab_reporting', 'pslab_nousage', 'pslab_path') ORDER BY 1",
  defaultPrivileges: 'SELECT count(*)::int AS entries FROM pg_catalog.pg_default_acl',
  hba: Object.freeze(['local all all trust']),
  searchPaths: ROLE_SEARCH_PATHS, phases: PHASE_SPECS,
});

// Error categories, read from the SQLSTATE and PostgreSQL's English message. The message itself is not retained.
export const ERROR_CATEGORIES = ['permission-denied-table', 'permission-denied-schema', 'relation-does-not-exist', 'other'] as const;
export type ErrorCategory = typeof ERROR_CATEGORIES[number];
export function errorCategory(sqlstate: string|null, message: string): ErrorCategory {
  if (sqlstate === '42501' && /^permission denied for table /.test(message)) return 'permission-denied-table';
  if (sqlstate === '42501' && /^permission denied for schema /.test(message)) return 'permission-denied-schema';
  if (sqlstate === '42P01' && /^relation ".*" does not exist$/.test(message)) return 'relation-does-not-exist';
  return 'other';
}
export type QueryResult = { ok: boolean; rowCount: number|null; sqlstate: string|null; error: ErrorCategory|null };
export type Attempt = { phase: PermissionsPhase; runId: string; collectedAt: string; role: PermissionsRole; table: LabTable;
  context: { currentUser: string; sessionUser: string; searchPath: string[]; currentSchema: string|null };
  catalog: { exists: boolean; visible: boolean|null };
  privileges: { schemaUsage: boolean; schemaCreate: boolean; select: boolean|null; insert: boolean|null; update: boolean|null; delete: boolean|null; truncate: boolean|null };
  unqualified: QueryResult; qualified: QueryResult };
export type Grant = { kind: 'schema'|'table'; object: string; grantee: string; privilege: string; grantable: boolean };
export type RoleRecord = { name: PermissionsRole; superuser: boolean; inherit: boolean; createRole: boolean; createDb: boolean; bypassRls: boolean; memberships: number };
export type PermissionsRun = { schemaVersion: 1; scenario: 'table-privilege'; runId: string; profile: 'local-lab'; collectedAt: string; expiresAt: string;
  postgresVersion: string; clusterFingerprint: string; versions: { node: string; pg: string };
  environment: { namesPresent: string[] };
  privilegeChange: { statement: string; grantsBefore: Grant[]; grantsAfter: Grant[]; rolesBefore: RoleRecord[]; rolesAfter: RoleRecord[]; defaultPrivilegeEntries: number };
  cleanup: 'COMPLETE'; attempts: Attempt[];
  classification: 'REPRODUCED_BEHAVIOR'; cause: null; customerResolution: null; reviewStatus: 'NOT_REVIEWED' };

const str = (max = 200) => ({ type: 'string', minLength: 1, maxLength: max });
const nstr = (max = 200) => ({ type: ['string', 'null'], maxLength: max });
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const date = { type: 'string', format: 'date-time' };
const bool = { type: 'boolean' };
const nbool = { type: ['boolean', 'null'] };
const identifier = { type: 'string', pattern: '^[a-z_][a-z0-9_]{0,62}$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const nullable = (rule: any) => ({ oneOf: [{ type: 'null' }, rule] });
const queryResult = object({ ok: bool, rowCount: { type: ['number', 'null'] }, sqlstate: { type: ['string', 'null'], pattern: '^[0-9A-Z]{5}$' }, error: { enum: [null, ...ERROR_CATEGORIES] } });
const attemptSchema = object({ phase: { enum: [...PERMISSIONS_PHASES] }, runId: uuid, collectedAt: date, role: { enum: [...PERMISSIONS_ROLES] }, table: { enum: [...LAB_TABLES] },
  context: object({ currentUser: identifier, sessionUser: identifier, searchPath: { type: 'array', maxItems: 8, items: identifier }, currentSchema: nullable(identifier) }),
  catalog: object({ exists: bool, visible: nbool }),
  privileges: object({ schemaUsage: bool, schemaCreate: bool, select: nbool, insert: nbool, update: nbool, delete: nbool, truncate: nbool }),
  unqualified: queryResult, qualified: queryResult });
const grant = object({ kind: { enum: ['schema', 'table'] }, object: { type: 'string', pattern: '^[a-z_][a-z0-9_]*(\\.[a-z_][a-z0-9_]*)?$', maxLength: 130 }, grantee: { type: 'string', pattern: '^(PUBLIC|[a-z_][a-z0-9_]{0,62})$' },
  privilege: { enum: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN', 'USAGE', 'CREATE'] }, grantable: bool });
const role = object({ name: { enum: [...PERMISSIONS_ROLES] }, superuser: bool, inherit: bool, createRole: bool, createDb: bool, bypassRls: bool, memberships: { type: 'number' } });
const schema = object({ schemaVersion: { const: 1 }, scenario: { const: 'table-privilege' }, runId: uuid, profile: { const: 'local-lab' }, collectedAt: date, expiresAt: date,
  postgresVersion: str(100), clusterFingerprint: digest, versions: object({ node: str(40), pg: str(20) }),
  environment: object({ namesPresent: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^[A-Z_]{2,40}$' } } }),
  privilegeChange: object({ statement: { const: PERMISSIONS_QUERIES.fix }, grantsBefore: { type: 'array', maxItems: 60, uniqueItems: true, items: grant }, grantsAfter: { type: 'array', maxItems: 60, uniqueItems: true, items: grant },
    rolesBefore: { type: 'array', minItems: 4, maxItems: 4, items: role }, rolesAfter: { type: 'array', minItems: 4, maxItems: 4, items: role }, defaultPrivilegeEntries: { type: 'number' } }),
  cleanup: { const: 'COMPLETE' }, classification: { const: 'REPRODUCED_BEHAVIOR' }, cause: { const: null }, customerResolution: { const: null }, reviewStatus: { const: 'NOT_REVIEWED' },
  attempts: { type: 'array', minItems: PERMISSIONS_PHASES.length, maxItems: PERMISSIONS_PHASES.length, items: attemptSchema } });

const SECRET_SHAPES = [/\/tmp\/pslab-perm-/, /postgres(ql)?:\/\//];
// The grant option is part of the key, so gaining or losing it counts as a change.
const key = (g: Grant) => `${g.kind}:${g.object}:${g.grantee}:${g.privilege}:${g.grantable}`;
// Grants present after the fix that were not there before, and grants that disappeared.
export function grantChanges(before: Grant[], after: Grant[]) {
  const b = new Set(before.map(key)), a = new Set(after.map(key));
  return { added: after.filter(g => !b.has(key(g))), removed: before.filter(g => !a.has(key(g))) };
}
// Whether a snapshot gives a role a privilege, directly or through PUBLIC. This is the whole answer here because the lab
// roles own nothing, are not superusers and belong to no other role; the checker requires all three.
function granted(grants: Grant[], kind: Grant['kind'], object: string, role: string, privilege: string) {
  return grants.some(g => g.kind === kind && g.object === object && g.privilege === privilege && (g.grantee === role || g.grantee === 'PUBLIC'));
}
// The search path a session reports leaves out schemas the role has no USAGE on.
export function effectiveSearchPath(role: PermissionsRole, grants: Grant[]) {
  return ROLE_SEARCH_PATHS[role].split(', ').filter(schema => granted(grants, 'schema', schema, role, 'USAGE'));
}
// What a phase's privileges, search path, current schema and table visibility should be, given the grant snapshot taken on
// the same side of the fix. Validation recomputes this from retained evidence; it never asks the database.
export function phaseExpectations(run: PermissionsRun, a: Attempt) {
  const spec = PHASE_SPECS[a.phase], grants = spec.afterFix ? run.privilegeChange.grantsAfter : run.privilegeChange.grantsBefore, table = `app_data.${spec.table}`;
  const privileges = { schemaUsage: granted(grants, 'schema', 'app_data', spec.role, 'USAGE'), schemaCreate: granted(grants, 'schema', 'app_data', spec.role, 'CREATE'),
    select: granted(grants, 'table', table, spec.role, 'SELECT'), insert: granted(grants, 'table', table, spec.role, 'INSERT'), update: granted(grants, 'table', table, spec.role, 'UPDATE'),
    delete: granted(grants, 'table', table, spec.role, 'DELETE'), truncate: granted(grants, 'table', table, spec.role, 'TRUNCATE') };
  const searchPath = effectiveSearchPath(spec.role, grants);
  return { privileges, searchPath, currentSchema: searchPath[0] ?? null, visible: searchPath.includes('app_data') };
}
// Phases whose recorded privileges, search path, current schema or visibility disagree with the grant snapshots.
export function snapshotMismatches(run: PermissionsRun) {
  return run.attempts.filter(a => { const x = phaseExpectations(run, a);
    return canonical(a.privileges) !== canonical(x.privileges) || canonical(a.context.searchPath) !== canonical(x.searchPath) || a.context.currentSchema !== x.currentSchema || a.catalog.visible !== x.visible; }).map(a => a.phase);
}
export const FIX_GRANT: Grant = { kind: 'table', object: 'app_data.project_tasks', grantee: APP_ROLE, privilege: 'SELECT', grantable: false };
const success = (r: QueryResult) => r.ok && r.rowCount === 1 && r.sqlstate === null && r.error === null;
const denied = (r: QueryResult, error: ErrorCategory, sqlstate: string) => !r.ok && r.rowCount === null && r.sqlstate === sqlstate && r.error === error;
const noWrites = (a: Attempt) => a.privileges.insert === false && a.privileges.update === false && a.privileges.delete === false && a.privileges.truncate === false && !a.privileges.schemaCreate;

export function checkPermissionsRun(value: unknown, now = new Date()) {
  validateArtifact(value, schema);
  const run = value as PermissionsRun;
  if (!Number.isFinite(now.getTime())) fail('Invalid permissions evidence clock.');
  const start = Date.parse(run.collectedAt), end = Date.parse(run.expiresAt);
  if (start > now.getTime() || end - start !== 3600000) fail('Invalid permissions evidence collection window.');
  if (SECRET_SHAPES.some(rx => rx.test(canonical(run)))) fail('A private path or connection string was retained.');
  if (!/^(16|17|18)\.[0-9]+( |$)/.test(run.postgresVersion)) fail('The retained evidence is not from PostgreSQL 16, 17 or 18.');
  const pc = run.privilegeChange, roleNames = canonical([...PERMISSIONS_ROLES].sort());
  for (const roles of [pc.rolesBefore, pc.rolesAfter]) if (canonical(roles.map(r => r.name).sort()) !== roleNames) fail('Each role snapshot must list each lab role exactly once.');
  if (canonical(pc.rolesBefore) !== canonical(pc.rolesAfter)) fail('Role attributes or memberships changed during the fix.');
  if (pc.rolesAfter.some(r => r.superuser || r.createRole || r.createDb || r.bypassRls || r.memberships !== 0)) fail('A lab role has elevated attributes or memberships.');
  if (pc.defaultPrivilegeEntries !== 0) fail('The lab database has default privileges, which the fixed experiment does not create.');
  const by = Object.fromEntries(run.attempts.map(a => [a.phase, a])) as Record<PermissionsPhase, Attempt>;
  let previous = start;
  run.attempts.forEach((a, i) => {
    const spec = PHASE_SPECS[a.phase], time = Date.parse(a.collectedAt);
    if (a.phase !== PERMISSIONS_PHASES[i] || a.runId !== run.runId || a.role !== spec.role || a.table !== spec.table) fail('Permissions attempt identity or order mismatch.');
    if (time < previous || time > now.getTime() || time >= end) fail('Invalid permissions attempt time.');
    previous = time;
    // Each phase connects as its own role, so the session's role must be that role, with no SET ROLE in between.
    if (a.context.currentUser !== spec.role || a.context.sessionUser !== spec.role) fail('A phase ran as a different role than intended.');
    if (!a.catalog.exists) fail('The lab table was missing from the catalog.');
    if ((a.privileges.select === null) !== !a.catalog.exists) fail('Table privileges and the catalog disagree.');
    // Each phase's privileges must be what the grant snapshot taken on the same side of the fix says. The reported search path is
    // the role's configured one without schemas it cannot use; the current schema is its first entry.
    const expected = phaseExpectations(run, a);
    if (canonical(a.privileges) !== canonical(expected.privileges)) fail(`In ${a.phase}, the grant snapshot and the recorded privileges disagree.`);
    if (canonical(a.context.searchPath) !== canonical(expected.searchPath)) fail(`In ${a.phase}, the effective search path differs from the role's configured search path and schema access.`);
    if (a.context.currentSchema !== expected.currentSchema) fail(`In ${a.phase}, the current schema is not the first schema in the effective search path.`);
    if (a.catalog.visible !== expected.visible) fail('Table visibility differs from schema access and the search path.');
    for (const r of [a.unqualified, a.qualified]) if (r.ok !== (r.sqlstate === null) || r.ok !== (r.rowCount !== null) || r.ok !== (r.error === null)) fail('A query result is inconsistent.');
    // Without the schema name, a visible table gives the same result as the qualified query, and a hidden one is not found.
    if (a.catalog.visible ? canonical(a.unqualified) !== canonical(a.qualified) : !denied(a.unqualified, 'relation-does-not-exist', '42P01')) fail(`In ${a.phase}, the query without the schema name disagrees with the table's visibility.`);
  });
  // Baseline: the application role reads a table that existed when it was given access.
  const base = by['baseline-existing-table'];
  if (!success(base.unqualified) || !success(base.qualified) || !base.privileges.schemaUsage || base.privileges.select !== true) fail('The baseline did not read the existing table.');
  // The failure: the right role, schema access and search path are in place; only SELECT on the new table is missing.
  const f = by['table-select-missing'];
  if (!f.privileges.schemaUsage || !f.context.searchPath.includes('app_data') || f.privileges.select !== false || !f.catalog.visible ||
      !denied(f.unqualified, 'permission-denied-table', '42501') || !denied(f.qualified, 'permission-denied-table', '42501')) fail('The failure is not a missing table SELECT for the application role.');
  // A different role gives the same error. Only the role identity tells them apart.
  for (const p of ['wrong-role', 'wrong-role-after-fix'] as const) {
    const w = by[p];
    if (w.context.currentUser === APP_ROLE || !w.privileges.schemaUsage || w.privileges.select !== false || !denied(w.unqualified, 'permission-denied-table', '42501') || !denied(w.qualified, 'permission-denied-table', '42501')) fail(`${p} did not fail as a different role without table SELECT.`);
  }
  // Without schema USAGE the table looks absent without the schema name, and the schema is refused with it.
  const u = by['schema-usage-missing'];
  if (u.privileges.schemaUsage || u.privileges.select !== true || u.context.searchPath.includes('app_data') || u.catalog.visible !== false ||
      !denied(u.unqualified, 'relation-does-not-exist', '42P01') || !denied(u.qualified, 'permission-denied-schema', '42501')) fail('The schema USAGE control differs from a role without schema access.');
  // A search_path without app_data gives the same "does not exist" error, but the schema-qualified query works.
  const s = by['search-path-missing'];
  if (!s.privileges.schemaUsage || s.privileges.select !== true || s.context.searchPath.includes('app_data') || s.catalog.visible !== false ||
      !denied(s.unqualified, 'relation-does-not-exist', '42P01') || !success(s.qualified)) fail('The search-path control differs from a search_path without app_data.');
  // The fix: one SELECT grant to the application role, nothing else; then the same query by the same role succeeds.
  const changes = grantChanges(run.privilegeChange.grantsBefore, run.privilegeChange.grantsAfter);
  // The grant option is compared too: SELECT WITH GRANT OPTION would let the application role grant it onward.
  if (changes.removed.length || canonical(changes.added) !== canonical([FIX_GRANT])) fail('The fix changed privileges other than SELECT on the one table for the application role, without the grant option.');
  const x = by['fix-applied'];
  if (!success(x.unqualified) || !success(x.qualified) || x.privileges.select !== true || !noWrites(x) || !x.privileges.schemaUsage) fail('The fix did not give read-only access to the table.');
  if (!noWrites(f)) fail('The application role had write privileges before the fix.');
  return { run, changes, evidenceStatus: now.getTime() >= end ? 'STALE' : 'MEASURED', reviewStatus: 'NOT_REVIEWED' as const };
}

export function permissionsManifest(run: PermissionsRun) {
  return { schemaVersion: 1, scenario: 'table-privilege', runHash: hash(run), catalogHash: hash(PERMISSIONS_QUERIES) };
}
export function inspectPermissions(dir: string, expectedHash?: string, now = new Date()) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular permissions run directory.');
  const result = checkPermissionsRun(readJson(join(dir, 'permissions-run.json')), now);
  const manifest = readJson(join(dir, 'permissions-manifest.json'));
  if (canonical(manifest) !== canonical(permissionsManifest(result.run)) || canonical(readJson(join(dir, 'permissions-probes.json'))) !== canonical(PERMISSIONS_QUERIES)) fail('Permissions artifact integrity mismatch.');
  const manifestHash = hash(manifest);
  if (expectedHash !== undefined && expectedHash !== manifestHash) fail('Permissions manifest differs from the supplied anchor.');
  return { ...result, integrity: 'VALID', anchorChecked: expectedHash !== undefined, manifestHash };
}

export const PHASE_LABELS: Record<PermissionsPhase, string> = {
  'baseline-existing-table': 'Baseline: the app role reads a table it was given access to',
  'table-select-missing': 'The app role queries the table added by the later migration',
  'wrong-role': 'Control: a different role runs the same query',
  'schema-usage-missing': 'Control: a role without USAGE on the schema',
  'search-path-missing': 'Control: a role whose search_path leaves out app_data',
  'fix-applied': 'The same query after GRANT SELECT on the one table',
  'wrong-role-after-fix': 'Control: the different role, after the fix',
};
const ERROR_TEXT: Record<ErrorCategory, string> = { 'permission-denied-table': 'permission denied for the table', 'permission-denied-schema': 'permission denied for the schema',
  'relation-does-not-exist': 'relation does not exist', other: 'another error' };
export const resultText = (r: QueryResult) => r.ok ? `succeeded (${r.rowCount} row)` : `SQLSTATE ${r.sqlstate}, ${ERROR_TEXT[r.error!]}`;
const yesNo = (v: boolean|null) => v === null ? 'n/a' : v ? 'yes' : 'no';
const pathText = (a: Attempt) => a.context.searchPath.length ? a.context.searchPath.join(', ') : 'none';

export function permissionsMarkdown(run: PermissionsRun, now = new Date()) {
  const checked = checkPermissionsRun(run, now), by = Object.fromEntries(run.attempts.map(a => [a.phase, a])) as Record<PermissionsPhase, Attempt>;
  const added = checked.changes.added.map(g => `${g.privilege} on ${g.object} for ${g.grantee}`).join('; ');
  return `# Permissions and search path\n\nEvidence: ${checked.evidenceStatus}. Review: NOT_REVIEWED.\n\n` +
    'This disposable local experiment starts PostgreSQL on a private Unix socket with TCP turned off. The application role was given SELECT on every table in app_data. A later migration then created app_data.project_tasks and granted nothing, because a grant on all tables covers only the tables that exist when it runs. Each check connects as one synthetic role and runs fixed queries.\n\n' +
    '| Check | Role | Without schema name | With schema name | Schema USAGE | Table SELECT | Search path |\n|---|---|---|---|---|---|---|\n' +
    run.attempts.map(a => `| ${PHASE_LABELS[a.phase]} | ${a.context.currentUser} | ${resultText(a.unqualified)} | ${resultText(a.qualified)} | ${yesNo(a.privileges.schemaUsage)} | ${yesNo(a.privileges.select)} | ${pathText(a)} |`).join('\n') +
    `\n\nThe application role (${APP_ROLE}) could read app_data.projects but not app_data.project_tasks. It had USAGE on app_data and app_data was in its search path, so the table was found; only SELECT on that table was missing, and both forms of the query returned SQLSTATE 42501, permission denied for the table.\n\n` +
    `A different role returned the same SQLSTATE and the same kind of message. The error alone did not show which role the application used; the session's current_user did.\n\n` +
    'Without USAGE on app_data, the query without the schema name returned 42P01, relation does not exist, as if the table were missing, and the schema-qualified query was refused at the schema. A search_path that leaves out app_data also returned 42P01 without the schema name, but the schema-qualified query worked. The catalog showed the table existed in every case.\n\n' +
    `The fix was one statement: ${run.privilegeChange.statement}. Comparing the grants before and after, the only change was ${added}. After it, the same query by the same role succeeded, while INSERT, UPDATE, DELETE and TRUNCATE on the table and CREATE on the schema stayed unavailable. The different role was still refused, so the grant reached only the intended role.\n\n` +
    `Default privileges in this database: ${run.privilegeChange.defaultPrivilegeEntries} entries. ALTER DEFAULT PRIVILEGES could give future tables the same access, but this lab does not test it.\n\n` +
    'Next questions: Which role does the application actually connect as (current_user)? What exact error and SQLSTATE does it report, and does the query include the schema name? Which grants does that role have on the schema and the table, and when was the table created compared with when grants were applied?\n\n' +
    'Scope: synthetic local PostgreSQL. Human cause review, customer resolution and message approval remain pending.\n';
}
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
export function permissionsHtml(run: PermissionsRun, now = new Date()) {
  const checked = checkPermissionsRun(run, now);
  const paragraphs = permissionsMarkdown(run, now).split('\n\n').filter(p => !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('Evidence:'));
  const cell = (label: string, value: string) => `<td role="cell" data-label="${escape(label)}">${escape(value)}</td>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'"><title>Permissions and search path | Postgres Support Lab</title><style>${reportStyles}

.panel p,.panel li,.lede{overflow-wrap:anywhere}
/* When the table has less than 600px, including beside the sidebar, each check gets its own block, with each value labelled. Explicit roles keep table semantics when rows use grid layout. */
.table-wrap{container-type:inline-size}
@container (max-width:600px){.results,.results thead,.results tbody{display:block}.results thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.results tr{display:grid;grid-template-columns:minmax(0,1fr);border-bottom:1px solid var(--line)}.results th,.results td{border-bottom:0;padding:4px 10px;overflow-wrap:anywhere}.results td::before{content:attr(data-label) ": ";font-weight:600}}</style></head><body><a class="skip" href="#results">Skip to results</a><aside><div class="brand"><span class="brand-mark">P</span>Postgres Support Lab</div><p class="tag">Local PostgreSQL investigation</p><nav><a href="#results">Measured results</a><a href="#interpretation">Interpretation</a><a href="#evidence">Evidence</a></nav></aside><main><header><p class="eyebrow">Permissions / search path</p><h1>The table exists, so why can’t the app query it?</h1><p class="lede">In this local test, the application role could see a table added by a later migration but not read it. Granting SELECT on that one table, and nothing else, let the same query succeed. Nobody has reviewed these results yet.</p><p class="status">${checked.evidenceStatus} · HUMAN REVIEW PENDING</p><p class="meta">Run ${escape(run.runId)}<br>Evidence collected ${escape(run.collectedAt)}<br>Freshness window ends ${escape(run.expiresAt)}<br>This page is a snapshot. Re-run inspection to check freshness.</p></header><section class="panel" id="results"><h2>Measured results</h2><div class="table-wrap"><table class="results" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Check</th><th role="columnheader" scope="col">Role</th><th role="columnheader" scope="col">Without schema name</th><th role="columnheader" scope="col">With schema name</th><th role="columnheader" scope="col">Schema USAGE</th><th role="columnheader" scope="col">Table SELECT</th><th role="columnheader" scope="col">Search path</th></tr></thead><tbody role="rowgroup">${run.attempts.map(a => `<tr role="row"><th role="rowheader" scope="row">${escape(PHASE_LABELS[a.phase])}</th>${cell('Role', a.context.currentUser)}${cell('Without schema name', resultText(a.unqualified))}${cell('With schema name', resultText(a.qualified))}${cell('Schema USAGE', yesNo(a.privileges.schemaUsage))}${cell('Table SELECT', yesNo(a.privileges.select))}${cell('Search path', pathText(a))}</tr>`).join('')}</tbody></table></div></section><section class="panel document" id="interpretation"><h2>What the comparison tells us</h2>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</section><section class="panel" id="evidence"><h2>Evidence and limitations</h2><p>PostgreSQL ${escape(run.postgresVersion)}. Private Unix socket only, TCP turned off. Synthetic roles without passwords. Cleanup complete.</p><p>Error messages are kept only as fixed categories with their SQLSTATE. Hashes check consistency against a separately retained anchor. They cannot authenticate a collector or detect a complete unanchored rewrite. HTML and Markdown are derived views; inspect the JSON artifacts for verification.</p><details><summary>Measured attempts and grants</summary><pre>${escape(JSON.stringify(run, null, 2))}</pre></details></section><footer>Independent project. Customer cause and resolution remain unset.${fontLicenses.map(l => `<details class="license"><summary>${escape(l.name)} font license</summary><pre>${escape(l.text)}</pre></details>`).join('')}</footer></main></body></html>`;
}
