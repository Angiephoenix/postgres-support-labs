import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { readChain, appendChain } from './review-chain.ts';
import { inspectIndex, INDEX_PHASES, INDEX_QUERIES, INDEX_NAME, PHASE_LABELS, blocks, plan, statisticsSentence } from './index-evidence.ts';
import type { IndexObservation, IndexPhase } from './index-evidence.ts';
import { indexPlan } from './index-lab.ts';
import reviewSchema from '../schemas/index-review-input.v1.json' with { type: 'json' };

export const INDEX_REMEDIES = ['create-index'] as const;
export type IndexRemedy = typeof INDEX_REMEDIES[number];
export type IndexReviewInput = { schemaVersion: 1; scenario: 'slow-query-index'; kind: 'cause'|'remedy'; comparisonHash: string;
  expectedReviewHead: string; reviewer: string; decision: 'accept'|'reject'|'request-changes'|'select'; remedy: IndexRemedy|null;
  causeReviewHash: string|null; rationale: string };
export const INDEX_CANDIDATE_TEXT = 'Without an index on customer_id, the query scanned the whole orders table to return the few rows that matched.';
export const INDEX_REMEDY_TEXT: Record<IndexRemedy, string> = { 'create-index': 'Create a B-tree index on orders (customer_id).' };
const FILE = 'index-reviews.jsonl', LOCK = '.index-review.lock';
export const indexEvidenceId = (phase: IndexPhase) => 'plan-' + phase;

function directory(dir: string) {
  const root = resolve(dir), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular index run directory.');
  return root;
}
function checkInput(value: unknown) {
  validateArtifact(value, reviewSchema);
  const v = value as IndexReviewInput;
  const mismatch = v.kind === 'cause' ? v.decision === 'select' || v.remedy !== null || v.causeReviewHash !== null
    : v.decision !== 'select' || v.remedy === null || v.causeReviewHash === null;
  if (mismatch) fail('Review input kind does not match its decision fields.');
}

export function indexStep(o: IndexObservation) {
  const s = o.summary;
  return { id: indexEvidenceId(o.phase), label: PHASE_LABELS[o.phase], value: o.value, indexPresent: o.indexPresent, columnStatistics: o.columnStatistics,
    scanNode: s.scanNode, indexName: s.indexName, estimatedRows: s.estimatedRows, actualRows: s.actualRows, rowsRemovedByFilter: s.rowsRemovedByFilter,
    buffers: { hit: s.sharedHitBlocks, read: s.sharedReadBlocks, total: blocks(s) }, planningMs: s.planningMs, executionMs: s.executionMs,
    result: o.result, queryHash: o.queryHash, settingsHash: o.settingsHash, role: o.role, database: o.database, collectedAt: o.collectedAt };
}
export type IndexStep = ReturnType<typeof indexStep>;

export function indexComparison(dir: string, now = new Date()) {
  const root = directory(dir), inspected = inspectIndex(root, undefined, now), run = inspected.run;
  if (canonical(readJson(join(root, 'index-plan.json'))) !== canonical({ ...indexPlan(), runId: run.runId, approved: true })) fail('The retained index plan is missing or inconsistent.');
  const phase = Object.fromEntries(run.observations.map(o => [o.phase, o])) as Record<IndexPhase, IndexObservation>;
  const step = (p: IndexPhase) => indexStep(phase[p]);
  const u = step('stats-unanalyzed'), a = step('stats-analyzed'), ar = step('stats-analyzed-repeat'), i = step('index-applied'), ir = step('index-applied-repeat'), c = step('common-value');
  const blockers = inspected.evidenceStatus === 'STALE' ? [`Evidence expired at ${run.expiresAt}. Run the lab again for current evidence.`] : [];
  const share = (n: number) => `${(100 * n / run.data.rows).toFixed(n * 1000 < run.data.rows ? 4 : 1)}%`;
  const material = { schemaVersion: 1, scenario: 'slow-query-index', runId: run.runId, profile: 'local-lab',
    sourceManifestHash: inspected.manifestHash, catalogHash: hash(INDEX_QUERIES), collectedAt: run.collectedAt, expiresAt: run.expiresAt,
    candidate: 'missing-index-on-selective-filter', candidateText: INDEX_CANDIDATE_TEXT,
    configuration: { postgresVersion: run.postgresVersion, settings: run.settings, roleSettings: run.roleSettings, statisticsSetup: run.statisticsSetup,
      data: run.data, index: run.index, cleanup: run.cleanup },
    statisticsControl: { unanalyzed: u, analyzed: a },
    before: { first: a, repeat: ar }, after: { first: i, repeat: ir },
    selectivityControl: c,
    remedies: { 'create-index': { description: INDEX_REMEDY_TEXT['create-index'], definition: run.index.definition, evidence: [i, ir] } },
    alternatives: [
      { explanation: 'Outdated or missing statistics led the planner to a poor plan', status: u.scanNode === a.scanNode && a.indexName === null ? 'NO_SIGNAL_WITHIN_SCOPE' : 'REPRODUCED_BEHAVIOR',
        evidence: [u.id, a.id], detail: statisticsSentence(phase['stats-unanalyzed'].summary, phase['stats-analyzed'].summary) + ' ' + run.statisticsSetup },
      { explanation: 'The value matches too many rows for an index to help', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [a.id, c.id],
        detail: `The reported value matched ${a.actualRows} of ${run.data.rows} rows (${share(a.actualRows)}). The common value matched ${c.actualRows} (${share(c.actualRows)}); with the index available and current statistics the planner chose ${plan(phase['common-value'].summary)} for it and read ${c.buffers.total} shared blocks. No scan type was forced. Selectivity changes which plan the planner chooses, so the result for the reported value does not carry over to common values.` },
      { explanation: 'A cold buffer cache made a single run slow', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [a.id, ar.id, i.id, ir.id],
        detail: `Repeated-run check. Without the index the query read ${a.buffers.read} blocks into PostgreSQL's shared buffers on the first run and ${ar.buffers.read} on the repeat, out of ${a.buffers.total} and ${ar.buffers.total} shared blocks in total. With the index the totals were ${i.buffers.total} and ${ir.buffers.total}. Reads into shared buffers may be served by the operating system's cache, so these counts do not establish physical disk activity or a cold cache. They do not prove a cold cache caused a slowdown, and they do not rule caching out.` },
      { explanation: 'The customer query, data or indexes differ from this lab', status: 'UNVERIFIED_HYPOTHESIS', evidence: [],
        detail: 'The customer query, its parameter values, row counts, statistics, indexes and planner settings have not been observed.' },
    ],
    evidence: INDEX_PHASES.map(p => ({ id: indexEvidenceId(p), phase: p, queryHash: phase[p].queryHash })) };
  return { ...material, comparisonHash: hash(material), checkedAt: now.toISOString(), evidenceStatus: inspected.evidenceStatus,
    blockers, status: blockers.length ? 'EVIDENCE_REQUIRED' : 'READY_FOR_REVIEW' };
}

function history(root: string, runId: string, now: Date) {
  const chain = readChain<IndexReviewInput>(root, FILE, runId, hash({ runId, artifact: 'index-review-v1' }), checkInput, now);
  // A remedy record must name the cause record immediately governing it, and that record must be an acceptance.
  let governing: typeof chain.entries[number] | undefined;
  for (const entry of chain.entries) {
    if (entry.input.kind === 'cause') governing = entry;
    else if (!governing || governing.input.decision !== 'accept' || entry.input.causeReviewHash !== governing.hash || entry.input.comparisonHash !== governing.input.comparisonHash) fail('Remedy selection is not bound to an accepted cause review.');
  }
  return chain;
}

export function inspectIndexReview(dir: string, now = new Date()) {
  const packet = indexComparison(dir, now), chain = history(directory(dir), packet.runId, now);
  const causeEntries = chain.entries.filter(e => e.input.kind === 'cause'), latest = causeEntries.at(-1);
  const applicable = latest?.input.comparisonHash === packet.comparisonHash;
  const accepted = applicable && latest!.input.decision === 'accept' && packet.status === 'READY_FOR_REVIEW';
  const reviewStatus = !latest ? 'NOT_REVIEWED' : !applicable ? 'REVIEW_OUTDATED' : latest.input.decision === 'accept'
    ? accepted ? 'ACCEPTED_LOCAL_LAB' : 'EVIDENCE_REQUIRED' : latest.input.decision === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
  // Only selections recorded after the latest cause record count. Rejection or re-acceptance withdraws earlier selections.
  const selection = accepted ? chain.entries.slice(chain.entries.indexOf(latest!) + 1).filter(e => e.input.kind === 'remedy').at(-1) : undefined;
  return { ...packet, reviewHead: chain.head, reviewStatus, reviews: chain.entries,
    cause: accepted ? { classification: 'SUPPORTED_CAUSE', candidate: packet.candidate, scope: 'local-lab', reviewHash: latest!.hash } : null,
    remedySelection: selection ? { remedy: selection.input.remedy as IndexRemedy, selectionHash: selection.hash, causeReviewHash: selection.input.causeReviewHash!,
      reviewer: selection.input.reviewer, recordedAt: selection.recordedAt } : null,
    customerResolution: null, communicationApproval: 'PENDING',
    limitation: 'These decisions cover the recorded local experiment. Customer cause, customer resolution and approval of outgoing messages remain outside them.' };
}

export function indexReviewTemplate(dir: string, kind: 'cause'|'remedy', now = new Date()) {
  const p = inspectIndexReview(dir, now);
  if (kind === 'remedy' && !p.cause) fail('Accept the cause for this comparison before selecting a remedy.');
  return { schemaVersion: 1, scenario: 'slow-query-index', kind, comparisonHash: p.comparisonHash, expectedReviewHead: p.reviewHead,
    reviewer: '', decision: kind === 'cause' ? 'request-changes' : 'select', remedy: null, causeReviewHash: kind === 'remedy' ? p.cause!.reviewHash : null, rationale: '' };
}

export function appendIndexReview(dir: string, input: unknown, now = new Date()) {
  checkInput(input);
  const value = input as IndexReviewInput, root = directory(dir);
  if (value.rationale.trim().length < 10) fail('Provide a substantive review rationale.');
  return appendChain<IndexReviewInput>(root, FILE, LOCK, now, () => {
    const packet = inspectIndexReview(root, now);
    if (value.comparisonHash !== packet.comparisonHash || value.expectedReviewHead !== packet.reviewHead) fail('Review input is outdated. Generate a fresh template and inspect the comparison.');
    if (value.kind === 'cause' && value.decision === 'accept' && packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent acceptance.');
    if (value.kind === 'remedy') {
      if (packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent remedy selection.');
      if (!packet.cause || value.causeReviewHash !== packet.cause.reviewHash) fail('Remedy selection requires the current accepted cause review.');
    }
    return { runId: packet.runId, sequence: packet.reviews.length + 1, previousHash: packet.reviewHead, previousAt: packet.reviews.at(-1)?.recordedAt, input: value };
  });
}

const ms = (n: number) => n < 1 ? n.toFixed(3) : n.toFixed(1);
export const describeStep = (s: IndexStep) => `${s.scanNode}${s.indexName ? ' on ' + s.indexName : ''}; estimated ${s.estimatedRows} rows, actual ${s.actualRows}` +
  `${s.rowsRemovedByFilter !== null ? `, ${s.rowsRemovedByFilter} removed by filter` : ''}; ${s.buffers.total} shared blocks (${s.buffers.hit} hit, ${s.buffers.read} read); ${ms(s.executionMs)} ms local execution; result ${s.result.orders} orders, total ${s.result.total}`;
export function formatIndexReview(p: ReturnType<typeof inspectIndexReview>) {
  const display = (value: unknown) => canonical(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const line = (s: IndexStep) => `- ${s.id} (${s.label}): ${describeStep(s)}`;
  return ['# Slow query and index investigation review', '', `Run: ${p.runId}`, `Evidence: ${p.status} (${p.evidenceStatus}; window ends ${p.expiresAt})`, `Cause review: ${p.reviewStatus}`,
    `Remedy: ${p.remedySelection ? p.remedySelection.remedy : 'not selected'}`, `Comparison hash: ${p.comparisonHash}`, `Review head: ${p.reviewHead}`, '',
    `Candidate for human review: ${p.candidateText}`, '',
    '## Statistics control', '', line(p.statisticsControl.unanalyzed), line(p.statisticsControl.analyzed), '', p.configuration.statisticsSetup, '',
    '## Before and after the index', '', line(p.before.first), line(p.before.repeat), line(p.after.first), line(p.after.repeat), '',
    '## Selectivity control', '', line(p.selectivityControl), '',
    '## Remedies', '', ...INDEX_REMEDIES.map(r => `- ${r}: ${p.remedies[r].description} (${p.remedies[r].definition})`), '',
    `Configuration: PostgreSQL ${p.configuration.postgresVersion}; ${p.configuration.data.rows} rows; data fingerprint unchanged (${p.configuration.data.fingerprintBefore}); parallel workers ${p.configuration.settings.max_parallel_workers_per_gather}; JIT ${p.configuration.settings.jit}; random_page_cost ${p.configuration.settings.random_page_cost}; cleanup ${p.configuration.cleanup}. Timing is local supporting evidence.`, '',
    '## Competing explanations', '', ...p.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    ...(p.blockers.length ? ['## Blockers', '', ...p.blockers.map(b => `- ${b}`), ''] : []),
    ...(p.reviews.length ? ['## Decision history', '', ...p.reviews.map(r => `- ${r.recordedAt}: ${r.input.kind}; ${r.input.reviewer}; ${r.input.decision}${r.input.remedy ? ' ' + r.input.remedy : ''}; rationale: ${display(r.input.rationale)}; hash ${r.hash}`), ''] : []),
    `Cause: ${p.cause ? 'human-accepted, scoped to this local experiment' : 'unset'}. Customer resolution: unset.`, '', p.limitation, '',
    'Cause choices: accept, reject, or request-changes. After acceptance, select the remedy for validation. Each decision binds to this comparison hash.', ''].join('\n');
}
export { INDEX_NAME };
