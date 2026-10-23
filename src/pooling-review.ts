import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { readChain, appendChain } from './review-chain.ts';
import { inspectPooling, POOLING_PHASES, POOLING_QUERIES } from './pooling-evidence.ts';
import type { Observation, Phase } from './pooling-evidence.ts';
import { poolingPlan } from './pooling-lab.ts';
import reviewSchema from '../schemas/pooling-review-input.v1.json' with { type: 'json' };

export const REMEDIES = ['transaction-contained', 'protocol-prepared'] as const;
export type Remedy = typeof REMEDIES[number];
export type PoolingReviewInput = { schemaVersion: 1; scenario: 'pooling-session'; kind: 'cause'|'remedy'; comparisonHash: string;
  expectedReviewHead: string; reviewer: string; decision: 'accept'|'reject'|'request-changes'|'select'; remedy: Remedy|null;
  causeReviewHash: string|null; rationale: string };
export const CANDIDATE_TEXT = 'The SQL prepared statement was unavailable on the backend used by the next transaction after the measured backend switch.';
export const REMEDY_TEXT: Record<Remedy, string> = {
  'transaction-contained': 'Prepare, execute and deallocate within one pooled transaction.',
  'protocol-prepared': 'Use driver-level (protocol) named prepared statements with PgBouncer max_prepared_statements enabled.',
};
const FILE = 'pooling-reviews.jsonl', LOCK = '.pooling-review.lock';
export const evidenceId = (phase: Phase) => 'pooling-' + phase;

function directory(dir: string) {
  const root = resolve(dir), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular pooling run directory.');
  return root;
}
function checkInput(value: unknown) {
  validateArtifact(value, reviewSchema);
  const v = value as PoolingReviewInput;
  const mismatch = v.kind === 'cause' ? v.decision === 'select' || v.remedy !== null || v.causeReviewHash !== null
    : v.decision !== 'select' || v.remedy === null || v.causeReviewHash === null;
  if (mismatch) fail('Review input kind does not match its decision fields.');
}

export function poolingComparison(dir: string, now = new Date()) {
  const root = directory(dir), inspected = inspectPooling(root, undefined, now), run = inspected.run;
  if (canonical(readJson(join(root, 'pooling-plan.json'))) !== canonical({ ...poolingPlan(), runId: run.runId, approved: true })) fail('The retained pooling plan is missing or inconsistent.');
  const phase = Object.fromEntries(run.observations.map(o => [o.phase, o])) as Record<Phase, Observation>;
  const step = (p: Phase) => { const o = phase[p]; return { id: evidenceId(p), endpoint: o.endpoint, backend: o.backend, heldBackend: o.heldBackend, sqlstate: o.sqlstate, count: o.count, collectedAt: o.collectedAt }; };
  const blockers = inspected.evidenceStatus === 'STALE' ? [`Evidence expired at ${run.expiresAt}. Run the lab again for current evidence.`] : [];
  const material = { schemaVersion: 1, scenario: 'pooling-session', runId: run.runId, profile: 'local-lab',
    sourceManifestHash: inspected.manifestHash, catalogHash: hash(POOLING_QUERIES), collectedAt: run.collectedAt, expiresAt: run.expiresAt,
    candidate: 'sql-prepare-unavailable-after-backend-switch', candidateText: CANDIDATE_TEXT,
    configuration: { poolMode: run.poolMode, maxPreparedStatements: run.maxPreparedStatements, postgresVersion: run.postgresVersion, pgbouncerVersion: run.pgbouncerVersion, cleanup: run.cleanup },
    baseline: { first: step('direct-first'), next: step('direct-next') },
    backendSwitch: { first: step('pooled-first'), next: step('pooled-next') },
    controls: { directReset: step('direct-reset'), timeout: step('timeout-control') },
    remedies: { 'transaction-contained': { description: REMEDY_TEXT['transaction-contained'], evidence: [step('pooled-contained')] },
      'protocol-prepared': { description: REMEDY_TEXT['protocol-prepared'], evidence: [step('protocol-first'), step('protocol-next')] } },
    alternatives: [
      { explanation: 'The connector or application reset the session', status: 'REPRODUCED_BEHAVIOR', evidence: [evidenceId('direct-reset')],
        detail: 'DEALLOCATE ALL on a direct connection produced the same 26000 on the original backend without any pool. A customer case needs evidence of which endpoint handled the request and whether sessions reset.' },
      { explanation: 'A timeout was mistaken for a pooling limitation', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [evidenceId('timeout-control')],
        detail: 'The bounded timeout control produced 57014, a different error from the 26000 recorded after the backend switch.' },
      { explanation: 'The prepared operation itself is invalid', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [evidenceId('direct-first'), evidenceId('direct-next')],
        detail: 'The same PREPARE and EXECUTE succeeded twice on one direct backend.' },
      { explanation: 'A customer application sent this workflow through a transaction pool', status: 'UNVERIFIED_HYPOTHESIS', evidence: [],
        detail: 'Customer endpoint, pool mode, connector preparation method and session resets have not been observed.' },
    ],
    evidence: POOLING_PHASES.map(p => ({ id: evidenceId(p), phase: p, queryHash: phase[p].queryHash })) };
  return { ...material, comparisonHash: hash(material), checkedAt: now.toISOString(), evidenceStatus: inspected.evidenceStatus,
    blockers, status: blockers.length ? 'EVIDENCE_REQUIRED' : 'READY_FOR_REVIEW' };
}

function history(root: string, runId: string, now: Date) {
  const chain = readChain<PoolingReviewInput>(root, FILE, runId, hash({ runId, artifact: 'pooling-review-v1' }), checkInput, now);
  // A remedy record must name the cause record immediately governing it, and that record must be an acceptance.
  let governing: typeof chain.entries[number] | undefined;
  for (const entry of chain.entries) {
    if (entry.input.kind === 'cause') governing = entry;
    else if (!governing || governing.input.decision !== 'accept' || entry.input.causeReviewHash !== governing.hash || entry.input.comparisonHash !== governing.input.comparisonHash) fail('Remedy selection is not bound to an accepted cause review.');
  }
  return chain;
}

export function inspectPoolingReview(dir: string, now = new Date()) {
  const packet = poolingComparison(dir, now), chain = history(directory(dir), packet.runId, now);
  const causeEntries = chain.entries.filter(e => e.input.kind === 'cause'), latest = causeEntries.at(-1);
  const applicable = latest?.input.comparisonHash === packet.comparisonHash;
  const accepted = applicable && latest!.input.decision === 'accept' && packet.status === 'READY_FOR_REVIEW';
  const reviewStatus = !latest ? 'NOT_REVIEWED' : !applicable ? 'REVIEW_OUTDATED' : latest.input.decision === 'accept'
    ? accepted ? 'ACCEPTED_LOCAL_LAB' : 'EVIDENCE_REQUIRED' : latest.input.decision === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
  // Only selections recorded after the latest cause record count. Rejection or re-acceptance withdraws earlier selections.
  const selection = accepted ? chain.entries.slice(chain.entries.indexOf(latest!) + 1).filter(e => e.input.kind === 'remedy').at(-1) : undefined;
  return { ...packet, reviewHead: chain.head, reviewStatus, reviews: chain.entries,
    cause: accepted ? { classification: 'SUPPORTED_CAUSE', candidate: packet.candidate, scope: 'local-lab', reviewHash: latest!.hash } : null,
    remedySelection: selection ? { remedy: selection.input.remedy as Remedy, selectionHash: selection.hash, causeReviewHash: selection.input.causeReviewHash!,
      reviewer: selection.input.reviewer, recordedAt: selection.recordedAt } : null,
    customerResolution: null, communicationApproval: 'PENDING',
    limitation: 'These decisions cover the recorded local experiment. Customer cause, customer resolution and approval of outgoing messages remain outside them.' };
}

export function poolingReviewTemplate(dir: string, kind: 'cause'|'remedy', now = new Date()) {
  const p = inspectPoolingReview(dir, now);
  if (kind === 'remedy' && !p.cause) fail('Accept the cause for this comparison before selecting a remedy.');
  return { schemaVersion: 1, scenario: 'pooling-session', kind, comparisonHash: p.comparisonHash, expectedReviewHead: p.reviewHead,
    reviewer: '', decision: kind === 'cause' ? 'request-changes' : 'select', remedy: null, causeReviewHash: kind === 'remedy' ? p.cause!.reviewHash : null, rationale: '' };
}

export function appendPoolingReview(dir: string, input: unknown, now = new Date()) {
  checkInput(input);
  const value = input as PoolingReviewInput, root = directory(dir);
  if (value.rationale.trim().length < 10) fail('Provide a substantive review rationale.');
  return appendChain<PoolingReviewInput>(root, FILE, LOCK, now, () => {
    const packet = inspectPoolingReview(root, now);
    if (value.comparisonHash !== packet.comparisonHash || value.expectedReviewHead !== packet.reviewHead) fail('Review input is outdated. Generate a fresh template and inspect the comparison.');
    if (value.kind === 'cause' && value.decision === 'accept' && packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent acceptance.');
    if (value.kind === 'remedy') {
      if (packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent remedy selection.');
      if (!packet.cause || value.causeReviewHash !== packet.cause.reviewHash) fail('Remedy selection requires the current accepted cause review.');
    }
    return { runId: packet.runId, sequence: packet.reviews.length + 1, previousHash: packet.reviewHead, previousAt: packet.reviews.at(-1)?.recordedAt, input: value };
  });
}

type Step = ReturnType<typeof poolingComparison>['baseline']['first'];
const describe = (s: Step) => `${s.endpoint} backend ${s.backend}${s.heldBackend !== null ? ` (backend ${s.heldBackend} held by another client)` : ''}: ${s.sqlstate ? 'SQLSTATE ' + s.sqlstate : 'success, count ' + s.count}`;
export function formatPoolingReview(p: ReturnType<typeof inspectPoolingReview>) {
  const display = (value: unknown) => canonical(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return ['# PgBouncer session investigation review', '', `Run: ${p.runId}`, `Evidence: ${p.status} (${p.evidenceStatus}; window ends ${p.expiresAt})`, `Cause review: ${p.reviewStatus}`,
    `Remedy: ${p.remedySelection ? p.remedySelection.remedy : 'not selected'}`, `Comparison hash: ${p.comparisonHash}`, `Review head: ${p.reviewHead}`, '',
    `Candidate for human review: ${p.candidateText}`, '',
    '## Direct baseline', '', `- ${p.baseline.first.id}: ${describe(p.baseline.first)}`, `- ${p.baseline.next.id}: ${describe(p.baseline.next)}`, '',
    '## Measured backend switch', '', `- ${p.backendSwitch.first.id}: ${describe(p.backendSwitch.first)}`, `- ${p.backendSwitch.next.id}: ${describe(p.backendSwitch.next)}`, '',
    '## Controls', '', `- ${p.controls.directReset.id}: ${describe(p.controls.directReset)}`, `- ${p.controls.timeout.id}: ${describe(p.controls.timeout)}`, '',
    '## Remedies', '', ...REMEDIES.flatMap(r => [`- ${r}: ${p.remedies[r].description}`, ...p.remedies[r].evidence.map(s => `  - ${s.id}: ${describe(s)}`)]), '',
    `Configuration: pool mode ${p.configuration.poolMode}; max_prepared_statements ${p.configuration.maxPreparedStatements}; PostgreSQL ${p.configuration.postgresVersion}; PgBouncer ${p.configuration.pgbouncerVersion}; cleanup ${p.configuration.cleanup}.`, '',
    '## Competing explanations', '', ...p.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    ...(p.blockers.length ? ['## Blockers', '', ...p.blockers.map(b => `- ${b}`), ''] : []),
    ...(p.reviews.length ? ['## Decision history', '', ...p.reviews.map(r => `- ${r.recordedAt}: ${r.input.kind}; ${r.input.reviewer}; ${r.input.decision}${r.input.remedy ? ' ' + r.input.remedy : ''}; rationale: ${display(r.input.rationale)}; hash ${r.hash}`), ''] : []),
    `Cause: ${p.cause ? 'human-accepted, scoped to this local experiment' : 'unset'}. Customer resolution: unset.`, '', p.limitation, '',
    'Cause choices: accept, reject, or request-changes. After acceptance, select one remedy for validation. Each decision binds to this comparison hash.', ''].join('\n');
}
