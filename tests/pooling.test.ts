import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonical, hash } from '../src/contracts.ts';
import { checkPoolingRun, inspectPooling, poolingManifest, poolingHtml, poolingMarkdown, POOLING_QUERIES } from '../src/pooling-evidence.ts';
import { runPoolingLab } from '../src/pooling-lab.ts';
import { poolingFixture } from './pooling-fixture.ts';

const now = new Date('2026-09-28T12:01:00.000Z');
test('pooling contract retains measured controls, expiry and an unset human decision', () => {
  const fixture = poolingFixture();
  assert.equal(checkPoolingRun(fixture, now).evidenceStatus, 'MEASURED');
  assert.equal(checkPoolingRun(fixture, new Date(fixture.expiresAt)).evidenceStatus, 'STALE');
  assert.equal(checkPoolingRun(fixture, now).run.cause, null);
  assert.match(poolingMarkdown(fixture, now), /26000 alone/);
  assert.match(poolingMarkdown(fixture, now), /Review decisions, validation and support-bundle export are separate steps/);
});
test('pooling evidence refuses false continuity, cross-run, role, query, result and cleanup claims', () => {
  const mutations = [
    r => { r.observations[3].backend = r.observations[2].backend; },
    r => { r.observations[3].heldBackend = 999; },
    r => { r.observations[7].backend = r.observations[6].backend; },
    r => { r.observations[4].backend = 999; },
    r => { r.observations[3].runId = '22222222-2222-4222-8222-222222222222'; },
    r => { r.observations[3].role = 'other_role'; },
    r => { r.observations[3].queryHash = hash('other'); },
    r => { r.observations[3].sqlstate = '57014'; },
    r => { r.observations[0].count = null; },
    r => { r.observations.reverse(); }, r => { r.observations.pop(); },
    r => { r.cleanup = 'FAILED'; }, r => { r.cause = 'pooling'; },
    r => { r.observations[0].collectedAt = '2026-09-28T11:59:00.000Z'; },
    r => { r.expiresAt = '2026-09-29T13:00:00.000Z'; },
    r => { r.poolMode = 'session'; }, r => { r.maxPreparedStatements = 0; },
    r => { r.connectionString = 'postgres://user:secret@example.com/db'; },
  ];
  for (const mutate of mutations) { const fixture: any = poolingFixture(); mutate(fixture); assert.throws(() => checkPoolingRun(fixture, now)); }
  assert.throws(() => checkPoolingRun(poolingFixture(), new Date('2026-09-28T11:00:00.000Z')));
});
test('pooling manifest detects mutation and external anchor detects a consistent rewrite', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-contract-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = poolingFixture(), manifest = poolingManifest(run), anchor = hash(manifest);
  const save = (name: string, v: unknown) => writeFileSync(join(dir, name), canonical(v));
  save('pooling-run.json', run); save('pooling-manifest.json', manifest); save('pooling-probes.json', POOLING_QUERIES);
  assert.equal(inspectPooling(dir, anchor, now).anchorChecked, true);
  run.clusterFingerprint = hash('rewritten'); save('pooling-run.json', run);
  assert.throws(() => inspectPooling(dir, anchor, now), /integrity/);
  save('pooling-manifest.json', poolingManifest(run));
  assert.throws(() => inspectPooling(dir, anchor, now), /anchor/);
  save('pooling-probes.json', {}); assert.throws(() => inspectPooling(dir, undefined, now), /integrity/);
});
test('pooling reads refuse symlinks and oversized evidence without modifying originals', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-read-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = join(dir, 'original'); writeFileSync(original, canonical(poolingFixture()));
  symlinkSync(original, join(dir, 'pooling-run.json'));
  assert.throws(() => inspectPooling(dir, undefined, now));
  assert.equal(readFileSync(original, 'utf8'), canonical(poolingFixture()));
  rmSync(join(dir, 'pooling-run.json')); writeFileSync(join(dir, 'pooling-run.json'), 'x'.repeat(65537));
  assert.throws(() => inspectPooling(dir, undefined, now));
});
test('pooling report shares the bright offline theme and escapes artifact text', () => {
  const fixture = poolingFixture(); fixture.postgresVersion = '<script>bad</script>';
  const html = poolingHtml(fixture, now);
  assert.ok(!html.includes('<script>bad</script>')); assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /--ink:#ffffff/); assert.match(html, /font\/woff2;base64/);
  assert.match(html, /HUMAN REVIEW PENDING/); assert.match(html, /snapshot/);
});
test('pooling report table stacks each check at phone width and keeps table roles', () => {
  const html = poolingHtml(poolingFixture(), now);
  assert.match(html, /@media\(max-width:480px\)\{\.results,\.results thead,\.results tbody\{display:block\}\.results tr\{display:grid/);
  assert.match(html, /<table class="results" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Check<\/th>/);
  assert.equal(html.match(/<th role="rowheader" scope="row">/g)?.length, poolingFixture().observations.length);
  assert.equal(html.match(/<td role="cell">/g)?.length, poolingFixture().observations.length * 3);
});
test('the committed version-one pooling example keeps its exported files unchanged', () => {
  const expected: Record<string, string> = {
    'pooling-manifest.json': 'ba216c502a64248c7f162a005e9efbf835572e581d5ed1cb7d82b8544450fc51',
    'pooling-plan.json': '06108b20d194f6e308a68df168750dd9b7d89b6c3ba704ccb3daf163c7f37da8',
    'pooling-probes.json': '35944c3430b7fe087cbab77c6b3ffe9669f484701903fe6481e26d1144f17dd6',
    'pooling-report.html': 'a0da1bd74332922ba631f1c2dd3fbb7ceb2e9062d5994b94e106a4c20d149801',
    'pooling-report.md': '4dd9818eec7aad87c182b737c95bf6a1abc9e41871ef254484428ba99cead96a',
    'pooling-run.json': '65113a2ef01080549f219468d753bac4dde27731d1eeb6bf2ae0f3eb41c0f6bf',
  };
  for (const [file, hash] of Object.entries(expected)) assert.equal(createHash('sha256').update(readFileSync(join('examples/pooling-run/run', file))).digest('hex'), hash, file);
});
test('pooling execution needs approval and dry-run ignores inherited targets and creates no files', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'output'); await assert.rejects(runPoolingLab({ approved: false, output }), /approve-lab/);
  assert.equal(existsSync(output), false);
  const cli = resolve('scripts/pooling-demo.ts');
  const result = spawnSync(process.execPath, [cli, '--dry-run'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PGHOST: 'secret.invalid', DATABASE_URL: 'postgres://secret.invalid/db', PSLAB_PG_BIN: '/missing' } });
  assert.equal(result.status, 0); assert.ok(!result.stdout.includes('secret.invalid')); assert.equal(existsSync(join(dir, 'cases')), false);
  for (const args of [['--approve-lab','--dry-run'], ['postgres://secret.invalid/db'], ['inspect', '/secret/missing']]) {
    const failed = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.ok(!failed.stderr.includes('secret'));
  }
});
