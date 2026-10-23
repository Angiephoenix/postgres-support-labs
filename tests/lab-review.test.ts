import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from '../src/contracts.ts';
import { labCatalog } from '../src/native-lab.ts';
import { inspectLabReview, labReviewMarkdown, reviewTemplate, appendLabReview } from '../src/lab-review.ts';

import { nativeProtocolFixture as fixture } from './native-protocol-fixture.ts';

function input(root: string, now: Date, decision = 'accept') {
  return {...reviewTemplate(root,now),reviewer:'test-reviewer',decision,rationale:'The scoped before and after records support this lab finding.'};
}

test('comparison reconstructs recorded changes, retains both controls and leaves decisions unset', t => {
  const {root,now} = fixture(t), p = inspectLabReview(root,now);
  assert.equal(p.status,'READY_FOR_REVIEW'); assert.equal(p.reviewStatus,'NOT_REVIEWED'); assert.equal(p.cause,null); assert.equal(p.resolution,null);
  assert.equal(p.evidence.flatMap(e=>e.artifactIds).length,25);
  assert.ok(p.changed.some(f=>f.field==='migration applied'&&f.before===false&&f.after===true));
  assert.ok(p.unchanged.some(f=>f.field==='search path'));
  assert.equal(p.controls.searchPath.sqlstate,'42P01'); assert.equal(p.controls.searchPath.qualifiedRows,1);
  assert.equal(inspectLabReview(root,new Date(now.getTime()+1000)).comparisonHash,p.comparisonHash);
  assert.match(labReviewMarkdown(root,now),/before-failure_observation/);
  assert.equal(existsSync(join(root,'reviews.jsonl')),false);
});
test('explicit acceptance is scoped to the lab; later rejection preserves the original review bytes', t => {
  const {root,now} = fixture(t); appendLabReview(root,input(root,now),now);
  const raw = readFileSync(join(root,'reviews.jsonl'),'utf8'), accepted = inspectLabReview(root,now);
  assert.equal(accepted.reviewStatus,'ACCEPTED_LOCAL_LAB'); assert.equal(accepted.cause?.scope,'local-lab'); assert.equal(accepted.resolution,null);
  appendLabReview(root,input(root,now,'reject'),now);
  assert.ok(readFileSync(join(root,'reviews.jsonl'),'utf8').startsWith(raw));
  const rejected = inspectLabReview(root,now); assert.equal(rejected.reviewStatus,'REJECTED'); assert.equal(rejected.cause,null); assert.equal(rejected.reviews.length,2);
  assert.match(labReviewMarkdown(root,now),/test-reviewer; reject/);
});
test('request changes remains pending and the blank template cannot record a decision', t => {
  const {root,now} = fixture(t);
  assert.throws(()=>appendLabReview(root,reviewTemplate(root,now),now));
  appendLabReview(root,input(root,now,'request-changes'),now);
  assert.equal(inspectLabReview(root,now).reviewStatus,'CHANGES_REQUESTED'); assert.equal(inspectLabReview(root,now).cause,null);
});
test('expiry withdraws accepted cause support and blocks a new acceptance', t => {
  const {root,now} = fixture(t); appendLabReview(root,input(root,now),now);
  const later = new Date(now.getTime()+3600001), p = inspectLabReview(root,later);
  assert.equal(p.status,'EVIDENCE_REQUIRED'); assert.equal(p.reviewStatus,'EVIDENCE_REQUIRED'); assert.equal(p.cause,null); assert.ok(p.blockers.length>=25);
  const raw = readFileSync(join(root,'reviews.jsonl'),'utf8');
  assert.throws(()=>appendLabReview(root,input(root,later),later),/blockers/);
  assert.equal(readFileSync(join(root,'reviews.jsonl'),'utf8'),raw);
});
test('outdated comparison and concurrent review inputs cannot overwrite history', t => {
  const {root,now} = fixture(t), stale = input(root,now);
  assert.throws(()=>appendLabReview(root,{...stale,comparisonHash:hash('other')},now),/outdated/);
  assert.equal(existsSync(join(root,'reviews.jsonl')),false);
  appendLabReview(root,stale,now); const raw=readFileSync(join(root,'reviews.jsonl'),'utf8');
  assert.throws(()=>appendLabReview(root,stale,now),/outdated/);
  assert.equal(readFileSync(join(root,'reviews.jsonl'),'utf8'),raw);
});
test('changed search path or current schema blocks causal acceptance despite successful query', t => {
  for(const field of ['searchPath','currentSchema']) {
    const {root,now} = fixture(t,(phase,_c,obs)=>{if(phase==='after') obs.find(o=>o.kind==='effective_context').result[field]=field==='searchPath'?['public','app_data']:'public';});
    assert.equal(inspectLabReview(root,now).status,'EVIDENCE_REQUIRED');
    assert.throws(()=>appendLabReview(root,input(root,now),now),/blockers/);
  }
});
test('incomplete control and unknown post-change permissions cannot support the candidate', t => {
  for(const phaseToChange of ['search-path-control','after']) {
    const {root,now} = fixture(t,(phase,_c,obs)=>{if(phase===phaseToChange) obs.find(o=>o.kind==='permissions').result.relationSelect=null;});
    assert.equal(inspectLabReview(root,now).status,'EVIDENCE_REQUIRED');
  }
});
test('cross-run evidence and a qualified probe for another relation are refused', t => {
  for(const change of ['run','relation']) {
    const {root,now} = fixture(t,(phase,_c,obs)=>{if(phase==='search-path-control') {if(change==='run') obs[0].source.runId='aaaaaaaa-1234-1234-1234-123456789abc'; else obs.at(-1).result.relation='other_table';}});
    assert.throws(()=>inspectLabReview(root,now),/another run|subject mismatch/);
  }
});
test('changed cached results, query catalog and incomplete cleanup are refused', t => {
  for(const change of ['summary','catalog','cleanup']) {
    const {root,now,run} = fixture(t);
    if(change==='catalog') writeFileSync(join(root,'probes.json'),JSON.stringify({...labCatalog(),migration:'SELECT 1'}));
    else {if(change==='summary') run.snapshots.before.migrationApplied=true; else run.cleanup='FAILED'; writeFileSync(join(root,'run.json'),JSON.stringify(run));}
    assert.throws(()=>inspectLabReview(root,now),/differs|required/);
  }
});
test('tampered ledger or review bytes fail closed and truncated reviews are rejected', t => {
  for(const change of ['ledger','review','truncate']) {
    const {root,now} = fixture(t); appendLabReview(root,input(root,now),now);
    const path=join(root,change==='ledger'?'before/evidence.jsonl':'reviews.jsonl'), raw=readFileSync(path,'utf8');
    writeFileSync(path,change==='truncate'?raw.slice(0,-2):raw.replace(change==='ledger'?'native-lab-1':'test-reviewer',change==='ledger'?'native-lab-2':'other-reviewer'));
    assert.throws(()=>inspectLabReview(root,now));
  }
});
test('review privacy, empty rationale, lock collision and symlink leave targets untouched', t => {
  const {root,now}=fixture(t), value=input(root,now);
  for(const rationale of ['          ','Contact person@example.com to accept this finding.']) assert.throws(()=>appendLabReview(root,{...value,rationale},now));
  assert.equal(existsSync(join(root,'reviews.jsonl')),false);
  writeFileSync(join(root,'.review.lock'),'held'); assert.throws(()=>appendLabReview(root,value,now),/locked/); rmSync(join(root,'.review.lock'));
  const target=join(root,'original.txt'); writeFileSync(target,'unchanged'); symlinkSync(target,join(root,'reviews.jsonl'));
  assert.throws(()=>appendLabReview(root,value,now)); assert.equal(readFileSync(target,'utf8'),'unchanged');
});
test('CLI comparison is read-only, dry-run ignores inputs and file errors hide sensitive paths', t => {
  const {root}=fixture(t), files=readdirSync(root).sort();
  const command=(...args:string[])=>spawnSync(process.execPath,['src/cli.ts','lab',...args],{encoding:'utf8'});
  const result=command('compare',root,'--json'); assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).cause,null);
  assert.deepEqual(readdirSync(root).sort(),files);
  for(const args of [['compare','/secret-path','--dry-run'],['review','/secret-path','/secret-input','--dry-run'],['review-template','/secret-path','--dry-run']]) assert.equal(command(...args).status,0);
  const failure=command('compare','/secret-path'); assert.equal(failure.status,1); assert.ok(!failure.stderr.includes('secret-path'));
});
