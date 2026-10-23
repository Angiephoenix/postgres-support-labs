import { parseIntake } from './intake.ts';
type Requirement = {id: string; why: string; collect: string; question: string};
export const requirements: Requirement[] = [
  {id:'target_identity', why:'A successful migration may have targeted another environment.', collect:'Compare the sanitized application target with the platform branch identifier. Exclude connection URIs.', question:'Which branch handled the failed request, and how did you verify that target?'},
  {id:'effective_context', why:'Role and search path affect object resolution.', collect:'Collect current database, effective role and search path from the affected application connection; record time and scope.', question:'Can you provide the effective database, role and search path from the failing connection?'},
  {id:'relation_inventory', why:'A visibility-limited lookup cannot establish global absence.', collect:'Collect bounded catalog metadata for the exact relation and relevant schemas, including visibility limitations.', question:'What exact relation name and schema does the query use, including capitalization?'},
  {id:'permissions', why:'Schema visibility and relation privileges need separate checks.', collect:'Inspect schema USAGE and required relation privileges under the application role.', question:'Can the application role access the expected schema and relation?'},
  {id:'migration_state', why:'A reported successful command does not identify where it ran.', collect:'Collect sanitized migration identifiers and target-specific deployment evidence.', question:'Which migration creates this relation, and what confirms it ran on the affected branch?'},
  {id:'failure_observation', why:'The failing operation must be tied to its environment and time.', collect:'Capture sanitized SQLSTATE and identifier-only query shape; omit literals and customer rows.', question:'Can you share the SQLSTATE and sanitized query shape from the failed request?'},
];
export function gaps(input: unknown) {
  const intake = parseIntake(input);
  const family = intake.sqlstate === '42P01' || /relation\b.*\bdoes not exist/i.test(intake.report + ' ' + (intake.errorMessage ?? '')) ? 'schema-resolution' : 'unclassified';
  const unknown = Object.entries(intake).filter(([,v]) => v === 'unknown').map(([k]) => k);
  return {schemaVersion:1, status:'EVIDENCE_REQUIRED', issueFamily:family,
    classificationBasis:'Customer-reported intake; observation collection is pending.',
    cause:null, resolution:null, unknownIntakeFields:unknown,
    missingIntakeFields: ['environment','branch','connectionMode','connector','relation','sqlstate'].filter(k => !Object.hasOwn(intake,k) || intake[k] === 'unknown'),
    evidenceGaps: family === 'schema-resolution' ? requirements : [{id:'clarify_symptom',why:'The current contract covers schema-resolution reports.',collect:'Request a sanitized error and expected behavior.',question:'What exact error do you see, and which operation triggers it?'}],
    note:'Reported values remain unverified until scoped observations are collected. This report contains collection guidance only.'};
}
export function markdown(input: unknown): string {
  const r = gaps(input);
  return ['# Evidence gap report','',`Status: ${r.status}`,`Issue family: ${r.issueFamily}`,'',r.classificationBasis,'',...r.evidenceGaps.flatMap(x=>[`## ${x.id.replaceAll('_',' ')}`,'',x.why,'',`Collect: ${x.collect}`,'',`Follow-up: ${x.question}`,'']),r.note,''].join('\n');
}
