import { hash } from '../src/contracts.ts';
import type { InvestigationCase, Kind, Results, TypedObservation } from '../src/contracts.ts';
export function investigationFixture(now:Date) {
  const scope={environment:'lab-production',branchFingerprint:hash('synthetic-main'),roleFingerprint:hash('synthetic-app'),connectionMode:'direct',identityMethod:'fixture-definition'} as const;
  const subject={relation:'project_labels',schema:'public',migrationId:'002_project_labels',queryShapeHash:hash('fixture-project-labels-query'),expectedBranchFingerprint:scope.branchFingerprint};
  const config:InvestigationCase={schemaVersion:2,caseId:'schema-case',profile:'fixture',scope,subject,intake:{schemaVersion:1,report:'The migration command reported success, but relation project_labels does not exist.',expectedBehavior:'Read project labels.',environment:scope.environment,relation:subject.relation,connectionMode:'direct',sqlstate:'42P01',branch:'unknown',dataSensitivity:'synthetic'}};
  const limitations='Synthetic fixture input. No database query was executed.';
  const results:Results={
    target_identity:{expectedBranchFingerprint:scope.branchFingerprint,observedBranchFingerprint:scope.branchFingerprint,method:'fixture-definition',limitations},
    effective_context:{database:'project_tracker',roleFingerprint:scope.roleFingerprint,searchPath:['public'],currentSchema:'public',limitations},
    relation_inventory:{relation:'project_labels',schema:'public',visible:false,coverage:'visible-to-role',limitations},
    permissions:{relation:'project_labels',schema:'public',schemaUsage:true,relationSelect:false,limitations},
    migration_state:{migrationId:subject.migrationId,targetBranchFingerprint:scope.branchFingerprint,applied:false,limitations},
    failure_observation:{relation:'project_labels',schema:'public',sqlstate:'42P01',queryShapeHash:subject.queryShapeHash,outcome:'error',limitations}
  };
  const observations=(Object.keys(results) as Kind[]).map(kind=>({schemaVersion:2,artifactId:kind+'-001',caseId:config.caseId,classification:'REPRODUCED_BEHAVIOR',source:{type:'fixture',id:'schema-drift',version:'2'},scope,kind,probeId:kind,queryHash:hash('fixture-probe-'+kind),collectionScope:'Bounded fixture '+kind,collectedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60000).toISOString(),collectorVersion:'fixture-import-2',redactionStatus:'synthetic-reviewed',parents:[],supersedes:null,correctionReason:null,result:results[kind]}) as TypedObservation);
  return {config,observations};
}
