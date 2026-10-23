import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readBounded, readJson, readLedgerSnapshot } from './ledger.ts';
import { MAX_FILE, MAX_TOTAL, sha256, json, checkMode, readSources as readLayoutSources, writeSources as writeLayoutSources, writeExport, manifestFiles, checkIntegrity, checkOutputs, listFiles as listLayoutFiles, bundlePaths } from './bundle-core.ts';
import type { BundleLayout, Mode } from './bundle-core.ts';
import { inspectLabReview } from './lab-review.ts';
import { labCatalog } from './native-lab.ts';
import { validateLab } from './lab-validation.ts';
import { bundleHtml } from './bundle-view.ts';
import { reportStyles as bundle2Styles } from './report-theme-v2.ts';
import { bundleHtml as legacyBundleHtml } from './bundle-view-v1.ts';
import manifestSchema from '../schemas/export-manifest.v1.json' with { type: 'json' };

export const PHASES = ['development','before','search-path-control','after'];
export const SOURCE_PATHS = ['run.json','plan.json','probes.json','reviews.jsonl',...PHASES.flatMap(p=>[p+'/case.json',p+'/evidence.jsonl'])];
export const OUTPUT_PATHS = ['case-summary.md','intake.json','evidence-gap-report.md','probe-plan.json','evidence.jsonl','timeline.json',
  'reproduction.md','comparison.json','hypotheses.json','findings.json','validation.json','resolution-validation.md','customer-reply.md',
  'engineering-escalation.md','runbook-candidate.md','support-bundle.html'];
const LAYOUT: BundleLayout = {sourcePaths:SOURCE_PATHS,outputPaths:OUTPUT_PATHS,sourceFolders:PHASES,reviewPath:'reviews.jsonl',writeEmptyReview:true,probePath:'probes.json',probeCatalog:labCatalog};
export const BUNDLE_PATHS = bundlePaths(LAYOUT);
// Bundle5 keeps the bundle4 wording and adds print revision 1 to the report; earlier bytes are unchanged.
type BundleVersion = '0.1.0-bundle1'|'0.1.0-bundle2'|'0.1.0-bundle3'|'0.1.0-bundle4'|'0.1.0-bundle5';
const CURRENT_VERSION: BundleVersion = '0.1.0-bundle5';
const RECORDS_DRAFT_REVISION = ['0.1.0-bundle4','0.1.0-bundle5'];
type RestyleSource = {manifestHash:string;restyledAt:string};
const readSources=(dir:string)=>readLayoutSources(LAYOUT,dir);
const writeSources=(root:string,files:Record<string,string>)=>writeLayoutSources(LAYOUT,root,files);
const listFiles=(root:string)=>listLayoutFiles(LAYOUT,root);
// Customer reply drafts are part of each bundle version's bytes. Revision 1 is shared by bundles 1 to 3.
export function customerReply(accepted: boolean, revision: 1|2) {
  return revision===1?['# Customer reply draft','','DRAFT: human communication approval pending.','',
    accepted?'We reproduced the reported missing-relation error in a separate local test database. The migration and relation were absent in that test. After applying the bundled migration, the same query succeeded.':'The local investigation still needs evidence or review before we can provide a supported explanation.',
    '', 'The local result does not confirm the state of your environment. Please confirm which target and role handled the failed request, the effective search path, and whether the relevant migration ran on that target. Share sanitized identifiers and results; omit connection strings, credentials and customer rows.',
    '', 'Any change in your environment needs its own approval and post-change validation.',''].join('\n')
    :['# Customer reply draft','','DRAFT: human communication approval pending.','',
    accepted?'We reproduced the \u201crelation does not exist\u201d error in a separate local test database. In that test, the migration hadn\u2019t been applied, so the table wasn\u2019t there. After we applied the migration, the same query worked.'
      :'We\u2019re still looking into the \u201crelation does not exist\u201d error. Our local test isn\u2019t complete yet, so we can\u2019t explain the cause at this point.',
    '', (accepted?'That shows one way this error can happen, but it doesn\u2019t tell us what happened in your environment. ':'')+'Could you check which database and role the failing request used, what its search path was, and whether the migration ran on that database? Please share names and results only, without connection strings, passwords or customer data.',
    '', 'Once we\u2019ve checked those details, we can discuss whether a change is needed. Any proposed change should follow your usual approval process, with the original query checked again afterward.',''].join('\n');
}
type DraftRevision = 1|2;
// Version 4 and 5 manifests record which draft wording the bundle carries. Fresh exports use revision 2; restyling copies
// the source's revision, so drafts never change. Bundles 1 to 3 have no field and always use revision 1.
function draftRevisionOf(manifest: any): DraftRevision {
  if (!RECORDS_DRAFT_REVISION.includes(manifest.toolVersion)) { if (manifest.draftRevision !== undefined) fail('Draft revision is only recorded for version 4 and 5 bundles.'); return 1; }
  if (manifest.draftRevision !== 1 && manifest.draftRevision !== 2) fail('Version 4 and 5 bundles must record their draft revision.');
  if (!manifest.restyledFrom && manifest.draftRevision !== 2) fail('A fresh version 4 or 5 export must use the current draft revision.');
  return manifest.draftRevision;
}
function buildFiles(source: string, mode: Mode, now: Date, version: BundleVersion = CURRENT_VERSION, draftRevision: DraftRevision = 2) {
  checkMode(mode);
  const inspected=inspectLabReview(source,now), validation=validateLab(source,now);
  const review=mode==='gaps'?{...inspected,cause:null,resolution:null}:inspected;
  if(mode==='reviewed' && validation.status!=='RESOLUTION_VALIDATED') fail('Reviewed export requires fresh evidence and an accepted local cause. Use --gaps-only for an incomplete report.');
  const snapshots=PHASES.map(phase=>({phase,snapshot:readLedgerSnapshot(join(source,phase),now)}));
  const observations=snapshots.flatMap(({phase,snapshot})=>snapshot.entries.map(entry=>({phase,entry})));
  const before=snapshots.find(s=>s.phase==='before')!.snapshot;
  if(before.case.schemaVersion!==3) fail('Expected a native lab case.');
  const intake=before.case.intake, generatedAt=now.toISOString();
  const timeline=[...snapshots.map(({phase,snapshot})=>({at:snapshot.entries[0].observation.collectedAt,label:'Collected '+phase+' snapshot',evidenceIds:snapshot.entries.map(e=>e.observation.artifactId)})),
    ...review.reviews.map(r=>({at:r.recordedAt,label:'Review: '+r.input.decision,evidenceIds:[],reviewHash:r.hash}))]
    .sort((a,b)=>a.at.localeCompare(b.at));
  const accepted=mode==='reviewed', finding=accepted?review.cause:null;
  const facts=Object.fromEntries([...review.changed,...review.unchanged].map(f=>[f.field,{before:f.before,after:f.after}]));
  const scope='Local PostgreSQL lab with synthetic data. Customer environment unverified. Customer resolution pending.';
  const status=accepted?'RESOLUTION_VALIDATED (local-lab)':'GAP_REPORT';
  const headline=accepted?'The reviewer accepted the missing-migration explanation for the local reproduction.':'The investigation remains incomplete in this gap-only export. No supported cause is exported.';
  const observed=`Recorded query outcome: ${facts['query outcome'].before} before the migration, ${facts['query outcome'].after} afterward. Recorded matching rows after the migration: ${facts['matching rows'].after}.`;
  const references=review.evidence.map(e=>`- ${e.phase}: ${e.artifactIds.join(', ')}; ledger head ${e.headHash}`).join('\n');
  const pending=mode==='gaps'?['Gap-only export requested; acceptance and validation claims are withheld.',...validation.blockers]:validation.blockers;
  const gapText=['# Evidence gap report','',scope,'',...pending.map(p=>'- '+p),'',
    '## Customer evidence still required','',
    '- Confirm the affected customer target, role and effective search path.',
    '- Collect bounded relation, privilege and migration observations from that scope.',
    '- Reproduce the failing query and collect post-action results after an approved customer change.',
    '- Obtain customer-message approval before sending a response.',''].join('\n');
  const customer=customerReply(accepted,RECORDS_DRAFT_REVISION.includes(version)?draftRevision:1);
  const engineering=['# Engineering handoff draft','','Internal draft. Escalation need has not been established.','',scope,'',headline,'',observed,'',
    '## Recorded comparison','',...review.changed.map(f=>`- ${f.field}: ${canonical(f.before)} -> ${canonical(f.after)}`),
    '', '## Context held constant','',...review.unchanged.map(f=>`- ${f.field}: ${canonical(f.before)}`),
    '', '## Alternative explanation','',`Search-path control: SQLSTATE ${review.controls.searchPath.sqlstate}; migration applied ${review.controls.searchPath.migrationApplied}; relation present ${review.controls.searchPath.relationPresent}; visible ${review.controls.searchPath.relationVisible}; qualified matching rows ${review.controls.searchPath.qualifiedRows}.`,
    '', '## Evidence references','',references,'',`Comparison: ${review.comparisonHash}`,`Review head: ${review.reviewHead}`,`Validation: ${validation.validationHash}`,
    '', '## Remaining uncertainty','','Customer target state, business impact, production behavior and the need for escalation remain unverified.',''].join('\n');
  const validationText=['# Resolution validation','',`Status at export: ${accepted?validation.status:'WITHHELD_IN_GAP_REPORT'}`,`Scope: ${validation.scope}`,`Checked: ${generatedAt}`,'',
    ...validation.checks.map(c=>`- ${c.passed?'PASS':'PENDING'}: ${c.id}; references ${c.evidence.join(', ')}`),'',validation.limitation,'',
    'Customer resolution: unset. Customer-message approval: pending.',''].join('\n');
  const hypotheses=[
    {candidate:'missing_migration',classification:accepted?'SUPPORTED_CAUSE':'UNVERIFIED_HYPOTHESIS',scope:'local-lab',evidence:['before-migration_state','before-relation_inventory','after-migration_state','after-failure_observation']},
    {candidate:'search_path',classification:'REPRODUCED_BEHAVIOR',scope:'search-path-control',evidence:['search-path-control-effective_context','search-path-control-failure_observation-qualified'],limitation:'Reproduced in a separate control database. Customer applicability unverified.'},
    {candidate:'wrong_target_or_role',classification:'UNVERIFIED_HYPOTHESIS',scope:'customer',evidence:[],limitation:'Customer scope has not been collected.'},
  ];
  const {validationHash: originalValidationHash, ...validationBody}=validation;
  const withheld={...validationBody,status:'WITHHELD_IN_GAP_REPORT'};
  const files:Record<string,string>={
    'case-summary.md':['# Case summary','',`Exported: ${generatedAt}`,`Status at export: ${status}`,`Run: ${review.runId}`,'',scope,'',headline,'',observed,'','Business impact: unknown.','',`Comparison: ${review.comparisonHash}`,`Review head: ${review.reviewHead}`,'','Communication approval: pending.',''].join('\n'),
    'intake.json':json(intake), 'evidence-gap-report.md':gapText, 'probe-plan.json':json(readJson(join(source,'plan.json'))),
    'evidence.jsonl':observations.map(json).join(''), 'timeline.json':json({schemaVersion:1,runId:review.runId,events:timeline}),
    'reproduction.md':['# Reproduce the local investigation','','Requires Node.js 24, pinned dependencies and PostgreSQL 16, 17 or 18 server tools. Run from the project checkout as a regular OS user.','','```sh','npm ci','npm run demo:postgres -- --dry-run','npm run demo:postgres -- --approve-lab','```','','The command creates a new disposable cluster with synthetic data, executes the bundled scenario, retains new evidence and removes the cluster. It requires explicit approval because setup and the migration write to that owned lab.','',observed,'','Recorded cleanup: COMPLETE. No additional database execution occurs during bundle export.','', 'Exact baseline, migration and probe SQL: sources/probes.json. The review decision must be made separately for each new run.',''].join('\n'),
    'comparison.json':json(review), 'hypotheses.json':json({schemaVersion:1,runId:review.runId,hypotheses}),
    'findings.json':json({schemaVersion:1,runId:review.runId,mode,generatedAt,finding,comparisonHash:review.comparisonHash,reviewHead:review.reviewHead,customerResolution:null,communicationApproval:'PENDING'}),
    'validation.json':json(accepted?validation:{...withheld,validationHash:hash(withheld)}),
    'resolution-validation.md':validationText, 'customer-reply.md':customer, 'engineering-escalation.md':engineering,
    'runbook-candidate.md':['# Missing-relation investigation: runbook candidate','','DRAFT: publication and reuse review pending.','',`Source run: ${review.runId}`,`Evidence status: ${status}`,'',
      '## Qualifying symptom','','An application reports relation-not-found. Capture the original SQLSTATE and exact relation identifier.','',
      '## Investigation steps','','1. Verify the failing connection target and effective role.','2. Inspect search path, exact schema and identifier casing.','3. Collect bounded relation and privilege observations.','4. Check migration history on that same target.','5. Test alternatives in an isolated lab. A schema-qualified control can help investigate visibility.','6. Review the evidence before selecting a cause.','7. Approve any change for its declared environment, then repeat the original query and expected-behavior checks.','',
      '## Confounders','','Wrong target, quoted identifiers, search path and missing privileges can affect interpretation. A successful migration command alone does not establish target state.','',
      '## Validation boundary','','This source bundle validates only its declared local query when the local review and freshness gates pass. Customer resolution requires customer-scoped post-action evidence.',''].join('\n'),
    'support-bundle.html':'',
  };
  const documents=Object.fromEntries(Object.entries(files).filter(([path])=>path.endsWith('.md')));
  files['support-bundle.html']=(version==='0.1.0-bundle1'?legacyBundleHtml:bundleHtml)({review,validation,generatedAt,mode,observations,timeline,facts,documents,...(version==='0.1.0-bundle2'?{styles:bundle2Styles,designRevision:1}:{}),...(version==='0.1.0-bundle4'?{copyRevision:2}:{}),...(version==='0.1.0-bundle5'?{copyRevision:2,print:true}:{})});
  return {files,review,validation,generatedAt};
}
type ExportBinding = {expectedComparisonHash?:string;expectedReviewHead?:string};
export function exportBundle(source:string, output:string, options:{mode?:Mode;now?:Date}&ExportBinding={}) {
  return writeBundle(source,output,options);
}
function writeBundle(source:string, output:string, options:{mode?:Mode;now?:Date;restyledFrom?:RestyleSource;draftRevision?:DraftRevision}&ExportBinding={}) {
  const mode=options.mode??'reviewed', now=options.now??new Date(); checkMode(mode);
  const captured=readSources(source), staging=mkdtempSync(join(tmpdir(),'pslab-bundle-'));
  try {
    writeSources(staging,captured);
    const draftRevision=options.draftRevision??2, built=buildFiles(staging,mode,now,CURRENT_VERSION,draftRevision), files={...built.files,...Object.fromEntries(Object.entries(captured).map(([p,s])=>['sources/'+p,s]))};
    if (options.expectedComparisonHash !== undefined && options.expectedComparisonHash !== built.review.comparisonHash ||
        options.expectedReviewHead !== undefined && options.expectedReviewHead !== built.review.reviewHead) fail('Investigation changed before export. Inspect it again.');
    const manifest={schemaVersion:1,toolVersion:CURRENT_VERSION,profile:'local-lab',runId:built.review.runId,generatedAt:built.generatedAt,mode,
      comparisonHash:built.review.comparisonHash,reviewHead:built.review.reviewHead,redactionStatus:'recognized-patterns-checked',communicationApproval:'PENDING',
      ...(options.restyledFrom?{restyledFrom:options.restyledFrom}:{}),draftRevision,
      files:manifestFiles(LAYOUT,files)};
    validateArtifact(manifest,manifestSchema);
    const manifestHash=writeExport(LAYOUT,output,files,manifest);
    return {status:'EXPORTED',mode,runId:built.review.runId,files:BUNDLE_PATHS.length+1,manifestHash,customerResolution:null,communicationApproval:'PENDING'};
  } finally { rmSync(staging,{recursive:true,force:true}); }
}
export function verifyBundle(dir:string, options:{expectedManifestHash?:string;now?:Date}={}) {
  const {root,now,manifest,manifestHash}=checkIntegrity(LAYOUT,dir,manifestSchema,options);
  readSources(join(root,'sources'));
  if(manifest.restyledFrom && (!['0.1.0-bundle2','0.1.0-bundle3','0.1.0-bundle4','0.1.0-bundle5'].includes(manifest.toolVersion) || new Date(manifest.restyledFrom.restyledAt)<new Date(manifest.generatedAt) || new Date(manifest.restyledFrom.restyledAt)>now)) fail('Bundle restyle clock or version is invalid.');
  const rebuilt=buildFiles(join(root,'sources'),manifest.mode,new Date(manifest.generatedAt),manifest.toolVersion,draftRevisionOf(manifest));
  if(rebuilt.review.runId!==manifest.runId || rebuilt.review.comparisonHash!==manifest.comparisonHash || rebuilt.review.reviewHead!==manifest.reviewHead) fail('Manifest investigation binding mismatch.');
  checkOutputs(LAYOUT,root,rebuilt.files);
  const current=validateLab(join(root,'sources'),now);
  return {integrity:'VALID',semanticConsistency:'VALID',anchorChecked:options.expectedManifestHash!==undefined,manifestHash,
    runId:manifest.runId,mode:manifest.mode,exportedAt:manifest.generatedAt,checkedAt:now.toISOString(),
    ...(manifest.restyledFrom?{restyledFrom:manifest.restyledFrom}:{}),
    validationAtExport:manifest.mode==='reviewed'?rebuilt.validation.status:'WITHHELD_IN_GAP_REPORT',
    currentEvidenceStatus:current.status,customerResolution:null,communicationApproval:'PENDING',
    limitation:'Verifies this exported snapshot. Later changes to the original case and complete unanchored rewrites are outside this check.'};
}

// Restyling freezes and verifies the complete input before creating a new representation.
// The original export clock is retained; evidence is never made fresh by a visual update.
export function restyleBundle(source:string, output:string, options:{expectedManifestHash?:string;now?:Date}={}) {
  const now=options.now??new Date(), root=resolve(source), destination=resolve(output);
  if(destination===root || destination.startsWith(root+sep)) fail('Restyled output must be outside the original bundle.');
  const staging=mkdtempSync(join(tmpdir(),'pslab-restyle-'));
  try {
    if(canonical(listFiles(root).sort())!==canonical([...BUNDLE_PATHS,'manifest.json'].sort())) fail('Bundle file inventory mismatch.');
    for(const folder of ['sources',...PHASES.map(p=>'sources/'+p)]) mkdirSync(join(staging,folder),{mode:0o700});
    let total=0;
    for(const path of [...BUNDLE_PATHS,'manifest.json']) {
      const raw=readBounded(join(root,path),path==='manifest.json'?65536:MAX_FILE);
      total+=Buffer.byteLength(raw); if(total>MAX_TOTAL+65536) fail('Bundle size limit exceeded.');
      writeFileSync(join(staging,path),raw,{flag:'wx',mode:0o600});
    }
    const verified=verifyBundle(staging,{...options,now});
    // Keep the source's draft wording: restyling changes presentation only.
    const draftRevision=draftRevisionOf(JSON.parse(readBounded(join(staging,'manifest.json'),65536)));
    const result=writeBundle(join(staging,'sources'),output,{mode:verified.mode,now:new Date(verified.exportedAt),draftRevision,
      restyledFrom:{manifestHash:verified.manifestHash,restyledAt:now.toISOString()}});
    return {...result,sourceManifestHash:verified.manifestHash,sourceAnchorChecked:verified.anchorChecked,
      originalExportedAt:verified.exportedAt,restyledAt:now.toISOString(),currentEvidenceStatus:verified.currentEvidenceStatus};
  } finally { rmSync(staging,{recursive:true,force:true}); }
}
