import { inspectPoolingReview } from './pooling-review.ts';
import { validatePooling } from './pooling-validation.ts';
import { loadProfile } from './platform-profile.ts';
import type { PlatformProfile } from './platform-profile.ts';

export const PROFILE_CHECK_SCOPE = 'This check compares a local lab run with PlanetScale documentation. It did not connect to PlanetScale or to a customer environment, and it does not show how either one behaves.';

// Sets a reviewed local PgBouncer run beside the PlanetScale profile in three separate groups:
// what the local run measured, what PlanetScale documents, and what to ask the customer.
// Local findings appear only while the run's evidence is fresh and a person has accepted its cause,
// the same gates that review and validation use. Documentation is never treated as an observation.
export function poolingProfileCheck(dir: string, now = new Date(), profile: PlatformProfile = loadProfile()) {
  const review = inspectPoolingReview(dir, now), validation = validatePooling(dir, now);
  const accepted = review.reviewStatus === 'ACCEPTED_LOCAL_LAB';
  const fact = (id: string) => profile.facts.find(f => f.id === id)!;
  const { first, next } = review.backendSwitch, reset = review.controls.directReset, config = review.configuration;
  const remedy = review.remedySelection?.remedy ?? null, validated = validation.status === 'RESOLUTION_VALIDATED';

  const localFindings = !accepted ? [] : [
    { id: 'sql-prepare-after-switch', classification: 'REPRODUCED_BEHAVIOR', scope: 'local-lab', evidence: [first.id, next.id],
      statement: `In the local run, a SQL PREPARE statement worked on backend ${first.backend}, then EXECUTE failed with SQLSTATE ${next.sqlstate} after PgBouncer ran the next transaction on backend ${next.backend}.` },
    { id: 'same-error-without-pooler', classification: 'REPRODUCED_BEHAVIOR', scope: 'local-lab', evidence: [reset.id],
      statement: `The direct reset control produced the same SQLSTATE ${reset.sqlstate} with no pooler, so the error code alone does not show that a pooler was involved.` },
    ...(remedy && validated ? [{ id: 'selected-fix-validated', classification: 'REPRODUCED_BEHAVIOR', scope: 'local-lab', evidence: review.remedies[remedy].evidence.map(s => s.id),
      statement: `The selected fix, ${remedy}, passed local validation with the local PgBouncer in ${config.poolMode} mode and max_prepared_statements set to ${config.maxPreparedStatements}.` }] : []),
  ];
  // Where a local setting and a documented fact concern the same thing. These are comparisons, not tests.
  const comparisons = !accepted ? [] : [
    { local: `The local PgBouncer ran in ${config.poolMode} pooling mode.`, documented: ['pooling-transaction-mode-only', 'pooling-per-transaction-assignment'],
      note: 'PlanetScale documents the same pooling mode for its managed PgBouncers. That does not show the local result applies to a PlanetScale branch.' },
    { local: 'SQL PREPARE did not survive a change of server connection between transactions.', documented: ['pooling-prepared-statements'],
      note: 'PlanetScale lists prepared statements that persist across transactions as limited under transaction pooling.' },
    { local: `The local run set max_prepared_statements to ${config.maxPreparedStatements}.`, documented: ['pooling-max-prepared-statements-default'],
      note: 'PlanetScale documents a default of 200. The values differ, and only the local value was tested.' },
  ];
  const blockers = accepted ? [] : [...review.blockers, ...(review.reviewStatus === 'NOT_REVIEWED' ? ['A person must accept the local cause before local findings are shown.']
    : review.reviewStatus !== 'ACCEPTED_LOCAL_LAB' ? [`The cause review is ${review.reviewStatus}. Local findings are withheld.`] : [])];
  return {
    schemaVersion: 1, artifactType: 'profile-check', scenario: 'pooling-session', runId: review.runId, checkedAt: now.toISOString(),
    profile: { id: profile.id, sources: profile.sources.map(s => ({ id: s.id, url: s.url, retrievedAt: s.retrievedAt, markdownSha256: s.markdownSha256 })) },
    evidenceStatus: review.evidenceStatus, expiresAt: review.expiresAt, reviewStatus: review.reviewStatus,
    comparisonHash: review.comparisonHash, reviewHead: review.reviewHead,
    localStatus: accepted ? 'SHOWN' : 'WITHHELD', blockers, localFindings, comparisons,
    documentedFacts: profile.facts.map(f => ({ id: f.id, topic: f.topic, classification: f.classification, statement: f.statement,
      source: profile.sources.find(s => s.id === f.sourceId)!.url, passage: f.passage })),
    customerQuestions: profile.customerQuestions.map(q => ({ ...q, classification: 'CUSTOMER_EVIDENCE_NEEDED' })),
    platformTested: false, customerEnvironmentTested: false, customerResolution: null, scope: PROFILE_CHECK_SCOPE,
  };
}

export function formatProfileCheck(c: ReturnType<typeof poolingProfileCheck>) {
  const facts = new Map(c.documentedFacts.map(f => [f.id, f]));
  return ['# PgBouncer run compared with the PlanetScale profile', '', c.scope, '',
    `Run: ${c.runId}`, `Evidence: ${c.evidenceStatus} (window ends ${c.expiresAt})`, `Cause review: ${c.reviewStatus}`, `Checked: ${c.checkedAt}`, '',
    '## What the local run measured', '',
    ...(c.localStatus === 'SHOWN' ? c.localFindings.map(f => `- ${f.statement} (${f.classification}, ${f.scope}; ${f.evidence.join(', ')})`)
      : ['Withheld. Local findings appear only while the evidence is fresh and a person has accepted the cause.', '', ...c.blockers.map(b => `- ${b}`)]), '',
    ...(c.comparisons.length ? ['## Local settings beside documented facts', '', ...c.comparisons.map(x => `- ${x.local} ${x.note} (see ${x.documented.join(', ')})`), ''] : []),
    '## What PlanetScale documents', '',
    ...c.profile.sources.map(s => `Source: ${s.url}, retrieved ${s.retrievedAt}, Markdown sha256 ${s.markdownSha256}`), '',
    ...c.documentedFacts.map(f => `- ${f.statement} (${f.classification}, ${f.topic}, ${f.id})`), '',
    '## What to ask the customer', '',
    ...c.customerQuestions.map(q => `- ${q.question}${q.facts.length ? ` Related: ${q.facts.map(id => facts.get(id)!.id).join(', ')}.` : ''}`), '',
    'Customer resolution: unset. PlanetScale tested: no. Customer environment tested: no.', ''].join('\n');
}
