import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hash } from '../src/contracts.ts';
import { PERMISSIONS_PHASES, PERMISSIONS_QUERIES as Q, PHASE_SPECS, permissionsManifest } from '../src/permissions-evidence.ts';
import { permissionsPlan } from '../src/permissions-lab.ts';
import { permissionsReviewTemplate, appendPermissionsReview } from '../src/permissions-review.ts';
import type { PermissionsRun, Attempt, PermissionsPhase, QueryResult, Grant, RoleRecord } from '../src/permissions-evidence.ts';

// Contract-test fixture only. No database produced these attempts. The outcomes copy the shape of a measured run on
// PostgreSQL 16.13 with pg 8.23.0; the fingerprint and times are synthetic.
const ok: QueryResult = { ok: true, rowCount: 1, sqlstate: null, error: null };
const tableDenied: QueryResult = { ok: false, rowCount: null, sqlstate: '42501', error: 'permission-denied-table' };
const schemaDenied: QueryResult = { ok: false, rowCount: null, sqlstate: '42501', error: 'permission-denied-schema' };
const missing: QueryResult = { ok: false, rowCount: null, sqlstate: '42P01', error: 'relation-does-not-exist' };
type Outcome = { searchPath: string[]; usage: boolean; select: boolean; unqualified: QueryResult; qualified: QueryResult };
const OUTCOMES: Record<PermissionsPhase, Outcome> = {
  'baseline-existing-table': { searchPath: ['app_data', 'public'], usage: true, select: true, unqualified: ok, qualified: ok },
  'table-select-missing': { searchPath: ['app_data', 'public'], usage: true, select: false, unqualified: tableDenied, qualified: tableDenied },
  'wrong-role': { searchPath: ['app_data', 'public'], usage: true, select: false, unqualified: tableDenied, qualified: tableDenied },
  'schema-usage-missing': { searchPath: ['public'], usage: false, select: true, unqualified: missing, qualified: schemaDenied },
  'search-path-missing': { searchPath: ['public'], usage: true, select: true, unqualified: missing, qualified: ok },
  'fix-applied': { searchPath: ['app_data', 'public'], usage: true, select: true, unqualified: ok, qualified: ok },
  'wrong-role-after-fix': { searchPath: ['app_data', 'public'], usage: true, select: false, unqualified: tableDenied, qualified: tableDenied },
};

export function permissionsAttempt(phase: PermissionsPhase, runId: string, collectedAt: string): Attempt {
  const spec = PHASE_SPECS[phase], o = OUTCOMES[phase];
  return structuredClone({ phase, runId, collectedAt, role: spec.role, table: spec.table,
    context: { currentUser: spec.role, sessionUser: spec.role, searchPath: o.searchPath, currentSchema: o.searchPath[0] ?? null },
    catalog: { exists: true, visible: o.usage && o.searchPath.includes('app_data') },
    privileges: { schemaUsage: o.usage, schemaCreate: false, select: o.select, insert: false, update: false, delete: false, truncate: false },
    unqualified: o.unqualified, qualified: o.qualified });
}
const g = (kind: 'schema'|'table', object: string, grantee: string, privilege: string): Grant => ({ kind, object, grantee, privilege, grantable: false });
export const GRANTS_BEFORE: Grant[] = [
  g('schema', 'app_data', 'pslab_app', 'USAGE'), g('schema', 'app_data', 'pslab_path', 'USAGE'), g('schema', 'app_data', 'pslab_reporting', 'USAGE'),
  g('schema', 'lab_meta', 'pslab_app', 'USAGE'), g('schema', 'lab_meta', 'pslab_nousage', 'USAGE'), g('schema', 'lab_meta', 'pslab_path', 'USAGE'), g('schema', 'lab_meta', 'pslab_reporting', 'USAGE'),
  g('schema', 'public', 'PUBLIC', 'USAGE'), g('schema', 'public', 'pg_database_owner', 'CREATE'), g('schema', 'public', 'pg_database_owner', 'USAGE'),
  g('table', 'app_data.project_tasks', 'pslab_nousage', 'SELECT'), g('table', 'app_data.project_tasks', 'pslab_path', 'SELECT'),
  g('table', 'app_data.projects', 'pslab_app', 'SELECT'), g('table', 'app_data.projects', 'pslab_reporting', 'SELECT'),
  g('table', 'lab_meta.identity', 'pslab_app', 'SELECT'), g('table', 'lab_meta.identity', 'pslab_nousage', 'SELECT'), g('table', 'lab_meta.identity', 'pslab_path', 'SELECT'), g('table', 'lab_meta.identity', 'pslab_reporting', 'SELECT'),
];
export const GRANTS_AFTER: Grant[] = [...GRANTS_BEFORE.slice(0, 10), g('table', 'app_data.project_tasks', 'pslab_app', 'SELECT'), ...GRANTS_BEFORE.slice(10)];
const ROLES: RoleRecord[] = (['pslab_app', 'pslab_nousage', 'pslab_path', 'pslab_reporting'] as const).map(name => ({ name, superuser: false, inherit: false, createRole: false, createDb: false, bypassRls: false, memberships: 0 }));

export function permissionsFixture(): PermissionsRun {
  const runId = '44444444-4444-4444-8444-444444444444', collectedAt = '2026-10-15T12:00:00.000Z';
  return { schemaVersion: 1, scenario: 'table-privilege', runId, profile: 'local-lab', collectedAt, expiresAt: '2026-10-15T13:00:00.000Z',
    postgresVersion: '16.13', clusterFingerprint: hash('synthetic-test-cluster'), versions: { node: 'v24.21.0', pg: '8.23.0' }, environment: { namesPresent: [] },
    privilegeChange: { statement: Q.fix, grantsBefore: structuredClone(GRANTS_BEFORE), grantsAfter: structuredClone(GRANTS_AFTER), rolesBefore: structuredClone(ROLES), rolesAfter: structuredClone(ROLES), defaultPrivilegeEntries: 0 },
    cleanup: 'COMPLETE', attempts: PERMISSIONS_PHASES.map((p, i) => permissionsAttempt(p, runId, new Date(Date.parse(collectedAt) + (i + 1) * 1000).toISOString())),
    classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED' };
}
export const FIXTURE_NOW = new Date('2026-10-15T12:10:00.000Z');

// A run directory holding the fixture, as the runner would leave it. Decisions use a clearly labelled automated test reviewer.
export function permissionsCase(t: any, change?: (run: PermissionsRun) => void) {
  const root = mkdtempSync(join(tmpdir(), 'permissions-case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = permissionsFixture(); change?.(run);
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), canonical(value) + '\n');
  write('permissions-run.json', run); write('permissions-manifest.json', permissionsManifest(run));
  write('permissions-probes.json', Q); write('permissions-plan.json', { ...permissionsPlan(), runId: run.runId, approved: true });
  return { root, run, now: FIXTURE_NOW, expired: new Date('2026-10-15T13:00:00.000Z') };
}
export const TEST_REVIEWER = 'automated-test-reviewer';
export function acceptPermissionsCause(root: string, now: Date, decision = 'accept') {
  return appendPermissionsReview(root, { ...permissionsReviewTemplate(root, 'cause', now), reviewer: TEST_REVIEWER, decision,
    rationale: 'Synthetic test decision recorded by the automated suite.' }, now);
}
export function selectPermissionsRemedy(root: string, now: Date) {
  return appendPermissionsReview(root, { ...permissionsReviewTemplate(root, 'remedy', now), reviewer: TEST_REVIEWER, remedy: 'grant-table-select',
    rationale: 'Synthetic test remedy selection recorded by the automated suite.' }, now);
}
