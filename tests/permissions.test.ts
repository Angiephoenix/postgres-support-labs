import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hash } from '../src/contracts.ts';
import { checkPermissionsRun, inspectPermissions, permissionsManifest, permissionsMarkdown, permissionsHtml, errorCategory, grantChanges, PERMISSIONS_QUERIES, PHASE_SPECS, ROLE_SEARCH_PATHS } from '../src/permissions-evidence.ts';
import { permissionsPlan, runPermissionsLab } from '../src/permissions-lab.ts';
import { permissionsFixture, FIXTURE_NOW } from './permissions-fixture.ts';

const at = (run: any, phase: string) => run.attempts.find((a: any) => a.phase === phase);
const rejects = (mutate: (run: any) => void, message: RegExp) => { const run: any = permissionsFixture(); mutate(run); assert.throws(() => checkPermissionsRun(run, FIXTURE_NOW), message); };

test('error categories come from the SQLSTATE and PostgreSQL message, and anything else is "other"', () => {
  assert.equal(errorCategory('42501', 'permission denied for table project_tasks'), 'permission-denied-table');
  assert.equal(errorCategory('42501', 'permission denied for schema app_data'), 'permission-denied-schema');
  assert.equal(errorCategory('42P01', 'relation "project_tasks" does not exist'), 'relation-does-not-exist');
  assert.equal(errorCategory('42501', 'relation "project_tasks" does not exist'), 'other');
  assert.equal(errorCategory('42P01', 'permission denied for table project_tasks'), 'other');
  assert.equal(errorCategory('57014', 'canceling statement due to statement timeout'), 'other');
});

test('the fixture passes, and the only grant change is SELECT on the one table for the application role', () => {
  const checked = checkPermissionsRun(permissionsFixture(), FIXTURE_NOW);
  assert.equal(checked.evidenceStatus, 'MEASURED'); assert.equal(checked.reviewStatus, 'NOT_REVIEWED');
  assert.deepEqual(checked.changes, { added: [{ kind: 'table', object: 'app_data.project_tasks', grantee: 'pslab_app', privilege: 'SELECT', grantable: false }], removed: [] });
  assert.equal(checkPermissionsRun(permissionsFixture(), new Date('2026-10-15T13:00:00.000Z')).evidenceStatus, 'STALE');
});

test('the run contract rejects a different role, a changed error and a wrong control', () => {
  rejects(r => { at(r, 'table-select-missing').context.currentUser = 'pslab_reporting'; }, /different role than intended/);
  rejects(r => { at(r, 'table-select-missing').context.sessionUser = 'pslab_owner'; }, /different role than intended/);
  rejects(r => { at(r, 'table-select-missing').unqualified = { ok: false, rowCount: null, sqlstate: '42P01', error: 'relation-does-not-exist' }; }, /not a missing table SELECT|disagrees with the table's visibility/);
  rejects(r => { at(r, 'table-select-missing').privileges.select = true; }, /not a missing table SELECT|recorded privileges disagree/);
  rejects(r => { at(r, 'wrong-role').unqualified = { ok: true, rowCount: 1, sqlstate: null, error: null }; }, /wrong-role did not fail|disagrees with the table's visibility/);
  rejects(r => { at(r, 'schema-usage-missing').qualified = { ok: false, rowCount: null, sqlstate: '42501', error: 'permission-denied-table' }; }, /schema USAGE control/);
  rejects(r => { at(r, 'search-path-missing').qualified = { ok: false, rowCount: null, sqlstate: '42P01', error: 'relation-does-not-exist' }; }, /search-path control/);
  rejects(r => { at(r, 'fix-applied').privileges.insert = true; }, /read-only access|recorded privileges disagree/);
  rejects(r => { at(r, 'fix-applied').unqualified = { ok: false, rowCount: null, sqlstate: '42501', error: 'permission-denied-table' }; }, /read-only access|disagrees with the table's visibility/);
  rejects(r => { at(r, 'wrong-role-after-fix').unqualified = { ok: true, rowCount: 1, sqlstate: null, error: null }; }, /wrong-role-after-fix did not fail|disagrees with the table's visibility/);
});

test('the run contract rejects any privilege change beyond the one SELECT grant', () => {
  rejects(r => { r.privilegeChange.grantsAfter.push({ kind: 'table', object: 'app_data.project_tasks', grantee: 'pslab_app', privilege: 'INSERT', grantable: false }); }, /privileges other than SELECT|recorded privileges disagree/);
  rejects(r => { r.privilegeChange.grantsAfter.push({ kind: 'schema', object: 'app_data', grantee: 'pslab_app', privilege: 'CREATE', grantable: false }); }, /privileges other than SELECT|recorded privileges disagree/);
  rejects(r => { r.privilegeChange.grantsAfter.push({ kind: 'table', object: 'app_data.project_tasks', grantee: 'PUBLIC', privilege: 'SELECT', grantable: false }); }, /privileges other than SELECT|recorded privileges disagree/);
  rejects(r => { r.privilegeChange.grantsAfter = r.privilegeChange.grantsBefore; }, /privileges other than SELECT|recorded privileges disagree/);
  rejects(r => { r.privilegeChange.grantsAfter = r.privilegeChange.grantsAfter.filter((g: any) => g.grantee !== 'pslab_reporting'); }, /privileges other than SELECT|recorded privileges disagree/);
  rejects(r => { r.privilegeChange.rolesAfter[0].superuser = true; }, /Role attributes or memberships changed/);
  rejects(r => { r.privilegeChange.rolesBefore[0].memberships = 1; r.privilegeChange.rolesAfter[0].memberships = 1; }, /elevated attributes or memberships/);
  rejects(r => { r.privilegeChange.statement = 'GRANT ALL ON app_data.project_tasks TO pslab_app'; }, /constant mismatch/);
  assert.deepEqual(grantChanges([], []), { added: [], removed: [] });
});

test('the run contract rejects inconsistent visibility, order, time and retained paths', () => {
  rejects(r => { at(r, 'schema-usage-missing').catalog.visible = true; }, /visibility/);
  rejects(r => { at(r, 'schema-usage-missing').context.searchPath = ['app_data', 'public']; }, /effective search path/);
  rejects(r => { at(r, 'baseline-existing-table').catalog.exists = false; }, /missing from the catalog/);
  rejects(r => { [r.attempts[1], r.attempts[2]] = [r.attempts[2], r.attempts[1]]; }, /identity or order/);
  rejects(r => { r.attempts[3].collectedAt = r.collectedAt.replace('12:00', '11:59'); }, /attempt time/);
  rejects(r => { r.expiresAt = '2026-10-15T14:00:00.000Z'; }, /collection window/);
  rejects(r => { r.postgresVersion = '16.13 /tmp/pslab-perm-abc'; }, /private path/);
  rejects(r => { at(r, 'fix-applied').unqualified.rowCount = null; }, /inconsistent/);
  rejects(r => { r.cause = 'accepted'; }, /constant mismatch/);
});

test('reports describe the failure, each control and the single grant, without claiming a cause', () => {
  const run = permissionsFixture(), md = permissionsMarkdown(run, FIXTURE_NOW), html = permissionsHtml(run, FIXTURE_NOW);
  assert.match(md, /Evidence: MEASURED\. Review: NOT_REVIEWED\./);
  assert.match(md, /only SELECT on that table was missing, and both forms of the query returned SQLSTATE 42501/);
  assert.match(md, /The error alone did not show which role the application used; the session's current_user did\./);
  assert.match(md, /returned 42P01, relation does not exist, as if the table were missing/);
  assert.match(md, /the only change was SELECT on app_data\.project_tasks for pslab_app\./);
  assert.match(md, /ALTER DEFAULT PRIVILEGES could give future tables the same access, but this lab does not test it\./);
  assert.match(md, /Human cause review, customer resolution and message approval remain pending\./);
  assert.doesNotMatch(md, /—/);
  assert.match(html, /<h1>The table exists, so why can’t the app query it\?<\/h1>/);
  assert.match(html, /MEASURED · HUMAN REVIEW PENDING/);
  assert.match(html, /data-label="Without schema name">SQLSTATE 42501, permission denied for the table</);
  assert.doesNotMatch(html, /<script/);
});

test('run inspection checks the probe catalog and manifest anchor', t => {
  const dir = mkdtempSync(join(tmpdir(), 'permissions-inspect-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = permissionsFixture(), manifest = permissionsManifest(run);
  writeFileSync(join(dir, 'permissions-run.json'), canonical(run)); writeFileSync(join(dir, 'permissions-manifest.json'), canonical(manifest));
  writeFileSync(join(dir, 'permissions-probes.json'), canonical(PERMISSIONS_QUERIES));
  const result = inspectPermissions(dir, hash(manifest), FIXTURE_NOW);
  assert.equal(result.integrity, 'VALID'); assert.equal(result.anchorChecked, true);
  assert.throws(() => inspectPermissions(dir, 'a'.repeat(64), FIXTURE_NOW), /differs from the supplied anchor/);
  writeFileSync(join(dir, 'permissions-probes.json'), canonical({ ...PERMISSIONS_QUERIES, fix: 'GRANT ALL ON app_data.project_tasks TO pslab_app' }));
  assert.throws(() => inspectPermissions(dir, undefined, FIXTURE_NOW), /integrity mismatch/);
  mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'link'));
  assert.throws(() => inspectPermissions(join(dir, 'link'), undefined, FIXTURE_NOW), /regular permissions run directory/);
});

test('the probe catalog is fixed SQL: one narrow fix, no writes by lab roles and search paths that differ only for the path control', () => {
  assert.equal(PERMISSIONS_QUERIES.fix, 'GRANT SELECT ON app_data.project_tasks TO pslab_app');
  // The blanket grant runs before the later migration creates the table, which is the scenario.
  const setup = PERMISSIONS_QUERIES.setup.join('\n'), migration = PERMISSIONS_QUERIES.migration.join('\n');
  assert.match(setup, /GRANT SELECT ON ALL TABLES IN SCHEMA app_data TO pslab_app/); assert.doesNotMatch(setup, /project_tasks/);
  assert.match(migration, /CREATE TABLE app_data\.project_tasks/); assert.doesNotMatch(migration, /GRANT/);
  assert.doesNotMatch(PERMISSIONS_QUERIES.controls.join('\n'), /pslab_app|pslab_reporting/);
  for (const sql of [PERMISSIONS_QUERIES.context, PERMISSIONS_QUERIES.catalog, PERMISSIONS_QUERIES.privileges, ...Object.values(PERMISSIONS_QUERIES.unqualified), ...Object.values(PERMISSIONS_QUERIES.qualified)])
    assert.match(sql, /^SELECT /);
  assert.deepEqual(Object.entries(ROLE_SEARCH_PATHS).filter(([, p]) => !p.includes('app_data')).map(([r]) => r), ['pslab_path']);
  assert.deepEqual([...new Set(Object.values(PHASE_SPECS).map(s => s.role))].sort(), ['pslab_app', 'pslab_nousage', 'pslab_path', 'pslab_reporting']);
  const plan = permissionsPlan();
  assert.equal(plan.network, false); assert.equal(plan.approvalRequired, true); assert.equal(plan.cause, null); assert.equal(plan.customerResolution, null);
});

test('the runner requires explicit approval before creating anything', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'permissions-approval-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(runPermissionsLab({ approved: false, output: join(dir, 'run') }), /requires --approve-lab/);
});

// Regression cases from review. Each one was accepted by the first version of the run contract.
const grantable = (run: any, value = false) => { for (const g of [...run.privilegeChange.grantsBefore, ...run.privilegeChange.grantsAfter]) g.grantable ??= value; return run; };
const rejectsReview = (mutate: (run: any) => void, message: RegExp) => { const run: any = grantable(permissionsFixture()); mutate(run); assert.throws(() => checkPermissionsRun(run, FIXTURE_NOW), message); };
const fixGrant = (grantable = false) => ({ kind: 'table', object: 'app_data.project_tasks', grantee: 'pslab_app', privilege: 'SELECT', grantable });

test('review: the wrong-role controls must be refused with and without the schema name', () => {
  for (const p of ['wrong-role', 'wrong-role-after-fix'])
  {
    rejectsReview(r => { at(r, p).qualified = { ok: true, rowCount: 1, sqlstate: null, error: null }; }, /did not fail as a different role|disagrees with the table's visibility/);
    rejectsReview(r => { at(r, p).qualified = { ok: false, rowCount: null, sqlstate: '42P01', error: 'relation-does-not-exist' }; at(r, p).unqualified = { ...at(r, p).qualified }; }, /disagrees with the table's visibility|did not fail as a different role/);
    rejectsReview(r => { at(r, p).qualified = { ok: true, rowCount: 1, sqlstate: null, error: null }; at(r, p).unqualified = { ok: true, rowCount: 1, sqlstate: null, error: null }; }, /did not fail as a different role/);
  }
});

test('review: grant snapshots must agree with the privilege flags each phase recorded', () => {
  // Snapshots holding only the added fix grant contradict the schema USAGE and table SELECT the phases recorded.
  rejectsReview(r => { r.privilegeChange.grantsBefore = []; r.privilegeChange.grantsAfter = [fixGrant()]; }, /grant snapshot and the recorded privileges disagree/);
  // INSERT in both snapshots, while every phase recorded INSERT as unavailable.
  rejectsReview(r => { for (const s of [r.privilegeChange.grantsBefore, r.privilegeChange.grantsAfter]) s.push({ kind: 'table', object: 'app_data.project_tasks', grantee: 'pslab_app', privilege: 'INSERT', grantable: false }); },
    /grant snapshot and the recorded privileges disagree/);
  rejectsReview(r => { for (const s of [r.privilegeChange.grantsBefore, r.privilegeChange.grantsAfter]) s.push({ kind: 'schema', object: 'app_data', grantee: 'PUBLIC', privilege: 'USAGE', grantable: false }); },
    /grant snapshot and the recorded privileges disagree/);
});

test('review: each role snapshot names the four lab roles exactly once', () => {
  const reporting = { name: 'pslab_reporting', superuser: false, inherit: false, createRole: false, createDb: false, bypassRls: false, memberships: 0 };
  rejectsReview(r => { r.privilegeChange.rolesBefore = [0, 1, 2, 3].map(() => ({ ...reporting })); r.privilegeChange.rolesAfter = [0, 1, 2, 3].map(() => ({ ...reporting })); }, /each lab role exactly once/);
});

test('review: search path, visibility and current schema must match each role and its schema access', () => {
  rejectsReview(r => { const a = at(r, 'fix-applied'); a.context.searchPath = ['public']; a.context.currentSchema = 'public'; a.catalog.visible = false; }, /effective search path/);
  rejectsReview(r => { at(r, 'search-path-missing').context.currentSchema = 'app_data'; }, /current schema/);
  rejectsReview(r => { at(r, 'baseline-existing-table').context.currentSchema = 'public'; }, /current schema/);
  rejectsReview(r => { at(r, 'search-path-missing').context.searchPath = []; at(r, 'search-path-missing').context.currentSchema = null; }, /effective search path/);
});

test('review: retained evidence must come from PostgreSQL 16, 17 or 18', () => {
  for (const v of ['15.8', '19.0', '9.6.24', 'sixteen']) rejectsReview(r => { r.postgresVersion = v; }, /PostgreSQL 16, 17 or 18/);
  for (const v of ['16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)', '17.11', '18.0']) { const r: any = grantable(permissionsFixture()); r.postgresVersion = v; assert.doesNotThrow(() => checkPermissionsRun(r, FIXTURE_NOW), v); }
});

test('review: the fixed experiment has no default privileges', () => {
  rejectsReview(r => { r.privilegeChange.defaultPrivilegeEntries = 1; }, /default privileges/);
});

test('review: grant options are kept, and the fix must be an ordinary SELECT that cannot be granted onward', () => {
  const ok: any = grantable(permissionsFixture());
  assert.deepEqual(checkPermissionsRun(ok, FIXTURE_NOW).changes.added, [fixGrant()]);
  rejectsReview(r => { r.privilegeChange.grantsAfter = r.privilegeChange.grantsAfter.map((g: any) => g.grantee === 'pslab_app' && g.object === 'app_data.project_tasks' ? { ...g, grantable: true } : g); }, /privileges other than SELECT/);
  // An existing grant gaining the grant option is a change too.
  rejectsReview(r => { r.privilegeChange.grantsAfter = r.privilegeChange.grantsAfter.map((g: any) => g.grantee === 'pslab_reporting' && g.object === 'app_data.projects' ? { ...g, grantable: true } : g); }, /privileges other than SELECT/);
  rejectsReview(r => { delete r.privilegeChange.grantsAfter[0].grantable; }, /Missing artifact field/);
});
