import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectPermissionsReview, permissionsReviewTemplate, appendPermissionsReview, formatPermissionsReview, DEFAULT_PRIVILEGES_SUGGESTION } from '../src/permissions-review.ts';
import { validatePermissions } from '../src/permissions-validation.ts';
import { exportPermissionsBundle, verifyPermissionsBundle, PERMISSIONS_TOOL_VERSION } from '../src/permissions-bundle.ts';
import { verifyAnyBundle } from '../src/bundle-dispatch.ts';
import { permissionsCase, acceptPermissionsCause, selectPermissionsRemedy, TEST_REVIEWER } from './permissions-fixture.ts';

const temp = (t: any) => { const d = mkdtempSync(join(tmpdir(), 'permissions-bundle-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const reviewed = (t: any) => { const c = permissionsCase(t); acceptPermissionsCause(c.root, c.now); selectPermissionsRemedy(c.root, c.now); return c; };
const withoutPre = (html: string) => html.replace(/<pre>[\s\S]*?<\/pre>/g, '');
const VALIDATION_CLAIMS = /PASS:|Passed:|Validates granting|validates only granting|RESOLUTION_VALIDATED|SUPPORTED_CAUSE|Validation: [0-9a-f]{64}/;

test('cause review and remedy selection are separate decisions on the shared review chain', t => {
  const c = permissionsCase(t);
  const fresh = inspectPermissionsReview(c.root, c.now);
  assert.equal(fresh.status, 'READY_FOR_REVIEW'); assert.equal(fresh.reviewStatus, 'NOT_REVIEWED'); assert.equal(fresh.cause, null); assert.equal(fresh.remedySelection, null);
  assert.equal(fresh.customerResolution, null); assert.equal(fresh.communicationApproval, 'PENDING');
  // A remedy cannot be selected before a person accepts the cause.
  assert.throws(() => permissionsReviewTemplate(c.root, 'remedy', c.now), /Accept the cause/);
  const outdated = { ...permissionsReviewTemplate(c.root, 'cause', c.now), reviewer: TEST_REVIEWER, decision: 'accept', rationale: 'Synthetic test decision recorded by the automated suite.' };
  acceptPermissionsCause(c.root, c.now, 'request-changes');
  assert.throws(() => appendPermissionsReview(c.root, outdated, c.now), /outdated/);
  assert.equal(inspectPermissionsReview(c.root, c.now).reviewStatus, 'CHANGES_REQUESTED');
  acceptPermissionsCause(c.root, c.now); selectPermissionsRemedy(c.root, c.now);
  const done = inspectPermissionsReview(c.root, c.now);
  assert.equal(done.reviewStatus, 'ACCEPTED_LOCAL_LAB'); assert.equal(done.remedySelection?.remedy, 'grant-table-select');
  // A later rejection withdraws the earlier selection.
  acceptPermissionsCause(c.root, c.now, 'reject');
  const rejected = inspectPermissionsReview(c.root, c.now);
  assert.equal(rejected.reviewStatus, 'REJECTED'); assert.equal(rejected.cause, null); assert.equal(rejected.remedySelection, null);
  // Inputs must match their kind, and only the one remedy exists.
  assert.throws(() => appendPermissionsReview(c.root, { ...permissionsReviewTemplate(c.root, 'cause', c.now), reviewer: TEST_REVIEWER, decision: 'select', rationale: 'Synthetic test decision recorded by the automated suite.' }, c.now), /kind does not match/);
  assert.throws(() => appendPermissionsReview(c.root, { ...permissionsReviewTemplate(c.root, 'cause', c.now), kind: 'remedy', reviewer: TEST_REVIEWER, decision: 'select', remedy: 'grant-all', causeReviewHash: 'a'.repeat(64), rationale: 'Synthetic test decision recorded by the automated suite.' }, c.now), /enum mismatch/);
  const text = formatPermissionsReview(rejected);
  assert.match(text, /Cause review: REJECTED/); assert.match(text, /Suggestion, not validated: ALTER DEFAULT PRIVILEGES/); assert.match(text, /Customer resolution: unset\./);
});

test('expired evidence blocks acceptance and remedy selection', t => {
  const c = permissionsCase(t);
  const stale = inspectPermissionsReview(c.root, c.expired);
  assert.equal(stale.status, 'EVIDENCE_REQUIRED'); assert.match(stale.blockers[0], /Evidence expired/);
  assert.throws(() => acceptPermissionsCause(c.root, c.expired), /Evidence blockers prevent acceptance/);
});

test('validation uses only retained evidence and needs an accepted cause and the selected one-table grant', t => {
  const c = permissionsCase(t);
  const blocked = validatePermissions(c.root, c.now);
  assert.equal(blocked.status, 'VALIDATION_BLOCKED'); assert.deepEqual(blocked.blockers, ['An applicable acceptance of the local cause is required.']);
  acceptPermissionsCause(c.root, c.now);
  assert.deepEqual(validatePermissions(c.root, c.now).blockers, ['Select the remedy this validation should claim.']);
  selectPermissionsRemedy(c.root, c.now);
  const v = validatePermissions(c.root, c.now);
  assert.equal(v.status, 'RESOLUTION_VALIDATED', JSON.stringify(v.checks.filter(x => !x.passed)));
  assert.deepEqual(v.checks.map(x => x.id), ['fresh-compatible-evidence', 'explicit-cause-review', 'remedy-selected', 'verified-baseline', 'original-failure-is-missing-table-select',
    'controls-separate-role-schema-and-search-path', 'only-ordinary-select-added', 'privileges-match-grant-snapshots', 'same-query-same-role-after-fix', 'read-only-after-fix', 'grant-reached-only-the-application-role']);
  assert.deepEqual(v.verification?.added, [{ kind: 'table', object: 'app_data.project_tasks', grantee: 'pslab_app', privilege: 'SELECT', grantable: false }]);
  assert.equal(v.verification?.writePrivileges, false); assert.equal(v.customerResolution, null); assert.equal(v.communicationApproval, 'PENDING');
  assert.match(v.basis, /No database connection is made during validation/);
  // ALTER DEFAULT PRIVILEGES is never part of what is validated.
  assert.doesNotMatch(JSON.stringify(v), /DEFAULT PRIVILEGES/);
  assert.equal(validatePermissions(c.root, c.expired).status, 'VALIDATION_BLOCKED');
});

test('reviewed and gap-only bundles export, verify through the dispatcher and reject edits', t => {
  const c = reviewed(t), dir = temp(t);
  const r = exportPermissionsBundle(c.root, join(dir, 'reviewed'), { now: c.now });
  const g = exportPermissionsBundle(c.root, join(dir, 'gaps'), { mode: 'gaps', now: c.now });
  for (const [name, e, at] of [['reviewed', r, 'RESOLUTION_VALIDATED'], ['gaps', g, 'WITHHELD_IN_GAP_REPORT']] as const) {
    const v = verifyAnyBundle(join(dir, name), { expectedManifestHash: e.manifestHash, now: c.now }) as any;
    assert.equal(v.integrity, 'VALID', name); assert.equal(v.semanticConsistency, 'VALID', name); assert.equal(v.validationAtExport, at, name);
    assert.equal(v.customerResolution, null, name); assert.equal(v.communicationApproval, 'PENDING', name);
    assert.equal(JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8')).toolVersion, PERMISSIONS_TOOL_VERSION);
  }
  assert.equal(readdirSync(join(dir, 'reviewed')).length, 17);
  const path = join(dir, 'reviewed', 'customer-reply.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('DRAFT', 'APPROVED'));
  assert.throws(() => verifyPermissionsBundle(join(dir, 'reviewed'), { expectedManifestHash: r.manifestHash, now: c.now }));
  assert.throws(() => exportPermissionsBundle(permissionsCase(t).root, join(dir, 'early'), { now: c.now }), /Reviewed export requires/);
  assert.throws(() => exportPermissionsBundle(c.root, join(dir, 'moved'), { now: c.now, expectedReviewHead: 'a'.repeat(64) }), /changed before export/);
});

test('gap-only exports withhold every validation claim and result, keep blockers and present the cause as a proposal, from accepted and unreviewed runs', t => {
  const dir = temp(t);
  for (const [name, c] of [['accepted', reviewed(t)], ['unreviewed', permissionsCase(t)]] as const) {
    exportPermissionsBundle(c.root, join(dir, name), { mode: 'gaps', now: c.now });
    const read = (f: string) => readFileSync(join(dir, name, f), 'utf8'), html = read('support-bundle.html');
    for (const f of ['case-summary.md', 'evidence-gap-report.md', 'resolution-validation.md', 'customer-reply.md', 'engineering-escalation.md', 'runbook-candidate.md', 'validation.json', 'findings.json', 'hypotheses.json'])
      assert.doesNotMatch(read(f), VALIDATION_CLAIMS, `${name} ${f}`);
    assert.doesNotMatch(withoutPre(html), VALIDATION_CLAIMS, `${name} html`);
    assert.match(html, /<p>Proposed explanation, awaiting review: The application role could find app_data\.project_tasks/, name);
    assert.match(html, /No remedy is validated in this gap-only export\. The cause has not been accepted for this export, and no fix is supported by it\./, name);
    assert.match(html, /No remedy is validated in this gap-only export\. Validation checks and their results are withheld\./, name);
    assert.match(read('resolution-validation.md'), /^Status at export: WITHHELD_IN_GAP_REPORT$/m, name);
    assert.match(read('engineering-escalation.md'), /^Validation: withheld in this gap-only export$/m, name);
    assert.match(read('runbook-candidate.md'), /## Validation boundary\n\nNo remedy is validated in this gap-only export\. The recorded experiment covers granting SELECT on one table to the application role in this lab only\./, name);
    const vj = JSON.parse(read('validation.json'));
    assert.equal(vj.status, 'WITHHELD_IN_GAP_REPORT', name);
    for (const key of ['checks', 'basis', 'verification', 'remedy', 'remedySelectionHash', 'causeReviewHash']) assert.ok(!(key in vj), `${name} validation.json ${key}`);
    assert.equal(JSON.parse(read('findings.json')).finding, null, name);
    assert.equal(JSON.parse(read('hypotheses.json')).hypotheses[0].classification, 'UNVERIFIED_HYPOTHESIS', name);
    if (name === 'unreviewed') {
      // Blockers name what is still missing; they are kept, not withheld.
      assert.deepEqual(vj.blockers, ['An applicable acceptance of the local cause is required.']);
      assert.match(read('resolution-validation.md'), /Remaining blockers:\n\n- An applicable acceptance of the local cause is required\./);
      assert.match(read('evidence-gap-report.md'), /- An applicable acceptance of the local cause is required\./);
      assert.match(html, /<h3>Remaining blockers<\/h3><ul><li>An applicable acceptance of the local cause is required\.<\/li>/);
    } else assert.deepEqual(vj.blockers, []);
  }
});

test('reviewed drafts keep the validated scope, customer resolution and message approval open, and ALTER DEFAULT PRIVILEGES only as a suggestion', t => {
  const c = reviewed(t), dir = temp(t);
  exportPermissionsBundle(c.root, join(dir, 'b'), { now: c.now });
  const read = (f: string) => readFileSync(join(dir, 'b', f), 'utf8');
  assert.match(read('customer-reply.md'), /^DRAFT: human communication approval pending\./m);
  assert.match(read('customer-reply.md'), /SELECT current_user/); assert.match(read('customer-reply.md'), /avoid working around this with broader access/);
  assert.match(read('resolution-validation.md'), /^- PASS: only-ordinary-select-added;/m);
  assert.match(read('resolution-validation.md'), /Customer resolution: unset\. Customer-message approval: pending\./);
  assert.equal(JSON.parse(read('findings.json')).customerResolution, null);
  for (const f of ['engineering-escalation.md', 'runbook-candidate.md', 'support-bundle.html']) {
    const text = read(f);
    assert.ok(text.includes(DEFAULT_PRIVILEGES_SUGGESTION), f);
    for (const m of text.matchAll(/ALTER DEFAULT PRIVILEGES/g)) assert.match(text.slice(Math.max(0, m.index! - 40), m.index!), /Suggestion, not validated: $/, f);
  }
  assert.doesNotMatch(read('validation.json'), /DEFAULT PRIVILEGES/);
  assert.match(read('support-bundle.html'), /<h1>The table exists, so why can’t the app query it\?<\/h1>/);
  assert.doesNotMatch(read('support-bundle.html'), /<script/);
});

test('permissions bundle1 output is pinned, so later wording changes need a new bundle version', t => {
  const dir = temp(t), c = reviewed(t);
  const v = { toolVersion: '0.1.0-permissions-bundle1' } as const;
  const r = exportPermissionsBundle(c.root, join(dir, 'r'), { now: c.now, ...v }), g = exportPermissionsBundle(c.root, join(dir, 'g'), { mode: 'gaps', now: c.now, ...v });
  const u = permissionsCase(t), gu = exportPermissionsBundle(u.root, join(dir, 'gu'), { mode: 'gaps', now: u.now, ...v });
  assert.deepEqual([r.manifestHash, g.manifestHash, gu.manifestHash], PINNED);
});
const PINNED = ['2e4eeaaf84adaa9568b57c4ee01422f12e91a0c18a824285e4098a6dd8d03f03', '80405b59d589e1fbb26f675949a235ea481a4730b5042fce61670a070ae26fe9', 'a4f00f4a103b75ec8de9309f36c7230b0682db66951d7805023e25fca2d51b6f'];

test('permissions CLI commands follow the same usage and dry-run rules as the other labs', t => {
  const c = permissionsCase(t), cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const dry = spawnSync(process.execPath, [cli, 'permissions', 'export', c.root, join(c.root, 'out'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0); assert.deepEqual(JSON.parse(dry.stdout), { operation: 'permissions export', network: false, database: false, writes: false, wouldWrite: true, readsInput: false });
  const bad = spawnSync(process.execPath, [cli, 'permissions', 'review-template', c.root, 'other'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Usage: permissions compare/);
});
