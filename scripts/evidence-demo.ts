import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { investigationFixture } from '../examples/investigation-fixture.ts';
import { createCase, appendObservation } from '../src/ledger.ts';
import { investigationGaps, investigationMarkdown } from '../src/investigation-gaps.ts';
const root=mkdtempSync(join(tmpdir(),'pslab-evidence-'));
try {
  const now=new Date(),dir=join(root,'case');
  const {config,observations}=investigationFixture(now);
  createCase(dir,config);
  function progress(label:string,time=now) {
    const r=investigationGaps(dir,time);
    console.log(`${label}: ${r.satisfied}/${r.total} requirements satisfied; ${r.status}`);
  }
  console.log('Synthetic evidence contract demo. No database queries are executed.');
  progress('Intake only');
  appendObservation(dir,observations[0],now);
  progress('Target identity added');
  for(const o of observations.slice(1)) appendObservation(dir,o,now);
  progress('All six observation types added');
  const inventory=observations.find(o=>o.kind==='relation_inventory')!;
  appendObservation(dir,{...inventory,artifactId:'inventory-conflict',result:{...inventory.result,visible:true}},now);
  progress('Conflicting inventory added');
  appendObservation(dir,{...inventory,artifactId:'inventory-correction',supersedes:'inventory-conflict',correctionReason:'Correct the synthetic visibility value.'},now);
  progress('Conflict corrected with history preserved');
  console.log(investigationMarkdown(dir,now));
  progress('After the evidence expires',new Date(now.getTime()+60000));
  console.log('Cause and resolution remain unset at every stage. Temporary files are removed.');
} finally {rmSync(root,{recursive:true,force:true});}
