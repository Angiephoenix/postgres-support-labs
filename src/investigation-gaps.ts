import { readLedgerSnapshot } from './ledger.ts';
import { requirements, gaps } from './gaps.ts';
import { fail, hash } from './contracts.ts';
import type { TypedObservation, InvestigationCase } from './contracts.ts';
function matchesSubject(o:TypedObservation,c:InvestigationCase): boolean {
  const s=c.subject;
  switch(o.kind) {
    case 'target_identity':return o.result.expectedBranchFingerprint===s.expectedBranchFingerprint;
    case 'effective_context':return true;
    case 'relation_inventory':case 'permissions':return o.result.relation===s.relation && o.result.schema===s.schema;
    case 'migration_state':return o.result.migrationId===s.migrationId;
    case 'failure_observation':return o.result.relation===s.relation && o.result.schema===s.schema && o.result.queryShapeHash===s.queryShapeHash;
  }
}
export function investigationGaps(dir:string,now=new Date()) {
  // Load, validate and evaluate one snapshot to keep the report internally consistent.
  const snapshot=readLedgerSnapshot(dir,now);
  const c=snapshot.case;
  if(c.schemaVersion===1) fail('Ledger gaps requires a version-two case with bound intake. Existing version-one cases remain readable through ledger inspect.');
  if(gaps(c.intake).issueFamily!=='schema-resolution') fail('The current evidence contract covers schema-resolution investigations.');
  const items=requirements.map(requirement=>{
    const usable:TypedObservation[]=[];
    const observedFacts=new Set<string>();
    const excluded:{artifactId:string;reason:string}[]=[];
    for(const entry of snapshot.entries) {
      const o=entry.observation;
      if(o.schemaVersion===1 || o.kind!==requirement.id) continue;
      if(!matchesSubject(o,c)) {excluded.push({artifactId:o.artifactId,reason:'SUBJECT_MISMATCH'});continue;}
      const status=snapshot.status.get(o.artifactId)!;
      if(status!=='CURRENT') {excluded.push({artifactId:o.artifactId,reason:status});continue;}
      if(o.kind!=='target_identity' && c.scope.branchFingerprint!==c.subject.expectedBranchFingerprint) {excluded.push({artifactId:o.artifactId,reason:'AFFECTED_BRANCH_MISMATCH'});continue;}
      const {limitations,...facts}=o.result;
      observedFacts.add(hash(facts));
      // A success observation cannot provide the original reported failure.
      if(o.kind==='failure_observation' && (o.result.outcome!=='error' || (c.intake.sqlstate && c.intake.sqlstate!=='unknown' && o.result.sqlstate!==c.intake.sqlstate))) {
        excluded.push({artifactId:o.artifactId,reason:'REPORTED_FAILURE_MISMATCH'});continue;
      }
      usable.push(o);
    }
    const status=observedFacts.size>1?'CONFLICTING':usable.length?'SATISFIED':excluded.length?'UNUSABLE':'MISSING';
    return {...requirement,status,evidence:usable.map(o=>({artifactId:o.artifactId,source:o.source,collectedAt:o.collectedAt,expiresAt:o.expiresAt,limitations:o.result.limitations})),excluded};
  });
  const satisfied=items.filter(x=>x.status==='SATISFIED').length;
  const legacyIds=snapshot.entries.filter(e=>e.observation.schemaVersion===1).map(e=>e.observation.artifactId);
  return {schemaVersion:1,caseId:c.caseId,profile:c.profile,scope:c.scope,subject:c.subject,
    checkedAt:snapshot.checkedAt,ledgerHeadHash:snapshot.summary.headHash,
    status:satisfied===items.length?(c.profile==='fixture'?'FIXTURE_EVIDENCE_COMPLETE':'LOCAL_LAB_EVIDENCE_COMPLETE'):'EVIDENCE_REQUIRED',
    satisfied,total:items.length,requirements:items,unmappedLegacyEvidence:legacyIds,
    intakeBasis:c.profile==='fixture'?'The intake is bound to this case. Observations have caller-supplied synthetic provenance.':'The intake is bound to this local lab case. Source labels and hashes are inspectable; they do not authenticate who ran the collector.',
    cause:null,resolution:null,reviewStatus:'NOT_REVIEWED',
    note:'Satisfied means the required scoped observation is available. This report does not validate a customer environment or establish a cause.'};
}
export function investigationMarkdown(dir:string,now=new Date()):string {
  const r=investigationGaps(dir,now);
  return ['# Investigation evidence report','',`Case: ${r.caseId}`,`Profile: ${r.profile}`,`Status: ${r.status}`,`Coverage: ${r.satisfied}/${r.total}`,`Checked: ${r.checkedAt}`,`Ledger head: ${r.ledgerHeadHash}`,'',r.intakeBasis,'',...r.requirements.flatMap(x=>[
    `## ${x.id.replaceAll('_',' ')}: ${x.status}`,'',x.why,'',
    ...x.evidence.map(e=>`Evidence: ${e.artifactId}; ${e.source.type} ${e.source.id} v${e.source.version}; collected ${e.collectedAt}; expires ${e.expiresAt}. Limits: ${e.limitations}`),
    ...x.excluded.map(e=>`Excluded: ${e.artifactId} (${e.reason}).`),
    ...(x.status==='SATISFIED'?[]:[`Collect: ${x.collect}`,`Follow-up: ${x.question}`]),''
  ]),...(r.unmappedLegacyEvidence.length?[`Legacy records requiring typed replacement: ${r.unmappedLegacyEvidence.join(', ')}`,'']:[]),r.note,'Cause: unset. Resolution: unset. Human review: pending.',''].join('\n');
}
