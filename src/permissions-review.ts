import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { readChain, appendChain } from './review-chain.ts';
import { inspectPermissions, snapshotMismatches, PERMISSIONS_PHASES, PERMISSIONS_QUERIES, PHASE_LABELS, APP_ROLE, resultText } from './permissions-evidence.ts';
import type { Attempt, PermissionsPhase } from './permissions-evidence.ts';
import { permissionsPlan } from './permissions-lab.ts';
import reviewSchema from '../schemas/permissions-review-input.v1.json' with { type: 'json' };

export const PERMISSIONS_REMEDIES = ['grant-table-select'] as const;
export type PermissionsRemedy = typeof PERMISSIONS_REMEDIES[number];
export type PermissionsReviewInput = { schemaVersion: 1; scenario: 'table-privilege'; kind: 'cause'|'remedy'; comparisonHash: string;
  expectedReviewHead: string; reviewer: string; decision: 'accept'|'reject'|'request-changes'|'select'; remedy: PermissionsRemedy|null;
  causeReviewHash: string|null; rationale: string };
export const PERMISSIONS_CANDIDATE_TEXT = 'The application role could find app_data.project_tasks but had no SELECT on it. It had USAGE on app_data and the schema was in its search path. The table was created after SELECT was granted on all tables in the schema, and a grant on all tables covers only the tables that exist when it runs.';
export const PERMISSIONS_REMEDY_TEXT: Record<PermissionsRemedy, string> = {
  'grant-table-select': 'Grant SELECT on app_data.project_tasks to the application role, without the grant option. No other privilege, role attribute or role membership changes.' };
// A follow-up for tables created later. It is not tested by this lab and is never a validated remedy.
export const DEFAULT_PRIVILEGES_SUGGESTION = 'Suggestion, not validated: ALTER DEFAULT PRIVILEGES, run as the role that creates the tables, could give tables created later in app_data the same SELECT for the application role. This lab does not test it.';
const FILE = 'permissions-reviews.jsonl', LOCK = '.permissions-review.lock';
export const permissionsEvidenceId = (phase: PermissionsPhase) => 'attempt-' + phase;

function directory(dir: string) {
  const root = resolve(dir), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular permissions run directory.');
  return root;
}
function checkInput(value: unknown) {
  validateArtifact(value, reviewSchema);
  const v = value as PermissionsReviewInput;
  const mismatch = v.kind === 'cause' ? v.decision === 'select' || v.remedy !== null || v.causeReviewHash !== null
    : v.decision !== 'select' || v.remedy === null || v.causeReviewHash === null;
  if (mismatch) fail('Review input kind does not match its decision fields.');
}

export function permissionsStep(a: Attempt) {
  return { id: permissionsEvidenceId(a.phase), label: PHASE_LABELS[a.phase], role: a.role, table: a.table, context: a.context, catalog: a.catalog,
    privileges: a.privileges, unqualified: a.unqualified, qualified: a.qualified, collectedAt: a.collectedAt };
}
export type PermissionsStep = ReturnType<typeof permissionsStep>;
export const stepOutcome = (s: PermissionsStep) => `without the schema name ${resultText(s.unqualified)}; with it ${resultText(s.qualified)}`;
const yesNo = (v: boolean|null) => v === null ? 'n/a' : v ? 'yes' : 'no';
export const stepDetail = (s: PermissionsStep) => `role ${s.context.currentUser}; ${stepOutcome(s)}; schema USAGE ${yesNo(s.privileges.schemaUsage)}; table SELECT ${yesNo(s.privileges.select)}; ` +
  `INSERT, UPDATE, DELETE or TRUNCATE ${[s.privileges.insert, s.privileges.update, s.privileges.delete, s.privileges.truncate].some(Boolean) ? 'yes' : 'no'}; search path ${s.context.searchPath.join(', ') || 'none'}; table in catalog ${yesNo(s.catalog.exists)}, visible ${yesNo(s.catalog.visible)}`;

export function permissionsComparison(dir: string, now = new Date()) {
  const root = directory(dir), inspected = inspectPermissions(root, undefined, now), run = inspected.run;
  if (canonical(readJson(join(root, 'permissions-plan.json'))) !== canonical({ ...permissionsPlan(), runId: run.runId, approved: true })) fail('The retained permissions plan is missing or inconsistent.');
  const by = Object.fromEntries(run.attempts.map(a => [a.phase, a])) as Record<PermissionsPhase, Attempt>;
  const step = (p: PermissionsPhase) => permissionsStep(by[p]);
  const blockers = inspected.evidenceStatus === 'STALE' ? [`Evidence expired at ${run.expiresAt}. Run the lab again for current evidence.`] : [];
  const res = (p: PermissionsPhase, which: 'unqualified'|'qualified') => resultText(by[p][which]);
  const material = { schemaVersion: 1, scenario: 'table-privilege', runId: run.runId, profile: 'local-lab',
    sourceManifestHash: inspected.manifestHash, catalogHash: hash(PERMISSIONS_QUERIES), collectedAt: run.collectedAt, expiresAt: run.expiresAt,
    candidate: 'table-created-after-schema-wide-grant', candidateText: PERMISSIONS_CANDIDATE_TEXT,
    configuration: { postgresVersion: run.postgresVersion, versions: run.versions, environment: run.environment, cleanup: run.cleanup },
    baseline: step('baseline-existing-table'), failure: step('table-select-missing'), fix: step('fix-applied'),
    controls: (['wrong-role', 'schema-usage-missing', 'search-path-missing', 'wrong-role-after-fix'] as const).map(step),
    // The grant change and its consistency with each phase, recomputed from the retained snapshots.
    privilegeChange: { statement: run.privilegeChange.statement, ...inspected.changes, rolesUnchanged: canonical(run.privilegeChange.rolesBefore) === canonical(run.privilegeChange.rolesAfter),
      defaultPrivilegeEntries: run.privilegeChange.defaultPrivilegeEntries, snapshotMismatches: snapshotMismatches(run) },
    remedies: { 'grant-table-select': { description: PERMISSIONS_REMEDY_TEXT['grant-table-select'], evidence: [step('fix-applied')] } },
    alternatives: [
      { explanation: 'The application connects as a different role', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [permissionsEvidenceId('wrong-role'), permissionsEvidenceId('table-select-missing')],
        detail: `A different role running the same query got the same result: ${res('wrong-role', 'unqualified')}. The error alone does not show which role was used. In the failure, current_user and session_user were ${by['table-select-missing'].context.currentUser}, the intended application role. In a customer case, ask for current_user from the application's own connection.` },
      { explanation: 'The role has no USAGE on the schema', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [permissionsEvidenceId('schema-usage-missing'), permissionsEvidenceId('table-select-missing')],
        detail: `Without USAGE on app_data, the schema dropped out of the effective search path. The query without the schema name returned ${res('schema-usage-missing', 'unqualified')}, as if the table were missing, and with the schema name ${res('schema-usage-missing', 'qualified')}. In the failure, the application role had USAGE and got 42501 for the table instead.` },
      { explanation: 'The search path leaves out the schema', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [permissionsEvidenceId('search-path-missing'), permissionsEvidenceId('table-select-missing')],
        detail: `With a search path of only public, the query without the schema name returned ${res('search-path-missing', 'unqualified')}, and with the schema name it ${res('search-path-missing', 'qualified')}. In the failure, app_data was in the search path and the schema-qualified query was refused too.` },
      { explanation: 'The table does not exist', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: PERMISSIONS_PHASES.map(permissionsEvidenceId),
        detail: 'The catalog listed app_data.project_tasks in every check, including the ones that returned 42P01, relation does not exist.' },
      { explanation: 'Row-level security, column privileges or access inherited through another role', status: 'UNVERIFIED_HYPOTHESIS', evidence: [],
        detail: 'Not tested here. The lab roles belong to no other role, the lab creates no row-level security policies, and it records table-level privileges only.' },
      { explanation: 'The customer environment differs from this lab', status: 'UNVERIFIED_HYPOTHESIS', evidence: [],
        detail: 'The role the customer application connects as, its grants, its search path, the query it sends and when its table was created have not been observed.' },
    ],
    evidence: PERMISSIONS_PHASES.map(p => ({ id: permissionsEvidenceId(p), phase: p, role: by[p].role, table: by[p].table })) };
  return { ...material, comparisonHash: hash(material), checkedAt: now.toISOString(), evidenceStatus: inspected.evidenceStatus,
    blockers, status: blockers.length ? 'EVIDENCE_REQUIRED' : 'READY_FOR_REVIEW' };
}

function history(root: string, runId: string, now: Date) {
  const chain = readChain<PermissionsReviewInput>(root, FILE, runId, hash({ runId, artifact: 'permissions-review-v1' }), checkInput, now);
  // A remedy record must name the cause record immediately governing it, and that record must be an acceptance.
  let governing: typeof chain.entries[number] | undefined;
  for (const entry of chain.entries) {
    if (entry.input.kind === 'cause') governing = entry;
    else if (!governing || governing.input.decision !== 'accept' || entry.input.causeReviewHash !== governing.hash || entry.input.comparisonHash !== governing.input.comparisonHash) fail('Remedy selection is not bound to an accepted cause review.');
  }
  return chain;
}

export function inspectPermissionsReview(dir: string, now = new Date()) {
  const packet = permissionsComparison(dir, now), chain = history(directory(dir), packet.runId, now);
  const causeEntries = chain.entries.filter(e => e.input.kind === 'cause'), latest = causeEntries.at(-1);
  const applicable = latest?.input.comparisonHash === packet.comparisonHash;
  const accepted = applicable && latest!.input.decision === 'accept' && packet.status === 'READY_FOR_REVIEW';
  const reviewStatus = !latest ? 'NOT_REVIEWED' : !applicable ? 'REVIEW_OUTDATED' : latest.input.decision === 'accept'
    ? accepted ? 'ACCEPTED_LOCAL_LAB' : 'EVIDENCE_REQUIRED' : latest.input.decision === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
  // Only selections recorded after the latest cause record count. Rejection or re-acceptance withdraws earlier selections.
  const selection = accepted ? chain.entries.slice(chain.entries.indexOf(latest!) + 1).filter(e => e.input.kind === 'remedy').at(-1) : undefined;
  return { ...packet, reviewHead: chain.head, reviewStatus, reviews: chain.entries,
    cause: accepted ? { classification: 'SUPPORTED_CAUSE', candidate: packet.candidate, scope: 'local-lab', reviewHash: latest!.hash } : null,
    remedySelection: selection ? { remedy: selection.input.remedy as PermissionsRemedy, selectionHash: selection.hash, causeReviewHash: selection.input.causeReviewHash!,
      reviewer: selection.input.reviewer, recordedAt: selection.recordedAt } : null,
    customerResolution: null, communicationApproval: 'PENDING',
    limitation: 'These decisions cover the recorded local experiment. Customer cause, customer resolution and approval of outgoing messages remain outside them.' };
}

export function permissionsReviewTemplate(dir: string, kind: 'cause'|'remedy', now = new Date()) {
  const p = inspectPermissionsReview(dir, now);
  if (kind === 'remedy' && !p.cause) fail('Accept the cause for this comparison before selecting a remedy.');
  return { schemaVersion: 1, scenario: 'table-privilege', kind, comparisonHash: p.comparisonHash, expectedReviewHead: p.reviewHead,
    reviewer: '', decision: kind === 'cause' ? 'request-changes' : 'select', remedy: null, causeReviewHash: kind === 'remedy' ? p.cause!.reviewHash : null, rationale: '' };
}

export function appendPermissionsReview(dir: string, input: unknown, now = new Date()) {
  checkInput(input);
  const value = input as PermissionsReviewInput, root = directory(dir);
  if (value.rationale.trim().length < 10) fail('Provide a substantive review rationale.');
  return appendChain<PermissionsReviewInput>(root, FILE, LOCK, now, () => {
    const packet = inspectPermissionsReview(root, now);
    if (value.comparisonHash !== packet.comparisonHash || value.expectedReviewHead !== packet.reviewHead) fail('Review input is outdated. Generate a fresh template and inspect the comparison.');
    if (value.kind === 'cause' && value.decision === 'accept' && packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent acceptance.');
    if (value.kind === 'remedy') {
      if (packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent remedy selection.');
      if (!packet.cause || value.causeReviewHash !== packet.cause.reviewHash) fail('Remedy selection requires the current accepted cause review.');
    }
    return { runId: packet.runId, sequence: packet.reviews.length + 1, previousHash: packet.reviewHead, previousAt: packet.reviews.at(-1)?.recordedAt, input: value };
  });
}

export function formatPermissionsReview(p: ReturnType<typeof inspectPermissionsReview>) {
  const display = (value: unknown) => canonical(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const line = (s: PermissionsStep) => `- ${s.id} (${s.label}): ${stepDetail(s)}`;
  const added = p.privilegeChange.added.map(g => `${g.privilege} on ${g.object} for ${g.grantee}${g.grantable ? ' with grant option' : ''}`).join('; ') || 'none';
  return ['# Permissions and search path review', '', `Run: ${p.runId}`, `Evidence: ${p.status} (${p.evidenceStatus}; window ends ${p.expiresAt})`, `Cause review: ${p.reviewStatus}`,
    `Remedy: ${p.remedySelection ? p.remedySelection.remedy : 'not selected'}`, `Comparison hash: ${p.comparisonHash}`, `Review head: ${p.reviewHead}`, '',
    `Candidate for human review: ${p.candidateText}`, '',
    '## Baseline, failure and fix', '', line(p.baseline), line(p.failure), line(p.fix), '',
    `Between the failure and the fix, the role (${APP_ROLE}), the table and the query stayed the same. The grants added: ${added}. Grants removed: ${p.privilegeChange.removed.length}. Role attributes and memberships unchanged: ${p.privilegeChange.rolesUnchanged ? 'yes' : 'no'}.`, '',
    '## Controls', '', ...p.controls.map(line), '',
    '## Remedies', '', ...PERMISSIONS_REMEDIES.map(r => `- ${r}: ${p.remedies[r].description}`), '', DEFAULT_PRIVILEGES_SUGGESTION, '',
    `Configuration: PostgreSQL ${p.configuration.postgresVersion}; Node ${p.configuration.versions.node}; pg ${p.configuration.versions.pg}; cleanup ${p.configuration.cleanup}.`, '',
    '## Competing explanations', '', ...p.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    ...(p.blockers.length ? ['## Blockers', '', ...p.blockers.map(b => `- ${b}`), ''] : []),
    ...(p.reviews.length ? ['## Decision history', '', ...p.reviews.map(r => `- ${r.recordedAt}: ${r.input.kind}; ${r.input.reviewer}; ${r.input.decision}${r.input.remedy ? ' ' + r.input.remedy : ''}; rationale: ${display(r.input.rationale)}; hash ${r.hash}`), ''] : []),
    `Cause: ${p.cause ? 'human-accepted, scoped to this local experiment' : 'unset'}. Customer resolution: unset.`, '', p.limitation, '',
    'Cause choices: accept, reject, or request-changes. After acceptance, select the remedy for validation. Each decision binds to this comparison hash.', ''].join('\n');
}
