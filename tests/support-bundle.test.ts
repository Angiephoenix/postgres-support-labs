import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, readdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { nativeProtocolFixture } from './native-protocol-fixture.ts';
import { appendLabReview, reviewTemplate } from '../src/lab-review.ts';
import { validateLab } from '../src/lab-validation.ts';
import { exportBundle, verifyBundle, BUNDLE_PATHS } from '../src/support-bundle.ts';
import { hash } from '../src/contracts.ts';

function setup(t:any, accepted=true, rationale='The original failure and post-change observations support the local finding.') {
  const f=nativeProtocolFixture(t);
  if(accepted) appendLabReview(f.root,{...reviewTemplate(f.root,f.now),reviewer:'test-reviewer',decision:'accept',rationale},f.now);
  return {...f,output:join(f.root,'bundle')};
}
function read(dir:string,path:string) { return readFileSync(join(dir,path),'utf8'); }
function parsed(dir:string,path:string) { return JSON.parse(read(dir,path)); }
function rehashFile(dir:string,path:string) {
  const manifest=parsed(dir,'manifest.json'), text=read(dir,path), entry=manifest.files.find((f:any)=>f.path===path);
  entry.sha256=createHash('sha256').update(text).digest('hex'); entry.bytes=Buffer.byteLength(text);
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));
}

test('validation binds reviewed local before and after evidence and leaves customer resolution pending', t=>{
  const f=setup(t), v=validateLab(f.root,f.now);
  assert.equal(v.status,'RESOLUTION_VALIDATED'); assert.equal(v.scope,'local-lab'); assert.equal(v.customerResolution,null);
  assert.equal(v.communicationApproval,'PENDING'); assert.ok(v.checks.every(c=>c.passed));
  assert.equal(v.originalFailure.artifactId,'before-failure_observation'); assert.equal(v.postChange.artifactId,'after-failure_observation');
  const {validationHash,...body}=v; assert.equal(validationHash,hash(body));
});
test('reviewed export is blocked for unreviewed, rejected or expired cases before writing output',t=>{
  for(const state of ['unreviewed','rejected','expired']) {
    const f=setup(t,state!=='unreviewed');
    if(state==='rejected') appendLabReview(f.root,{...reviewTemplate(f.root,f.now),reviewer:'test-reviewer',decision:'reject',rationale:'The local finding requires further investigation.'},f.now);
    const now=state==='expired'?new Date(f.now.getTime()+3600001):f.now;
    assert.equal(validateLab(f.root,now).status,'VALIDATION_BLOCKED');
    assert.throws(()=>exportBundle(f.root,f.output,{now}),/requires fresh/); assert.equal(existsSync(f.output),false);
  }
});
test('portable reviewed export includes all specified views, original ledger bytes and a verifiable manifest',t=>{
  const f=setup(t), result=exportBundle(f.root,f.output,{now:f.now});
  assert.equal(result.files,BUNDLE_PATHS.length+1);
  for(const phase of ['development','before','search-path-control','after']) assert.equal(read(f.output,`sources/${phase}/evidence.jsonl`),read(f.root,`${phase}/evidence.jsonl`));
  const report=verifyBundle(f.output,{expectedManifestHash:result.manifestHash,now:f.now});
  assert.equal(report.integrity,'VALID'); assert.equal(report.semanticConsistency,'VALID'); assert.equal(report.anchorChecked,true);
  assert.equal(report.validationAtExport,'RESOLUTION_VALIDATED'); assert.equal(report.currentEvidenceStatus,'RESOLUTION_VALIDATED');
  assert.equal(report.customerResolution,null); assert.equal(report.communicationApproval,'PENDING');
  const moved=join(f.root,'moved'); cpSync(f.output,moved,{recursive:true}); rmSync(f.output,{recursive:true});
  assert.equal(verifyBundle(moved,{now:f.now}).integrity,'VALID');
});
test('gap-only export withholds finding and validation and retains customer follow-up questions',t=>{
  const f=setup(t,false); exportBundle(f.root,f.output,{mode:'gaps',now:f.now});
  const finding=parsed(f.output,'findings.json'), v=parsed(f.output,'validation.json');
  assert.equal(finding.finding,null); assert.equal(v.status,'WITHHELD_IN_GAP_REPORT');
  const {validationHash,...body}=v; assert.equal(validationHash,hash(body));
  assert.match(read(f.output,'evidence-gap-report.md'),/effective search path/);
  assert.ok(!read(f.output,'customer-reply.md').includes('same query succeeded'));
  assert.equal(verifyBundle(f.output,{now:f.now}).validationAtExport,'WITHHELD_IN_GAP_REPORT');
});
test('accepted evidence in gap-only mode still withholds exported cause claims',t=>{
  const f=setup(t); exportBundle(f.root,f.output,{mode:'gaps',now:f.now});
  assert.equal(parsed(f.output,'comparison.json').cause,null); assert.equal(parsed(f.output,'findings.json').finding,null);
  assert.equal(verifyBundle(f.output,{now:f.now}).mode,'gaps');
});
test('historical bundle integrity remains valid after expiry while current validation is blocked',t=>{
  const f=setup(t); exportBundle(f.root,f.output,{now:f.now});
  const report=verifyBundle(f.output,{now:new Date(f.now.getTime()+3600001)});
  assert.equal(report.integrity,'VALID'); assert.equal(report.validationAtExport,'RESOLUTION_VALIDATED');
  assert.equal(report.currentEvidenceStatus,'VALIDATION_BLOCKED');
});
test('customer and engineering views share the local finding without disclosing internal reviewer data',t=>{
  const f=setup(t); exportBundle(f.root,f.output,{now:f.now});
  const customer=read(f.output,'customer-reply.md'), internal=read(f.output,'engineering-escalation.md');
  assert.match(customer,/separate local test database/); assert.match(internal,/local reproduction/);
  assert.match(customer,/approval pending/); assert.match(internal,/Customer resolution pending/);
  for(const privateValue of ['test-reviewer',f.run.runId,parsed(f.output,'comparison.json').reviewHead]) assert.ok(!customer.includes(privateValue));
  assert.match(internal,/before-failure_observation/); assert.match(read(f.output,'runbook-candidate.md'),/DRAFT: publication/);
});
test('edited documents are rejected even after their manifest entry is rehashed',t=>{
  for(const path of ['customer-reply.md','validation.json','support-bundle.html']) {
    const f=setup(t); exportBundle(f.root,f.output,{now:f.now});
    writeFileSync(join(f.output,path),read(f.output,path)+'\nCustomer issue resolved.');
    assert.throws(()=>verifyBundle(f.output,{now:f.now}),/digest/);
    rehashFile(f.output,path); assert.throws(()=>verifyBundle(f.output,{now:f.now}),/disagrees/);
  }
});
test('manifest traversal, duplicate paths, added files and altered review history fail verification',t=>{
  for(const change of ['traversal','duplicate','extra','review']) {
    const f=setup(t); exportBundle(f.root,f.output,{now:f.now});
    if(change==='extra') writeFileSync(join(f.output,'unexpected.txt'),'extra');
    else if(change==='review') {writeFileSync(join(f.output,'sources/reviews.jsonl'),''); rehashFile(f.output,'sources/reviews.jsonl');}
    else {const m=parsed(f.output,'manifest.json'); m.files[0].path=change==='traversal'?'../private.txt':m.files[1].path; writeFileSync(join(f.output,'manifest.json'),JSON.stringify(m));}
    assert.throws(()=>verifyBundle(f.output,{now:f.now}));
  }
});
test('trusted manifest anchor and export time are checked',t=>{
  const f=setup(t); exportBundle(f.root,f.output,{now:f.now});
  assert.throws(()=>verifyBundle(f.output,{now:f.now,expectedManifestHash:'0'.repeat(64)}),/trusted/);
  assert.throws(()=>verifyBundle(f.output,{now:new Date(f.now.getTime()-1)}),/clock/);
});
test('existing output, symlinked files and symlinked source directories are refused',t=>{
  const f=setup(t); exportBundle(f.root,f.output,{now:f.now}); const raw=read(f.output,'manifest.json');
  assert.throws(()=>exportBundle(f.root,f.output,{now:f.now})); assert.equal(read(f.output,'manifest.json'),raw);
  const target=join(f.root,'external.txt'); writeFileSync(target,'unchanged');
  rmSync(join(f.output,'customer-reply.md')); symlinkSync(target,join(f.output,'customer-reply.md'));
  assert.throws(()=>verifyBundle(f.output,{now:f.now}),/Symlinks/); assert.equal(readFileSync(target,'utf8'),'unchanged');
  rmSync(join(f.root,'before'),{recursive:true}); symlinkSync(join(f.output,'sources/before'),join(f.root,'before'));
  assert.throws(()=>exportBundle(f.root,join(f.root,'other'),{now:f.now}),/regular directories/);
});
test('recognized sensitive source text blocks export before output is created',t=>{
  const f=setup(t); const run=parsed(f.root,'run.json'); run.note='postgres://admin:secret@private-host/customer'; writeFileSync(join(f.root,'run.json'),JSON.stringify(run));
  assert.throws(()=>exportBundle(f.root,f.output,{now:f.now}),/Privacy gate/); assert.equal(existsSync(f.output),false);
});
test('HTML escapes review content and every evidence link resolves to a record',t=>{
  const payload='Reviewed <img src=x onerror="alert(1)"> and </blockquote><script>alert(2)</script> in the test rationale.';
  const f=setup(t,true,payload); exportBundle(f.root,f.output,{now:f.now});
  const html=read(f.output,'support-bundle.html'); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;')); assert.match(html,/default-src 'none'/);
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  for(const [,target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target),target);
  assert.ok(!html.includes('https://')); assert.match(html,/Recorded snapshot/);
});
test('CLI validates, exports and verifies; dry runs write nothing and errors sanitize paths',t=>{
  const f=setup(t), cli=(...args:string[])=>spawnSync(process.execPath,['src/cli.ts','lab',...args],{encoding:'utf8'});
  const valid=cli('validate',f.root); assert.equal(valid.status,0,valid.stderr); assert.equal(JSON.parse(valid.stdout).status,'RESOLUTION_VALIDATED');
  const exported=cli('export',f.root,f.output); assert.equal(exported.status,0,exported.stderr);
  const checked=cli('verify-bundle',f.output,JSON.parse(exported.stdout).manifestHash); assert.equal(checked.status,0,checked.stderr);
  const before=readdirSync(f.root).sort();
  for(const args of [['export','/secret-source','/secret-target','--dry-run'],['validate','/secret-source','--dry-run'],['verify-bundle','/secret-source','--dry-run']]) assert.equal(cli(...args).status,0);
  assert.deepEqual(readdirSync(f.root).sort(),before);
  const error=cli('export','/secret-source','/secret-target'); assert.equal(error.status,1); assert.ok(!error.stderr.includes('secret-source'));
});
