import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical } from '../src/contracts.ts';
import { inspectPoolingReview } from '../src/pooling-review.ts';
import { inspectPooling } from '../src/pooling-evidence.ts';
import { exportPoolingBundle, verifyPoolingBundle, POOLING_BUNDLE_PATHS } from '../src/pooling-bundle.ts';
import { verifyAnyBundle } from '../src/bundle-dispatch.ts';
import { poolingCase, acceptCause, selectRemedy } from './pooling-case-fixture.ts';

const later = (d: Date, ms = 60000) => new Date(d.getTime() + ms);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function reviewed(t: any, remedy = 'protocol-prepared') {
  const f = poolingCase(t); acceptCause(f.root, f.now); selectRemedy(f.root, f.now, remedy);
  const out = join(f.root, 'bundle'), exported = exportPoolingBundle(f.root, out, { now: f.now });
  return { ...f, out, exported };
}
function rehash(out: string, path: string, text: string) {
  writeFileSync(join(out, path), text);
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), entry = m.files.find((x: any) => x.path === path);
  entry.sha256 = sha(text); entry.bytes = Buffer.byteLength(text);
  writeFileSync(join(out, 'manifest.json'), canonical(m) + '\n');
}

test('reviewed export contains every output from one snapshot and verifies against its anchor', t => {
  const { out, exported, now } = reviewed(t);
  assert.equal(exported.remedy, 'protocol-prepared'); assert.equal(exported.customerResolution, null); assert.equal(exported.communicationApproval, 'PENDING');
  const files = [...readdirSync(out).filter(n => n !== 'sources'), ...readdirSync(join(out, 'sources')).map(n => 'sources/' + n)].sort();
  assert.deepEqual(files, [...POOLING_BUNDLE_PATHS, 'manifest.json'].sort());
  const v = verifyAnyBundle(out, { expectedManifestHash: exported.manifestHash, now: later(now) }) as any;
  assert.equal(v.integrity, 'VALID'); assert.equal(v.semanticConsistency, 'VALID'); assert.equal(v.anchorChecked, true);
  assert.equal(v.validationAtExport, 'RESOLUTION_VALIDATED'); assert.equal(v.currentEvidenceStatus, 'RESOLUTION_VALIDATED'); assert.equal(v.remedy, 'protocol-prepared');
  const findings = JSON.parse(readFileSync(join(out, 'findings.json'), 'utf8'));
  assert.equal(findings.finding.scope, 'local-lab'); assert.equal(findings.remedySelection.remedy, 'protocol-prepared'); assert.equal(findings.customerResolution, null);
  const customer = readFileSync(join(out, 'customer-reply.md'), 'utf8');
  assert.match(customer, /DRAFT: human communication approval pending/); assert.match(customer, /does not confirm the state of your environment/);
  assert.ok(!customer.includes('automated-test-reviewer'));
  const engineering = readFileSync(join(out, 'engineering-escalation.md'), 'utf8');
  assert.match(engineering, /pooling-direct-reset/); assert.match(engineering, /REPRODUCED_BEHAVIOR/);
  assert.match(readFileSync(join(out, 'support-bundle.html'), 'utf8'), /protocol-prepared · selected/);
});

test('after expiry an unchanged bundle stays valid while current support is withdrawn', t => {
  const { out, exported, expired } = reviewed(t, 'transaction-contained');
  const v = verifyPoolingBundle(out, { expectedManifestHash: exported.manifestHash, now: later(expired) });
  assert.equal(v.integrity, 'VALID'); assert.equal(v.validationAtExport, 'RESOLUTION_VALIDATED'); assert.equal(v.currentEvidenceStatus, 'VALIDATION_BLOCKED');
  assert.equal(v.exportedAt, '2026-09-28T12:30:00.000Z');
});

test('reviewed export requires an accepted cause, a selected remedy and fresh evidence; gap export withholds claims', t => {
  const f = poolingCase(t);
  assert.throws(() => exportPoolingBundle(f.root, join(f.root, 'a'), { now: f.now }), /Reviewed export requires/);
  acceptCause(f.root, f.now);
  assert.throws(() => exportPoolingBundle(f.root, join(f.root, 'b'), { now: f.now }), /Reviewed export requires/);
  selectRemedy(f.root, f.now);
  assert.throws(() => exportPoolingBundle(f.root, join(f.root, 'c'), { now: f.expired }), /Reviewed export requires/);
  assert.deepEqual(['a','b','c'].filter(n => existsSync(join(f.root, n))), []);
  const gaps = join(f.root, 'gaps'), exported = exportPoolingBundle(f.root, gaps, { mode: 'gaps', now: f.expired });
  assert.equal(exported.remedy, null);
  const findings = JSON.parse(readFileSync(join(gaps, 'findings.json'), 'utf8')), validation = JSON.parse(readFileSync(join(gaps, 'validation.json'), 'utf8'));
  assert.equal(findings.finding, null); assert.equal(findings.remedySelection, null); assert.equal(validation.status, 'WITHHELD_IN_GAP_REPORT');
  assert.doesNotMatch(readFileSync(join(gaps, 'customer-reply.md'), 'utf8'), /validated/);
  assert.match(readFileSync(join(gaps, 'evidence-gap-report.md'), 'utf8'), /expired/);
  assert.equal(verifyPoolingBundle(gaps, { now: later(f.expired) }).validationAtExport, 'WITHHELD_IN_GAP_REPORT');
});

test('export rechecks the inspected comparison and decision head and never overwrites', t => {
  const f = poolingCase(t); acceptCause(f.root, f.now);
  const inspected = inspectPoolingReview(f.root, f.now); selectRemedy(f.root, f.now);
  assert.throws(() => exportPoolingBundle(f.root, join(f.root, 'x'), { now: f.now, expectedComparisonHash: inspected.comparisonHash, expectedReviewHead: inspected.reviewHead }), /changed before export/);
  assert.equal(existsSync(join(f.root, 'x')), false);
  mkdirSync(join(f.root, 'existing'));
  assert.throws(() => exportPoolingBundle(f.root, join(f.root, 'existing'), { now: f.now }));
  assert.deepEqual(readdirSync(join(f.root, 'existing')), []);
});

test('rehashed drafts, findings or validation, and changed manifest bindings are rejected', t => {
  for (const [path, from, to] of [['customer-reply.md', 'local test', 'production test'], ['findings.json', 'local-lab', 'customer'], ['validation.json', 'protocol-prepared', 'transaction-contained'], ['engineering-escalation.md', 'Internal draft', 'Approved']]) {
    const { out, now } = reviewed(t);
    const text = readFileSync(join(out, path), 'utf8'); assert.ok(text.includes(from));
    rehash(out, path, text.replace(from, to));
    assert.throws(() => verifyPoolingBundle(out, { now: later(now) }), /disagrees with its evidence/);
  }
  const { out, now } = reviewed(t);
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')); m.remedy = 'transaction-contained';
  writeFileSync(join(out, 'manifest.json'), canonical(m) + '\n');
  assert.throws(() => verifyPoolingBundle(out, { now: later(now) }), /binding mismatch/);
});

test('inventory, symlinks, altered sources and unsupported bundle versions are rejected', t => {
  let b = reviewed(t); writeFileSync(join(b.out, 'extra.md'), 'x');
  assert.throws(() => verifyPoolingBundle(b.out, { now: later(b.now) }), /inventory/);
  b = reviewed(t); symlinkSync(join(b.out, 'case-summary.md'), join(b.out, 'sources', 'link.md'));
  assert.throws(() => verifyPoolingBundle(b.out, { now: later(b.now) }), /Symlinks/);
  b = reviewed(t); rehash(b.out, 'sources/pooling-probes.json', '{"execute":"EXECUTE other"}\n');
  assert.throws(() => verifyPoolingBundle(b.out, { now: later(b.now) }), /probe catalog/);
  b = reviewed(t); assert.throws(() => verifyPoolingBundle(b.out, { expectedManifestHash: sha('other'), now: later(b.now) }), /trusted manifest/);
  for (const change of [{ scenario: 'other' }, { toolVersion: '0.1.0-pooling-bundle9' }]) {
    const c = reviewed(t), m = JSON.parse(readFileSync(join(c.out, 'manifest.json'), 'utf8'));
    writeFileSync(join(c.out, 'manifest.json'), canonical({ ...m, ...change }) + '\n');
    assert.throws(() => verifyAnyBundle(c.out, { now: later(c.now) }), /Unsupported bundle scenario or version/);
  }
});

test('earlier schema bundles and version-one pooling runs remain verifiable', () => {
  const schema = verifyAnyBundle('examples/schema-case/bundle', { expectedManifestHash: 'c16380e3d30d3e846218772b8bfeaf11ced3c9f9e3b1867e96af4b55295720fc' }) as any;
  assert.equal(schema.integrity, 'VALID'); assert.equal(schema.validationAtExport, 'RESOLUTION_VALIDATED');
  const pooling = inspectPooling('examples/pooling-run/run', 'dbf6cc33d93bc3aa35e6b5ea5ba917bac93a6d08adffab826fe1ad5851a455bf');
  assert.equal(pooling.integrity, 'VALID'); assert.equal(pooling.anchorChecked, true);
  const reviewedPool = verifyAnyBundle('examples/pooling-case/bundle', { expectedManifestHash: 'b5bf2ed591a54d49b55a208038d6687e6d3f354037ccb545fbec0ceadea6505c' }) as any;
  assert.equal(reviewedPool.integrity, 'VALID'); assert.equal(reviewedPool.remedy, 'protocol-prepared'); assert.equal(reviewedPool.validationAtExport, 'RESOLUTION_VALIDATED');
});
