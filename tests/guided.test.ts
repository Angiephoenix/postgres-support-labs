import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runGuided, guideLabReview } from '../src/guided.ts';
import { nativeProtocolFixture } from './native-protocol-fixture.ts';
import { inspectLabReview, appendLabReview, reviewTemplate } from '../src/lab-review.ts';
import { exportBundle, verifyBundle } from '../src/support-bundle.ts';

function temporary(t: any) {
  const path = mkdtempSync(join(tmpdir(), 'guided-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
function ioFor(answers: (string | null)[], before?: (prompt: string) => void) {
  const output: string[] = [], remaining = [...answers];
  return { output, remaining, say(text: string) { output.push(text); }, async ask(prompt: string) {
    output.push(prompt); before?.(prompt);
    assert.ok(remaining.length, 'Unexpected question: ' + prompt);
    return remaining.shift()!;
  } };
}
const rationale = 'The scoped before and after observations support the missing migration in this local lab.';
const reviewAnswers = ['review','accept','Test reviewer',rationale,'yes','yes','reviewed','yes'];
const accepted = (f: any) => appendLabReview(f.root, {...reviewTemplate(f.root,f.now), reviewer:'other-reviewer',decision:'accept',rationale},f.now);

test('guided intake validates without echoing rejected material and preserves unknown context', async t => {
  const root = join(temporary(t),'cases');
  const io = ioFor(['1','postgres://person:private-value@example.invalid/db','relation project_labels does not exist','The query should return project labels',
    ...Array(15).fill(''),'yes','4']);
  await runGuided(io,{casesRoot:root});
  const dir = join(root,readdirSync(root)[0]), intake = JSON.parse(readFileSync(join(dir,'intake.json'),'utf8'));
  assert.equal(intake.branch,'unknown'); assert.equal(intake.dataSensitivity,'unknown');
  assert.equal(intake.connectionMode,'unknown'); assert.equal(intake.report,'relation project_labels does not exist');
  assert.deepEqual(readdirSync(dir).sort(),['evidence-gap-report.md','intake.json']);
  assert.match(readFileSync(join(dir,'evidence-gap-report.md'),'utf8'),/Follow-up:/);
  assert.ok(!io.output.join('\n').includes('private-value')); assert.equal(io.remaining.length,0);
});

test('cancellation, declined save, and declined execution create no case or database work', async t => {
  const root = join(temporary(t),'cases'); let called = false;
  for (const answers of [['1',null], ['1','A query failed','Rows should return',...Array(15).fill(''),'','4'], ['3','back','4']]) {
    const io = ioFor(answers);
    await runGuided(io,{casesRoot:root,runLab:async () => { called = true; throw Error('Should not execute'); }});
    assert.equal(existsSync(root),false);
  }
  assert.equal(called,false);
});

test('guided review binds explicit judgment, exports and verifies without manual hashes', async t => {
  const f = nativeProtocolFixture(t), io = ioFor(reviewAnswers);
  await guideLabReview(io,f.root,() => f.now);
  const review = inspectLabReview(f.root,f.now);
  assert.equal(review.reviewStatus,'ACCEPTED_LOCAL_LAB'); assert.equal(review.reviews.length,1);
  assert.equal(review.reviews[0].input.rationale,rationale);
  const dir = join(f.root,readdirSync(f.root).find(n => n.startsWith('support-bundle-'))!);
  const hashLine = io.output.find(s => s.startsWith('Manifest hash: '))!;
  const hash = hashLine.split('\n')[0].slice('Manifest hash: '.length);
  const result = verifyBundle(dir,{expectedManifestHash:hash,now:f.now});
  assert.equal(result.anchorChecked,true); assert.equal(result.semanticConsistency,'VALID');
  assert.equal(result.customerResolution,null); assert.equal(result.communicationApproval,'PENDING');
});

test('expired evidence withholds acceptance and exports only gaps while preserving earlier review', async t => {
  const f = nativeProtocolFixture(t); accepted(f);
  const original = readFileSync(join(f.root,'reviews.jsonl'),'utf8');
  const now = () => new Date(f.now.getTime()+3600001);
  const denied = ioFor(['review','accept','back']);
  await guideLabReview(denied,f.root,now);
  assert.match(denied.output.join('\n'),/Acceptance is blocked/);
  const io = ioFor(['export','reviewed','gaps','yes']);
  await guideLabReview(io,f.root,now);
  const dir = join(f.root,readdirSync(f.root).find(n => n.startsWith('support-bundle-'))!);
  assert.equal(verifyBundle(dir,{now:now()}).mode,'gaps');
  assert.equal(JSON.parse(readFileSync(join(dir,'findings.json'),'utf8')).finding,null);
  assert.equal(readFileSync(join(f.root,'reviews.jsonl'),'utf8'),original);
});

test('a competing review while the reviewer types cannot be overwritten', async t => {
  const f = nativeProtocolFixture(t);
  const io = ioFor(['review','accept','Test reviewer',rationale,'yes'], prompt => {
    if (prompt.startsWith('Record this review?')) accepted(f);
  });
  await assert.rejects(guideLabReview(io,f.root,() => f.now),/outdated/);
  assert.equal(inspectLabReview(f.root,f.now).reviews.length,1);
  assert.equal(inspectLabReview(f.root,f.now).reviews[0].input.reviewer,'other-reviewer');
});

test('expiry during confirmation prevents acceptance or a reviewed export', async t => {
  const f = nativeProtocolFixture(t); let now = f.now;
  const io = ioFor(['review','accept','Test reviewer',rationale,'yes'], prompt => {
    if (prompt.startsWith('Record this review?')) now = new Date(f.now.getTime()+3600001);
  });
  await assert.rejects(guideLabReview(io,f.root,() => now),/blockers/);
  assert.equal(existsSync(join(f.root,'reviews.jsonl')),false);
  accepted(f); now = f.now;
  const exporting = ioFor(['export','reviewed','yes'], prompt => {
    if (prompt.startsWith('Create and verify')) now = new Date(f.now.getTime()+3600001);
  });
  await assert.rejects(guideLabReview(exporting,f.root,() => now));
  assert.ok(!readdirSync(f.root).some(n => n.startsWith('support-bundle-')));
});

test('export refuses a changed review after the displayed summary and confirmation', async t => {
  const f = nativeProtocolFixture(t); accepted(f);
  const packet = inspectLabReview(f.root,f.now), original = readFileSync(join(f.root,'reviews.jsonl'),'utf8');
  const io = ioFor(['export','reviewed','yes'], prompt => {
    if (prompt.startsWith('Create and verify')) accepted(f);
  });
  await assert.rejects(guideLabReview(io,f.root,() => f.now),/changed before export/);
  assert.ok(readFileSync(join(f.root,'reviews.jsonl'),'utf8').startsWith(original));
  assert.ok(!readdirSync(f.root).some(n => n.startsWith('support-bundle-')));
  assert.throws(() => exportBundle(f.root,join(f.root,'explicit'),{now:f.now,expectedComparisonHash:'0'.repeat(64),expectedReviewHead:packet.reviewHead}),/changed/);
  assert.equal(existsSync(join(f.root,'explicit')),false);
});

test('run selection uses numbered directories and a new lab requires the exact approval phrase', async t => {
  const f = nativeProtocolFixture(t), parent = temporary(t), root = join(parent,'cases'); mkdirSync(root);
  cpSync(f.root,join(root,'native-saved'),{recursive:true});
  symlinkSync(f.root,join(root,'native-link'));
  const io = ioFor(['2','../outside','1','back','3','yes','run lab','back','4']); let called = 0;
  await runGuided(io,{casesRoot:root,now:() => f.now,runLab:async options => {
    called++; assert.equal(options.approved,true); cpSync(f.root,options.output,{recursive:true}); return f.run;
  }});
  assert.equal(called,1); assert.ok(!io.output.some(s => s.includes('native-link')));
  assert.equal(readdirSync(root).filter(n => n.startsWith('native-')).length,3);
});

test('review secrets and control characters are rejected; declining confirmation leaves no review', async t => {
  const f = nativeProtocolFixture(t), io = ioFor(['review','reject','\u001b[31mName','Test reviewer','password=private-value',rationale,'no']);
  await guideLabReview(io,f.root,() => f.now);
  assert.equal(existsSync(join(f.root,'reviews.jsonl')),false);
  assert.ok(!io.output.join('\n').includes('private-value'));
});

test('CLI dry run needs no terminal or files; piped input and shortcut approval flags are refused', t => {
  const cwd = temporary(t), cli = resolveCli();
  const exec = (args:string[]) => spawnSync(process.execPath,[cli,'guide',...args],{cwd,encoding:'utf8',input:'3\nrun lab\n'});
  const dry = exec(['--dry-run']); assert.equal(dry.status,0,dry.stderr); assert.equal(JSON.parse(dry.stdout).writes,false);
  assert.equal(exec([]).status,1); assert.match(exec([]).stderr,/interactive terminal/);
  assert.equal(exec(['--approve-lab']).status,1); assert.deepEqual(readdirSync(cwd),[]);
});
function resolveCli() { return new URL('../src/cli.ts',import.meta.url).pathname; }
