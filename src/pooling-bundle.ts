import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { POOLING_QUERIES } from './pooling-evidence.ts';
import type { PoolingRun } from './pooling-evidence.ts';
import { inspectPoolingReview, evidenceId, REMEDIES, REMEDY_TEXT } from './pooling-review.ts';
import type { Remedy } from './pooling-review.ts';
import { validatePooling } from './pooling-validation.ts';
import { poolingBundleHtml } from './pooling-bundle-view.ts';
import { sha256, json, checkMode, readSources, writeSources, writeExport, manifestFiles, checkIntegrity, checkOutputs, bundlePaths } from './bundle-core.ts';
import type { BundleLayout, Mode } from './bundle-core.ts';
import manifestSchema from '../schemas/pooling-export-manifest.v1.json' with { type: 'json' };

// Each version's rendered text is frozen so earlier bundles keep verifying. New exports use the latest version.
// Bundle3 keeps the bundle2 wording and adds print revision 1 to the report; earlier bytes are unchanged.
export const POOLING_TOOL_VERSIONS = ['0.1.0-pooling-bundle1', '0.1.0-pooling-bundle2', '0.1.0-pooling-bundle3'] as const;
export type PoolingToolVersion = typeof POOLING_TOOL_VERSIONS[number];
export const POOLING_TOOL_VERSION: PoolingToolVersion = '0.1.0-pooling-bundle3';
export const POOLING_SOURCE_PATHS = ['pooling-run.json','pooling-probes.json','pooling-plan.json','pooling-manifest.json','pooling-reviews.jsonl'];
export const POOLING_OUTPUT_PATHS = ['case-summary.md','evidence-gap-report.md','probe-plan.json','evidence.jsonl','timeline.json','reproduction.md',
  'comparison.json','hypotheses.json','findings.json','validation.json','resolution-validation.md','customer-reply.md','engineering-escalation.md',
  'runbook-candidate.md','support-bundle.html'];
export const POOLING_BUNDLE_PATHS = bundlePaths({ sourcePaths: POOLING_SOURCE_PATHS, outputPaths: POOLING_OUTPUT_PATHS } as BundleLayout);
type Binding = { expectedComparisonHash?: string; expectedReviewHead?: string };
const LAYOUT: BundleLayout = { sourcePaths: POOLING_SOURCE_PATHS, outputPaths: POOLING_OUTPUT_PATHS, sourceFolders: [],
  reviewPath: 'pooling-reviews.jsonl', writeEmptyReview: false, probePath: 'pooling-probes.json', probeCatalog: () => POOLING_QUERIES };

const VALIDATED_SENTENCE: Record<Remedy, string> = {
  'protocol-prepared': 'In that test, we validated one approach: using the driver\u2019s named prepared statements, with PgBouncer\u2019s max_prepared_statements setting enabled.',
  'transaction-contained': 'In that test, we validated one approach: preparing, running and removing the statement within a single pooled transaction.',
};
const describe = (s: { endpoint: string; backend: number; heldBackend: number|null; sqlstate: string|null; count: number|null }) =>
  `${s.endpoint} backend ${s.backend}${s.heldBackend !== null ? ` while backend ${s.heldBackend} was held` : ''}: ${s.sqlstate ? 'SQLSTATE ' + s.sqlstate : 'success, count ' + s.count}`;

function buildFiles(source: string, mode: Mode, now: Date, version: PoolingToolVersion = POOLING_TOOL_VERSION) {
  checkMode(mode);
  const inspected = inspectPoolingReview(source, now), validation = validatePooling(source, now);
  if (mode === 'reviewed' && validation.status !== 'RESOLUTION_VALIDATED') fail('Reviewed export requires fresh evidence, an accepted local cause and a selected remedy. Use --gaps-only for an incomplete report.');
  const accepted = mode === 'reviewed';
  const review = accepted ? inspected : { ...inspected, cause: null, remedySelection: null };
  const run = readJson(join(source, 'pooling-run.json')) as PoolingRun, generatedAt = now.toISOString();
  const remedy = accepted ? inspected.remedySelection!.remedy : null;
  const timeline = [{ at: run.collectedAt, label: 'Collected measured pooling run', evidenceIds: review.evidence.map(e => e.id) },
    ...review.reviews.map(r => ({ at: r.recordedAt, label: r.input.kind === 'cause' ? 'Cause review: ' + r.input.decision : 'Remedy selected: ' + r.input.remedy, evidenceIds: [], reviewHash: r.hash }))]
    .sort((a, b) => a.at.localeCompare(b.at));
  const scope = 'Local PostgreSQL and PgBouncer experiment with synthetic data. Customer environment unverified. Customer resolution pending.';
  const headline = accepted ? `The reviewer accepted this explanation for the local experiment: ${review.candidateText}` : 'The investigation remains incomplete in this gap-only export. No supported cause or validated remedy is exported.';
  const sw = review.backendSwitch, reset = review.controls.directReset, timeout = review.controls.timeout;
  const observed = `Recorded switch: ${sw.first.id} ran on backend ${sw.first.backend}; ${sw.next.id} ran on backend ${sw.next.backend} while backend ${sw.next.heldBackend} was held, and EXECUTE returned SQLSTATE ${sw.next.sqlstate}.`;
  const references = review.evidence.map(e => `- ${e.id}: ${e.phase}; query hash ${e.queryHash}`).join('\n');
  const pending = mode === 'gaps' ? ['Gap-only export requested; acceptance, remedy and validation claims are withheld.', ...validation.blockers] : validation.blockers;
  const remedyLine = remedy ? `Selected remedy: ${remedy}. ${REMEDY_TEXT[remedy]}` : 'Selected remedy: none exported.';
  const gapText = ['# Evidence gap report', '', scope, '', ...(pending.length ? pending.map(p => '- ' + p) : ['- No local evidence gaps at export.']), '',
    '## Customer evidence still required', '',
    '- Identify which endpoint (direct or pooled) handled the failing request, and the pool mode in use.',
    '- Determine whether the connector uses SQL PREPARE or protocol-level prepared statements, and whether it resets sessions.',
    '- Compare the same operation on a direct connection with the same role and database.',
    '- Collect post-change results after an approved customer change.',
    '- Obtain customer-message approval before sending a response.', ''].join('\n');
  const customer = ['# Customer reply draft', '', 'DRAFT: human communication approval pending.', '',
    accepted ? `We reproduced a prepared-statement error (SQLSTATE 26000) in a separate local test with PgBouncer in transaction mode. A statement prepared with SQL PREPARE was unavailable when the next transaction ran on a different server connection. The same workflow succeeded on a direct connection. ${version === '0.1.0-pooling-bundle1' ? `In that test we validated one approach: ${REMEDY_TEXT[remedy!].charAt(0).toLowerCase() + REMEDY_TEXT[remedy!].slice(1)}` : VALIDATED_SENTENCE[remedy!]}`
      : 'The local investigation still needs evidence or review before we can provide a supported explanation.',
    '', 'The local result does not confirm the state of your environment. The same error can also appear when a session is reset. Please confirm which endpoint handled the failing request, the pool mode, whether your driver uses SQL PREPARE or protocol-level prepared statements, and whether it resets sessions. Share sanitized settings and error output; omit connection strings, credentials and customer rows.',
    '', 'Any change in your environment needs its own approval and post-change validation.', ''].join('\n');
  const engineering = ['# Engineering handoff draft', '', 'Internal draft. Escalation need has not been established.', '', scope, '', headline, '', observed, '', remedyLine, '',
    '## Direct baseline', '', `- ${review.baseline.first.id}: ${describe(review.baseline.first)}`, `- ${review.baseline.next.id}: ${describe(review.baseline.next)}`, '',
    '## Controls', '', `- ${reset.id}: ${describe(reset)}`, `- ${timeout.id}: ${describe(timeout)}`, '',
    '## Remedy evidence', '', ...REMEDIES.flatMap(r => review.remedies[r].evidence.map(s => `- ${r}: ${s.id}: ${describe(s)}`)), '',
    '## Configuration', '', `Pool mode ${review.configuration.poolMode}; max_prepared_statements ${review.configuration.maxPreparedStatements}; PostgreSQL ${review.configuration.postgresVersion}; PgBouncer ${review.configuration.pgbouncerVersion}; cleanup ${review.configuration.cleanup}.`, '',
    '## Competing explanations', '', ...review.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    '## Evidence references', '', references, '', `Source manifest: ${review.sourceManifestHash}`, `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, `Validation: ${validation.validationHash}`, '',
    '## Remaining uncertainty', '', 'Customer endpoint, pool mode, connector behavior, business impact and the need for escalation remain unverified.', ''].join('\n');
  const validationText = ['# Resolution validation', '', `Status at export: ${accepted ? validation.status : 'WITHHELD_IN_GAP_REPORT'}`, `Scope: ${validation.scope}`, `Remedy: ${accepted ? remedy : 'withheld'}`, `Checked: ${generatedAt}`, '',
    validation.basis, '', ...validation.checks.map(c => `- ${c.passed ? 'PASS' : 'PENDING'}: ${c.id}; references ${c.evidence.join(', ') || 'none'}`), '', validation.limitation, '',
    'Customer resolution: unset. Customer-message approval: pending.', ''].join('\n');
  const hypotheses = [
    { candidate: review.candidate, classification: accepted ? 'SUPPORTED_CAUSE' : 'UNVERIFIED_HYPOTHESIS', scope: 'local-lab', evidence: [sw.first.id, sw.next.id, review.baseline.next.id] },
    ...review.alternatives.map(a => ({ candidate: a.explanation, classification: a.status, scope: a.evidence.length ? 'local-lab' : 'customer', evidence: a.evidence, limitation: a.detail })),
  ];
  const { validationHash: _ignored, ...validationBody } = validation;
  const withheld = { ...validationBody, status: 'WITHHELD_IN_GAP_REPORT' };
  const status = accepted ? `RESOLUTION_VALIDATED (local-lab, ${remedy})` : 'GAP_REPORT';
  const files: Record<string, string> = {
    'case-summary.md': ['# Case summary', '', `Exported: ${generatedAt}`, `Status at export: ${status}`, `Run: ${review.runId}`, '', scope, '', headline, '', observed, '', remedyLine, '', 'Business impact: unknown.', '', `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, '', 'Communication approval: pending.', ''].join('\n'),
    'evidence-gap-report.md': gapText,
    'probe-plan.json': json(readJson(join(source, 'pooling-plan.json'))),
    'evidence.jsonl': run.observations.map(o => json({ id: evidenceId(o.phase), observation: o })).join(''),
    'timeline.json': json({ schemaVersion: 1, runId: review.runId, events: timeline }),
    'reproduction.md': ['# Reproduce the local experiment', '', 'Requires Node.js 24, pinned dependencies, PostgreSQL 16, 17 or 18 server tools and PgBouncer 1.21 or later within major version 1. Run from the project checkout as a regular OS user.', '', '```sh', 'npm ci', 'npm run demo:pooling -- --dry-run', 'npm run demo:pooling -- --approve-lab', '```', '',
      'The command starts disposable PostgreSQL and PgBouncer processes on private Unix sockets, runs the fixed probes, retains new evidence and removes the servers. It requires explicit approval.', '', observed, '',
      'Recorded cleanup: COMPLETE. No database execution occurs during bundle export or validation.', '', 'Exact probe SQL: sources/pooling-probes.json. Each new run needs its own review decisions.', ''].join('\n'),
    'comparison.json': json(review), 'hypotheses.json': json({ schemaVersion: 1, runId: review.runId, hypotheses }),
    'findings.json': json({ schemaVersion: 1, scenario: 'pooling-session', runId: review.runId, mode, generatedAt, finding: review.cause, remedySelection: review.remedySelection,
      comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, customerResolution: null, communicationApproval: 'PENDING' }),
    'validation.json': json(accepted ? validation : { ...withheld, validationHash: hash(withheld) }),
    'resolution-validation.md': validationText, 'customer-reply.md': customer, 'engineering-escalation.md': engineering,
    'runbook-candidate.md': ['# Prepared statement unavailable through a pool: runbook candidate', '', 'DRAFT: publication and reuse review pending.', '', `Source run: ${review.runId}`, `Evidence status: ${status}`, '',
      '## Qualifying symptom', '', 'An application reports SQLSTATE 26000 (prepared statement does not exist) while connected through a pooler. Capture the exact error, statement name and time.', '',
      '## Investigation steps', '', '1. Identify which endpoint handled the failing request and the pool mode.', '2. Determine whether the connector uses SQL PREPARE or protocol-level prepared statements.', '3. Check whether the application or connector resets sessions (for example DEALLOCATE ALL or DISCARD).', '4. Compare the same operation on a direct connection with the same role and database.', '5. Reproduce in an isolated lab with a direct baseline, a reset control and a timeout control.', '6. Review the evidence before selecting a cause.', '7. Choose a remedy that matches the application workflow, approve it for its environment, then repeat the original operation.', '',
      '## Confounders', '', 'Session resets produce the same 26000 without a pool. A port number alone does not prove the connection mode. Timeouts produce a different error (57014).', '',
      '## Validation boundary', '', 'This source bundle validates only its selected remedy in the local experiment when the review and freshness gates pass. Customer resolution requires customer-scoped post-change evidence.', ''].join('\n'),
    'support-bundle.html': '',
  };
  const documents = Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.md')));
  files['support-bundle.html'] = poolingBundleHtml({ review, validation, generatedAt, mode, run, timeline, documents, copyRevision: version === '0.1.0-pooling-bundle1' ? 1 : 2,
    print: version === '0.1.0-pooling-bundle3' });
  return { files, review, validation, generatedAt, remedy };
}

export function exportPoolingBundle(source: string, output: string, options: { mode?: Mode; now?: Date; toolVersion?: PoolingToolVersion } & Binding = {}) {
  const mode = options.mode ?? 'reviewed', now = options.now ?? new Date(), toolVersion = options.toolVersion ?? POOLING_TOOL_VERSION; checkMode(mode);
  if (!POOLING_TOOL_VERSIONS.includes(toolVersion)) fail('Unsupported pooling bundle tool version.');
  const captured = readSources(LAYOUT, source), staging = mkdtempSync(join(tmpdir(), 'pslab-pool-bundle-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const built = buildFiles(staging, mode, now, toolVersion), files = { ...built.files, ...Object.fromEntries(Object.entries(captured).map(([p, s]) => ['sources/' + p, s])) };
    // Recheck the exact comparison and decision head the caller inspected, using the captured snapshot.
    if (options.expectedComparisonHash !== undefined && options.expectedComparisonHash !== built.review.comparisonHash ||
        options.expectedReviewHead !== undefined && options.expectedReviewHead !== built.review.reviewHead) fail('Investigation changed before export. Inspect it again.');
    const manifest = { schemaVersion: 1, scenario: 'pooling-session', toolVersion, profile: 'local-lab', runId: built.review.runId,
      generatedAt: built.generatedAt, mode, comparisonHash: built.review.comparisonHash, reviewHead: built.review.reviewHead,
      sourceManifestHash: built.review.sourceManifestHash, remedy: built.remedy, redactionStatus: 'recognized-patterns-checked', communicationApproval: 'PENDING',
      files: manifestFiles(LAYOUT, files) };
    validateArtifact(manifest, manifestSchema);
    const manifestHash = writeExport(LAYOUT, output, files, manifest);
    return { status: 'EXPORTED', scenario: 'pooling-session', mode, runId: built.review.runId, remedy: built.remedy, files: POOLING_BUNDLE_PATHS.length + 1,
      manifestHash, customerResolution: null, communicationApproval: 'PENDING' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function verifyPoolingBundle(dir: string, options: { expectedManifestHash?: string; now?: Date } = {}) {
  const { root, now, manifest, manifestHash } = checkIntegrity(LAYOUT, dir, manifestSchema, options);
  // Rebuild every output from the captured sources at the recorded export time.
  const captured = readSources(LAYOUT, join(root, 'sources')), staging = mkdtempSync(join(tmpdir(), 'pslab-pool-verify-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const rebuilt = buildFiles(staging, manifest.mode, new Date(manifest.generatedAt), manifest.toolVersion);
    if (rebuilt.review.runId !== manifest.runId || rebuilt.review.comparisonHash !== manifest.comparisonHash || rebuilt.review.reviewHead !== manifest.reviewHead ||
        rebuilt.review.sourceManifestHash !== manifest.sourceManifestHash || rebuilt.remedy !== manifest.remedy) fail('Manifest investigation binding mismatch.');
    checkOutputs(LAYOUT, root, rebuilt.files);
    const current = validatePooling(staging, now);
    return { integrity: 'VALID', semanticConsistency: 'VALID', anchorChecked: options.expectedManifestHash !== undefined, manifestHash,
      scenario: 'pooling-session', runId: manifest.runId, mode: manifest.mode, remedy: manifest.remedy, exportedAt: manifest.generatedAt, checkedAt: now.toISOString(),
      validationAtExport: manifest.mode === 'reviewed' ? rebuilt.validation.status : 'WITHHELD_IN_GAP_REPORT',
      currentEvidenceStatus: current.status, customerResolution: null, communicationApproval: 'PENDING',
      limitation: 'Verifies this exported snapshot. Later changes to the original run and complete unanchored rewrites are outside this check.' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
