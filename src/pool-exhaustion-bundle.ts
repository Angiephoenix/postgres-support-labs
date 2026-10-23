import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { LEAK_QUERIES, POOL_CONFIG } from './pool-exhaustion-evidence.ts';
import type { LeakRun } from './pool-exhaustion-evidence.ts';
import { inspectLeakReview, leakEvidenceId, stepDetail, endings, LEAK_REMEDY_TEXT, POOL_QUERY_SUGGESTION, CAPACITY_NOTE } from './pool-exhaustion-review.ts';
import type { LeakStep } from './pool-exhaustion-review.ts';
import { validateLeak } from './pool-exhaustion-validation.ts';
import { leakBundleHtml } from './pool-exhaustion-bundle-view.ts';
import { json, checkMode, readSources, writeSources, writeExport, manifestFiles, checkIntegrity, checkOutputs, bundlePaths } from './bundle-core.ts';
import type { BundleLayout, Mode } from './bundle-core.ts';
import manifestSchema from '../schemas/pool-exhaustion-export-manifest.v1.json' with { type: 'json' };

// Each version's rendered text is frozen so earlier bundles keep verifying. New wording needs a new version.
// A gap-only export presents the cause as a proposal and withholds every validation claim and result, including for a run
// whose cause was accepted. Blockers stay, because they name what is still missing.
// Bundle2 adds print revision 1 and the macOS result to the reproduction note; bundle1 bytes are unchanged.
export const LEAK_TOOL_VERSIONS = ['0.1.0-pool-exhaustion-bundle1', '0.1.0-pool-exhaustion-bundle2'] as const;
export type LeakToolVersion = typeof LEAK_TOOL_VERSIONS[number];
export const LEAK_TOOL_VERSION: LeakToolVersion = '0.1.0-pool-exhaustion-bundle2';
const TESTED_PLATFORMS = 'Tested locally on Linux with PostgreSQL 16.13, in Linux CI on PostgreSQL 16, 17 and 18, and on macOS 12.7.6 with PostgreSQL 17.11.';
export const GAP_NO_REMEDY = 'No remedy is validated in this gap-only export.';
export const GAP_CHECKS_WITHHELD = `${GAP_NO_REMEDY} Validation checks and their results are withheld.`;
export const GAP_CAUSE_NOT_ACCEPTED = `${GAP_NO_REMEDY} The cause has not been accepted for this export, and no fix is supported by it.`;
export const GAP_RUNBOOK_BOUNDARY = `${GAP_NO_REMEDY} The recorded experiment covers releasing the client in finally in one synthetic request handler in this lab only. Customer resolution needs evidence from the customer’s environment after an approved change.`;
export const LEAK_SOURCE_PATHS = ['pool-exhaustion-run.json','pool-exhaustion-probes.json','pool-exhaustion-plan.json','pool-exhaustion-manifest.json','pool-exhaustion-reviews.jsonl'];
export const LEAK_OUTPUT_PATHS = ['case-summary.md','evidence-gap-report.md','probe-plan.json','evidence.jsonl','timeline.json','reproduction.md',
  'comparison.json','hypotheses.json','findings.json','validation.json','resolution-validation.md','customer-reply.md','engineering-escalation.md',
  'runbook-candidate.md','support-bundle.html'];
export const LEAK_BUNDLE_PATHS = bundlePaths({ sourcePaths: LEAK_SOURCE_PATHS, outputPaths: LEAK_OUTPUT_PATHS } as BundleLayout);
type Binding = { expectedComparisonHash?: string; expectedReviewHead?: string };
const LAYOUT: BundleLayout = { sourcePaths: LEAK_SOURCE_PATHS, outputPaths: LEAK_OUTPUT_PATHS, sourceFolders: [],
  reviewPath: 'pool-exhaustion-reviews.jsonl', writeEmptyReview: false, probePath: 'pool-exhaustion-probes.json', probeCatalog: () => LEAK_QUERIES };

function buildFiles(source: string, mode: Mode, now: Date, version: LeakToolVersion = LEAK_TOOL_VERSION) {
  checkMode(mode);
  if (!LEAK_TOOL_VERSIONS.includes(version)) fail('Unsupported pool-exhaustion bundle tool version.');
  const print = version !== '0.1.0-pool-exhaustion-bundle1';
  const inspected = inspectLeakReview(source, now), validation = validateLeak(source, now);
  if (mode === 'reviewed' && validation.status !== 'RESOLUTION_VALIDATED') fail('Reviewed export requires fresh evidence, an accepted local cause and a selected remedy. Use --gaps-only for an incomplete report.');
  const accepted = mode === 'reviewed';
  const review = accepted ? inspected : { ...inspected, cause: null, remedySelection: null };
  const run = readJson(join(source, 'pool-exhaustion-run.json')) as LeakRun, generatedAt = now.toISOString();
  const remedy = accepted ? inspected.remedySelection!.remedy : null;
  const timeline = [{ at: run.collectedAt, label: 'Collected measured pool-exhaustion run', evidenceIds: review.evidence.map(e => e.id) },
    ...review.reviews.map(r => ({ at: r.recordedAt, label: r.input.kind === 'cause' ? 'Cause review: ' + r.input.decision : 'Remedy selected: ' + r.input.remedy, evidenceIds: [], reviewHash: r.hash }))]
    .sort((a, b) => a.at.localeCompare(b.at));
  const scope = 'Local PostgreSQL experiment with a synthetic in-process request handler and synthetic data. Customer environment unverified. Customer resolution pending.';
  const headline = accepted ? `The reviewer accepted this explanation for the local experiment: ${review.candidateText}` : 'The investigation remains incomplete in this gap-only export. No supported cause or validated remedy is exported.';
  const proposal = accepted ? review.candidateText : `Proposed explanation, awaiting review: ${review.candidateText}`;
  const l = review.leak, x = review.fixResult;
  const observed = `Recorded comparison: ${review.failure.id}, with the original handler, left ${l.leasesOpenAfterQuiet} checkouts open on idle server sessions after ${l.quietMs} ms with no load, and the later valid requests failed with the pool's checkout timeout, which has no SQLSTATE. ${review.fix.id}, the same request plan with only the handler's release handling changed, left ${x.leasesOpenAfterRecovery} open, and the same valid requests ${endings(x.probe, x.recovery)}.`;
  const line = (s: LeakStep) => `- ${s.id} (${s.label}): ${stepDetail(s)}`;
  const pending = mode === 'gaps' ? ['Gap-only export requested; acceptance, remedy and validation claims are withheld.', ...validation.blockers] : validation.blockers;
  const remedyLine = remedy ? `Selected remedy: ${remedy}. ${LEAK_REMEDY_TEXT[remedy]}` : 'Selected remedy: none exported.';
  const gapText = ['# Evidence gap report', '', scope, '', ...(pending.length ? pending.map(p => '- ' + p) : ['- No local evidence gaps at export.']), '',
    '## Customer evidence still required', '',
    '- The pool library and its settings: the maximum number of clients and the checkout timeout.',
    '- The exact error when requests hang, and whether it carries a SQLSTATE. A pool checkout timeout usually has none; a server refusal gives 53300.',
    '- Whether the timeouts continue after traffic drops.',
    '- pg_stat_activity for the application at those times: how many sessions, and whether they are idle, active or idle in transaction.',
    '- The code paths that check out a client, and whether each releases it when a query fails.',
    '- Post-change results after an approved customer change.',
    '- Customer-message approval before sending a response.', ''].join('\n');
  const customer = ['# Customer reply draft', '', 'DRAFT: human communication approval pending.', '',
    accepted ? 'We reproduced a similar pattern in a separate local test. A request handler returned its database connection to the pool only when its query succeeded. Each request that hit a query error kept its connection, and once those equalled the pool size, later requests waited and timed out even when traffic was low. Returning the connection in a finally block, including after an error, stopped connections building up in the same test.'
      : 'The local investigation still needs evidence or review before we can provide a supported explanation.',
    '', 'This local result does not confirm what is happening in your environment. Timeouts while waiting for a connection can also come from genuine load, slow queries or long transactions, which clear once the load ends. Please tell us your pool settings (the maximum number of connections and the checkout timeout), the exact error your application logs and whether it includes a SQLSTATE, whether the timeouts continue after traffic drops, and, if you can, what pg_stat_activity shows for your application\'s sessions at those times: how many there are, and whether they are idle, active or idle in transaction. Leave out passwords and full connection strings.',
    '', 'Please avoid treating a larger pool as the fix for this pattern. It can help with genuine load, but if connections are not being returned it only delays the timeouts. Any change on your side needs its own approval and a check afterwards.', ''].join('\n');
  const engineering = ['# Engineering handoff draft', '', 'Internal draft. Escalation need has not been established.', '', scope, '', headline, '', observed, '', remedyLine, '',
    '## Baseline, leak and fix', '', line(review.baseline), line(review.failure), line(review.fix), '',
    '## Controls', '', ...review.controls.map(line), '',
    '## Handler change', '', `Removed: ${review.handlerChange.removed.map(c => '`' + c + '`').join(' ')}`, `Added: ${review.handlerChange.added.map(c => '`' + c + '`').join(' ')}`,
    `Same request plan in both phases: ${review.samePlan ? 'yes' : 'no'}. Forced cleanup after measurement closed ${l.closedByTeardown} leaked clients and is not counted as a release.`, '',
    '## Follow-up to consider', '', POOL_QUERY_SUGGESTION, '', CAPACITY_NOTE, '',
    '## When escalation would be worth considering', '',
    '- Every code path releases its client, including after query errors, and the pool still reports clients checked out with no requests in flight.',
    '- The server refuses connections with SQLSTATE 53300 while the application\'s pools stay within the server\'s connection limits.',
    '- A checkout timeout on its own is not enough: in this lab, demand, slow queries and transactions left open produced the same error and recovered.', '',
    '## Configuration', '', `PostgreSQL ${review.configuration.postgresVersion}; Node ${run.versions.node}; pg ${run.versions.pg}; pg-pool ${run.versions.pgPool}. Pool of ${POOL_CONFIG.max} clients with an ${POOL_CONFIG.connectionTimeoutMillis} ms checkout timeout; server with ${run.server.maxConnections} connection slots, ${run.server.superuserReservedConnections} reserved for superusers. Synthetic role without a password on a private Unix socket with TCP turned off. Environment variables present (names only): ${run.environment.namesPresent.join(', ') || 'none'}; every connection setting was passed explicitly. Cleanup ${run.cleanup}.`, '',
    'Error messages are kept only as fixed categories with their SQLSTATE. Connection strings and file paths are not retained.', '',
    '## Competing explanations', '', ...review.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    '## Evidence references', '', review.evidence.map(e => `- ${e.id}: ${e.phase}; ${e.codePath}`).join('\n'), '',
    `Source manifest: ${review.sourceManifestHash}`, `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, accepted ? `Validation: ${validation.validationHash}` : 'Validation: withheld in this gap-only export', '',
    '## Remaining uncertainty', '', 'The customer application\'s pool settings, its code paths, its error rate, its server\'s connection settings, business impact and the need for escalation remain unverified.', ''].join('\n');
  const validationText = ['# Resolution validation', '', `Status at export: ${accepted ? validation.status : 'WITHHELD_IN_GAP_REPORT'}`, `Scope: ${validation.scope}`, `Remedy: ${accepted ? remedy : 'withheld'}`, `Checked: ${generatedAt}`, '',
    ...(accepted ? [validation.basis, '', ...validation.checks.map(c => `- ${c.passed ? 'PASS' : 'PENDING'}: ${c.id}; references ${c.evidence.join(', ') || 'none'}`), '', validation.limitation, '']
      : [GAP_CHECKS_WITHHELD, '', ...(validation.blockers.length ? ['Remaining blockers:', '', ...validation.blockers.map(b => `- ${b}`), ''] : [])]),
    'Customer resolution: unset. Customer-message approval: pending.', ''].join('\n');
  const hypotheses = [
    { candidate: review.candidate, classification: accepted ? 'SUPPORTED_CAUSE' : 'UNVERIFIED_HYPOTHESIS', scope: 'local-lab', evidence: [review.failure.id, review.fix.id, review.baseline.id] },
    ...review.alternatives.map(a => ({ candidate: a.explanation, classification: a.status, scope: a.evidence.length ? 'local-lab' : 'customer', evidence: a.evidence, limitation: a.detail })),
  ];
  // A gap-only validation.json keeps the status, scope and blockers, and drops the checks, their results, the verification and
  // the cause and remedy references.
  const { validationHash: _ignored, checks: _c, basis: _b, verification: _v, remedy: _r, remedySelectionHash: _s, causeReviewHash: _h, ...gapBody } = validation as typeof validation & Record<string, unknown>;
  const withheld = { ...gapBody, status: 'WITHHELD_IN_GAP_REPORT', limitation: GAP_CHECKS_WITHHELD };
  const status = accepted ? `RESOLUTION_VALIDATED (local-lab, ${remedy})` : 'GAP_REPORT';
  const files: Record<string, string> = {
    'case-summary.md': ['# Case summary', '', `Exported: ${generatedAt}`, `Status at export: ${status}`, `Run: ${review.runId}`, '', scope, '', headline, '', observed, '', remedyLine, '', 'Business impact: unknown.', '', `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, '', 'Communication approval: pending.', ''].join('\n'),
    'evidence-gap-report.md': gapText,
    'probe-plan.json': json(readJson(join(source, 'pool-exhaustion-plan.json'))),
    'evidence.jsonl': run.phases.map(p => json({ id: leakEvidenceId(p.phase), phase: p })).join(''),
    'timeline.json': json({ schemaVersion: 1, runId: review.runId, events: timeline }),
    'reproduction.md': ['# Reproduce the local experiment', '', 'Requires Node.js 24, pinned dependencies and PostgreSQL 16, 17 or 18 server tools. Run from the project checkout as a regular OS user. ' + (print ? TESTED_PLATFORMS : 'Tested locally on Linux with PostgreSQL 16.13, and in Linux CI on PostgreSQL 16, 17 and 18. macOS has not been tested.'), '', '```sh', 'npm ci', 'npm run demo:pool-exhaustion -- --dry-run', 'npm run demo:pool-exhaustion -- --approve-lab', '```', '',
      'The command starts a disposable PostgreSQL server on a private Unix socket with TCP turned off, runs the synthetic request handler against a small pg pool through each phase, replays the same requests with the fixed handler, closes every client with time limits and removes the server. It requires explicit approval.', '', observed, '',
      'Recorded cleanup: COMPLETE. No database execution occurs during bundle export or validation.', '', 'Exact statements and handler code: sources/pool-exhaustion-probes.json. Each new run needs its own review decisions.', ''].join('\n'),
    'comparison.json': json(review), 'hypotheses.json': json({ schemaVersion: 1, runId: review.runId, hypotheses }),
    'findings.json': json({ schemaVersion: 1, scenario: 'connection-leak', runId: review.runId, mode, generatedAt, finding: review.cause, remedySelection: review.remedySelection,
      comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, customerResolution: null, communicationApproval: 'PENDING' }),
    'validation.json': json(accepted ? validation : { ...withheld, validationHash: hash(withheld) }),
    'resolution-validation.md': validationText, 'customer-reply.md': customer, 'engineering-escalation.md': engineering,
    'runbook-candidate.md': ['# Requests hang waiting for a database connection: runbook candidate', '', 'DRAFT: publication and reuse review pending.', '', `Source run: ${review.runId}`, `Evidence status: ${status}`, '',
      '## Qualifying symptom', '', 'Requests wait for a database connection and fail with the pool\'s checkout timeout. For pg-pool, that error has no SQLSTATE. Capture the error, its time and the load at that time.', '',
      '## Investigation steps', '', '1. Check whether the errors carry a SQLSTATE. 53300 means the server refused a new connection; a pool checkout timeout has none.',
      '2. Check whether the timeouts continue after the load drops. Demand, slow queries and long transactions clear once they finish; clients that are never returned do not.',
      '3. At a quiet moment, compare how many clients the pool reports in use with pg_stat_activity for the application. Idle sessions while the pool reports every client in use point to clients not being returned.',
      '4. Look for sessions that are active or idle in transaction. They point to slow queries and open transactions instead.',
      '5. Review every code path that checks out a client, especially error paths, for a release that is skipped when a query fails.',
      '6. Reproduce in an isolated lab with a working baseline, then replay the same requests with only the release handling changed.',
      '7. Review the evidence before selecting a cause, then approve the narrowest code change and check the same requests again.', '',
      '## Confounders', '', 'Genuine demand, slow queries and long transactions give the same checkout timeout and recover on their own. A server refusal gives SQLSTATE 53300. A larger pool delays a leak without fixing it. PgBouncer in transaction mode, or several applications on one role, break the link between server sessions and one application\'s checkouts.', '',
      '## Validation boundary', '', accepted ? 'This source bundle validates only releasing the client in finally, passing the error, in the synthetic request handler of the local experiment when the review and freshness gates pass. Customer resolution requires customer-scoped post-change evidence.' : GAP_RUNBOOK_BOUNDARY, '',
      '## Follow-up', '', POOL_QUERY_SUGGESTION, '', CAPACITY_NOTE, ''].join('\n'),
    'support-bundle.html': '',
  };
  const documents = Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.md')));
  files['support-bundle.html'] = leakBundleHtml({ review, validation, generatedAt, mode, run, timeline, documents, proposal, print });
  return { files, review, validation, generatedAt, remedy };
}

export function exportLeakBundle(source: string, output: string, options: { mode?: Mode; now?: Date; toolVersion?: LeakToolVersion } & Binding = {}) {
  const mode = options.mode ?? 'reviewed', now = options.now ?? new Date(), toolVersion = options.toolVersion ?? LEAK_TOOL_VERSION; checkMode(mode);
  if (!LEAK_TOOL_VERSIONS.includes(toolVersion)) fail('Unsupported pool-exhaustion bundle tool version.');
  const captured = readSources(LAYOUT, source), staging = mkdtempSync(join(tmpdir(), 'pslab-pool-bundle-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const built = buildFiles(staging, mode, now, toolVersion), files = { ...built.files, ...Object.fromEntries(Object.entries(captured).map(([p, s]) => ['sources/' + p, s])) };
    // Recheck the exact comparison and decision head the caller inspected, using the captured snapshot.
    if (options.expectedComparisonHash !== undefined && options.expectedComparisonHash !== built.review.comparisonHash ||
        options.expectedReviewHead !== undefined && options.expectedReviewHead !== built.review.reviewHead) fail('Investigation changed before export. Inspect it again.');
    const manifest = { schemaVersion: 1, scenario: 'connection-leak', toolVersion, profile: 'local-lab', runId: built.review.runId,
      generatedAt: built.generatedAt, mode, comparisonHash: built.review.comparisonHash, reviewHead: built.review.reviewHead,
      sourceManifestHash: built.review.sourceManifestHash, remedy: built.remedy, redactionStatus: 'recognized-patterns-checked', communicationApproval: 'PENDING',
      files: manifestFiles(LAYOUT, files) };
    validateArtifact(manifest, manifestSchema);
    const manifestHash = writeExport(LAYOUT, output, files, manifest);
    return { status: 'EXPORTED', scenario: 'connection-leak', mode, runId: built.review.runId, remedy: built.remedy, files: LEAK_BUNDLE_PATHS.length + 1,
      manifestHash, customerResolution: null, communicationApproval: 'PENDING' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function verifyLeakBundle(dir: string, options: { expectedManifestHash?: string; now?: Date } = {}) {
  const { root, now, manifest, manifestHash } = checkIntegrity(LAYOUT, dir, manifestSchema, options);
  // Rebuild every output from the captured sources at the recorded export time.
  const captured = readSources(LAYOUT, join(root, 'sources')), staging = mkdtempSync(join(tmpdir(), 'pslab-pool-verify-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const rebuilt = buildFiles(staging, manifest.mode, new Date(manifest.generatedAt), manifest.toolVersion);
    if (rebuilt.review.runId !== manifest.runId || rebuilt.review.comparisonHash !== manifest.comparisonHash || rebuilt.review.reviewHead !== manifest.reviewHead ||
        rebuilt.review.sourceManifestHash !== manifest.sourceManifestHash || rebuilt.remedy !== manifest.remedy) fail('Manifest investigation binding mismatch.');
    checkOutputs(LAYOUT, root, rebuilt.files);
    const current = validateLeak(staging, now);
    return { integrity: 'VALID', semanticConsistency: 'VALID', anchorChecked: options.expectedManifestHash !== undefined, manifestHash,
      scenario: 'connection-leak', runId: manifest.runId, mode: manifest.mode, remedy: manifest.remedy, exportedAt: manifest.generatedAt, checkedAt: now.toISOString(),
      validationAtExport: manifest.mode === 'reviewed' ? rebuilt.validation.status : 'WITHHELD_IN_GAP_REPORT',
      currentEvidenceStatus: current.status, customerResolution: null, communicationApproval: 'PENDING',
      limitation: 'Verifies this exported snapshot. Later changes to the original run and complete unanchored rewrites are outside this check.' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
