import { validationRecord } from './validation-core.ts';
import { canonical } from './contracts.ts';
import { inspectLeakReview, leakEvidenceId } from './pool-exhaustion-review.ts';
import { inspectLeak, openLeasesAt, handlerHashes, PLANS, POOL_CONFIG, SERVER_SETTINGS } from './pool-exhaustion-evidence.ts';
import type { LeakPhase, PhaseRecord } from './pool-exhaustion-evidence.ts';

// The only lines the fix may change: the original handler's release on success becomes a release in finally that passes the error.
export const EXPECTED_HANDLER_CHANGE = { removed: ['client.release();'],
  added: ['let failure;', 'try {', '} catch (error) {', 'failure = error;', 'throw error;', '} finally {', 'client.release(failure);'] };

// Checks retained evidence from the completed run. No server is started or queried here.
// Clients closed by forced cleanup after a phase was measured are never counted as released.
export function validateLeak(dir: string, now = new Date()) {
  const review = inspectLeakReview(dir, now), selection = review.remedySelection, remedy = selection?.remedy ?? null;
  const run = inspectLeak(dir, undefined, now).run, ph = Object.fromEntries(run.phases.map(p => [p.phase, p])) as Record<LeakPhase, PhaseRecord>;
  const leak = ph['leak-reproduced'], fix = ph['fix-applied'], teardown = Object.fromEntries(run.teardown.map(t => [t.phase, t]));
  const ids = (...phases: LeakPhase[]) => phases.map(leakEvidenceId);
  const outcomes = (p: PhaseRecord, step: string) => p.requests.filter(q => q.step === step).map(q => q.outcome);
  const recovered = (p: PhaseRecord) => openLeasesAt(p, p.checkpoints.at(-1)!.name).length === 0 && outcomes(p, 'recovery').every(o => o === 'ok') && outcomes(p, 'recovery').length === 1;
  const failingLeases = (p: PhaseRecord) => p.requests.filter(q => q.step === 'failing').map(q => p.leases.find(l => l.lease === q.lease)!);
  const afterFailing = fix.checkpoints.find(c => c.name === 'after-failing')!;
  const checks = [
    { id: 'fresh-compatible-evidence', passed: review.status === 'READY_FOR_REVIEW', evidence: review.evidence.map(e => e.id) },
    { id: 'explicit-cause-review', passed: review.reviewStatus === 'ACCEPTED_LOCAL_LAB', evidence: review.cause ? [review.cause.reviewHash] : [] },
    { id: 'remedy-selected', passed: selection !== null, evidence: selection ? [selection.selectionHash] : [] },
    { id: 'verified-baseline', passed: ph['baseline-valid-only'].requests.every(q => q.outcome === 'ok') && review.baseline.openCheckoutsAtEnd === 0, evidence: ids('baseline-valid-only') },
    { id: 'original-failure-is-leaked-checkouts', passed: leak.handler === 'original' && review.leak.leasesOpenAfterQuiet === PLANS.leak.failing && review.leak.leakedSessionsIdle &&
        failingLeases(leak).every(l => l.releaseSeq === null) && review.leak.probe === 'pool-checkout-timeout' && review.leak.recovery === 'pool-checkout-timeout', evidence: ids('leak-reproduced') },
    { id: 'controls-separate-demand-slow-transaction-and-refusal', passed: (['demand-beyond-capacity', 'slow-query', 'long-transaction'] as const).every(p => recovered(ph[p]) && ph[p].requests.some(q => q.outcome === 'pool-checkout-timeout')) &&
        outcomes(ph['server-refusal'], 'gated').includes('server-refused-reserved') && !ph['server-refusal'].requests.some(q => q.outcome === 'pool-checkout-timeout') && recovered(ph['server-refusal']),
      evidence: ids('demand-beyond-capacity', 'slow-query', 'long-transaction', 'server-refusal') },
    { id: 'same-request-plan-and-configuration', passed: review.samePlan && canonical(review.configuration.pool) === canonical(POOL_CONFIG) && canonical(review.configuration.server) === canonical(SERVER_SETTINGS),
      evidence: ids('leak-reproduced', 'fix-applied') },
    { id: 'only-release-handling-changed', passed: canonical(review.handlerChange) === canonical(EXPECTED_HANDLER_CHANGE) && canonical(run.handlers) === canonical(handlerHashes()) &&
        leak.handler === 'original' && fix.handler === 'fixed', evidence: ids('leak-reproduced', 'fix-applied') },
    { id: 'failing-clients-released-with-error', passed: failingLeases(fix).length === PLANS.leak.failing && failingLeases(fix).every(l => l.releasedWithError && l.releaseSeq !== null && l.releaseSeq < afterFailing.seq),
      evidence: ids('fix-applied') },
    { id: 'no-checkouts-left-after-fix', passed: remedy === 'release-in-finally' && review.fixResult.leasesOpenAfterRecovery === 0 && review.fixResult.probe === 'ok' && review.fixResult.recovery === 'ok' &&
        fix.leases.every(l => l.releaseSeq !== null), evidence: ids('fix-applied') },
    { id: 'capacity-limit-unchanged-by-fix', passed: outcomes(ph['demand-beyond-capacity-after-fix'], 'busy').includes('pool-checkout-timeout') && recovered(ph['demand-beyond-capacity-after-fix']),
      evidence: ids('demand-beyond-capacity-after-fix') },
    { id: 'forced-cleanup-not-counted-as-release', passed: teardown['leak-reproduced'].openLeases === leak.leases.filter(l => l.releaseSeq === null).length && teardown['fix-applied'].openLeases === 0,
      evidence: ids('leak-reproduced', 'fix-applied') },
  ];
  return validationRecord({ scenario: 'connection-leak', runId: review.runId,
    comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, causeReviewHash: review.cause?.reviewHash ?? null,
    remedy, remedySelectionHash: selection?.selectionHash ?? null, checkedAt: now.toISOString(),
    basis: 'Retained pool events, checkouts, pool counters and server sessions from the completed run. No database connection is made during validation. The fix counts only when the same request plan, with only the handler’s release handling changed, leaves no checkout open: every failing request releases its client with the error before the next checkpoint, and the later valid requests succeed. Clients closed by forced cleanup are never counted as released.',
    verification: remedy ? { handlerChange: review.handlerChange, releasedWithError: review.fixResult.releasedWithError, leasesOpenAfterRecovery: review.fixResult.leasesOpenAfterRecovery,
      probe: review.fixResult.probe, recovery: review.fixResult.recovery, demandAfterFixTimeouts: outcomes(ph['demand-beyond-capacity-after-fix'], 'busy').filter(o => o === 'pool-checkout-timeout').length } : null },
    checks,
    [...review.blockers, ...(!review.cause ? ['An applicable acceptance of the local cause is required.'] : []),
      ...(review.cause && !selection ? ['Select the remedy this validation should claim.'] : [])],
    'Validates releasing the client in finally, passing the error, in the recorded local experiment. The cluster has been removed. Other code paths, other pool settings, pool.query(), a larger pool, PgBouncer, PlanetScale and the customer environment remain unverified.');
}
