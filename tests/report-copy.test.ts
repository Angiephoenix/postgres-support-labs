import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeProtocolFixture } from './native-protocol-fixture.ts';
import { appendLabReview, reviewTemplate } from '../src/lab-review.ts';
import { exportBundle, verifyBundle, restyleBundle, BUNDLE_PATHS } from '../src/support-bundle.ts';
import { exportPoolingBundle } from '../src/pooling-bundle.ts';
import { verifyAnyBundle } from '../src/bundle-dispatch.ts';
import { poolingCase, acceptCause, selectRemedy } from './pooling-case-fixture.ts';

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
const SCHEMA_HEADING = 'Why can’t the app find the table?';
const POOLING_HEADING = 'Why can’t the next transaction find the prepared statement?';

function schemaBundle(t: any, accepted: boolean) {
  const f = nativeProtocolFixture(t);
  if (accepted) appendLabReview(f.root, { ...reviewTemplate(f.root, f.now), reviewer: 'test-reviewer', decision: 'accept', rationale: 'Synthetic test acceptance of the local finding.' }, f.now);
  const output = join(f.root, 'bundle');
  exportBundle(f.root, output, { mode: accepted ? 'reviewed' : 'gaps', now: f.now });
  return { ...f, output };
}

test('new schema exports (bundle5) keep the version 4 headings and the plain-language customer reply', t => {
  const { output, now } = schemaBundle(t, true), html = read(output, 'support-bundle.html'), reply = read(output, 'customer-reply.md');
  assert.equal(JSON.parse(read(output, 'manifest.json')).toolVersion, '0.1.0-bundle5');
  assert.ok(html.includes(SCHEMA_HEADING)); assert.ok(!html.includes('Two different explanations'));
  assert.match(html, /Applying it made the query work\./); assert.match(html, /we needed more than the error message/);
  assert.match(reply, /In that test, the migration hadn’t been applied/);
  assert.match(reply, /Once we’ve checked those details, we can discuss whether a change is needed\./);
  assert.match(reply, /DRAFT: human communication approval pending/);
  assert.equal(verifyBundle(output, { now: new Date(now.getTime() + 1000) }).integrity, 'VALID');
});

test('gap-only schema exports use neutral heading text and a neutral customer reply', t => {
  const { output } = schemaBundle(t, false), html = read(output, 'support-bundle.html'), reply = read(output, 'customer-reply.md');
  assert.ok(html.includes(SCHEMA_HEADING)); assert.match(html, /isn’t complete yet/);
  assert.doesNotMatch(html, /Applying it made the query work/);
  assert.match(reply, /We’re still looking into/); assert.doesNotMatch(reply, /That shows one way/); assert.doesNotMatch(reply, /we applied the migration/);
});

test('restyling the committed schema example keeps its evidence, text and export time and does not renew freshness', t => {
  const dir = mkdtempSync(join(tmpdir(), 'restyle-example-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = 'examples/schema-case/bundle', anchor = 'c16380e3d30d3e846218772b8bfeaf11ced3c9f9e3b1867e96af4b55295720fc', output = join(dir, 'restyled');
  const result = restyleBundle(source, output, { expectedManifestHash: anchor });
  assert.equal(result.sourceAnchorChecked, true); assert.equal(result.currentEvidenceStatus, 'VALIDATION_BLOCKED');
  for (const path of BUNDLE_PATHS.filter(p => p !== 'support-bundle.html')) assert.equal(read(output, path), read(source, path));
  const manifest = JSON.parse(read(output, 'manifest.json'));
  assert.equal(manifest.toolVersion, '0.1.0-bundle5'); assert.equal(manifest.generatedAt, JSON.parse(read(source, 'manifest.json')).generatedAt);
  assert.equal(manifest.restyledFrom.manifestHash, anchor);
  assert.ok(read(output, 'support-bundle.html').includes(SCHEMA_HEADING));
  const verified = verifyAnyBundle(output, { expectedManifestHash: result.manifestHash }) as any;
  assert.equal(verified.integrity, 'VALID'); assert.equal(verified.validationAtExport, 'RESOLUTION_VALIDATED'); assert.equal(verified.currentEvidenceStatus, 'VALIDATION_BLOCKED');
  assert.equal(verifyAnyBundle(source, { expectedManifestHash: anchor }).integrity, 'VALID');
});

test('new pooling exports (bundle3) keep the version 2 headings and the remedy-specific validated sentence', t => {
  for (const [remedy, sentence] of [['protocol-prepared', 'using the driver’s named prepared statements, with PgBouncer’s max_prepared_statements setting enabled.'],
    ['transaction-contained', 'preparing, running and removing the statement within a single pooled transaction.']]) {
    const f = poolingCase(t); acceptCause(f.root, f.now); selectRemedy(f.root, f.now, remedy);
    const out = join(f.root, 'bundle'); exportPoolingBundle(f.root, out, { now: f.now });
    assert.equal(JSON.parse(read(out, 'manifest.json')).toolVersion, '0.1.0-pooling-bundle3');
    const reply = read(out, 'customer-reply.md'), html = read(out, 'support-bundle.html');
    assert.ok(reply.includes('In that test, we validated one approach: ' + sentence));
    assert.match(reply, /does not confirm the state of your environment/); assert.match(reply, /DRAFT: human communication approval pending/);
    assert.ok(html.includes(POOLING_HEADING)); assert.match(html, /a different PostgreSQL server connection/); assert.ok(!html.includes('Different backend'));
    assert.equal((verifyAnyBundle(out, { now: new Date(f.now.getTime() + 1000) }) as any).integrity, 'VALID');
  }
  const g = poolingCase(t), gaps = join(g.root, 'gaps'); exportPoolingBundle(g.root, gaps, { mode: 'gaps', now: g.now });
  const html = read(gaps, 'support-bundle.html');
  assert.ok(html.includes(POOLING_HEADING)); assert.match(html, /isn’t complete yet/); assert.doesNotMatch(html, /the statement prepared earlier wasn’t there/);
});

test('earlier pooling bundle versions keep their original wording', () => {
  const html = read('examples/pooling-case/bundle', 'support-bundle.html');
  assert.ok(html.includes('Same connection.<br>Different backend.'));
  assert.equal((verifyAnyBundle('examples/pooling-case/bundle', { expectedManifestHash: 'b5bf2ed591a54d49b55a208038d6687e6d3f354037ccb545fbec0ceadea6505c' }) as any).integrity, 'VALID');
});

test('the committed restyled schema copy verifies against its recorded hash', () => {
  const v = verifyAnyBundle('examples/schema-case/bundle-restyled', { expectedManifestHash: 'a88c90245332cf5c7c1cfc9fd9f9211d43e4f90898a5ddfa7ab043cbbc9dde14' }) as any;
  assert.equal(v.integrity, 'VALID'); assert.equal(v.exportedAt, '2026-09-29T16:14:26.822Z');
  assert.equal(v.restyledFrom.manifestHash, 'c16380e3d30d3e846218772b8bfeaf11ced3c9f9e3b1867e96af4b55295720fc');
  assert.equal(v.validationAtExport, 'RESOLUTION_VALIDATED'); assert.equal(v.currentEvidenceStatus, 'VALIDATION_BLOCKED');
});

// Restyling must carry each bundle's draft wording forward unchanged.
function payloadMatches(source: string, output: string) {
  for (const path of BUNDLE_PATHS.filter(p => p !== 'support-bundle.html')) assert.equal(read(output, path), read(source, path), path);
}
test('restyling fresh version 4 exports keeps their drafts, export time and review history, including a second restyle', t => {
  for (const accepted of [true, false]) {
    const { output, now } = schemaBundle(t, accepted), first = join(output, '..', 'restyle-1'), second = join(output, '..', 'restyle-2');
    const sourceHash = JSON.parse(JSON.stringify(verifyBundle(output, { now }))).manifestHash;
    const later = new Date(now.getTime() + 60000), latest = new Date(now.getTime() + 120000);
    const r1 = restyleBundle(output, first, { expectedManifestHash: sourceHash, now: later });
    payloadMatches(output, first);
    const m1 = JSON.parse(read(first, 'manifest.json'));
    assert.equal(m1.draftRevision, 2); assert.equal(m1.generatedAt, now.toISOString()); assert.equal(m1.restyledFrom.manifestHash, sourceHash);
    assert.match(read(first, 'customer-reply.md'), accepted ? /In that test, the migration hadn’t been applied/ : /We’re still looking into/);
    const r2 = restyleBundle(first, second, { expectedManifestHash: r1.manifestHash, now: latest });
    payloadMatches(output, second);
    const m2 = JSON.parse(read(second, 'manifest.json'));
    assert.equal(m2.draftRevision, 2); assert.equal(m2.generatedAt, now.toISOString()); assert.equal(m2.restyledFrom.manifestHash, r1.manifestHash);
    for (const [dir, hash] of [[first, r1.manifestHash], [second, r2.manifestHash]]) {
      const v = verifyBundle(dir, { expectedManifestHash: hash, now: latest });
      assert.equal(v.integrity, 'VALID'); assert.equal(v.exportedAt, now.toISOString());
      assert.equal(v.validationAtExport, accepted ? 'RESOLUTION_VALIDATED' : 'WITHHELD_IN_GAP_REPORT');
      assert.equal(v.currentEvidenceStatus, verifyBundle(output, { now: latest }).currentEvidenceStatus);
    }
  }
});

test('older bundles restyled to version 4 keep the original reply wording and record revision 1', t => {
  const dir = mkdtempSync(join(tmpdir(), 'restyle-old-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'restyled');
  restyleBundle('examples/schema-case/bundle', out, { expectedManifestHash: 'c16380e3d30d3e846218772b8bfeaf11ced3c9f9e3b1867e96af4b55295720fc' });
  assert.equal(JSON.parse(read(out, 'manifest.json')).draftRevision, 1);
  assert.match(read(out, 'customer-reply.md'), /We reproduced the reported missing-relation error/);
});

test('a version 4 manifest with a missing or inconsistent draft revision is rejected', t => {
  const { output, now } = schemaBundle(t, true), path = join(output, 'manifest.json'), original = read(output, 'manifest.json');
  for (const change of [(m: any) => { delete m.draftRevision; }, (m: any) => { m.draftRevision = 1; }, (m: any) => { m.draftRevision = 3; }]) {
    const m = JSON.parse(original); change(m); writeFileSync(path, JSON.stringify(m));
    assert.throws(() => verifyBundle(output, { now }));
  }
});
