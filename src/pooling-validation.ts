import { validationRecord } from './validation-core.ts';
import { inspectPoolingReview } from './pooling-review.ts';

// Checks retained observations from the completed run. No server is started or queried here.
export function validatePooling(dir: string, now = new Date()) {
  const review = inspectPoolingReview(dir, now), selection = review.remedySelection, remedy = selection?.remedy ?? null;
  const { first, next } = review.backendSwitch, config = review.configuration;
  const remedySteps = remedy ? review.remedies[remedy].evidence : [];
  const switched = (a: typeof first, b: typeof first) => b.heldBackend === a.backend && b.backend !== a.backend;
  const remedyPassed = remedy === 'transaction-contained'
    ? remedySteps[0].endpoint === 'transaction' && remedySteps[0].sqlstate === null
    : remedy === 'protocol-prepared'
      ? remedySteps.every(s => s.endpoint === 'transaction' && s.sqlstate === null) && switched(remedySteps[0], remedySteps[1]) && config.poolMode === 'transaction' && config.maxPreparedStatements === 10
      : false;
  const checks = [
    { id: 'fresh-compatible-evidence', passed: review.status === 'READY_FOR_REVIEW', evidence: review.evidence.map(e => e.id) },
    { id: 'explicit-cause-review', passed: review.reviewStatus === 'ACCEPTED_LOCAL_LAB', evidence: review.cause ? [review.cause.reviewHash] : [] },
    { id: 'remedy-selected', passed: selection !== null, evidence: selection ? [selection.selectionHash] : [] },
    { id: 'original-failure-after-measured-switch', passed: next.sqlstate === '26000' && switched(first, next), evidence: [first.id, next.id] },
    { id: 'selected-remedy-succeeds', passed: remedyPassed, evidence: remedySteps.map(s => s.id) },
    { id: 'expected-row-count', passed: remedySteps.length > 0 && remedySteps.every(s => s.count === 1), evidence: remedySteps.map(s => s.id) },
  ];
  return validationRecord({ scenario: 'pooling-session', runId: review.runId,
    comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, causeReviewHash: review.cause?.reviewHash ?? null,
    remedy, remedySelectionHash: selection?.selectionHash ?? null, checkedAt: now.toISOString(),
    basis: 'Retained observations from the completed run. No database connection is made during validation.',
    configuration: remedy === 'protocol-prepared' ? { poolMode: config.poolMode, maxPreparedStatements: config.maxPreparedStatements, pgbouncerVersion: config.pgbouncerVersion } : null },
    checks,
    [...review.blockers, ...(!review.cause ? ['An applicable acceptance of the local cause is required.'] : []),
      ...(review.cause && !selection ? ['Select the remedy this validation should claim.'] : [])],
    'Validates the selected remedy for this SQL prepared-statement workflow in the recorded local experiment. The servers have been removed. Arbitrary application behavior, other session features and customer environments remain unverified.');
}
