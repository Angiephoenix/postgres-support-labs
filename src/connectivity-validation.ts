import { validationRecord } from './validation-core.ts';
import { inspectConnectivityReview } from './connectivity-review.ts';
import { CHAIN_ERRORS, SERVER_NAME } from './connectivity-evidence.ts';
import { canonical } from './contracts.ts';

// Checks retained attempts from the completed run. No server is started or queried here.
// Encryption alone never satisfies the fix: the chain and host-name checks must have been on and passed.
export function validateConnectivity(dir: string, now = new Date()) {
  const review = inspectConnectivityReview(dir, now), selection = review.remedySelection, remedy = selection?.remedy ?? null;
  const { baseline, failure, fix } = review, certs = review.configuration.certificates;
  const remedySteps = remedy ? review.remedies[remedy].evidence : [];
  const verified = (s: typeof fix) => s.failure === null && s.effectiveTls !== null && s.effectiveTls.rejectUnauthorized && !s.effectiveTls.customIdentityCheck &&
    s.effectiveTls.serverName === SERVER_NAME && s.tls !== null && s.tls.authorized && s.tls.hostnameCheck === 'passed' && s.tls.serverName === SERVER_NAME &&
    s.tls.peerFingerprint === certs.server.fingerprint256 && s.session !== null && s.session.ssl;
  const settingsExceptCa = (s: typeof fix) => canonical({ ...s.effectiveTls, caSource: null });
  const checks = [
    { id: 'fresh-compatible-evidence', passed: review.status === 'READY_FOR_REVIEW', evidence: review.evidence.map(e => e.id) },
    { id: 'explicit-cause-review', passed: review.reviewStatus === 'ACCEPTED_LOCAL_LAB', evidence: review.cause ? [review.cause.reviewHash] : [] },
    { id: 'remedy-selected', passed: selection !== null, evidence: selection ? [selection.selectionHash] : [] },
    { id: 'verified-baseline', passed: verified(baseline), evidence: [baseline.id] },
    { id: 'original-failure-at-chain-verification', passed: failure.failure?.stage === 'tlsVerified' && CHAIN_ERRORS.includes(failure.failure.code ?? '') &&
        failure.stages.serverAcceptedTls === 'passed' && failure.effectiveTls?.caSource === 'default-trust-store' && failure.effectiveTls.rejectUnauthorized, evidence: [failure.id] },
    { id: 'only-trusted-ca-changed', passed: failure.shape.replace('no sslrootcert', 'sslrootcert issuing-ca') === fix.shape && settingsExceptCa(failure) === settingsExceptCa(fix) &&
        fix.effectiveTls?.caSource === 'issuing-ca', evidence: [failure.id, fix.id] },
    { id: 'chain-and-hostname-verified-after-fix', passed: remedy === 'trust-issuing-ca' && remedySteps.length === 1 && remedySteps[0].id === fix.id && verified(fix), evidence: remedySteps.map(s => s.id) },
    { id: 'same-session-as-baseline', passed: fix.session !== null && baseline.session !== null && fix.session.role === baseline.session.role && fix.session.database === baseline.session.database, evidence: [baseline.id, fix.id] },
  ];
  return validationRecord({ scenario: 'tls-trust', runId: review.runId,
    comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, causeReviewHash: review.cause?.reviewHash ?? null,
    remedy, remedySelectionHash: selection?.selectionHash ?? null, checkedAt: now.toISOString(),
    basis: 'Retained attempts from the completed run. No database connection is made during validation. The fix counts only when certificate-chain and host-name checks were turned on and passed; an encrypted but unverified session does not count.',
    verification: remedy ? { certificateChecks: fix.effectiveTls?.rejectUnauthorized ?? null, chainVerified: fix.tls?.authorized ?? null, hostnameCheck: fix.tls?.hostnameCheck ?? null,
      serverName: fix.tls?.serverName ?? null, peerFingerprint: fix.tls?.peerFingerprint ?? null } : null },
    checks,
    [...review.blockers, ...(!review.cause ? ['An applicable acceptance of the local cause is required.'] : []),
      ...(review.cause && !selection ? ['Select the remedy this validation should claim.'] : [])],
    'Validates trusting the issuing CA for this lab server and certificate in the recorded local experiment. The server and its keys have been removed. Public CAs, sslrootcert=system, other drivers, the customer network and customer certificates remain unverified.');
}
