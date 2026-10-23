import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { INDEX_QUERIES } from './index-evidence.ts';
import type { IndexRun } from './index-evidence.ts';
import { inspectIndexReview, indexEvidenceId, describeStep, INDEX_REMEDY_TEXT } from './index-review.ts';
import type { IndexStep } from './index-review.ts';
import { validateIndex } from './index-validation.ts';
import { indexBundleHtml } from './index-bundle-view.ts';
import { json, checkMode, readSources, writeSources, writeExport, manifestFiles, checkIntegrity, checkOutputs, bundlePaths } from './bundle-core.ts';
import type { BundleLayout, Mode } from './bundle-core.ts';
import manifestSchema from '../schemas/index-export-manifest.v1.json' with { type: 'json' };

// Each version's rendered text is frozen so earlier bundles keep verifying. New exports use the latest version.
// Bundle2 adds print revision 1 to the report; bundle1 bytes are unchanged.
export const INDEX_TOOL_VERSIONS = ['0.1.0-index-bundle1', '0.1.0-index-bundle2'] as const;
export type IndexToolVersion = typeof INDEX_TOOL_VERSIONS[number];
export const INDEX_TOOL_VERSION: IndexToolVersion = '0.1.0-index-bundle2';
export const INDEX_SOURCE_PATHS = ['index-run.json','index-probes.json','index-plan.json','index-manifest.json','index-reviews.jsonl'];
export const INDEX_OUTPUT_PATHS = ['case-summary.md','evidence-gap-report.md','probe-plan.json','evidence.jsonl','timeline.json','reproduction.md',
  'comparison.json','hypotheses.json','findings.json','validation.json','resolution-validation.md','customer-reply.md','engineering-escalation.md',
  'runbook-candidate.md','support-bundle.html'];
export const INDEX_BUNDLE_PATHS = bundlePaths({ sourcePaths: INDEX_SOURCE_PATHS, outputPaths: INDEX_OUTPUT_PATHS } as BundleLayout);
type Binding = { expectedComparisonHash?: string; expectedReviewHead?: string };
const LAYOUT: BundleLayout = { sourcePaths: INDEX_SOURCE_PATHS, outputPaths: INDEX_OUTPUT_PATHS, sourceFolders: [],
  reviewPath: 'index-reviews.jsonl', writeEmptyReview: false, probePath: 'index-probes.json', probeCatalog: () => INDEX_QUERIES };
const ms = (n: number) => n < 1 ? n.toFixed(3) : n.toFixed(1);

function buildFiles(source: string, mode: Mode, now: Date, version: IndexToolVersion = INDEX_TOOL_VERSION) {
  if (!INDEX_TOOL_VERSIONS.includes(version)) fail('Unsupported index bundle tool version.');
  checkMode(mode);
  const inspected = inspectIndexReview(source, now), validation = validateIndex(source, now);
  if (mode === 'reviewed' && validation.status !== 'RESOLUTION_VALIDATED') fail('Reviewed export requires fresh evidence, an accepted local cause and a selected remedy. Use --gaps-only for an incomplete report.');
  const accepted = mode === 'reviewed';
  const review = accepted ? inspected : { ...inspected, cause: null, remedySelection: null };
  const run = readJson(join(source, 'index-run.json')) as IndexRun, generatedAt = now.toISOString();
  const remedy = accepted ? inspected.remedySelection!.remedy : null;
  const timeline = [{ at: run.collectedAt, label: 'Collected measured index run', evidenceIds: review.evidence.map(e => e.id) },
    ...review.reviews.map(r => ({ at: r.recordedAt, label: r.input.kind === 'cause' ? 'Cause review: ' + r.input.decision : 'Remedy selected: ' + r.input.remedy, evidenceIds: [], reviewHash: r.hash }))]
    .sort((a, b) => a.at.localeCompare(b.at));
  const scope = 'Local PostgreSQL experiment with synthetic data. Customer environment unverified. Customer resolution pending.';
  const headline = accepted ? `The reviewer accepted this explanation for the local experiment: ${review.candidateText}` : 'The investigation remains incomplete in this gap-only export. No supported cause or validated remedy is exported.';
  const b = review.before.first, a = review.after.first, u = review.statisticsControl.unanalyzed, c = review.selectivityControl;
  const observed = `Recorded comparison: without the index, ${b.id} used ${b.scanNode} and read ${b.buffers.total} shared blocks to return ${b.actualRows} rows. With the index, ${a.id} used ${a.scanNode}${a.indexName ? ' on ' + a.indexName : ''} and read ${a.buffers.total}. The result was the same in both runs.`;
  const line = (s: IndexStep) => `- ${s.id} (${s.label}): ${describeStep(s)}`;
  const references = review.evidence.map(e => `- ${e.id}: ${e.phase}; query hash ${e.queryHash}`).join('\n');
  const pending = mode === 'gaps' ? ['Gap-only export requested; acceptance, remedy and validation claims are withheld.', ...validation.blockers] : validation.blockers;
  const remedyLine = remedy ? `Selected remedy: ${remedy}. ${INDEX_REMEDY_TEXT[remedy]}` : 'Selected remedy: none exported.';
  const gapText = ['# Evidence gap report', '', scope, '', ...(pending.length ? pending.map(p => '- ' + p) : ['- No local evidence gaps at export.']), '',
    '## Customer evidence still required', '',
    '- Collect EXPLAIN (ANALYZE, BUFFERS) output for the slow query in the affected environment, with literal values removed.',
    '- Find out how many rows match the values that are slow, and how many rows the table holds.',
    '- List the indexes on the filtered columns, and when the table was last analyzed.',
    '- Find out whether the slowdown happens on every run or only on some runs.',
    '- Collect post-change results after an approved customer change.',
    '- Obtain customer-message approval before sending a response.', ''].join('\n');
  const customer = ['# Customer reply draft', '', 'DRAFT: human communication approval pending.', '',
    accepted ? `We reproduced a similar pattern in a separate local test with synthetic data. A query for one customer’s orders read the whole table, ${b.buffers.total} shared blocks, to return ${b.actualRows} rows. ${u.estimatedRows !== review.statisticsControl.analyzed.estimatedRows ? 'Refreshing the table statistics changed the planner\u2019s row estimate but not the plan.' : 'Refreshing the table statistics did not change the plan.'} After we added an index on the filtered column, the same query returned the same result and read ${a.buffers.total} blocks. In that test it took ${ms(b.executionMs)} ms before the index and ${ms(a.executionMs)} ms after; timing on your system will differ.`
      : 'The local investigation still needs evidence or review before we can provide a supported explanation.',
    '', 'The local result does not confirm what is happening in your database. An index helps when the value you filter on matches a small share of rows; for common values the planner may reasonably choose a different plan. Please share EXPLAIN (ANALYZE, BUFFERS) output for the slow query, how many rows match the value you search for, the indexes on that table and when it was last analyzed. Remove literal values, customer data, connection strings and credentials before sharing.',
    '', 'Any index change in your environment needs its own approval and post-change check. Building an index on a large table takes time, and a plain CREATE INDEX blocks writes to the table while it runs.', ''].join('\n');
  const engineering = ['# Engineering handoff draft', '', 'Internal draft. Escalation need has not been established.', '', scope, '', headline, '', observed, '', remedyLine, '',
    '## Statistics control', '', line(u), line(review.statisticsControl.analyzed), '', review.configuration.statisticsSetup, '',
    '## Before and after the index', '', line(review.before.first), line(review.before.repeat), line(review.after.first), line(review.after.repeat), '',
    '## Selectivity control', '', line(c), '',
    '## Configuration', '', `PostgreSQL ${review.configuration.postgresVersion}; ${run.data.rows} synthetic rows; data fingerprint ${run.data.fingerprintBefore} before and after; max_parallel_workers_per_gather ${run.settings.max_parallel_workers_per_gather}; jit ${run.settings.jit}; random_page_cost ${run.settings.random_page_cost}; shared_buffers ${run.settings.shared_buffers}; index definition: ${run.index.definition}; cleanup ${run.cleanup}.`, '',
    'Literal values are replaced with $1 throughout the retained plans. Timing is local supporting evidence; validation compares shared buffer blocks and plans.', '',
    '## Competing explanations', '', ...review.alternatives.map(x => `- ${x.explanation} (${x.status}): ${x.detail}`), '',
    '## Evidence references', '', references, '', `Source manifest: ${review.sourceManifestHash}`, `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, `Validation: ${validation.validationHash}`, '',
    '## Remaining uncertainty', '', 'The customer query, its parameter values, data distribution, statistics, existing indexes, write load, business impact and the need for escalation remain unverified.', ''].join('\n');
  const validationText = ['# Resolution validation', '', `Status at export: ${accepted ? validation.status : 'WITHHELD_IN_GAP_REPORT'}`, `Scope: ${validation.scope}`, `Remedy: ${accepted ? remedy : 'withheld'}`, `Checked: ${generatedAt}`, '',
    validation.basis, '', ...validation.checks.map(x => `- ${x.passed ? 'PASS' : 'PENDING'}: ${x.id}; references ${x.evidence.join(', ') || 'none'}`), '',
    `Local timing, for support only: ${ms(b.executionMs)} and ${ms(review.before.repeat.executionMs)} ms without the index; ${ms(a.executionMs)} and ${ms(review.after.repeat.executionMs)} ms with it.`, '',
    validation.limitation, '', 'Customer resolution: unset. Customer-message approval: pending.', ''].join('\n');
  const hypotheses = [
    { candidate: review.candidate, classification: accepted ? 'SUPPORTED_CAUSE' : 'UNVERIFIED_HYPOTHESIS', scope: 'local-lab', evidence: [b.id, a.id, u.id] },
    ...review.alternatives.map(x => ({ candidate: x.explanation, classification: x.status, scope: x.evidence.length ? 'local-lab' : 'customer', evidence: x.evidence, limitation: x.detail })),
  ];
  const { validationHash: _ignored, ...validationBody } = validation;
  const withheld = { ...validationBody, status: 'WITHHELD_IN_GAP_REPORT' };
  const status = accepted ? `RESOLUTION_VALIDATED (local-lab, ${remedy})` : 'GAP_REPORT';
  const files: Record<string, string> = {
    'case-summary.md': ['# Case summary', '', `Exported: ${generatedAt}`, `Status at export: ${status}`, `Run: ${review.runId}`, '', scope, '', headline, '', observed, '', remedyLine, '', 'Business impact: unknown.', '', `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, '', 'Communication approval: pending.', ''].join('\n'),
    'evidence-gap-report.md': gapText,
    'probe-plan.json': json(readJson(join(source, 'index-plan.json'))),
    'evidence.jsonl': run.observations.map(o => json({ id: indexEvidenceId(o.phase), observation: o })).join(''),
    'timeline.json': json({ schemaVersion: 1, runId: review.runId, events: timeline }),
    'reproduction.md': ['# Reproduce the local experiment', '', 'Requires Node.js 24, pinned dependencies and PostgreSQL 16, 17 or 18 server tools. Run from the project checkout as a regular OS user.', '', '```sh', 'npm ci', 'npm run demo:index -- --dry-run', 'npm run demo:index -- --approve-lab', '```', '',
      'The command starts a disposable PostgreSQL server on a private Unix socket, loads synthetic data, runs the fixed probes, retains new evidence and removes the server. It requires explicit approval.', '', observed, '',
      'Recorded cleanup: COMPLETE. No database execution occurs during bundle export or validation.', '', 'Exact probe SQL: sources/index-probes.json. Each new run needs its own review decisions.', ''].join('\n'),
    'comparison.json': json(review), 'hypotheses.json': json({ schemaVersion: 1, runId: review.runId, hypotheses }),
    'findings.json': json({ schemaVersion: 1, scenario: 'slow-query-index', runId: review.runId, mode, generatedAt, finding: review.cause, remedySelection: review.remedySelection,
      comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, customerResolution: null, communicationApproval: 'PENDING' }),
    'validation.json': json(accepted ? validation : { ...withheld, validationHash: hash(withheld) }),
    'resolution-validation.md': validationText, 'customer-reply.md': customer, 'engineering-escalation.md': engineering,
    'runbook-candidate.md': ['# Slow query on a selective filter: runbook candidate', '', 'DRAFT: publication and reuse review pending.', '', `Source run: ${review.runId}`, `Evidence status: ${status}`, '',
      '## Qualifying symptom', '', 'A query that filters on one column is slower than expected, and the plan shows a sequential scan that removes most rows by filter. Capture the query shape, the values that are slow and the time.', '',
      '## Investigation steps', '', '1. Collect EXPLAIN (ANALYZE, BUFFERS) for the slow query, with literal values removed.', '2. Compare estimated and actual rows. Check when the table was last analyzed.', '3. Find how many rows match the slow values. An index helps selective values; for common values a sequential or bitmap scan can be the right plan.', '4. List existing indexes on the filtered columns.', '5. Run the query twice and compare blocks found in shared buffers with blocks read into them. Reads may come from the operating system\u2019s cache, so treat this as a check, not proof of disk activity or a cold cache.', '6. Reproduce in an isolated lab with the same query, role and planner settings before and after the change.', '7. Review the evidence before selecting a cause.', '8. Approve the index for its environment, build it with care for write locks, then repeat the original query and compare the plan, result and buffers.', '',
      '## Confounders', '', 'Missing or outdated statistics, low selectivity, cache state, parallel workers, JIT and planner settings can all change a plan. A sequential scan is not always the wrong plan.', '',
      '## Validation boundary', '', 'This source bundle validates only its selected index for this query in the local experiment when the review and freshness gates pass. Customer resolution requires customer-scoped post-change evidence.', ''].join('\n'),
    'support-bundle.html': '',
  };
  const documents = Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.md')));
  files['support-bundle.html'] = indexBundleHtml({ review, validation, generatedAt, mode, run, timeline, documents, print: version !== '0.1.0-index-bundle1' });
  return { files, review, validation, generatedAt, remedy };
}

export function exportIndexBundle(source: string, output: string, options: { mode?: Mode; now?: Date; toolVersion?: IndexToolVersion } & Binding = {}) {
  const mode = options.mode ?? 'reviewed', now = options.now ?? new Date(), toolVersion = options.toolVersion ?? INDEX_TOOL_VERSION; checkMode(mode);
  if (!INDEX_TOOL_VERSIONS.includes(toolVersion)) fail('Unsupported index bundle tool version.');
  const captured = readSources(LAYOUT, source), staging = mkdtempSync(join(tmpdir(), 'pslab-index-bundle-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const built = buildFiles(staging, mode, now, toolVersion), files = { ...built.files, ...Object.fromEntries(Object.entries(captured).map(([p, s]) => ['sources/' + p, s])) };
    // Recheck the exact comparison and decision head the caller inspected, using the captured snapshot.
    if (options.expectedComparisonHash !== undefined && options.expectedComparisonHash !== built.review.comparisonHash ||
        options.expectedReviewHead !== undefined && options.expectedReviewHead !== built.review.reviewHead) fail('Investigation changed before export. Inspect it again.');
    const manifest = { schemaVersion: 1, scenario: 'slow-query-index', toolVersion, profile: 'local-lab', runId: built.review.runId,
      generatedAt: built.generatedAt, mode, comparisonHash: built.review.comparisonHash, reviewHead: built.review.reviewHead,
      sourceManifestHash: built.review.sourceManifestHash, remedy: built.remedy, redactionStatus: 'recognized-patterns-checked', communicationApproval: 'PENDING',
      files: manifestFiles(LAYOUT, files) };
    validateArtifact(manifest, manifestSchema);
    const manifestHash = writeExport(LAYOUT, output, files, manifest);
    return { status: 'EXPORTED', scenario: 'slow-query-index', mode, runId: built.review.runId, remedy: built.remedy, files: INDEX_BUNDLE_PATHS.length + 1,
      manifestHash, customerResolution: null, communicationApproval: 'PENDING' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function verifyIndexBundle(dir: string, options: { expectedManifestHash?: string; now?: Date } = {}) {
  const { root, now, manifest, manifestHash } = checkIntegrity(LAYOUT, dir, manifestSchema, options);
  // Rebuild every output from the captured sources at the recorded export time.
  const captured = readSources(LAYOUT, join(root, 'sources')), staging = mkdtempSync(join(tmpdir(), 'pslab-index-verify-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const rebuilt = buildFiles(staging, manifest.mode, new Date(manifest.generatedAt), manifest.toolVersion);
    if (rebuilt.review.runId !== manifest.runId || rebuilt.review.comparisonHash !== manifest.comparisonHash || rebuilt.review.reviewHead !== manifest.reviewHead ||
        rebuilt.review.sourceManifestHash !== manifest.sourceManifestHash || rebuilt.remedy !== manifest.remedy) fail('Manifest investigation binding mismatch.');
    checkOutputs(LAYOUT, root, rebuilt.files);
    const current = validateIndex(staging, now);
    return { integrity: 'VALID', semanticConsistency: 'VALID', anchorChecked: options.expectedManifestHash !== undefined, manifestHash,
      scenario: 'slow-query-index', runId: manifest.runId, mode: manifest.mode, remedy: manifest.remedy, exportedAt: manifest.generatedAt, checkedAt: now.toISOString(),
      validationAtExport: manifest.mode === 'reviewed' ? rebuilt.validation.status : 'WITHHELD_IN_GAP_REPORT',
      currentEvidenceStatus: current.status, customerResolution: null, communicationApproval: 'PENDING',
      limitation: 'Verifies this exported snapshot. Later changes to the original run and complete unanchored rewrites are outside this check.' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
