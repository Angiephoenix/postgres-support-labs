import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { readChain, appendChain } from './review-chain.ts';
import { inspectLeak, requestShape, handlerChange, openLeasesAt, openAtEnd, outcomeSummary, sessionSummary, LEAK_PHASES, LEAK_QUERIES, PHASE_LABELS, CODE_PATHS,
  POOL_CONFIG, PLANS } from './pool-exhaustion-evidence.ts';
import type { LeakPhase, PhaseRecord } from './pool-exhaustion-evidence.ts';
import { leakPlan } from './pool-exhaustion-lab.ts';
import reviewSchema from '../schemas/pool-exhaustion-review-input.v1.json' with { type: 'json' };

export const LEAK_REMEDIES = ['release-in-finally'] as const;
export type LeakRemedy = typeof LEAK_REMEDIES[number];
export type LeakReviewInput = { schemaVersion: 1; scenario: 'connection-leak'; kind: 'cause'|'remedy'; comparisonHash: string;
  expectedReviewHead: string; reviewer: string; decision: 'accept'|'reject'|'request-changes'|'select'; remedy: LeakRemedy|null;
  causeReviewHash: string|null; rationale: string };
export const LEAK_CANDIDATE_TEXT = 'The request handler released its pool client only when its query succeeded. Each request whose query failed kept its client checked out on an idle server session, so once the failed requests equalled the pool size, later requests waited for a client and timed out, even with no load.';
export const LEAK_REMEDY_TEXT: Record<LeakRemedy, string> = {
  'release-in-finally': 'Release the client in finally in the request handler, passing the error when the query failed, so the pool discards that client instead of reusing it. The query, the pool configuration and the request plan stay the same.' };
// Neither of these is tested by this lab, and neither is ever a validated remedy.
export const POOL_QUERY_SUGGESTION = 'Suggestion, not validated: for code that runs a single statement, pool.query() checks out the client and releases it itself, including when the query fails. This lab does not test it.';
export const CAPACITY_NOTE = 'A larger pool may help when demand genuinely exceeds the pool, as the demand control shows, but it does not fix a leak: leaked clients would still build up until the larger pool is used up too.';
const FILE = 'pool-exhaustion-reviews.jsonl', LOCK = '.pool-exhaustion-review.lock';
export const leakEvidenceId = (phase: LeakPhase) => 'phase-' + phase;

function directory(dir: string) {
  const root = resolve(dir), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular pool-exhaustion run directory.');
  return root;
}
function checkInput(value: unknown) {
  validateArtifact(value, reviewSchema);
  const v = value as LeakReviewInput;
  const mismatch = v.kind === 'cause' ? v.decision === 'select' || v.remedy !== null || v.causeReviewHash !== null
    : v.decision !== 'select' || v.remedy === null || v.causeReviewHash === null;
  if (mismatch) fail('Review input kind does not match its decision fields.');
}

export function leakStep(p: PhaseRecord) {
  return { id: leakEvidenceId(p.phase), phase: p.phase, label: PHASE_LABELS[p.phase], codePath: CODE_PATHS[p.phase], handler: p.handler,
    requests: outcomeSummary(p), openCheckoutsAtEnd: openAtEnd(p), sessionsAtEnd: sessionSummary(p), collectedAt: p.collectedAt };
}
export type LeakStep = ReturnType<typeof leakStep>;
// How a phase's probe and recovery request ended, in words.
const ENDING: Record<string, string> = { ok: 'succeeded', 'pool-checkout-timeout': 'timed out waiting for a pool client' };
const ending = (outcome: string) => ENDING[outcome] ?? `ended with ${outcome}`;
export const endings = (probe: string, recovery: string) => probe === recovery ? `both ${ending(probe)}` : `${ending(probe)} and ${ending(recovery)} respectively`;
export const stepDetail = (s: LeakStep) => `${s.codePath}; requests: ${s.requests}; open checkouts at the end: ${s.openCheckoutsAtEnd}; server sessions at the end: ${s.sessionsAtEnd}`;
const count = (p: PhaseRecord, step: string, outcome: string) => p.requests.filter(q => q.step === step && q.outcome === outcome).length;
const onlyOutcome = (p: PhaseRecord, step: string) => p.requests.find(q => q.step === step)!.outcome;

export function leakComparison(dir: string, now = new Date()) {
  const root = directory(dir), inspected = inspectLeak(root, undefined, now), run = inspected.run;
  if (canonical(readJson(join(root, 'pool-exhaustion-plan.json'))) !== canonical({ ...leakPlan(), runId: run.runId, approved: true })) fail('The retained pool-exhaustion plan is missing or inconsistent.');
  const ph = Object.fromEntries(run.phases.map(p => [p.phase, p])) as Record<LeakPhase, PhaseRecord>;
  const step = (p: LeakPhase) => leakStep(ph[p]);
  const leak = ph['leak-reproduced'], fix = ph['fix-applied'], demand = ph['demand-beyond-capacity'], refusal = ph['server-refusal'];
  const blockers = inspected.evidenceStatus === 'STALE' ? [`Evidence expired at ${run.expiresAt}. Run the lab again for current evidence.`] : [];
  const leaked = openLeasesAt(leak, 'after-quiet'), quiet = leak.checkpoints.find(c => c.name === 'after-quiet')!, teardown = Object.fromEntries(run.teardown.map(t => [t.phase, t]));
  const leakedSessionsIdle = leaked.every(l => quiet.sessions.some(s => s.pid === l.backendPid && s.state === 'idle' && !s.inTransaction));
  const material = { schemaVersion: 1, scenario: 'connection-leak', runId: run.runId, profile: 'local-lab',
    sourceManifestHash: inspected.manifestHash, catalogHash: hash(LEAK_QUERIES), collectedAt: run.collectedAt, expiresAt: run.expiresAt,
    candidate: 'client-not-released-after-query-error', candidateText: LEAK_CANDIDATE_TEXT,
    configuration: { postgresVersion: run.postgresVersion, versions: run.versions, environment: run.environment, server: run.server, pool: POOL_CONFIG, cleanup: run.cleanup },
    baseline: step('baseline-valid-only'), failure: step('leak-reproduced'), fix: step('fix-applied'),
    controls: (['demand-beyond-capacity', 'slow-query', 'long-transaction', 'server-refusal', 'demand-beyond-capacity-after-fix'] as const).map(step),
    // The measurements the cause and the fix rest on, read from the checked run.
    leak: { failingRequests: PLANS.leak.failing, leasesOpenAfterQuiet: leaked.length, leakedSessionsIdle, quietMs: leak.quietMs,
      probe: onlyOutcome(leak, 'probe'), recovery: onlyOutcome(leak, 'recovery'), closedByTeardown: teardown['leak-reproduced'].openLeases },
    fixResult: { releasedWithError: fix.leases.filter(l => l.releasedWithError).length, leasesOpenAfterRecovery: openLeasesAt(fix, 'after-recovery').length,
      probe: onlyOutcome(fix, 'probe'), recovery: onlyOutcome(fix, 'recovery'), closedByTeardown: teardown['fix-applied'].openLeases },
    samePlan: canonical(requestShape(leak)) === canonical(requestShape(fix)) && leak.planHash === fix.planHash, handlerChange: handlerChange(),
    remedies: { 'release-in-finally': { description: LEAK_REMEDY_TEXT['release-in-finally'], evidence: [step('fix-applied')] } },
    alternatives: [
      { explanation: 'Legitimate demand beyond the pool’s capacity', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [leakEvidenceId('demand-beyond-capacity'), leakEvidenceId('leak-reproduced')],
        detail: `More concurrent requests than clients gave the same checkout timeout (${count(demand, 'busy', 'ok')} succeeded and ${count(demand, 'busy', 'pool-checkout-timeout')} timed out), while the server showed queries running. Once the load ended, every client was released and the next request succeeded. In the leak, ${leaked.length} checkouts stayed open on idle sessions after ${leak.quietMs} ms with no load.` },
      { explanation: 'Slow queries holding every client', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [leakEvidenceId('slow-query'), leakEvidenceId('leak-reproduced')],
        detail: 'While queries were held running on the server, their sessions showed active and waiting, and a probe timed out. The pool recovered when they finished. The leaked sessions were idle, with no query running.' },
      { explanation: 'Transactions left open by the application', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [leakEvidenceId('long-transaction'), leakEvidenceId('leak-reproduced')],
        detail: 'While the application held transactions open, their sessions showed idle in transaction, and a probe timed out. The pool recovered when they committed. The leaked sessions were idle outside any transaction.' },
      { explanation: 'PostgreSQL refusing new connections', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [leakEvidenceId('server-refusal'), leakEvidenceId('leak-reproduced')],
        detail: `A pool allowed to open more clients than the server had free ordinary slots got SQLSTATE 53300 on connect for each connection past the ${refusal.slots!.free} free slots. That is a server error on connect. The leak’s timeouts came from the pool, had no SQLSTATE, and no connection was refused.` },
      { explanation: 'Another application or a pooler sharing the role or the server', status: 'UNVERIFIED_HYPOTHESIS', evidence: [],
        detail: 'Not tested here. With several applications on one role, or PgBouncer in transaction mode, server sessions no longer map to one application’s checkouts.' },
      { explanation: 'The customer environment differs from this lab', status: 'UNVERIFIED_HYPOTHESIS', evidence: [],
        detail: 'The customer application’s pool configuration, its code paths that check out clients, its error rate and its server’s connection settings have not been observed.' },
    ],
    evidence: LEAK_PHASES.map(p => ({ id: leakEvidenceId(p), phase: p, handler: ph[p].handler, codePath: CODE_PATHS[p] })) };
  return { ...material, comparisonHash: hash(material), checkedAt: now.toISOString(), evidenceStatus: inspected.evidenceStatus,
    blockers, status: blockers.length ? 'EVIDENCE_REQUIRED' : 'READY_FOR_REVIEW' };
}

function history(root: string, runId: string, now: Date) {
  const chain = readChain<LeakReviewInput>(root, FILE, runId, hash({ runId, artifact: 'pool-exhaustion-review-v1' }), checkInput, now);
  // A remedy record must name the cause record immediately governing it, and that record must be an acceptance.
  let governing: typeof chain.entries[number] | undefined;
  for (const entry of chain.entries) {
    if (entry.input.kind === 'cause') governing = entry;
    else if (!governing || governing.input.decision !== 'accept' || entry.input.causeReviewHash !== governing.hash || entry.input.comparisonHash !== governing.input.comparisonHash) fail('Remedy selection is not bound to an accepted cause review.');
  }
  return chain;
}

export function inspectLeakReview(dir: string, now = new Date()) {
  const packet = leakComparison(dir, now), chain = history(directory(dir), packet.runId, now);
  const causeEntries = chain.entries.filter(e => e.input.kind === 'cause'), latest = causeEntries.at(-1);
  const applicable = latest?.input.comparisonHash === packet.comparisonHash;
  const accepted = applicable && latest!.input.decision === 'accept' && packet.status === 'READY_FOR_REVIEW';
  const reviewStatus = !latest ? 'NOT_REVIEWED' : !applicable ? 'REVIEW_OUTDATED' : latest.input.decision === 'accept'
    ? accepted ? 'ACCEPTED_LOCAL_LAB' : 'EVIDENCE_REQUIRED' : latest.input.decision === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
  // Only selections recorded after the latest cause record count. Rejection or re-acceptance withdraws earlier selections.
  const selection = accepted ? chain.entries.slice(chain.entries.indexOf(latest!) + 1).filter(e => e.input.kind === 'remedy').at(-1) : undefined;
  return { ...packet, reviewHead: chain.head, reviewStatus, reviews: chain.entries,
    cause: accepted ? { classification: 'SUPPORTED_CAUSE', candidate: packet.candidate, scope: 'local-lab', reviewHash: latest!.hash } : null,
    remedySelection: selection ? { remedy: selection.input.remedy as LeakRemedy, selectionHash: selection.hash, causeReviewHash: selection.input.causeReviewHash!,
      reviewer: selection.input.reviewer, recordedAt: selection.recordedAt } : null,
    customerResolution: null, communicationApproval: 'PENDING',
    limitation: 'These decisions cover the recorded local experiment. Customer cause, customer resolution and approval of outgoing messages remain outside them.' };
}

// The template starts with safe defaults: a cause template asks for changes, and a remedy template names no remedy.
// A person edits the reviewer, rationale and decision, or the remedy, before submitting it.
export function leakReviewTemplate(dir: string, kind: 'cause'|'remedy', now = new Date()) {
  const p = inspectLeakReview(dir, now);
  if (kind === 'remedy' && !p.cause) fail('Accept the cause for this comparison before selecting a remedy.');
  return { schemaVersion: 1, scenario: 'connection-leak', kind, comparisonHash: p.comparisonHash, expectedReviewHead: p.reviewHead,
    reviewer: '', decision: kind === 'cause' ? 'request-changes' : 'select', remedy: null, causeReviewHash: kind === 'remedy' ? p.cause!.reviewHash : null, rationale: '' };
}

export function appendLeakReview(dir: string, input: unknown, now = new Date()) {
  checkInput(input);
  const value = input as LeakReviewInput, root = directory(dir);
  if (value.rationale.trim().length < 10) fail('Provide a substantive review rationale.');
  return appendChain<LeakReviewInput>(root, FILE, LOCK, now, () => {
    const packet = inspectLeakReview(root, now);
    if (value.comparisonHash !== packet.comparisonHash || value.expectedReviewHead !== packet.reviewHead) fail('Review input is outdated. Generate a fresh template and inspect the comparison.');
    if (value.kind === 'cause' && value.decision === 'accept' && packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent acceptance.');
    if (value.kind === 'remedy') {
      if (packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent remedy selection.');
      if (!packet.cause || value.causeReviewHash !== packet.cause.reviewHash) fail('Remedy selection requires the current accepted cause review.');
    }
    return { runId: packet.runId, sequence: packet.reviews.length + 1, previousHash: packet.reviewHead, previousAt: packet.reviews.at(-1)?.recordedAt, input: value };
  });
}

export function formatLeakReview(p: ReturnType<typeof inspectLeakReview>) {
  const display = (value: unknown) => canonical(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const line = (s: LeakStep) => `- ${s.id} (${s.label}): ${stepDetail(s)}`;
  return ['# Application pool exhaustion review', '', `Run: ${p.runId}`, `Evidence: ${p.status} (${p.evidenceStatus}; window ends ${p.expiresAt})`, `Cause review: ${p.reviewStatus}`,
    `Remedy: ${p.remedySelection ? p.remedySelection.remedy : 'not selected'}`, `Comparison hash: ${p.comparisonHash}`, `Review head: ${p.reviewHead}`, '',
    `Candidate for human review: ${p.candidateText}`, '',
    '## Baseline, leak and fix', '', line(p.baseline), line(p.failure), line(p.fix), '',
    `With the original handler, ${p.leak.leasesOpenAfterQuiet} of the ${p.leak.failingRequests} failing requests' checkouts were still open on idle sessions after ${p.leak.quietMs} ms with no load, and the probe and recovery request ${endings(p.leak.probe, p.leak.recovery)}. ` +
      `With the fixed handler and the same request plan (${p.samePlan ? 'identical' : 'different'}), ${p.fixResult.releasedWithError} clients were released with the error, ${p.fixResult.leasesOpenAfterRecovery} checkouts were open at the end, and the probe and recovery request ${endings(p.fixResult.probe, p.fixResult.recovery)}.`, '',
    `Handler change: removed ${p.handlerChange.removed.map(l => '`' + l + '`').join(' ')}; added ${p.handlerChange.added.map(l => '`' + l + '`').join(' ')}.`, '',
    '## Controls', '', ...p.controls.map(line), '',
    '## Remedies', '', ...LEAK_REMEDIES.map(r => `- ${r}: ${p.remedies[r].description}`), '', POOL_QUERY_SUGGESTION, '', CAPACITY_NOTE, '',
    `Configuration: PostgreSQL ${p.configuration.postgresVersion}; Node ${p.configuration.versions.node}; pg ${p.configuration.versions.pg}; pg-pool ${p.configuration.versions.pgPool}; pool of ${p.configuration.pool.max} clients with an ${p.configuration.pool.connectionTimeoutMillis} ms checkout timeout; cleanup ${p.configuration.cleanup}.`, '',
    '## Competing explanations', '', ...p.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    ...(p.blockers.length ? ['## Blockers', '', ...p.blockers.map(b => `- ${b}`), ''] : []),
    ...(p.reviews.length ? ['## Decision history', '', ...p.reviews.map(r => `- ${r.recordedAt}: ${r.input.kind}; ${r.input.reviewer}; ${r.input.decision}${r.input.remedy ? ' ' + r.input.remedy : ''}; rationale: ${display(r.input.rationale)}; hash ${r.hash}`), ''] : []),
    `Cause: ${p.cause ? 'human-accepted, scoped to this local experiment' : 'unset'}. Customer resolution: unset.`, '', p.limitation, '',
    'Cause choices: accept, reject, or request-changes. After acceptance, select the remedy for validation. Each decision binds to this comparison hash.', ''].join('\n');
}

export type LeakReview = ReturnType<typeof inspectLeakReview>;
