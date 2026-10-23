import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, fsyncSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonical, hash, fail, parseCase, parseObservation, observationSubject, LedgerError } from './contracts.ts';
import type { Case, Observation } from './contracts.ts';
export { LedgerError };
type Entry = { sequence:number; recordedAt:string; previousHash:string; observation:Observation; hash:string };
const MAX_LEDGER = 8 * 1024 * 1024;
export function readJson(path:string): unknown {
  try { return JSON.parse(readBounded(path,65536)); }
  catch(error) { if(error instanceof LedgerError) throw error; return fail('Cannot read artifact JSON.'); }
}
export function readBounded(path:string,limit:number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) fail('Artifact file is invalid or too large.');
    const result=readFileSync(fd,'utf8');
    if(Buffer.byteLength(result)>limit) fail('Artifact file is too large.');
    return result;
  } finally { if(fd !== undefined) closeSync(fd); }
}
function directory(dir:string): string {
  const path=resolve(dir);
  if(!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('Expected a regular case directory.');
  return path;
}
function lock<T>(dir:string,run:()=>T): T {
  let fd:number;
  try { fd=openSync(join(dir,'.ledger.lock'),'wx',0o600); }
  catch { return fail('Case is locked or unavailable. Do not remove a lock while a writer is running.'); }
  try { return run(); } finally { closeSync(fd); unlinkSync(join(dir,'.ledger.lock')); }
}
function clock(now:Date): string {
  if(!Number.isFinite(now.getTime())) return fail('Invalid clock.');
  return now.toISOString();
}
function checkEntry(o:Observation,c:Case,prior:Entry[],recordedAt:string) {
  if(o.schemaVersion===3 && c.schemaVersion!==3 || c.schemaVersion===3 && o.schemaVersion!==3) fail('Local lab and fixture evidence cannot be mixed.');
  if(o.schemaVersion===2 && c.schemaVersion!==2) fail('Typed observations require a version-two investigation case.');
  if(o.caseId !== c.caseId || canonical(o.scope) !== canonical(c.scope)) fail('Observation case or scope mismatch.');
  const time=Date.parse(recordedAt);
  if(Date.parse(o.collectedAt)>time || Date.parse(o.expiresAt)<=time) fail('Observation is stale or future-dated at admission.');
  if(prior.some(e=>e.observation.artifactId===o.artifactId)) fail('Artifact ID already exists.');
  const superseded=new Set(prior.map(e=>e.observation.supersedes).filter(Boolean));
  const unavailable=new Set<string>(superseded as Set<string>);
  for(const e of prior) {
    if(Date.parse(e.observation.expiresAt)<=time || e.observation.parents.some(id=>unavailable.has(id))) unavailable.add(e.observation.artifactId);
  }
  for(const id of o.parents) {
    const parent=prior.find(e=>e.observation.artifactId===id);
    if(!parent || unavailable.has(id) || Date.parse(parent.observation.expiresAt)<=time || Date.parse(parent.observation.collectedAt)>Date.parse(o.collectedAt)) fail('Parent evidence is missing, superseded, stale or newer than the observation.');
  }
  if(o.supersedes) {
    const old=prior.find(e=>e.observation.artifactId===o.supersedes);
    if(!old || superseded.has(o.supersedes)) fail('Correction target is missing or already superseded.');
    if(old.observation.probeId!==o.probeId || old.observation.collectionScope!==o.collectionScope || canonical(observationSubject(old.observation))!==canonical(observationSubject(o)) || Date.parse(o.collectedAt)<Date.parse(old.observation.collectedAt)) fail('Correction must retain its probe and collection scope and be at least as recent.');
    if(o.parents.includes(o.supersedes)) fail('Correction cannot depend on the evidence it replaces.');
  }
  const identity=({artifactId, ...rest}:Observation)=>rest;
  if(prior.some(e=>hash(identity(e.observation))===hash(identity(o)))) fail('Duplicate observation content.');
}
function load(dir:string) {
  const c=parseCase(readJson(join(dir,'case.json')));
  const raw=readBounded(join(dir,'evidence.jsonl'),MAX_LEDGER);
  if(raw && !raw.endsWith('\n')) fail('Ledger is incomplete. Restore a verified copy before writing.');
  const entries:Entry[]=[];
  for(const line of raw ? raw.slice(0,-1).split('\n') : []) {
    let e:Entry;
    try { e=JSON.parse(line); } catch { return fail('Ledger contains malformed JSON.'); }
    if(!e || typeof e!=='object' || Array.isArray(e) || Object.keys(e).sort().join(',')!=='hash,observation,previousHash,recordedAt,sequence') fail('Malformed ledger entry.');
    if(e.sequence!==entries.length+1 || e.previousHash!==(entries.at(-1)?.hash ?? hash(c))) fail('Ledger order or chain mismatch.');
    if(typeof e.recordedAt!=='string' || !Number.isFinite(Date.parse(e.recordedAt)) || new Date(e.recordedAt).toISOString()!==e.recordedAt || (entries.length && e.recordedAt<entries.at(-1)!.recordedAt)) fail('Ledger admission time is invalid.');
    const {hash:stored,...body}=e;
    if(stored!==hash(body)) fail('Ledger hash mismatch.');
    e.observation=parseObservation(e.observation);
    checkEntry(e.observation,c,entries,e.recordedAt);
    entries.push(e);
  }
  return {case:c,entries,raw};
}
export function createCase(dir:string,input:unknown) {
  const c=parseCase(input);
  // Claim an unused directory before writing. Existing directories are never replaced.
  mkdirSync(dir,{mode:0o700});
  writeFileSync(join(dir,'case.json'),canonical(c)+'\n',{flag:'wx',mode:0o600});
  writeFileSync(join(dir,'evidence.jsonl'),'',{flag:'wx',mode:0o600});
  return c;
}
export function appendObservation(dir:string,input:unknown,now=new Date()): Entry {
  const o=parseObservation(input), time=clock(now), path=directory(dir);
  return lock(path,()=>{
    const state=load(path);
    if(state.entries.length && time<state.entries.at(-1)!.recordedAt) fail('Clock moved behind the last ledger entry.');
    checkEntry(o,state.case,state.entries,time);
    const body={sequence:state.entries.length+1,recordedAt:time,previousHash:state.entries.at(-1)?.hash ?? hash(state.case),observation:o};
    const entry={...body,hash:hash(body)};
    const next=state.raw+canonical(entry)+'\n';
    if(Buffer.byteLength(next)>MAX_LEDGER) fail('Ledger size limit reached.');
    const temp=join(path,'.ledger-'+randomUUID()+'.tmp');
    const fd=openSync(temp,'wx',0o600);
    try { writeFileSync(fd,next); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp,join(path,'evidence.jsonl')); } finally { try { unlinkSync(temp); } catch {} }
    return entry;
  });
}
export function readLedgerSnapshot(dir:string,now=new Date(),expectedHead?:string) {
  const time=clock(now), state=load(directory(dir));
  if(state.entries.some(e=>e.recordedAt>time)) fail('Ledger contains a future admission time.');
  const head=state.entries.at(-1)?.hash ?? hash(state.case);
  if(expectedHead!==undefined && expectedHead!==head) fail('Ledger differs from the trusted head.');
  const superseded=new Set(state.entries.map(e=>e.observation.supersedes).filter(Boolean));
  const status=new Map<string,string>();
  for(const e of state.entries) {
    const o=e.observation;
    status.set(o.artifactId,superseded.has(o.artifactId)?'SUPERSEDED':Date.parse(o.expiresAt)<=Date.parse(time)?'STALE':'CURRENT');
  }
  for(const e of state.entries) if(status.get(e.observation.artifactId)==='CURRENT' && e.observation.parents.some(id=>status.get(id)!=='CURRENT')) status.set(e.observation.artifactId,'PARENT_UNAVAILABLE');
  const summary={schemaVersion:1,caseId:state.case.caseId,profile:state.case.profile,scope:state.case.scope,
    integrity:'VALID',anchorChecked:expectedHead!==undefined,headHash:head,caseHash:hash(state.case),
    ledgerFileHash:createHash('sha256').update(state.raw).digest('hex'),entryCount:state.entries.length,
    observations:state.entries.map(e=>({artifactId:e.observation.artifactId,classification:e.observation.classification,source:e.observation.source,status:status.get(e.observation.artifactId)})),
    cause:null,resolution:null};
  return {case:state.case,entries:state.entries,status,summary,checkedAt:time};
}
export function inspectLedger(dir:string,now=new Date(),expectedHead?:string) {
  return readLedgerSnapshot(dir,now,expectedHead).summary;
}
