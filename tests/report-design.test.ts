import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { nativeProtocolFixture } from './native-protocol-fixture.ts';
import { appendLabReview, reviewTemplate } from '../src/lab-review.ts';
import { exportBundle, verifyBundle, restyleBundle, BUNDLE_PATHS, OUTPUT_PATHS, customerReply } from '../src/support-bundle.ts';
import { reportStyles as bundle2Styles } from '../src/report-theme-v2.ts';
import { bundleHtml } from '../src/bundle-view.ts';
import { bundleHtml as legacyHtml } from '../src/bundle-view-v1.ts';
import { displayValue, documentHtml } from '../src/bundle-view.ts';
import fonts from '../src/report-fonts.json' with { type: 'json' };
const digest=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const read=(dir:string,path:string)=>readFileSync(join(dir,path),'utf8');
const json=(dir:string,path:string)=>JSON.parse(read(dir,path));
function setup(t:any, accepted=true) {
  const f=nativeProtocolFixture(t);
  if(accepted) appendLabReview(f.root,{...reviewTemplate(f.root,f.now),reviewer:'test-reviewer',decision:'accept',rationale:'The original failure and post-change observations support the local finding.'},f.now);
  const output=join(f.root,'bundle'); exportBundle(f.root,output,{now:f.now,mode:accepted?'reviewed':'gaps'});
  return {...f,output};
}
// Reconstruct the prior version using its frozen renderer and unchanged evidence-derived outputs.
function legacyBundle(dir:string, version='0.1.0-bundle1') {
  const review=json(dir,'comparison.json'), validation=json(dir,'validation.json'), m=json(dir,'manifest.json');
  // Earlier versions used the original reply text.
  const reply=customerReply(m.mode==='reviewed',1); writeFileSync(join(dir,'customer-reply.md'),reply);
  const replyEntry=m.files.find((f:any)=>f.path==='customer-reply.md'); replyEntry.sha256=digest(reply); replyEntry.bytes=Buffer.byteLength(reply);
  const facts=Object.fromEntries([...review.changed,...review.unchanged].map((f:any)=>[f.field,{before:f.before,after:f.after}]));
  const html=(version==='0.1.0-bundle1'?legacyHtml:bundleHtml)({styles:bundle2Styles,designRevision:1,documents:Object.fromEntries(OUTPUT_PATHS.filter(p=>p.endsWith('.md')).map(p=>[p,read(dir,p)])),review,validation,generatedAt:m.generatedAt,mode:m.mode,
    observations:read(dir,'evidence.jsonl').trim().split('\n').map(JSON.parse),timeline:json(dir,'timeline.json').events,facts});
  writeFileSync(join(dir,'support-bundle.html'),html);
  m.toolVersion=version; delete m.draftRevision; // Earlier manifests have no draft revision field.
  const entry=m.files.find((f:any)=>f.path==='support-bundle.html'); entry.sha256=digest(html);entry.bytes=Buffer.byteLength(html);
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(m)+'\n');
  return digest(read(dir,'manifest.json'));
}
test('legacy anchored bundle survives restyling after expiry with original bytes and clocks preserved',t=>{
  for(const version of ['0.1.0-bundle1','0.1.0-bundle2']) {
  const f=setup(t), anchor=legacyBundle(f.output,version), now=new Date(f.now.getTime()+3600001);
  assert.throws(()=>restyleBundle(f.output,join(f.output,'nested'),{now}),/outside/);
  const original=Object.fromEntries([...BUNDLE_PATHS,'manifest.json'].map(p=>[p,read(f.output,p)]));
  assert.equal(verifyBundle(f.output,{expectedManifestHash:anchor,now}).integrity,'VALID');
  const output=join(f.root,'signal'), result=restyleBundle(f.output,output,{expectedManifestHash:anchor,now});
  assert.equal(result.sourceAnchorChecked,true); assert.equal(result.currentEvidenceStatus,'VALIDATION_BLOCKED');
  assert.equal(result.originalExportedAt,f.now.toISOString()); assert.notEqual(result.manifestHash,anchor);
  for(const path of BUNDLE_PATHS.filter(p=>p!=='support-bundle.html')) assert.equal(read(output,path),original[path]);
  for(const path of [...BUNDLE_PATHS,'manifest.json']) assert.equal(read(f.output,path),original[path]);
  const verified=verifyBundle(output,{expectedManifestHash:result.manifestHash,now});
  assert.equal(verified.validationAtExport,'RESOLUTION_VALIDATED'); assert.equal(verified.currentEvidenceStatus,'VALIDATION_BLOCKED');
  assert.equal(verified.restyledFrom.manifestHash,anchor); assert.equal(verified.restyledFrom.restyledAt,now.toISOString());
  assert.equal(json(output,'manifest.json').toolVersion,'0.1.0-bundle5');
  }
});
test('restyling retains gap-only withholding and refuses bad anchors, edited input, existing output and future clocks',t=>{
  const f=setup(t,false), output=join(f.root,'signal');
  assert.throws(()=>restyleBundle(f.output,output,{expectedManifestHash:'0'.repeat(64),now:f.now}),/trusted/); assert.equal(existsSync(output),false);
  const result=restyleBundle(f.output,output,{now:f.now});
  assert.equal(verifyBundle(output,{now:f.now}).validationAtExport,'WITHHELD_IN_GAP_REPORT');
  assert.equal(json(output,'findings.json').finding,null);
  assert.throws(()=>restyleBundle(f.output,output,{now:f.now}));
  assert.equal(verifyBundle(output,{now:f.now,expectedManifestHash:result.manifestHash}).integrity,'VALID');
  const manifest=json(output,'manifest.json');manifest.restyledFrom.restyledAt=new Date(f.now.getTime()+1).toISOString();
  writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>verifyBundle(output,{now:f.now}),/restyle clock/);
  writeFileSync(join(f.output,'customer-reply.md'),'Modified');
  assert.throws(()=>restyleBundle(f.output,join(f.root,'unsafe'),{now:f.now}),/digest/);
  assert.equal(existsSync(join(f.root,'unsafe')),false);
});
test('report embeds fonts with verified bytes, escapes drafts and labels query controls distinctly',t=>{
  const f=setup(t), html=read(f.output,'support-bundle.html');
  for(const font of fonts) { assert.equal(digest(Buffer.from(font.data,'base64')),font.sha256); assert.ok(html.includes(font.data)); }
  assert.match(html,/font-src data:/);assert.match(html,/Schema-qualified control query/);assert.match(html,/Application query result/);
  assert.match(html,/<td>Not applied<\/td><td>Applied<\/td>/);assert.match(html,/<td>Unknown<\/td><td>Granted<\/td>/);
  assert.match(html,/SIL OPEN FONT LICENSE/);assert.match(html,/id="document-customer-reply"/);
  assert.ok(!/<(?:script|link|iframe|img)\b/i.test(html));
  const customer=html.match(/<details open class="draft" id="document-customer-reply">([\s\S]*?)<\/details>/)![1];
  assert.ok(!customer.includes('test-reviewer')); assert.ok(!customer.includes(f.run.runId)); assert.match(customer,/approval pending/);
  assert.equal(displayValue('relation SELECT',null),'Unknown'); assert.equal(displayValue('SQLSTATE',null),'None recorded');
  assert.equal(displayValue('matching rows',null),'Not recorded');
  const escaped=documentHtml('# Title\n\n<script>alert(1)</script>\n\n```sh\n<img src=x>\n```');
  assert.ok(!escaped.includes('<script>'));assert.match(escaped,/&lt;img/);
});
test('restyle CLI completes without a database and rejects invalid flags without reading input',t=>{
  const f=setup(t), output=join(f.root,'signal'), anchor=digest(read(f.output,'manifest.json'));
  const cli=(...args:string[])=>spawnSync(process.execPath,['src/cli.ts','lab','restyle-bundle',...args],{encoding:'utf8'});
  const dry=cli('/private-source','/private-output',anchor,'--dry-run');assert.equal(dry.status,0,dry.stderr);assert.equal(JSON.parse(dry.stdout).readsInput,false);
  const result=cli(f.output,output,anchor);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).sourceAnchorChecked,true);
  assert.equal(verifyBundle(output).integrity,'VALID');
  assert.equal(cli('/private-source','/private-output','--approve-lab').status,1);
  const missing=cli('/private-source','/private-output');assert.equal(missing.status,1);assert.ok(!missing.stderr.includes('private-source'));
});
