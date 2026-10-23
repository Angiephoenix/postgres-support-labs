import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCase, appendObservation, inspectLedger } from '../src/ledger.ts';
import { hash } from '../src/contracts.ts';
const root=mkdtempSync(join(tmpdir(),'pslab-demo-'));
try {
  const dir=join(root,'case');
  const scope={environment:'lab-production',branchFingerprint:hash('synthetic-main'),roleFingerprint:hash('synthetic-app'),connectionMode:'direct',identityMethod:'fixture-definition'};
  createCase(dir,{schemaVersion:1,caseId:'demo-case',profile:'fixture',scope});
  const now=new Date();
  const observation={schemaVersion:1,artifactId:'obs-001',caseId:'demo-case',classification:'REPRODUCED_BEHAVIOR',source:{type:'fixture',id:'schema-drift',version:'1'},scope,probeId:'relation-inventory',queryHash:hash('fixture-inventory-v1'),collectionScope:'project_labels in public under synthetic-app',collectedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60000).toISOString(),collectorVersion:'fixture-import-1',redactionStatus:'synthetic-reviewed',parents:[],supersedes:null,correctionReason:null,result:{relation:'project_labels',schema:'public',visible:false,sqlstate:'42P01',limitations:'Synthetic input; no database query was executed.'}};
  appendObservation(dir,observation,now);
  const first=inspectLedger(dir,now);
  console.log('Synthetic ledger demonstration. No database queries are executed.');
  console.log('Before correction:',JSON.stringify(first,null,2));
  const original=readFileSync(join(dir,'evidence.jsonl'),'utf8');
  appendObservation(dir,{...observation,artifactId:'obs-002',supersedes:'obs-001',correctionReason:'Correct the synthetic visibility record.',result:{...observation.result,visible:true,sqlstate:null}},now);
  const report=inspectLedger(dir,now);
  console.log('After correction:',JSON.stringify(report,null,2));
  console.log('Original entry preserved:',readFileSync(join(dir,'evidence.jsonl'),'utf8').startsWith(original));
  console.log('Cause and resolution remain unset. The temporary case is removed after this run.');
} finally { rmSync(root,{recursive:true,force:true}); }
