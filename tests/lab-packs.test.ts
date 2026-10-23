import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPacks, requireWorkingPack, PACK_IDS } from '../src/lab-packs.ts';

const copy = (t: any) => { const dir = mkdtempSync(join(tmpdir(), 'packs-')); t.after(() => rmSync(dir, { recursive: true, force: true })); cpSync('packs', dir, { recursive: true }); return dir; };
const edit = (dir: string, id: string, change: (p: any) => void) => { const path = join(dir, id + '.json'), p = JSON.parse(readFileSync(path, 'utf8')); change(p); writeFileSync(path, JSON.stringify(p)); };

test('all six version-one labs load and all six are working', () => {
  const packs = loadPacks();
  assert.deepEqual(packs.map(p => p.id), [...PACK_IDS]);
  assert.deepEqual(packs.filter(p => p.status === 'working').map(p => p.id), [...PACK_IDS]);
  for (const p of packs) assert.ok(p.stillToBuild.length > 0, p.id);
  assert.equal(requireWorkingPack('pgbouncer-session').bundle?.scenario, 'pooling-session');
  assert.equal(requireWorkingPack('slow-query-index').bundle?.scenario, 'slow-query-index');
  assert.equal(requireWorkingPack('connectivity').bundle?.scenario, 'tls-trust');
  assert.equal(requireWorkingPack('permissions').bundle?.scenario, 'table-privilege');
  assert.equal(requireWorkingPack('pool-exhaustion').bundle?.scenario, 'connection-leak');
});

test('pack files cannot carry SQL or drift from the bundled probe catalogs, phases, fixes or bundle versions', t => {
  const cases: [string, (p: any) => void, RegExp][] = [
    ['pgbouncer-session', p => { p.sql = 'DROP TABLE projects'; }, /Unsupported artifact field/],
    ['pgbouncer-session', p => { p.probeCatalog.sha256 = '0'.repeat(64); }, /does not match its bundled probe catalog/],
    ['schema-drift', p => { p.probeCatalog.source = 'pooling-evidence'; }, /does not match its bundled probe catalog/],
    ['pgbouncer-session', p => { p.phases = p.phases.slice(1); }, /phases differ/],
    ['pgbouncer-session', p => { p.controls.push({ phase: 'not-a-phase', purpose: 'A control that the lab does not run.' }); }, /controls its lab does not run: not-a-phase/],
    ['pgbouncer-session', p => { p.controls = []; }, /missing controls its lab runs: direct-reset, timeout-control/],
    ['pgbouncer-session', p => { p.controls = p.controls.filter((c: any) => c.phase !== 'timeout-control'); }, /missing controls its lab runs: timeout-control\./],
    ['pgbouncer-session', p => { p.controls.push({ ...p.controls[0] }); }, /lists a control more than once/],
    ['pgbouncer-session', p => { p.controls.push({ phase: 'pooled-first', purpose: 'A lab phase that is not one of its controls.' }); }, /controls its lab does not run: pooled-first/],
    ['schema-drift', p => { p.controls = []; }, /missing controls its lab runs: search-path-control/],
    ['pgbouncer-session', p => { p.remedies = ['transaction-contained']; }, /fixes differ/],
    ['schema-drift', p => { p.bundle.toolVersions = ['0.1.0-bundle4']; }, /bundle versions differ/],
    // A pack marked planned while its lab is bundled, or working without a guide, is refused.
    ['pool-exhaustion', p => { p.status = 'planned'; }, /must not claim an implementation/],
    ['pool-exhaustion', p => { p.guide = null; }, /no matching bundled implementation/],
    ['connectivity', p => { p.controls = p.controls.filter((c: any) => c.phase !== 'require-libpq-compat'); }, /missing controls its lab runs: require-libpq-compat\./],
    ['pool-exhaustion', p => { p.probeCatalog = { source: 'native-lab', sha256: '0'.repeat(64) }; }, /does not match its bundled probe catalog/],
    ['pool-exhaustion', p => { p.controls = p.controls.filter((c: any) => c.phase !== 'server-refusal'); }, /missing controls its lab runs: server-refusal\./],
    ['pool-exhaustion', p => { p.remedies = ['larger-pool']; }, /fixes differ/],
    ['pool-exhaustion', p => { p.bundle.toolVersions = ['0.1.0-pool-exhaustion-bundle2']; }, /bundle versions differ/],
    ['permissions', p => { p.controls = p.controls.filter((c: any) => c.phase !== 'search-path-missing'); }, /missing controls its lab runs: search-path-missing\./],
    ['permissions', p => { p.remedies = ['grant-all']; }, /fixes differ/],
    ['permissions', p => { p.probeCatalog.source = 'connectivity-evidence'; }, /does not match its bundled probe catalog/],
    ['slow-query-index', p => { p.controls = p.controls.filter((c: any) => c.phase !== 'common-value'); }, /missing controls its lab runs: common-value\./],
    ['slow-query-index', p => { p.probeCatalog.source = 'pooling-evidence'; }, /does not match its bundled probe catalog/],
    ['connectivity', p => { p.id = 'permissions'; }, /declares a different id/],
  ];
  for (const [id, change, message] of cases) {
    const dir = copy(t); edit(dir, id, change);
    assert.throws(() => loadPacks(dir), message, id);
    assert.throws(() => requireWorkingPack(id as any, dir), message, id);
  }
});

test('a lab runner checks only its own pack, so a broken or missing unrelated pack does not block it', t => {
  const planned = copy(t); edit(planned, 'pool-exhaustion', p => { p.sql = 'SELECT 1'; }); unlinkSync(join(planned, 'connectivity.json'));
  const unrelated = copy(t); edit(unrelated, 'schema-drift', p => { p.probeCatalog.sha256 = '0'.repeat(64); });
  for (const dir of [planned, unrelated]) {
    assert.throws(() => loadPacks(dir));
    assert.equal(requireWorkingPack('pgbouncer-session', dir).id, 'pgbouncer-session');
  }
  assert.equal(requireWorkingPack('schema-drift', planned).id, 'schema-drift');
  assert.throws(() => requireWorkingPack('schema-drift', unrelated), /does not match its bundled probe catalog/);
  const missing = copy(t); unlinkSync(join(missing, 'pgbouncer-session.json'));
  assert.throws(() => requireWorkingPack('pgbouncer-session', missing));
  assert.equal(requireWorkingPack('schema-drift', missing).id, 'schema-drift');
});

test('the pack directory must hold exactly the six pack files as regular files', t => {
  const missing = copy(t); unlinkSync(join(missing, 'pool-exhaustion.json'));
  assert.throws(() => loadPacks(missing), /exactly the six/);
  const extra = copy(t); writeFileSync(join(extra, 'extra.json'), '{}');
  assert.throws(() => loadPacks(extra), /exactly the six/);
  const linked = copy(t); unlinkSync(join(linked, 'connectivity.json')); symlinkSync(resolve('packs/connectivity.json'), join(linked, 'connectivity.json'));
  assert.throws(() => loadPacks(linked));
});

test('lab packs CLI lists every lab, checks every pack and rejects unknown flags', () => {
  const cli = resolve('src/cli.ts');
  const listed = spawnSync(process.execPath, [cli, 'lab', 'packs'], { encoding: 'utf8' });
  assert.equal(listed.status, 0);
  for (const title of ['Missing tables and schema drift', 'Session behavior through PgBouncer', 'SSL, authentication and connection strings', 'Permissions and search path', 'Slow queries and indexes', 'Application pool exhaustion']) assert.ok(listed.stdout.includes(title), title);
  assert.equal(JSON.parse(spawnSync(process.execPath, [cli, 'lab', 'packs', '--json'], { encoding: 'utf8' }).stdout).length, 6);
  const checked = spawnSync(process.execPath, [cli, 'lab', 'packs', '--check'], { encoding: 'utf8' });
  assert.equal(checked.status, 0); assert.match(checked.stdout, /All 6 lab pack files are valid/);
  assert.equal(spawnSync(process.execPath, [cli, 'lab', 'packs', '--yaml'], { encoding: 'utf8' }).status, 1);
});
