import { validationRecord } from './validation-core.ts';
import { inspectPermissionsReview } from './permissions-review.ts';
import type { PermissionsStep } from './permissions-review.ts';
import { APP_ROLE, FIX_GRANT, PERMISSIONS_QUERIES } from './permissions-evidence.ts';
import type { QueryResult } from './permissions-evidence.ts';
import { canonical } from './contracts.ts';

// Checks retained evidence from the completed run. No server is started or queried here.
// The fix counts only when the one added grant is an ordinary SELECT for the application role and nothing else changed.
export function validatePermissions(dir: string, now = new Date()) {
  const review = inspectPermissionsReview(dir, now), selection = review.remedySelection, remedy = selection?.remedy ?? null;
  const { baseline, failure, fix, privilegeChange: change } = review;
  const remedySteps = remedy ? review.remedies[remedy].evidence : [];
  const control = (id: string) => review.controls.find(c => c.id === id)!;
  const ok = (r: QueryResult) => r.ok && r.rowCount === 1 && r.sqlstate === null;
  const denied = (r: QueryResult, error: string, sqlstate: string) => !r.ok && r.sqlstate === sqlstate && r.error === error;
  const readOnly = (s: PermissionsStep) => !s.privileges.insert && !s.privileges.update && !s.privileges.delete && !s.privileges.truncate && !s.privileges.schemaCreate;
  const wrongRole = control('attempt-wrong-role'), noUsage = control('attempt-schema-usage-missing'), path = control('attempt-search-path-missing'), wrongAfter = control('attempt-wrong-role-after-fix');
  const checks = [
    { id: 'fresh-compatible-evidence', passed: review.status === 'READY_FOR_REVIEW', evidence: review.evidence.map(e => e.id) },
    { id: 'explicit-cause-review', passed: review.reviewStatus === 'ACCEPTED_LOCAL_LAB', evidence: review.cause ? [review.cause.reviewHash] : [] },
    { id: 'remedy-selected', passed: selection !== null, evidence: selection ? [selection.selectionHash] : [] },
    { id: 'verified-baseline', passed: baseline.context.currentUser === APP_ROLE && ok(baseline.unqualified) && ok(baseline.qualified) && baseline.privileges.select === true, evidence: [baseline.id] },
    { id: 'original-failure-is-missing-table-select', passed: failure.context.currentUser === APP_ROLE && failure.context.sessionUser === APP_ROLE && failure.privileges.schemaUsage &&
        failure.context.searchPath.includes('app_data') && failure.catalog.exists && failure.catalog.visible === true && failure.privileges.select === false &&
        denied(failure.unqualified, 'permission-denied-table', '42501') && denied(failure.qualified, 'permission-denied-table', '42501'), evidence: [failure.id] },
    { id: 'controls-separate-role-schema-and-search-path', passed: wrongRole.context.currentUser !== APP_ROLE && canonical(wrongRole.unqualified) === canonical(failure.unqualified) &&
        !noUsage.privileges.schemaUsage && denied(noUsage.unqualified, 'relation-does-not-exist', '42P01') && denied(noUsage.qualified, 'permission-denied-schema', '42501') &&
        path.privileges.schemaUsage && denied(path.unqualified, 'relation-does-not-exist', '42P01') && ok(path.qualified), evidence: [wrongRole.id, noUsage.id, path.id] },
    // The grant option is part of the comparison: SELECT WITH GRANT OPTION would let the application role pass it on.
    { id: 'only-ordinary-select-added', passed: change.statement === PERMISSIONS_QUERIES.fix && change.removed.length === 0 && canonical(change.added) === canonical([FIX_GRANT]) &&
        change.rolesUnchanged && change.defaultPrivilegeEntries === 0, evidence: [failure.id, fix.id] },
    { id: 'privileges-match-grant-snapshots', passed: change.snapshotMismatches.length === 0, evidence: review.evidence.map(e => e.id) },
    { id: 'same-query-same-role-after-fix', passed: remedy === 'grant-table-select' && remedySteps.length === 1 && remedySteps[0].id === fix.id &&
        fix.context.currentUser === failure.context.currentUser && fix.table === failure.table && ok(fix.unqualified) && ok(fix.qualified) && fix.privileges.select === true, evidence: remedySteps.map(s => s.id) },
    { id: 'read-only-after-fix', passed: readOnly(fix) && readOnly(failure), evidence: [failure.id, fix.id] },
    { id: 'grant-reached-only-the-application-role', passed: wrongAfter.context.currentUser !== APP_ROLE && wrongAfter.privileges.select === false &&
        denied(wrongAfter.unqualified, 'permission-denied-table', '42501') && denied(wrongAfter.qualified, 'permission-denied-table', '42501'), evidence: [wrongAfter.id] },
  ];
  return validationRecord({ scenario: 'table-privilege', runId: review.runId,
    comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, causeReviewHash: review.cause?.reviewHash ?? null,
    remedy, remedySelectionHash: selection?.selectionHash ?? null, checkedAt: now.toISOString(),
    basis: 'Retained checks and grant snapshots from the completed run. No database connection is made during validation. The fix counts only when the single added grant is SELECT on app_data.project_tasks for the application role without the grant option, every check agrees with the grant snapshots, and the same query by the same role then succeeds with no write access.',
    verification: remedy ? { statement: change.statement, added: change.added, removed: change.removed, role: fix.context.currentUser,
      unqualified: fix.unqualified, qualified: fix.qualified, writePrivileges: !readOnly(fix) } : null },
    checks,
    [...review.blockers, ...(!review.cause ? ['An applicable acceptance of the local cause is required.'] : []),
      ...(review.cause && !selection ? ['Select the remedy this validation should claim.'] : [])],
    'Validates granting SELECT on app_data.project_tasks to the application role, without the grant option, in the recorded local experiment. The cluster has been removed. Other tables and roles, row-level security, column privileges, default privileges for tables created later, PlanetScale and the customer environment remain unverified.');
}
