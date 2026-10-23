import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../src/contracts.ts';
import { createCase, appendObservation, inspectLedger } from '../src/ledger.ts';
import { labCatalog, labPlan } from '../src/native-lab.ts';

// These records simulate the native artifact protocol for adversarial tests.
// Only native-lab.integration.ts executes PostgreSQL and verifies measured output.
export function nativeProtocolFixture(t: any, edit?: (phase: string, config: any, observations: any[]) => void) {
  const root = mkdtempSync(join(tmpdir(), 'review-test-')); t.after(() => rmSync(root, {recursive:true,force:true}));
  const now = new Date(), runId = '12345678-1234-1234-1234-123456789abc';
  const clusterFingerprint = hash('test-cluster'), catalog = labCatalog();
  const snapshots: Record<string, any> = {};
  for (const phase of ['development','before','search-path-control','after']) {
    const control = phase === 'search-path-control', failed = phase === 'before' || control, present = phase !== 'before';
    const database = control ? 'pslab_search_path' : phase === 'development' ? 'pslab_development' : 'pslab_affected';
    const scope = {environment:'local-lab',branchFingerprint:hash(database),roleFingerprint:hash('pslab_app'),connectionMode:'direct',identityMethod:'lab-marker'};
    const searchPath = control ? ['public'] : ['app_data','public'];
    const config = {schemaVersion:3,caseId:phase,profile:'local-lab',scope,
      subject:{relation:'project_labels',schema:'app_data',migrationId:'002_project_labels',queryShapeHash:hash(catalog.queries.failure_observation),expectedBranchFingerprint:scope.branchFingerprint},
      intake:{schemaVersion:1,report:'Synthetic application cannot resolve project_labels.',expectedBehavior:'The application can count project labels.',sqlstate:'42P01',relation:'project_labels',environment:'local-lab',connectionMode:'direct',dataSensitivity:'synthetic'}};
    const results: Record<string, any> = {
      target_identity:{expectedBranchFingerprint:scope.branchFingerprint,observedBranchFingerprint:scope.branchFingerprint,method:'lab-marker',serverVersion:'170011',clusterFingerprint},
      effective_context:{database,roleFingerprint:scope.roleFingerprint,searchPath,currentSchema:searchPath[0]},
      relation_inventory:{relation:'project_labels',schema:'app_data',present,visible:present&&!control,coverage:'visible-to-role'},
      permissions:{relation:'project_labels',schema:'app_data',schemaUsage:true,relationSelect:present?true:null},
      migration_state:{migrationId:'002_project_labels',targetBranchFingerprint:scope.branchFingerprint,applied:present},
      failure_observation:{relation:'project_labels',schema:'app_data',sqlstate:failed?'42P01':null,queryShapeHash:hash(catalog.queries.failure_observation),outcome:failed?'error':'success',matchingRows:failed?null:'1'},
    };
    function observation(kind: string, qualified = false) {
      return {schemaVersion:3,kind,artifactId:`${phase}-${kind}${qualified?'-qualified':''}`,caseId:phase,classification:'REPRODUCED_BEHAVIOR',
        source:{type:'local-lab',id:'schema-drift',version:'1',runId},scope,probeId:qualified?'qualified_control':kind,
        queryHash:hash(qualified?catalog.qualifiedQuery:catalog.queries[kind]),collectionScope:'single-lab-connection',
        collectedAt:now.toISOString(),expiresAt:new Date(now.getTime()+3600000).toISOString(),collectorVersion:'native-lab-1',redactionStatus:'synthetic-reviewed',
        parents:kind==='target_identity'?[]:[`${phase}-target_identity`],supersedes:null,correctionReason:null,
        result:{...results[kind],...(qualified?{sqlstate:null,outcome:'success',matchingRows:'1',queryShapeHash:hash(catalog.qualifiedQuery)}:{}),limitations:'Simulated protocol for unit tests. No PostgreSQL execution.'}};
    }
    const observations = Object.keys(results).map(kind => observation(kind));
    if(control) observations.push(observation('failure_observation',true));
    edit?.(phase,config,observations);
    const dir = join(root,phase); createCase(dir,config);
    for(const o of observations) appendObservation(dir,o,now);
    const r = Object.fromEntries(observations.filter(o=>o.probeId!=='qualified_control').map(o=>[o.kind,o.result]));
    snapshots[phase] = {caseId:phase,database:r.effective_context.database,outcome:r.failure_observation.outcome,sqlstate:r.failure_observation.sqlstate,
      matchingRows:r.failure_observation.matchingRows===null?null:Number(r.failure_observation.matchingRows),qualifiedRows:control?1:null,
      migrationApplied:r.migration_state.applied,relationPresent:r.relation_inventory.present,relationVisible:r.relation_inventory.visible,
      searchPath:r.effective_context.searchPath,branchFingerprint:scope.branchFingerprint,roleFingerprint:scope.roleFingerprint,queryShapeHash:config.subject.queryShapeHash,
      evidenceIds:observations.map(o=>o.artifactId),headHash:inspectLedger(dir,now).headHash,coverage:failed?6:5,collectedAt:now.toISOString()};
  }
  const run = {schemaVersion:1,runId,profile:'local-lab',status:'COMPLETE',cleanup:'COMPLETE',failedStage:null,snapshots,
    migrationHash:hash(catalog.migration),clusterFingerprint,cause:null,resolution:null,reviewStatus:'NOT_REVIEWED',note:'Test protocol only.'};
  for(const [name,value] of Object.entries({'run.json':run,'probes.json':catalog,'plan.json':{...labPlan(),runId,approved:true}})) writeFileSync(join(root,name),JSON.stringify(value));
  return {root,now,run};
}
