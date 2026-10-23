import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadProfile, checkProfileSources } from '../src/platform-profile.ts';
import { poolingProfileCheck, formatProfileCheck, PROFILE_CHECK_SCOPE } from '../src/pooling-profile-check.ts';
import { poolingCase, acceptCause, selectRemedy } from './pooling-case-fixture.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const temp = (t: any) => { const dir = mkdtempSync(join(tmpdir(), 'profile-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const tampered = (t: any, change: (p: any) => void) => { const p = JSON.parse(readFileSync('profiles/planetscale-postgres.v1.json', 'utf8')); change(p); const path = join(temp(t), 'p.json'); writeFileSync(path, JSON.stringify(p)); return path; };

test('the PlanetScale profile holds only documented facts, each with its source passage, URL, retrieval time and hashes', () => {
  const p = loadProfile();
  assert.deepEqual(p.sources.map(s => s.url), ['https://planetscale.com/docs/postgres/connecting', 'https://planetscale.com/docs/postgres/connecting/pgbouncer']);
  for (const s of p.sources) { assert.match(s.retrievedAt, /^2026-10-04T/); assert.match(s.markdownSha256, /^[a-f0-9]{64}$/); assert.match(s.htmlSha256, /^[a-f0-9]{64}$/); }
  assert.deepEqual([...new Set(p.facts.map(f => f.topic))].sort(), ['connection-string', 'pooling', 'ssl']);
  for (const f of p.facts) { assert.equal(f.classification, 'DOCUMENTED_BEHAVIOR'); assert.equal(f.passageSha256, sha(f.passage)); }
  assert.match(p.scope, /Nothing in this profile was tested against PlanetScale or a customer environment/);
});

test('profiles with edited passages, unknown references, observations or secrets are rejected', t => {
  const cases: [(p: any) => void, RegExp][] = [
    [p => { p.facts[0].passage += ' Extra words.'; }, /passage does not match its hash/],
    [p => { p.facts[0].sourceId = 'unknown'; }, /unknown source/],
    [p => { p.customerQuestions[0].facts = ['not-a-fact']; }, /unknown fact/],
    [p => { p.facts[0].classification = 'REPRODUCED_BEHAVIOR'; }, /constant mismatch/],
    [p => { p.scope = 'Tested on PlanetScale.'; }, /constant mismatch/],
    [p => { p.sources[0].url = 'https://example.com/docs/postgres'; }, /format mismatch/],
    [p => { p.facts[1].id = p.facts[0].id; }, /unique/],
    [p => { p.facts[0].passage = "password=pscale_pw_abcdefghijklmnopqrstuvwxyz0123456789"; p.facts[0].passageSha256 = sha(p.facts[0].passage); }, /Privacy gate/],
  ];
  for (const [change, message] of cases) assert.throws(() => loadProfile(tampered(t, change)), message);
});

test('source recheck keeps passage presence separate from review: any changed or missing page needs review', t => {
  const p = loadProfile(), dir = temp(t);
  const page = (id: string) => '# Page\n\n' + p.facts.filter(f => f.sourceId === id).map(f => f.passage).join('\n\n') + '\n';
  const status = (r: ReturnType<typeof checkProfileSources>) => r.sources.map(s => s.status);
  // Unchanged: copies whose bytes hash to the recorded Markdown hashes.
  const recorded = p.sources.map(s => s.markdownSha256);
  for (const s of p.sources) writeFileSync(join(dir, s.id + '.md'), page(s.id));
  const exact = { ...p, sources: p.sources.map(s => ({ ...s, markdownSha256: sha(page(s.id)) })) };
  let result = checkProfileSources(exact, dir);
  assert.deepEqual(status(result), ['UNCHANGED', 'UNCHANGED']); assert.deepEqual(result.sources.map(s => s.missingPassages), [[], []]);
  assert.equal(result.allPassagesPresent, true); assert.equal(result.sourceReviewRequired, false);
  // Unchanged page whose profile quotes a passage that is not on it: never reported as unchanged.
  const edited = { ...exact, facts: exact.facts.map(f => f.id === 'pooling-per-transaction-assignment' ? { ...f, passage: f.passage + ' Not on the page.' } : f) };
  result = checkProfileSources(edited, dir);
  assert.deepEqual(status(result), ['UNCHANGED', 'PASSAGES_CHANGED']); assert.deepEqual(result.sources[1].missingPassages, ['pooling-per-transaction-assignment']);
  assert.equal(result.allPassagesPresent, false); assert.equal(result.sourceReviewRequired, true);
  // Changed pages that keep every quotation: passages present, review still required.
  assert.ok(p.sources.every((s, i) => sha(page(s.id)) !== recorded[i]));
  result = checkProfileSources(p, dir);
  assert.deepEqual(status(result), ['PAGE_CHANGED_PASSAGES_PRESENT', 'PAGE_CHANGED_PASSAGES_PRESENT']);
  assert.equal(result.allPassagesPresent, true); assert.equal(result.sourceReviewRequired, true);
  assert.ok(!('current' in result));
  // Missing quotation.
  writeFileSync(join(dir, 'pgbouncer.md'), page('pgbouncer').replace('transaction mode', 'session mode'));
  result = checkProfileSources(p, dir);
  assert.equal(result.sources[1].status, 'PASSAGES_CHANGED'); assert.ok(result.sources[1].missingPassages!.includes('pooling-per-transaction-assignment'));
  assert.equal(result.allPassagesPresent, false); assert.equal(result.sourceReviewRequired, true);
  // Missing file: its passages were not checked.
  unlinkSync(join(dir, 'pgbouncer.md'));
  result = checkProfileSources(p, dir);
  assert.deepEqual(status(result), ['PAGE_CHANGED_PASSAGES_PRESENT', 'MISSING']); assert.equal(result.sources[1].missingPassages, null);
  assert.equal(result.allPassagesPresent, false); assert.equal(result.sourceReviewRequired, true);
  // The CLI exits non-zero whenever review is required, and zero only when every page is unchanged.
  writeFileSync(join(dir, 'pgbouncer.md'), page('pgbouncer'));
  const cli = spawnSync(process.execPath, [resolve('src/cli.ts'), 'profile', 'check-sources', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 1); const out = JSON.parse(cli.stdout);
  assert.equal(out.allPassagesPresent, true); assert.equal(out.sourceReviewRequired, true);
});

test('profile check shows local findings only for a fresh run with an accepted cause, and never claims a platform or customer test', t => {
  const unreviewed = poolingCase(t);
  let c = poolingProfileCheck(unreviewed.root, unreviewed.now);
  assert.equal(c.localStatus, 'WITHHELD'); assert.deepEqual(c.localFindings, []); assert.deepEqual(c.comparisons, []);
  assert.match(c.blockers.join(' '), /must accept the local cause/);
  assert.equal(c.documentedFacts.length, loadProfile().facts.length); assert.ok(c.customerQuestions.every(q => q.classification === 'CUSTOMER_EVIDENCE_NEEDED'));

  const reviewed = poolingCase(t); acceptCause(reviewed.root, reviewed.now);
  c = poolingProfileCheck(reviewed.root, reviewed.now);
  assert.equal(c.localStatus, 'SHOWN'); assert.deepEqual(c.localFindings.map(f => f.id), ['sql-prepare-after-switch', 'same-error-without-pooler']);
  assert.ok(c.localFindings.every(f => f.classification === 'REPRODUCED_BEHAVIOR' && f.scope === 'local-lab'));
  selectRemedy(reviewed.root, reviewed.now);
  c = poolingProfileCheck(reviewed.root, reviewed.now);
  assert.deepEqual(c.localFindings.map(f => f.id), ['sql-prepare-after-switch', 'same-error-without-pooler', 'selected-fix-validated']);
  assert.match(c.comparisons.map(x => x.note).join(' '), /only the local value was tested/);

  const expired = poolingProfileCheck(reviewed.root, reviewed.expired);
  assert.equal(expired.localStatus, 'WITHHELD'); assert.deepEqual(expired.localFindings, []); assert.match(expired.blockers.join(' '), /Evidence expired/);

  for (const result of [c, expired]) {
    assert.equal(result.platformTested, false); assert.equal(result.customerEnvironmentTested, false); assert.equal(result.customerResolution, null);
    assert.equal(result.scope, PROFILE_CHECK_SCOPE);
    const text = formatProfileCheck(result);
    assert.match(text, /did not connect to PlanetScale or to a customer environment/);
    assert.ok(text.indexOf('## What the local run measured') < text.indexOf('## What PlanetScale documents'));
    assert.ok(text.indexOf('## What PlanetScale documents') < text.indexOf('## What to ask the customer'));
  }
});
