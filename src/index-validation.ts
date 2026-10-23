import { validationRecord } from './validation-core.ts';
import { inspectIndexReview, INDEX_NAME } from './index-review.ts';
import type { IndexStep } from './index-review.ts';

const INDEX_PLANS = ['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'];

// Checks retained plans from the completed run. No server is started or queried here.
// Timing is reported as supporting local evidence; no speedup threshold is checked.
export function validateIndex(dir: string, now = new Date()) {
  const review = inspectIndexReview(dir, now), selection = review.remedySelection, remedy = selection?.remedy ?? null;
  const { before, after } = review, data = review.configuration.data;
  const pairs: [IndexStep, IndexStep][] = [[before.first, after.first], [before.repeat, after.repeat]];
  const measured = [before.first, before.repeat, after.first, after.repeat];
  const usesIndex = (s: IndexStep) => INDEX_PLANS.includes(s.scanNode) && s.indexName === INDEX_NAME;
  const checks = [
    { id: 'fresh-compatible-evidence', passed: review.status === 'READY_FOR_REVIEW', evidence: review.evidence.map(e => e.id) },
    { id: 'explicit-cause-review', passed: review.reviewStatus === 'ACCEPTED_LOCAL_LAB', evidence: review.cause ? [review.cause.reviewHash] : [] },
    { id: 'remedy-selected', passed: selection !== null, evidence: selection ? [selection.selectionHash] : [] },
    { id: 'same-data-query-role-and-settings', passed: data.fingerprintBefore === data.fingerprintAfter &&
        measured.every(s => s.value === 'rare' && s.columnStatistics && s.queryHash === before.first.queryHash && s.settingsHash === before.first.settingsHash && s.role === before.first.role && s.database === before.first.database),
      evidence: measured.map(s => s.id) },
    { id: 'unchanged-result', passed: measured.every(s => s.result.orders === before.first.result.orders && s.result.total === before.first.result.total), evidence: measured.map(s => s.id) },
    { id: 'index-absent-before', passed: [before.first, before.repeat].every(s => !s.indexPresent && s.indexName === null), evidence: [before.first.id, before.repeat.id] },
    { id: 'selected-index-used-after', passed: remedy === 'create-index' && [after.first, after.repeat].every(s => s.indexPresent && usesIndex(s)), evidence: [after.first.id, after.repeat.id] },
    { id: 'less-work-after', passed: remedy === 'create-index' && pairs.every(([b, a]) => a.buffers.total < b.buffers.total), evidence: measured.map(s => s.id) },
  ];
  return validationRecord({ scenario: 'slow-query-index', runId: review.runId,
    comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, causeReviewHash: review.cause?.reviewHash ?? null,
    remedy, remedySelectionHash: selection?.selectionHash ?? null, checkedAt: now.toISOString(),
    basis: 'Retained plans and results from the completed run. No database connection is made during validation. Work is compared by shared buffer blocks; timing is supporting local evidence with no required speedup.',
    timing: { beforeMs: [before.first.executionMs, before.repeat.executionMs], afterMs: [after.first.executionMs, after.repeat.executionMs], scope: 'local-lab' } },
    checks,
    [...review.blockers, ...(!review.cause ? ['An applicable acceptance of the local cause is required.'] : []),
      ...(review.cause && !selection ? ['Select the remedy this validation should claim.'] : [])],
    'Validates the selected index for this query and synthetic data in the recorded local experiment. The server has been removed. Other queries, data distributions, write overhead from the index and customer environments remain unverified.');
}
