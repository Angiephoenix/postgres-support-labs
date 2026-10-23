import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { PERMISSIONS_QUERIES, APP_ROLE } from './permissions-evidence.ts';
import type { PermissionsRun } from './permissions-evidence.ts';
import { inspectPermissionsReview, permissionsEvidenceId, stepDetail, PERMISSIONS_REMEDY_TEXT, DEFAULT_PRIVILEGES_SUGGESTION } from './permissions-review.ts';
import type { PermissionsStep } from './permissions-review.ts';
import { validatePermissions } from './permissions-validation.ts';
import { permissionsBundleHtml } from './permissions-bundle-view.ts';
import { json, checkMode, readSources, writeSources, writeExport, manifestFiles, checkIntegrity, checkOutputs, bundlePaths } from './bundle-core.ts';
import type { BundleLayout, Mode } from './bundle-core.ts';
import manifestSchema from '../schemas/permissions-export-manifest.v1.json' with { type: 'json' };

// Each version's rendered text is frozen so earlier bundles keep verifying. New wording needs a new version.
// From bundle1, a gap-only export presents the cause as a proposal and withholds every validation claim and result,
// including for a run whose cause was accepted. Blockers stay, because they name what is still missing.
// Bundle2 adds print revision 1 and the macOS result to the reproduction note; bundle1 bytes are unchanged.
export const PERMISSIONS_TOOL_VERSIONS = ['0.1.0-permissions-bundle1', '0.1.0-permissions-bundle2'] as const;
export type PermissionsToolVersion = typeof PERMISSIONS_TOOL_VERSIONS[number];
export const PERMISSIONS_TOOL_VERSION: PermissionsToolVersion = '0.1.0-permissions-bundle2';
const TESTED_PLATFORMS = 'Tested locally on Linux with PostgreSQL 16.13, in Linux CI on PostgreSQL 16, 17 and 18, and on macOS 12.7.6 with PostgreSQL 17.11.';
export const GAP_NO_REMEDY = 'No remedy is validated in this gap-only export.';
export const GAP_CHECKS_WITHHELD = `${GAP_NO_REMEDY} Validation checks and their results are withheld.`;
export const GAP_CAUSE_NOT_ACCEPTED = `${GAP_NO_REMEDY} The cause has not been accepted for this export, and no fix is supported by it.`;
export const GAP_RUNBOOK_BOUNDARY = `${GAP_NO_REMEDY} The recorded experiment covers granting SELECT on one table to the application role in this lab only. Customer resolution needs evidence from the customer’s environment after an approved change.`;
export const PERMISSIONS_SOURCE_PATHS = ['permissions-run.json','permissions-probes.json','permissions-plan.json','permissions-manifest.json','permissions-reviews.jsonl'];
export const PERMISSIONS_OUTPUT_PATHS = ['case-summary.md','evidence-gap-report.md','probe-plan.json','evidence.jsonl','timeline.json','reproduction.md',
  'comparison.json','hypotheses.json','findings.json','validation.json','resolution-validation.md','customer-reply.md','engineering-escalation.md',
  'runbook-candidate.md','support-bundle.html'];
export const PERMISSIONS_BUNDLE_PATHS = bundlePaths({ sourcePaths: PERMISSIONS_SOURCE_PATHS, outputPaths: PERMISSIONS_OUTPUT_PATHS } as BundleLayout);
type Binding = { expectedComparisonHash?: string; expectedReviewHead?: string };
const LAYOUT: BundleLayout = { sourcePaths: PERMISSIONS_SOURCE_PATHS, outputPaths: PERMISSIONS_OUTPUT_PATHS, sourceFolders: [],
  reviewPath: 'permissions-reviews.jsonl', writeEmptyReview: false, probePath: 'permissions-probes.json', probeCatalog: () => PERMISSIONS_QUERIES };

function buildFiles(source: string, mode: Mode, now: Date, version: PermissionsToolVersion = PERMISSIONS_TOOL_VERSION) {
  checkMode(mode);
  if (!PERMISSIONS_TOOL_VERSIONS.includes(version)) fail('Unsupported permissions bundle tool version.');
  const print = version !== '0.1.0-permissions-bundle1';
  const inspected = inspectPermissionsReview(source, now), validation = validatePermissions(source, now);
  if (mode === 'reviewed' && validation.status !== 'RESOLUTION_VALIDATED') fail('Reviewed export requires fresh evidence, an accepted local cause and a selected remedy. Use --gaps-only for an incomplete report.');
  const accepted = mode === 'reviewed';
  const review = accepted ? inspected : { ...inspected, cause: null, remedySelection: null };
  const run = readJson(join(source, 'permissions-run.json')) as PermissionsRun, generatedAt = now.toISOString();
  const remedy = accepted ? inspected.remedySelection!.remedy : null;
  const timeline = [{ at: run.collectedAt, label: 'Collected measured permissions run', evidenceIds: review.evidence.map(e => e.id) },
    ...review.reviews.map(r => ({ at: r.recordedAt, label: r.input.kind === 'cause' ? 'Cause review: ' + r.input.decision : 'Remedy selected: ' + r.input.remedy, evidenceIds: [], reviewHash: r.hash }))]
    .sort((a, b) => a.at.localeCompare(b.at));
  const scope = 'Local PostgreSQL experiment with synthetic roles and data. Customer environment unverified. Customer resolution pending.';
  const headline = accepted ? `The reviewer accepted this explanation for the local experiment: ${review.candidateText}` : 'The investigation remains incomplete in this gap-only export. No supported cause or validated remedy is exported.';
  const proposal = accepted ? review.candidateText : `Proposed explanation, awaiting review: ${review.candidateText}`;
  const f = review.failure, x = review.fix;
  const observed = `Recorded comparison: ${f.id}, as ${f.context.currentUser}, found the table in the catalog with USAGE on app_data and app_data in its search path, but returned SQLSTATE ${f.unqualified.sqlstate} for the table with and without the schema name. After the one grant, ${x.id}, the same role and query, succeeded.`;
  const line = (s: PermissionsStep) => `- ${s.id} (${s.label}): ${stepDetail(s)}`;
  const pending = mode === 'gaps' ? ['Gap-only export requested; acceptance, remedy and validation claims are withheld.', ...validation.blockers] : validation.blockers;
  const remedyLine = remedy ? `Selected remedy: ${remedy}. ${PERMISSIONS_REMEDY_TEXT[remedy]}` : 'Selected remedy: none exported.';
  const gapText = ['# Evidence gap report', '', scope, '', ...(pending.length ? pending.map(p => '- ' + p) : ['- No local evidence gaps at export.']), '',
    '## Customer evidence still required', '',
    '- The role the application actually connects as: current_user and session_user from the application\'s own connection.',
    '- The exact error and SQLSTATE, and the query as the application sends it, including whether it names the schema.',
    '- That role\'s privileges on the schema and the table, and the search path its sessions use.',
    '- When the table was created, compared with when access was granted to the role.',
    '- Post-change results after an approved customer change.',
    '- Customer-message approval before sending a response.', ''].join('\n');
  const customer = ['# Customer reply draft', '', 'DRAFT: human communication approval pending.', '',
    accepted ? 'We reproduced a similar error in a separate local test. The table existed and the application\'s role could find it, but the role had no SELECT on it: the table was created after access was granted on the other tables in its schema, and a grant on all tables in a schema covers only the tables that exist when it runs. Granting SELECT on that one table to the application\'s role, and nothing else, let the same query succeed.'
      : 'The local investigation still needs evidence or review before we can provide a supported explanation.',
    '', 'This local result does not confirm what is happening in your environment. The same error can come from the application connecting as a different role than expected, so please tell us which role your application connects as (the result of SELECT current_user on the application\'s own connection), the exact error and SQLSTATE, the query as the application sends it, including whether it names the schema, and when the table was created compared with when access was granted. Leave out passwords and full connection strings.',
    '', 'Please avoid working around this with broader access, such as granting ALL privileges or using a superuser or the table owner\'s role. Any change on your side needs its own approval and a check afterwards.', ''].join('\n');
  const engineering = ['# Engineering handoff draft', '', 'Internal draft. Escalation need has not been established.', '', scope, '', headline, '', observed, '', remedyLine, '',
    '## Baseline, failure and fix', '', line(review.baseline), line(f), line(x), '',
    '## Controls', '', ...review.controls.map(line), '',
    '## Grant change', '', `Statement: ${review.privilegeChange.statement}`, `Grants added: ${review.privilegeChange.added.map(g => `${g.privilege} on ${g.object} for ${g.grantee}${g.grantable ? ' with grant option' : ', without grant option'}`).join('; ') || 'none'}.`,
    `Grants removed: ${review.privilegeChange.removed.length}. Role attributes and memberships unchanged: ${review.privilegeChange.rolesUnchanged ? 'yes' : 'no'}. Default-privilege entries: ${review.privilegeChange.defaultPrivilegeEntries}.`, '',
    '## Follow-up to consider', '', DEFAULT_PRIVILEGES_SUGGESTION, '',
    '## When escalation would be worth considering', '',
    `- The application connects as the expected role, with USAGE on the schema, SELECT on the table and the schema in its search path, and is still refused.`,
    '- A grant that should apply does not appear in the table\'s privileges, or disappears after being made.',
    '- A 42501 or 42P01 on its own is not enough: in this lab both came from ordinary privilege and search path settings. Check the role, schema access, table access and search path first.', '',
    '## Configuration', '', `PostgreSQL ${review.configuration.postgresVersion}; Node ${run.versions.node}; pg ${run.versions.pg}. Synthetic roles without passwords on a private Unix socket with TCP turned off. Environment variables present (names only): ${run.environment.namesPresent.join(', ') || 'none'}; every connection setting was passed explicitly. Cleanup ${run.cleanup}.`, '',
    'Error messages are kept only as fixed categories with their SQLSTATE. Connection strings and file paths are not retained.', '',
    '## Competing explanations', '', ...review.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    '## Evidence references', '', review.evidence.map(e => `- ${e.id}: ${e.phase}; role ${e.role}; table ${e.table}`).join('\n'), '',
    `Source manifest: ${review.sourceManifestHash}`, `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, accepted ? `Validation: ${validation.validationHash}` : 'Validation: withheld in this gap-only export', '',
    '## Remaining uncertainty', '', 'The customer application\'s role, its grants and search path, the query it sends, business impact and the need for escalation remain unverified.', ''].join('\n');
  const validationText = ['# Resolution validation', '', `Status at export: ${accepted ? validation.status : 'WITHHELD_IN_GAP_REPORT'}`, `Scope: ${validation.scope}`, `Remedy: ${accepted ? remedy : 'withheld'}`, `Checked: ${generatedAt}`, '',
    ...(accepted ? [validation.basis, '', ...validation.checks.map(c => `- ${c.passed ? 'PASS' : 'PENDING'}: ${c.id}; references ${c.evidence.join(', ') || 'none'}`), '', validation.limitation, '']
      : [GAP_CHECKS_WITHHELD, '', ...(validation.blockers.length ? ['Remaining blockers:', '', ...validation.blockers.map(b => `- ${b}`), ''] : [])]),
    'Customer resolution: unset. Customer-message approval: pending.', ''].join('\n');
  const hypotheses = [
    { candidate: review.candidate, classification: accepted ? 'SUPPORTED_CAUSE' : 'UNVERIFIED_HYPOTHESIS', scope: 'local-lab', evidence: [f.id, x.id, review.baseline.id] },
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
    'probe-plan.json': json(readJson(join(source, 'permissions-plan.json'))),
    'evidence.jsonl': run.attempts.map(a => json({ id: permissionsEvidenceId(a.phase), attempt: a })).join(''),
    'timeline.json': json({ schemaVersion: 1, runId: review.runId, events: timeline }),
    'reproduction.md': ['# Reproduce the local experiment', '', 'Requires Node.js 24, pinned dependencies and PostgreSQL 16, 17 or 18 server tools. Run from the project checkout as a regular OS user. ' + (print ? TESTED_PLATFORMS : 'Tested locally on Linux with PostgreSQL 16.13, and in Linux CI on PostgreSQL 16, 17 and 18. macOS has not been tested.'), '', '```sh', 'npm ci', 'npm run demo:permissions -- --dry-run', 'npm run demo:permissions -- --approve-lab', '```', '',
      'The command starts a disposable PostgreSQL server on a private Unix socket with TCP turned off, connects as each synthetic role, grants SELECT on the one table, checks again, and removes the server. It requires explicit approval.', '', observed, '',
      'Recorded cleanup: COMPLETE. No database execution occurs during bundle export or validation.', '', 'Exact statements: sources/permissions-probes.json. Each new run needs its own review decisions.', ''].join('\n'),
    'comparison.json': json(review), 'hypotheses.json': json({ schemaVersion: 1, runId: review.runId, hypotheses }),
    'findings.json': json({ schemaVersion: 1, scenario: 'table-privilege', runId: review.runId, mode, generatedAt, finding: review.cause, remedySelection: review.remedySelection,
      comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, customerResolution: null, communicationApproval: 'PENDING' }),
    'validation.json': json(accepted ? validation : { ...withheld, validationHash: hash(withheld) }),
    'resolution-validation.md': validationText, 'customer-reply.md': customer, 'engineering-escalation.md': engineering,
    'runbook-candidate.md': ['# Table exists but the app cannot read it: runbook candidate', '', 'DRAFT: publication and reuse review pending.', '', `Source run: ${review.runId}`, `Evidence status: ${status}`, '',
      '## Qualifying symptom', '', 'An application gets SQLSTATE 42501 (permission denied) or 42P01 (relation does not exist) for a table that exists. Capture the exact error, the query as sent, and the time.', '',
      '## Investigation steps', '', '1. Run SELECT current_user, session_user on the application\'s own connection. A different role than expected gives the same errors.',
      '2. Check whether the role has USAGE on the table\'s schema, and whether the schema appears in current_schemas(false). Without USAGE, the schema drops out of the effective search path and the table looks missing.',
      '3. Run the query with the schema name. 42P01 without it but success with it points to the search path; 42501 for the schema points to USAGE; 42501 for the table points to table privileges.',
      '4. Check the role\'s privileges on the table, and whether the table was created after a grant on all tables in its schema.',
      '5. Reproduce in an isolated lab with a working baseline, then change only the one grant.', '6. Review the evidence before selecting a cause.',
      '7. Approve the narrowest grant for its environment, then repeat the original query as the same role.', '',
      '## Confounders', '', 'A different role gives the same 42501. A missing USAGE and a search path without the schema both give 42P01 without the schema name. Granting ALL, a superuser or the owner role makes the error disappear without being the right fix. Row-level security and column privileges are not covered by this lab.', '',
      '## Validation boundary', '', accepted ? `This source bundle validates only granting SELECT on app_data.project_tasks to ${APP_ROLE}, without the grant option, in the local experiment when the review and freshness gates pass. Customer resolution requires customer-scoped post-change evidence.` : GAP_RUNBOOK_BOUNDARY, '',
      '## Follow-up', '', DEFAULT_PRIVILEGES_SUGGESTION, ''].join('\n'),
    'support-bundle.html': '',
  };
  const documents = Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.md')));
  files['support-bundle.html'] = permissionsBundleHtml({ review, validation, generatedAt, mode, run, timeline, documents, proposal, print });
  return { files, review, validation, generatedAt, remedy };
}

export function exportPermissionsBundle(source: string, output: string, options: { mode?: Mode; now?: Date; toolVersion?: PermissionsToolVersion } & Binding = {}) {
  const mode = options.mode ?? 'reviewed', now = options.now ?? new Date(), toolVersion = options.toolVersion ?? PERMISSIONS_TOOL_VERSION; checkMode(mode);
  if (!PERMISSIONS_TOOL_VERSIONS.includes(toolVersion)) fail('Unsupported permissions bundle tool version.');
  const captured = readSources(LAYOUT, source), staging = mkdtempSync(join(tmpdir(), 'pslab-perm-bundle-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const built = buildFiles(staging, mode, now, toolVersion), files = { ...built.files, ...Object.fromEntries(Object.entries(captured).map(([p, s]) => ['sources/' + p, s])) };
    // Recheck the exact comparison and decision head the caller inspected, using the captured snapshot.
    if (options.expectedComparisonHash !== undefined && options.expectedComparisonHash !== built.review.comparisonHash ||
        options.expectedReviewHead !== undefined && options.expectedReviewHead !== built.review.reviewHead) fail('Investigation changed before export. Inspect it again.');
    const manifest = { schemaVersion: 1, scenario: 'table-privilege', toolVersion, profile: 'local-lab', runId: built.review.runId,
      generatedAt: built.generatedAt, mode, comparisonHash: built.review.comparisonHash, reviewHead: built.review.reviewHead,
      sourceManifestHash: built.review.sourceManifestHash, remedy: built.remedy, redactionStatus: 'recognized-patterns-checked', communicationApproval: 'PENDING',
      files: manifestFiles(LAYOUT, files) };
    validateArtifact(manifest, manifestSchema);
    const manifestHash = writeExport(LAYOUT, output, files, manifest);
    return { status: 'EXPORTED', scenario: 'table-privilege', mode, runId: built.review.runId, remedy: built.remedy, files: PERMISSIONS_BUNDLE_PATHS.length + 1,
      manifestHash, customerResolution: null, communicationApproval: 'PENDING' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function verifyPermissionsBundle(dir: string, options: { expectedManifestHash?: string; now?: Date } = {}) {
  const { root, now, manifest, manifestHash } = checkIntegrity(LAYOUT, dir, manifestSchema, options);
  // Rebuild every output from the captured sources at the recorded export time.
  const captured = readSources(LAYOUT, join(root, 'sources')), staging = mkdtempSync(join(tmpdir(), 'pslab-perm-verify-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const rebuilt = buildFiles(staging, manifest.mode, new Date(manifest.generatedAt), manifest.toolVersion);
    if (rebuilt.review.runId !== manifest.runId || rebuilt.review.comparisonHash !== manifest.comparisonHash || rebuilt.review.reviewHead !== manifest.reviewHead ||
        rebuilt.review.sourceManifestHash !== manifest.sourceManifestHash || rebuilt.remedy !== manifest.remedy) fail('Manifest investigation binding mismatch.');
    checkOutputs(LAYOUT, root, rebuilt.files);
    const current = validatePermissions(staging, now);
    return { integrity: 'VALID', semanticConsistency: 'VALID', anchorChecked: options.expectedManifestHash !== undefined, manifestHash,
      scenario: 'table-privilege', runId: manifest.runId, mode: manifest.mode, remedy: manifest.remedy, exportedAt: manifest.generatedAt, checkedAt: now.toISOString(),
      validationAtExport: manifest.mode === 'reviewed' ? rebuilt.validation.status : 'WITHHELD_IN_GAP_REPORT',
      currentEvidenceStatus: current.status, customerResolution: null, communicationApproval: 'PENDING',
      limitation: 'Verifies this exported snapshot. Later changes to the original run and complete unanchored rewrites are outside this check.' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
