import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical } from '../src/contracts.ts';
import { sha256 } from '../src/bundle-core.ts';
import { appendChain } from '../src/review-chain.ts';
import { leakManifest } from '../src/pool-exhaustion-evidence.ts';
import { inspectLeakReview, leakReviewTemplate, appendLeakReview, formatLeakReview, POOL_QUERY_SUGGESTION, CAPACITY_NOTE } from '../src/pool-exhaustion-review.ts';
import { validateLeak, EXPECTED_HANDLER_CHANGE } from '../src/pool-exhaustion-validation.ts';
import { exportLeakBundle, verifyLeakBundle, LEAK_TOOL_VERSION } from '../src/pool-exhaustion-bundle.ts';
import { verifyAnyBundle } from '../src/bundle-dispatch.ts';
import { leakCase, acceptLeakCause, selectLeakRemedy, TEST_REVIEWER, phaseOf, checkpointOf } from './pool-exhaustion-fixture.ts';

const temp = (t: any) => { const d = mkdtempSync(join(tmpdir(), 'leak-bundle-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const reviewed = (t: any) => { const c = leakCase(t); acceptLeakCause(c.root, c.now); selectLeakRemedy(c.root, c.now); return c; };
const withoutPre = (html: string) => html.replace(/<pre>[\s\S]*?<\/pre>/g, '');
const VALIDATION_CLAIMS = /PASS:|Passed:|Validates releasing|validates only releasing|RESOLUTION_VALIDATED|SUPPORTED_CAUSE|Validation: [0-9a-f]{64}/;
const rationale = 'Synthetic test decision recorded by the automated suite.';

test('cause review and remedy selection are separate decisions on the shared review chain, and later decisions withdraw a selection', t => {
  const c = leakCase(t);
  const fresh = inspectLeakReview(c.root, c.now);
  assert.equal(fresh.status, 'READY_FOR_REVIEW'); assert.equal(fresh.reviewStatus, 'NOT_REVIEWED'); assert.equal(fresh.cause, null); assert.equal(fresh.remedySelection, null);
  assert.equal(fresh.customerResolution, null); assert.equal(fresh.communicationApproval, 'PENDING');
  assert.deepEqual(fresh.handlerChange, EXPECTED_HANDLER_CHANGE); assert.equal(fresh.samePlan, true);
  // A remedy cannot be selected before a person accepts the cause.
  assert.throws(() => leakReviewTemplate(c.root, 'remedy', c.now), /Accept the cause/);
  const outdated = { ...leakReviewTemplate(c.root, 'cause', c.now), reviewer: TEST_REVIEWER, decision: 'accept', rationale };
  acceptLeakCause(c.root, c.now, 'request-changes');
  assert.throws(() => appendLeakReview(c.root, outdated, c.now), /outdated/);
  assert.equal(inspectLeakReview(c.root, c.now).reviewStatus, 'CHANGES_REQUESTED');
  acceptLeakCause(c.root, c.now); selectLeakRemedy(c.root, c.now);
  const done = inspectLeakReview(c.root, c.now);
  assert.equal(done.reviewStatus, 'ACCEPTED_LOCAL_LAB'); assert.equal(done.remedySelection?.remedy, 'release-in-finally');
  // A later rejection withdraws the selection, and a new acceptance needs a fresh selection.
  acceptLeakCause(c.root, c.now, 'reject');
  const rejected = inspectLeakReview(c.root, c.now);
  assert.equal(rejected.reviewStatus, 'REJECTED'); assert.equal(rejected.cause, null); assert.equal(rejected.remedySelection, null);
  assert.equal(validateLeak(c.root, c.now).status, 'VALIDATION_BLOCKED');
  acceptLeakCause(c.root, c.now);
  assert.equal(inspectLeakReview(c.root, c.now).remedySelection, null);
  assert.deepEqual(validateLeak(c.root, c.now).blockers, ['Select the remedy this validation should claim.']);
  // Inputs must match their kind, and only the one remedy exists.
  assert.throws(() => appendLeakReview(c.root, { ...leakReviewTemplate(c.root, 'cause', c.now), reviewer: TEST_REVIEWER, decision: 'select', rationale }, c.now), /kind does not match/);
  assert.throws(() => appendLeakReview(c.root, { ...leakReviewTemplate(c.root, 'remedy', c.now), reviewer: TEST_REVIEWER, remedy: 'larger-pool', rationale }, c.now), /enum mismatch/);
  const text = formatLeakReview(inspectLeakReview(c.root, c.now));
  assert.match(text, /Cause review: ACCEPTED_LOCAL_LAB/); assert.match(text, /Remedy: not selected/); assert.match(text, /Customer resolution: unset\./);
  assert.ok(text.includes(POOL_QUERY_SUGGESTION) && text.includes(CAPACITY_NOTE));
});

test('templates start with safe defaults and must be edited before they are accepted', t => {
  const c = leakCase(t);
  const cause = leakReviewTemplate(c.root, 'cause', c.now);
  assert.equal(cause.decision, 'request-changes'); assert.equal(cause.remedy, null); assert.equal(cause.causeReviewHash, null); assert.equal(cause.reviewer, ''); assert.equal(cause.rationale, '');
  assert.throws(() => appendLeakReview(c.root, cause, c.now), /format mismatch|rationale/);
  acceptLeakCause(c.root, c.now);
  const remedy = leakReviewTemplate(c.root, 'remedy', c.now);
  assert.equal(remedy.decision, 'select'); assert.equal(remedy.remedy, null); assert.equal(remedy.causeReviewHash, inspectLeakReview(c.root, c.now).cause!.reviewHash);
  // A remedy left as null is refused; the remedy must be set by hand.
  assert.throws(() => appendLeakReview(c.root, { ...remedy, reviewer: TEST_REVIEWER, rationale }, c.now), /kind does not match/);
  assert.throws(() => appendLeakReview(c.root, { ...remedy, reviewer: TEST_REVIEWER, remedy: 'release-in-finally', causeReviewHash: 'a'.repeat(64), rationale }, c.now), /current accepted cause review/);
  appendLeakReview(c.root, { ...remedy, reviewer: TEST_REVIEWER, remedy: 'release-in-finally', rationale }, c.now);
  assert.equal(inspectLeakReview(c.root, c.now).remedySelection?.remedy, 'release-in-finally');
});

test('stale evidence blocks acceptance, remedy selection, validation and a reviewed export, and the gap-only export keeps the blocker', t => {
  const c = leakCase(t), dir = temp(t);
  const stale = inspectLeakReview(c.root, c.expired);
  assert.equal(stale.status, 'EVIDENCE_REQUIRED'); assert.match(stale.blockers[0], /Evidence expired/);
  assert.throws(() => acceptLeakCause(c.root, c.expired), /Evidence blockers prevent acceptance/);
  // An acceptance made while fresh stops counting once the evidence expires.
  acceptLeakCause(c.root, c.now);
  assert.equal(inspectLeakReview(c.root, c.expired).reviewStatus, 'EVIDENCE_REQUIRED');
  assert.throws(() => leakReviewTemplate(c.root, 'remedy', c.expired), /Accept the cause/);
  selectLeakRemedy(c.root, c.now);
  const blocked = validateLeak(c.root, c.expired);
  assert.equal(blocked.status, 'VALIDATION_BLOCKED'); assert.match(blocked.blockers.join(' '), /Evidence expired/);
  assert.throws(() => exportLeakBundle(c.root, join(dir, 'r'), { now: c.expired }), /Reviewed export requires/);
  exportLeakBundle(c.root, join(dir, 'g'), { mode: 'gaps', now: c.expired });
  assert.match(JSON.parse(readFileSync(join(dir, 'g', 'validation.json'), 'utf8')).blockers.join(' '), /Evidence expired/);
});

test('contradictory or edited records are refused', t => {
  // A run whose records contradict each other is refused before any review.
  const bad = leakCase(t, r => { checkpointOf(phaseOf(r, 'fix-applied'), 'probe-started').counters = { total: 0, idle: 0, checkedOut: 0, waiting: 0 }; });
  assert.throws(() => inspectLeakReview(bad.root, bad.now), /counters at probe-started differ/);
  // Editing the retained run after a review breaks the manifest anchor that the comparison is built on.
  const c = reviewed(t), path = join(c.root, 'pool-exhaustion-run.json'), original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace('"quietMs":1001', '"quietMs":1002'));
  assert.throws(() => inspectLeakReview(c.root, c.now), /integrity mismatch/);
  // With a consistent new manifest, the comparison changes, so the earlier decisions no longer apply.
  const run = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(join(c.root, 'pool-exhaustion-manifest.json'), canonical(leakManifest(run)) + '\n');
  const outdated = inspectLeakReview(c.root, c.now);
  assert.equal(outdated.reviewStatus, 'REVIEW_OUTDATED'); assert.equal(outdated.cause, null); assert.equal(outdated.remedySelection, null);
  assert.equal(validateLeak(c.root, c.now).status, 'VALIDATION_BLOCKED');
  // Edited or truncated review history fails closed.
  const h = reviewed(t), reviews = join(h.root, 'pool-exhaustion-reviews.jsonl'), bytes = readFileSync(reviews, 'utf8');
  writeFileSync(reviews, bytes.replace('Synthetic test decision', 'Synthetic test verdict'));
  assert.throws(() => inspectLeakReview(h.root, h.now), /hash mismatch/);
  writeFileSync(reviews, bytes.slice(0, -1));
  assert.throws(() => inspectLeakReview(h.root, h.now), /truncated/);
  // A remedy record bound to a rejected cause is refused on read, even with a valid chain.
  const r = leakCase(t); acceptLeakCause(r.root, r.now, 'reject');
  const packet = inspectLeakReview(r.root, r.now), rejectHash = packet.reviewHead;
  appendChain(r.root, 'pool-exhaustion-reviews.jsonl', '.pool-exhaustion-review.lock', r.now, () => ({ runId: packet.runId, sequence: 2, previousHash: packet.reviewHead, previousAt: packet.reviews[0].recordedAt,
    input: { schemaVersion: 1, scenario: 'connection-leak', kind: 'remedy', comparisonHash: packet.comparisonHash, expectedReviewHead: packet.reviewHead, reviewer: TEST_REVIEWER, decision: 'select', remedy: 'release-in-finally', causeReviewHash: rejectHash, rationale } }));
  assert.throws(() => inspectLeakReview(r.root, r.now), /not bound to an accepted cause review/);
});

test('validation uses only retained evidence and needs fresh evidence, an accepted cause and the selected release-in-finally', t => {
  const c = leakCase(t);
  const blocked = validateLeak(c.root, c.now);
  assert.equal(blocked.status, 'VALIDATION_BLOCKED'); assert.deepEqual(blocked.blockers, ['An applicable acceptance of the local cause is required.']);
  acceptLeakCause(c.root, c.now);
  assert.deepEqual(validateLeak(c.root, c.now).blockers, ['Select the remedy this validation should claim.']);
  selectLeakRemedy(c.root, c.now);
  const v = validateLeak(c.root, c.now);
  assert.equal(v.status, 'RESOLUTION_VALIDATED', JSON.stringify(v.checks.filter(x => !x.passed)));
  assert.deepEqual(v.checks.map(x => x.id), ['fresh-compatible-evidence', 'explicit-cause-review', 'remedy-selected', 'verified-baseline', 'original-failure-is-leaked-checkouts',
    'controls-separate-demand-slow-transaction-and-refusal', 'same-request-plan-and-configuration', 'only-release-handling-changed', 'failing-clients-released-with-error',
    'no-checkouts-left-after-fix', 'capacity-limit-unchanged-by-fix', 'forced-cleanup-not-counted-as-release']);
  assert.deepEqual(v.verification?.handlerChange, EXPECTED_HANDLER_CHANGE);
  assert.equal(v.verification?.releasedWithError, 3); assert.equal(v.verification?.leasesOpenAfterRecovery, 0);
  assert.equal(v.customerResolution, null); assert.equal(v.communicationApproval, 'PENDING');
  assert.match(v.basis, /No database connection is made during validation/); assert.match(v.basis, /Clients closed by forced cleanup are never counted as released/);
  // pool.query() and a larger pool are never part of what is validated.
  assert.doesNotMatch(JSON.stringify({ ...v, limitation: '' }), /pool\.query|larger pool/);
});

test('reviewed and gap-only bundles export, verify through the dispatcher and reject tampering', t => {
  const c = reviewed(t), dir = temp(t);
  const r = exportLeakBundle(c.root, join(dir, 'reviewed'), { now: c.now });
  const g = exportLeakBundle(c.root, join(dir, 'gaps'), { mode: 'gaps', now: c.now });
  for (const [name, e, at] of [['reviewed', r, 'RESOLUTION_VALIDATED'], ['gaps', g, 'WITHHELD_IN_GAP_REPORT']] as const) {
    const v = verifyAnyBundle(join(dir, name), { expectedManifestHash: e.manifestHash, now: c.now }) as any;
    assert.equal(v.integrity, 'VALID', name); assert.equal(v.semanticConsistency, 'VALID', name); assert.equal(v.validationAtExport, at, name);
    assert.equal(v.scenario, 'connection-leak', name); assert.equal(v.customerResolution, null, name); assert.equal(v.communicationApproval, 'PENDING', name);
    assert.equal(JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8')).toolVersion, LEAK_TOOL_VERSION);
  }
  assert.equal(readdirSync(join(dir, 'reviewed')).length, 17);
  // A changed draft, a changed source with its manifest entry rehashed, an added file and a wrong anchor are all refused.
  const draft = join(dir, 'reviewed', 'customer-reply.md');
  writeFileSync(draft, readFileSync(draft, 'utf8').replace('DRAFT', 'APPROVED'));
  assert.throws(() => verifyLeakBundle(join(dir, 'reviewed'), { expectedManifestHash: r.manifestHash, now: c.now }));
  const source = join(dir, 'gaps', 'sources', 'pool-exhaustion-run.json'), manifestPath = join(dir, 'gaps', 'manifest.json');
  const edited = readFileSync(source, 'utf8').replace('"quietMs":1001', '"quietMs":1002'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(source, edited);
  for (const f of manifest.files) if (f.path === 'sources/pool-exhaustion-run.json') { f.sha256 = sha256(edited); f.bytes = Buffer.byteLength(edited); }
  writeFileSync(manifestPath, canonical(manifest) + '\n');
  assert.throws(() => verifyLeakBundle(join(dir, 'gaps'), { now: c.now }));
  const g2 = exportLeakBundle(c.root, join(dir, 'gaps2'), { mode: 'gaps', now: c.now });
  appendFileSync(join(dir, 'gaps2', 'extra.md'), 'not part of the bundle');
  assert.throws(() => verifyLeakBundle(join(dir, 'gaps2'), { expectedManifestHash: g2.manifestHash, now: c.now }));
  assert.throws(() => verifyAnyBundle(join(dir, 'gaps'), { expectedManifestHash: 'a'.repeat(64), now: c.now }));
  // A reviewed export needs a complete review, and an export rechecks the comparison the caller inspected.
  assert.throws(() => exportLeakBundle(leakCase(t).root, join(dir, 'early'), { now: c.now }), /Reviewed export requires/);
  assert.throws(() => exportLeakBundle(c.root, join(dir, 'moved'), { now: c.now, expectedReviewHead: 'a'.repeat(64) }), /changed before export/);
});

test('gap-only exports withhold every cause and validation claim, check result and remedy reference, keep blockers and present the cause as a proposal', t => {
  const dir = temp(t);
  for (const [name, c] of [['accepted', reviewed(t)], ['unreviewed', leakCase(t)]] as const) {
    exportLeakBundle(c.root, join(dir, name), { mode: 'gaps', now: c.now });
    const read = (f: string) => readFileSync(join(dir, name, f), 'utf8'), html = read('support-bundle.html');
    for (const f of ['case-summary.md', 'evidence-gap-report.md', 'resolution-validation.md', 'customer-reply.md', 'engineering-escalation.md', 'runbook-candidate.md', 'validation.json', 'findings.json', 'hypotheses.json'])
      assert.doesNotMatch(read(f), VALIDATION_CLAIMS, `${name} ${f}`);
    assert.doesNotMatch(withoutPre(html), VALIDATION_CLAIMS, `${name} html`);
    assert.doesNotMatch(withoutPre(html), /release-in-finally · selected/, `${name} html remedy`);
    assert.match(html, /<p>Proposed explanation, awaiting review: The request handler released its pool client only when its query succeeded\./, name);
    assert.match(html, /No remedy is validated in this gap-only export\. The cause has not been accepted for this export, and no fix is supported by it\./, name);
    assert.match(html, /No remedy is validated in this gap-only export\. Validation checks and their results are withheld\./, name);
    assert.match(read('resolution-validation.md'), /^Status at export: WITHHELD_IN_GAP_REPORT$/m, name);
    assert.match(read('resolution-validation.md'), /^Remedy: withheld$/m, name);
    assert.match(read('case-summary.md'), /^Selected remedy: none exported\.$/m, name);
    assert.match(read('engineering-escalation.md'), /^Validation: withheld in this gap-only export$/m, name);
    assert.match(read('runbook-candidate.md'), /## Validation boundary\n\nNo remedy is validated in this gap-only export\. The recorded experiment covers releasing the client in finally in one synthetic request handler in this lab only\./, name);
    const vj = JSON.parse(read('validation.json'));
    assert.equal(vj.status, 'WITHHELD_IN_GAP_REPORT', name);
    for (const key of ['checks', 'basis', 'verification', 'remedy', 'remedySelectionHash', 'causeReviewHash']) assert.ok(!(key in vj), `${name} validation.json ${key}`);
    const findings = JSON.parse(read('findings.json'));
    assert.equal(findings.finding, null, name); assert.equal(findings.remedySelection, null, name);
    assert.equal(JSON.parse(read('comparison.json')).remedySelection, null, name);
    assert.equal(JSON.parse(read('manifest.json')).remedy, null, name);
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

test('reviewed drafts keep the validated scope, customer resolution and message approval open, and never present a larger pool or pool.query() as validated', t => {
  const c = reviewed(t), dir = temp(t);
  exportLeakBundle(c.root, join(dir, 'b'), { now: c.now });
  const read = (f: string) => readFileSync(join(dir, 'b', f), 'utf8');
  assert.match(read('customer-reply.md'), /^DRAFT: human communication approval pending\./m);
  assert.match(read('customer-reply.md'), /Please avoid treating a larger pool as the fix for this pattern\./);
  assert.match(read('resolution-validation.md'), /^- PASS: failing-clients-released-with-error;/m);
  assert.match(read('resolution-validation.md'), /Customer resolution: unset\. Customer-message approval: pending\./);
  assert.equal(JSON.parse(read('findings.json')).customerResolution, null);
  for (const f of ['engineering-escalation.md', 'runbook-candidate.md', 'support-bundle.html']) {
    const text = read(f);
    assert.ok(text.includes(POOL_QUERY_SUGGESTION) && text.includes(CAPACITY_NOTE), f);
    // pool.query() appears only in the unvalidated suggestion and in the validation limitation that lists it as unverified.
    const limitation = 'Other code paths, other pool settings, pool.query(), a larger pool, PgBouncer, PlanetScale and the customer environment remain unverified.';
    assert.doesNotMatch(text.replaceAll(POOL_QUERY_SUGGESTION, '').replaceAll(limitation, ''), /pool\.query\(\)/, f);
  }
  // Every mention of a larger pool in the drafts is the capacity note or the customer reply's warning against it.
  for (const f of ['customer-reply.md', 'engineering-escalation.md', 'runbook-candidate.md'])
    for (const m of read(f).matchAll(/[^.]*larger pool[^.]*\./g)) assert.match(m[0], /does not fix a leak|avoid treating a larger pool as the fix|delays a leak without fixing it|but if connections are not being returned it only delays/, `${f}: ${m[0]}`);
  assert.match(read('support-bundle.html'), /<h1>Requests hang waiting for a connection\. Is it a leak\?<\/h1>/);
  assert.match(read('support-bundle.html'), /<li><strong>Passed:<\/strong> only release handling changed<\/li>/);
  assert.doesNotMatch(read('support-bundle.html'), /<script/);
});

test('pool-exhaustion bundle1 output is pinned, so later wording changes need a new bundle version', t => {
  const dir = temp(t), c = reviewed(t);
  const v = { toolVersion: '0.1.0-pool-exhaustion-bundle1' } as const;
  const r = exportLeakBundle(c.root, join(dir, 'r'), { now: c.now, ...v }), g = exportLeakBundle(c.root, join(dir, 'g'), { mode: 'gaps', now: c.now, ...v });
  const u = leakCase(t), gu = exportLeakBundle(u.root, join(dir, 'gu'), { mode: 'gaps', now: u.now, ...v });
  assert.deepEqual([r.manifestHash, g.manifestHash, gu.manifestHash], PINNED);
});
const PINNED = ['3a976fb09f48c25b9c5995641f1ff817d61b74e6ad6896164e8f4a53f39b8eaa', 'c82f2ff88f60f6ae8643bb3b452c69554f365804033ba64ff59e367ee73c3db2', '41d5d2f052646153e635de577487941f172b36372aed62207b5cd5c99fd02d7e'];

test('pool-exhaustion CLI commands follow the same usage and dry-run rules as the other labs', t => {
  const c = leakCase(t), cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const dry = spawnSync(process.execPath, [cli, 'pool-exhaustion', 'export', c.root, join(c.root, 'out'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0); assert.deepEqual(JSON.parse(dry.stdout), { operation: 'pool-exhaustion export', network: false, database: false, writes: false, wouldWrite: true, readsInput: false });
  const bad = spawnSync(process.execPath, [cli, 'pool-exhaustion', 'review-template', c.root, 'other'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Usage: pool-exhaustion compare/);
});
