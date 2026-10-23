import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { readChain, appendChain } from './review-chain.ts';
import { inspectConnectivity, CONNECTIVITY_PHASES, CONNECTIVITY_QUERIES, PHASE_LABELS, PHASE_SPECS, STAGE_LABELS, outcome, reachedSentence } from './connectivity-evidence.ts';
import type { Attempt, ConnectivityPhase } from './connectivity-evidence.ts';
import { connectivityPlan } from './connectivity-lab.ts';
import reviewSchema from '../schemas/connectivity-review-input.v1.json' with { type: 'json' };

export const CONNECTIVITY_REMEDIES = ['trust-issuing-ca'] as const;
export type ConnectivityRemedy = typeof CONNECTIVITY_REMEDIES[number];
export type ConnectivityReviewInput = { schemaVersion: 1; scenario: 'tls-trust'; kind: 'cause'|'remedy'; comparisonHash: string;
  expectedReviewHead: string; reviewer: string; decision: 'accept'|'reject'|'request-changes'|'select'; remedy: ConnectivityRemedy|null;
  causeReviewHash: string|null; rationale: string };
export const CONNECTIVITY_CANDIDATE_TEXT = 'The client checked the server certificate against a trust store that did not contain the CA that issued it, so certificate-chain verification failed before PostgreSQL authentication.';
export const CONNECTIVITY_REMEDY_TEXT: Record<ConnectivityRemedy, string> = {
  'trust-issuing-ca': 'Give the client the CA that issued the server certificate (sslrootcert), keeping sslmode=verify-full and a host name that is on the certificate.' };
const FILE = 'connectivity-reviews.jsonl', LOCK = '.connectivity-review.lock';
export const connectivityEvidenceId = (phase: ConnectivityPhase) => 'attempt-' + phase;

function directory(dir: string) {
  const root = resolve(dir), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular connectivity run directory.');
  return root;
}
function checkInput(value: unknown) {
  validateArtifact(value, reviewSchema);
  const v = value as ConnectivityReviewInput;
  const mismatch = v.kind === 'cause' ? v.decision === 'select' || v.remedy !== null || v.causeReviewHash !== null
    : v.decision !== 'select' || v.remedy === null || v.causeReviewHash === null;
  if (mismatch) fail('Review input kind does not match its decision fields.');
}

export function connectivityStep(a: Attempt) {
  return { id: connectivityEvidenceId(a.phase), label: PHASE_LABELS[a.phase], shape: a.shape, outcome: outcome(a), stages: a.stages, failure: a.failure,
    effectiveTls: a.effective.tls, tls: a.tls, session: a.session, parse: { ok: a.parse.ok, errorCode: a.parse.errorCode, warnings: a.parse.warnings }, serverLog: a.serverLog, collectedAt: a.collectedAt };
}
export type ConnectivityStep = ReturnType<typeof connectivityStep>;

export function connectivityComparison(dir: string, now = new Date()) {
  const root = directory(dir), inspected = inspectConnectivity(root, undefined, now), run = inspected.run;
  if (canonical(readJson(join(root, 'connectivity-plan.json'))) !== canonical({ ...connectivityPlan(), runId: run.runId, approved: true })) fail('The retained connectivity plan is missing or inconsistent.');
  const by = Object.fromEntries(run.attempts.map(a => [a.phase, a])) as Record<ConnectivityPhase, Attempt>;
  const step = (p: ConnectivityPhase) => connectivityStep(by[p]);
  const blockers = inspected.evidenceStatus === 'STALE' ? [`Evidence expired at ${run.expiresAt}. Run the lab again for current evidence.`] : [];
  const code = (p: ConnectivityPhase) => by[p].failure?.sqlstate ?? by[p].failure?.code ?? 'none';
  const pw = (p: ConnectivityPhase) => by[p].parse.ok ? (by[p].failure ? `failed at ${STAGE_LABELS[by[p].failure!.stage]}` : 'parsed and connected') : `failed to parse (${by[p].parse.errorCode})`;
  const material = { schemaVersion: 1, scenario: 'tls-trust', runId: run.runId, profile: 'local-lab',
    sourceManifestHash: inspected.manifestHash, catalogHash: hash(CONNECTIVITY_QUERIES), collectedAt: run.collectedAt, expiresAt: run.expiresAt,
    candidate: 'client-does-not-trust-issuing-ca', candidateText: CONNECTIVITY_CANDIDATE_TEXT,
    configuration: { postgresVersion: run.postgresVersion, versions: run.versions, environment: run.environment, certificates: run.certificates, keyFiles: run.keyFiles, cleanup: run.cleanup },
    baseline: step('baseline-verified'), failure: step('untrusted-ca'), fix: step('trusted-ca-fix'),
    controls: (['wrong-ca', 'hostname-mismatch', 'require-driver-default', 'require-libpq-compat', 'no-tls', 'wrong-password', 'unknown-role', 'wrong-database',
      'password-hash-unencoded', 'password-at-unencoded', 'password-both-unencoded', 'password-both-encoded', 'tcp-refused'] as const).map(step),
    remedies: { 'trust-issuing-ca': { description: CONNECTIVITY_REMEDY_TEXT['trust-issuing-ca'], evidence: [step('trusted-ca-fix')] } },
    alternatives: [
      { explanation: 'The client trusts a CA, but not the one that issued this certificate', status: 'REPRODUCED_BEHAVIOR', evidence: [connectivityEvidenceId('wrong-ca'), connectivityEvidenceId('untrusted-ca')],
        detail: `Supplying a different, untrusted CA failed with ${code('wrong-ca')}, the same code as supplying no CA. The error code alone does not show which CA the client has, so ask which file sslrootcert points to.` },
      { explanation: 'The host name does not match the certificate', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [connectivityEvidenceId('hostname-mismatch'), connectivityEvidenceId('trusted-ca-fix')],
        detail: `A host name that is not on the certificate failed at the same stage but with a different code, ${code('hostname-mismatch')}. The reported failure used a host name on the certificate, and the fix passed the host-name check.` },
      { explanation: 'sslmode=require was expected not to verify the certificate', status: 'REPRODUCED_BEHAVIOR', evidence: [connectivityEvidenceId('require-driver-default'), connectivityEvidenceId('require-libpq-compat')],
        detail: `With pg ${run.versions.pg} and pg-connection-string ${run.versions.pgConnectionString}, sslmode=require turned certificate checks on, like verify-full, and failed with ${code('require-driver-default')}. With uselibpqcompat=true it connected encrypted without verifying the certificate, which is not a fix. Other drivers and versions may differ.` },
      { explanation: 'The server refused the connection', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [connectivityEvidenceId('no-tls'), connectivityEvidenceId('untrusted-ca')],
        detail: `With TLS off, the server refused the connection with SQLSTATE ${code('no-tls')}. The reported failure has no SQLSTATE: the server agreed to TLS and the client rejected the certificate. A 28000 refusal alone does not show that escalation is needed.` },
      { explanation: 'The password, role or database is wrong', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: ['wrong-password', 'unknown-role', 'wrong-database'].map(p => connectivityEvidenceId(p as ConnectivityPhase)),
        detail: `These failed only after certificate verification passed. A wrong password (${code('wrong-password')}) and an unknown role (${code('unknown-role')}) were refused during authentication, with the same code. A missing database was refused with ${code('wrong-database')} at ${STAGE_LABELS[by['wrong-database'].failure?.stage ?? 'sessionReady']}${by['wrong-database'].stages.authenticated === 'passed' ? ', after the server accepted the credentials' : ''}.` },
      { explanation: 'Special characters in the password broke the connection string', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: ['password-hash-unencoded', 'password-at-unencoded', 'password-both-unencoded', 'password-both-encoded'].map(p => connectivityEvidenceId(p as ConnectivityPhase)),
        detail: `With this parser, # alone ${pw('password-hash-unencoded')}; @ alone ${pw('password-at-unencoded')}; # and @ together ${pw('password-both-unencoded')}; the same password percent-encoded ${pw('password-both-encoded')}. These failures happen before any connection, unlike the reported one.` },
      { explanation: 'Nothing was listening at the address', status: 'NO_SIGNAL_WITHIN_SCOPE', evidence: [connectivityEvidenceId('tcp-refused')],
        detail: `A port with nothing listening failed at TCP connect with ${code('tcp-refused')}. ${reachedSentence(by)}` },
      { explanation: 'The customer environment differs from this lab', status: 'UNVERIFIED_HYPOTHESIS', evidence: [],
        detail: 'The customer client library and version, its sslmode, sslrootcert and host name, the certificate the server presents to it, and its network path have not been observed.' },
    ],
    evidence: CONNECTIVITY_PHASES.map(p => ({ id: connectivityEvidenceId(p), phase: p, shape: by[p].shape })) };
  return { ...material, comparisonHash: hash(material), checkedAt: now.toISOString(), evidenceStatus: inspected.evidenceStatus,
    blockers, status: blockers.length ? 'EVIDENCE_REQUIRED' : 'READY_FOR_REVIEW' };
}

function history(root: string, runId: string, now: Date) {
  const chain = readChain<ConnectivityReviewInput>(root, FILE, runId, hash({ runId, artifact: 'connectivity-review-v1' }), checkInput, now);
  // A remedy record must name the cause record immediately governing it, and that record must be an acceptance.
  let governing: typeof chain.entries[number] | undefined;
  for (const entry of chain.entries) {
    if (entry.input.kind === 'cause') governing = entry;
    else if (!governing || governing.input.decision !== 'accept' || entry.input.causeReviewHash !== governing.hash || entry.input.comparisonHash !== governing.input.comparisonHash) fail('Remedy selection is not bound to an accepted cause review.');
  }
  return chain;
}

export function inspectConnectivityReview(dir: string, now = new Date()) {
  const packet = connectivityComparison(dir, now), chain = history(directory(dir), packet.runId, now);
  const causeEntries = chain.entries.filter(e => e.input.kind === 'cause'), latest = causeEntries.at(-1);
  const applicable = latest?.input.comparisonHash === packet.comparisonHash;
  const accepted = applicable && latest!.input.decision === 'accept' && packet.status === 'READY_FOR_REVIEW';
  const reviewStatus = !latest ? 'NOT_REVIEWED' : !applicable ? 'REVIEW_OUTDATED' : latest.input.decision === 'accept'
    ? accepted ? 'ACCEPTED_LOCAL_LAB' : 'EVIDENCE_REQUIRED' : latest.input.decision === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
  // Only selections recorded after the latest cause record count. Rejection or re-acceptance withdraws earlier selections.
  const selection = accepted ? chain.entries.slice(chain.entries.indexOf(latest!) + 1).filter(e => e.input.kind === 'remedy').at(-1) : undefined;
  return { ...packet, reviewHead: chain.head, reviewStatus, reviews: chain.entries,
    cause: accepted ? { classification: 'SUPPORTED_CAUSE', candidate: packet.candidate, scope: 'local-lab', reviewHash: latest!.hash } : null,
    remedySelection: selection ? { remedy: selection.input.remedy as ConnectivityRemedy, selectionHash: selection.hash, causeReviewHash: selection.input.causeReviewHash!,
      reviewer: selection.input.reviewer, recordedAt: selection.recordedAt } : null,
    customerResolution: null, communicationApproval: 'PENDING',
    limitation: 'These decisions cover the recorded local experiment. Customer cause, customer resolution and approval of outgoing messages remain outside them.' };
}

export function connectivityReviewTemplate(dir: string, kind: 'cause'|'remedy', now = new Date()) {
  const p = inspectConnectivityReview(dir, now);
  if (kind === 'remedy' && !p.cause) fail('Accept the cause for this comparison before selecting a remedy.');
  return { schemaVersion: 1, scenario: 'tls-trust', kind, comparisonHash: p.comparisonHash, expectedReviewHead: p.reviewHead,
    reviewer: '', decision: kind === 'cause' ? 'request-changes' : 'select', remedy: null, causeReviewHash: kind === 'remedy' ? p.cause!.reviewHash : null, rationale: '' };
}

export function appendConnectivityReview(dir: string, input: unknown, now = new Date()) {
  checkInput(input);
  const value = input as ConnectivityReviewInput, root = directory(dir);
  if (value.rationale.trim().length < 10) fail('Provide a substantive review rationale.');
  return appendChain<ConnectivityReviewInput>(root, FILE, LOCK, now, () => {
    const packet = inspectConnectivityReview(root, now);
    if (value.comparisonHash !== packet.comparisonHash || value.expectedReviewHead !== packet.reviewHead) fail('Review input is outdated. Generate a fresh template and inspect the comparison.');
    if (value.kind === 'cause' && value.decision === 'accept' && packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent acceptance.');
    if (value.kind === 'remedy') {
      if (packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent remedy selection.');
      if (!packet.cause || value.causeReviewHash !== packet.cause.reviewHash) fail('Remedy selection requires the current accepted cause review.');
    }
    return { runId: packet.runId, sequence: packet.reviews.length + 1, previousHash: packet.reviewHead, previousAt: packet.reviews.at(-1)?.recordedAt, input: value };
  });
}

// Wording 1 is frozen for bundle1 exports. Wording 2 separates the TLS the connection string asked for from the TLS
// the attempt reached, and labels the host-name result of an unverified session as the lab's own check afterwards.
const phaseOf = (s: ConnectivityStep) => s.id.slice('attempt-'.length) as ConnectivityPhase;
const tlsReached = (s: ConnectivityStep) => s.stages.serverAcceptedTls === 'passed';
const notReached = (s: ConnectivityStep) => `TLS not reached${s.failure ? ` (failed at ${STAGE_LABELS[s.failure.stage]})` : ''}`;
export function tlsRequestText(s: ConnectivityStep) {
  const e = s.effectiveTls, sslmode = PHASE_SPECS[phaseOf(s)].sslmode;
  if (e) return `certificate checks ${e.rejectUnauthorized ? 'on' : 'off'}, CA ${e.caSource}, TLS name ${e.serverName}${tlsReached(s) ? '' : '; ' + notReached(s)}`;
  return sslmode === 'disable' ? 'TLS not requested (sslmode disable)' : `sslmode ${sslmode} requested, ${notReached(s)}`;
}
export function tlsResultText(s: ConnectivityStep) {
  if (!s.tls) return '';
  return s.effectiveTls?.rejectUnauthorized ? 'chain and host name verified during the TLS handshake'
    : `chain not verified; host name ${s.tls.hostnameCheck === 'passed' ? 'matched' : 'did not match'} in a check the lab ran afterwards, not enforced on this connection`;
}
export const describeAttempt = (s: ConnectivityStep, wording: 1|2 = 2) => `${s.outcome}` + (wording === 1
  ? (s.effectiveTls ? `; certificate checks ${s.effectiveTls.rejectUnauthorized ? 'on' : 'off'}, CA ${s.effectiveTls.caSource}, TLS name ${s.effectiveTls.serverName}` : '; TLS not requested') +
    (s.tls ? `; chain ${s.tls.authorized ? 'verified' : 'not verified'}, host name ${s.tls.hostnameCheck}` : '')
  : `; ${tlsRequestText(s)}` + (s.tls ? `; ${tlsResultText(s)}` : '')) +
  (s.session ? `; session role ${s.session.role}, database ${s.session.database}, encrypted ${s.session.ssl}` : '') + `; server log: ${s.serverLog.length ? s.serverLog.join(', ') : 'no entries (inconclusive)'}`;
export function formatConnectivityReview(p: ReturnType<typeof inspectConnectivityReview>) {
  const display = (value: unknown) => canonical(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const line = (s: ConnectivityStep) => `- ${s.id} (${s.label}): ${describeAttempt(s)}`;
  return ['# Connection strings, authentication and TLS review', '', `Run: ${p.runId}`, `Evidence: ${p.status} (${p.evidenceStatus}; window ends ${p.expiresAt})`, `Cause review: ${p.reviewStatus}`,
    `Remedy: ${p.remedySelection ? p.remedySelection.remedy : 'not selected'}`, `Comparison hash: ${p.comparisonHash}`, `Review head: ${p.reviewHead}`, '',
    `Candidate for human review: ${p.candidateText}`, '',
    '## Baseline, failure and fix', '', line(p.baseline), line(p.failure), line(p.fix), '',
    'Between the failure and the fix, only the trusted CA changed. Destination, TLS name, certificate checks, role, database and query stayed the same.', '',
    '## Controls', '', ...p.controls.map(line), '',
    '## Remedies', '', ...CONNECTIVITY_REMEDIES.map(r => `- ${r}: ${p.remedies[r].description}`), '',
    `Configuration: PostgreSQL ${p.configuration.postgresVersion}; Node ${p.configuration.versions.node}; pg ${p.configuration.versions.pg}; pg-connection-string ${p.configuration.versions.pgConnectionString}; ${p.configuration.versions.openssl}; server certificate ${p.configuration.certificates.server.altNames}; cleanup ${p.configuration.cleanup}.`, '',
    '## Competing explanations', '', ...p.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    ...(p.blockers.length ? ['## Blockers', '', ...p.blockers.map(b => `- ${b}`), ''] : []),
    ...(p.reviews.length ? ['## Decision history', '', ...p.reviews.map(r => `- ${r.recordedAt}: ${r.input.kind}; ${r.input.reviewer}; ${r.input.decision}${r.input.remedy ? ' ' + r.input.remedy : ''}; rationale: ${display(r.input.rationale)}; hash ${r.hash}`), ''] : []),
    `Cause: ${p.cause ? 'human-accepted, scoped to this local experiment' : 'unset'}. Customer resolution: unset.`, '', p.limitation, '',
    'Cause choices: accept, reject, or request-changes. After acceptance, select the remedy for validation. Each decision binds to this comparison hash.', ''].join('\n');
}
