import { join } from 'node:path';
import { validationRecord } from './validation-core.ts';
import { readLedgerSnapshot } from './ledger.ts';
import { inspectLabReview } from './lab-review.ts';

export function validateLab(dir: string, now = new Date()) {
  const review = inspectLabReview(dir, now);
  const before = readLedgerSnapshot(join(dir, 'before'), now), after = readLedgerSnapshot(join(dir, 'after'), now);
  const failures = [before, after].map(s => s.entries.find(e => e.observation.probeId === 'failure_observation')!.observation);
  const original = failures[0], post = failures[1];
  const accepted = review.reviewStatus === 'ACCEPTED_LOCAL_LAB';
  const checks = [
    { id: 'fresh-compatible-evidence', passed: review.status === 'READY_FOR_REVIEW', evidence: review.evidence.flatMap(e => e.artifactIds) },
    { id: 'explicit-cause-review', passed: accepted, evidence: review.reviews.at(-1) ? [review.reviews.at(-1)!.hash] : [] },
    { id: 'original-failure-reproduced', passed: (original.result as any).sqlstate === '42P01', evidence: [original.artifactId] },
    { id: 'post-change-query-succeeds', passed: (post.result as any).outcome === 'success' && (post.result as any).sqlstate === null, evidence: [post.artifactId] },
    { id: 'expected-row-count', passed: (post.result as any).matchingRows === '1', evidence: [post.artifactId] },
  ];
  return validationRecord({ runId: review.runId,
    comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, checkedAt: now.toISOString(),
    originalFailure: { artifactId: original.artifactId, collectedAt: original.collectedAt, ledgerHead: before.summary.headHash },
    postChange: { artifactId: post.artifactId, collectedAt: post.collectedAt, ledgerHead: after.summary.headHash },
    target: before.case.scope, declaredAction: review.declaredChange, migrationHash: review.migrationHash },
    checks,
    [...review.blockers, ...(!accepted ? ['An applicable acceptance of the local cause is required.'] : [])],
    'Validates the recorded query and expected row count in the disposable local lab. The cluster has been removed. Customer environments and broader application behavior remain unverified.');
}
