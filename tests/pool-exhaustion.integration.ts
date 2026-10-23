import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runLeakLab } from '../src/pool-exhaustion-lab.ts';
import { inspectLeak, requestShape, PLANS } from '../src/pool-exhaustion-evidence.ts';

const temporary = () => readdirSync('/tmp').filter(n => n.startsWith('pslab-leak-')).sort();
const ownedServers = () => spawnSync('pgrep', ['-fa', '[p]slab-leak-'], { encoding: 'utf8' }).stdout.trim();
const phase = (run: any, name: string) => run.phases.find((p: any) => p.phase === name);
const checkpoint = (p: any, name: string) => p.checkpoints.find((c: any) => c.name === name);
const open = (p: any, name: string) => { const c = checkpoint(p, name); return p.leases.filter((l: any) => l.acquireSeq < c.seq && (l.releaseSeq === null || l.releaseSeq >= c.seq)); };
// Wraps the real server tools; `stop` can be made to fail without stopping anything.
function wrappedTools(dir: string, real: string, options: { failStop?: boolean } = {}) {
  const bin = join(dir, 'bin'), log = join(dir, 'pg_ctl.log'); mkdirSync(bin);
  writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in start|stop|status) echo "$a" >> "${log}";; esac; done\n` +
    (options.failStop ? `for a in "$@"; do if [ "$a" = stop ]; then exit 1; fi; done\n` : '') + `exec "${real}/pg_ctl" "$@"\n`, { mode: 0o700 });
  for (const tool of ['initdb', 'postgres']) writeFileSync(join(bin, tool), `#!/bin/sh\nexec "${real}/${tool}" "$@"\n`, { mode: 0o700 });
  return { bin, log };
}

test('actual PostgreSQL shows the leak, every control and the fix from one replayed request plan, twice', { timeout: 300000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'leak-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary();
  for (const name of ['first', 'repeat']) {
    const output = join(dir, name), { run, manifestHash } = await runLeakLab({ approved: true, output });
    const checked = inspectLeak(output, manifestHash);
    assert.equal(checked.integrity, 'VALID'); assert.equal(checked.anchorChecked, true); assert.equal(checked.evidenceStatus, 'MEASURED');
    const leak = phase(run, 'leak-reproduced'), fix = phase(run, 'fix-applied');
    // Measured: the leaked checkouts stay open on idle sessions after the quiet period; the fixed handler leaves none.
    assert.equal(open(leak, 'after-quiet').length, PLANS.leak.failing);
    assert.ok(checkpoint(leak, 'after-quiet').sessions.every((s: any) => s.state === 'idle'));
    assert.equal(open(fix, 'after-quiet').length, 0);
    assert.deepEqual(requestShape(leak), requestShape(fix));
    // The pool's timeout has no SQLSTATE; the server's refusal does.
    assert.ok(leak.requests.some((q: any) => q.outcome === 'pool-checkout-timeout' && q.sqlstate === null));
    assert.ok(phase(run, 'server-refusal').requests.some((q: any) => q.outcome === 'server-refused-reserved' && q.sqlstate === '53300'));
    assert.ok(phase(run, 'demand-beyond-capacity-after-fix').requests.some((q: any) => q.outcome === 'pool-checkout-timeout'));
    assert.equal(run.teardown.find((x: any) => x.phase === 'leak-reproduced').openLeases, PLANS.leak.failing);
    assert.equal(run.cause, null); assert.equal(run.customerResolution, null);
    assert.match(run.postgresVersion, /^1[678]\./);
    for (const file of readdirSync(output)) {
      const text = readFileSync(join(output, file), 'utf8');
      // Raw pg-pool and PostgreSQL messages are not retained, only their SQLSTATE and a fixed category.
      assert.doesNotMatch(text, /\/tmp\/pslab-leak-|postgres:\/\/|timeout exceeded when trying to connect|remaining connection slots are reserved|sorry, too many clients/, file);
      assert.equal(statSync(join(output, file)).mode & 0o077, 0, file);
    }
    const bytes = readFileSync(join(output, 'pool-exhaustion-run.json'), 'utf8');
    await assert.rejects(runLeakLab({ approved: true, output }), /EEXIST/);
    assert.equal(readFileSync(join(output, 'pool-exhaustion-run.json'), 'utf8'), bytes);
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  }
});

test('a failure while leaked leases are open still closes every client, stops the owned server and removes the cluster', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'leak-open-leases-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), { bin, log } = wrappedTools(dir, real);
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runLeakLab({ approved: true, output: join(dir, 'run'), injectFailure: 'leases-open' }), /during leak-reproduced\. Cleanup completed\. Injected test failure while leases are open\./);
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'pool-exhaustion-failure.json'), 'utf8'));
    assert.equal(failure.stage, 'leak-reproduced'); assert.equal(failure.cleanup, 'COMPLETE'); assert.equal(failure.cause, null);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls[0], 'start'); assert.ok(calls.includes('stop')); assert.equal(calls.at(-1), 'status');
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
    assert.deepEqual(readdirSync(join(dir, 'run')).sort(), ['pool-exhaustion-failure.json', 'pool-exhaustion-plan.json', 'pool-exhaustion-probes.json']);
  } finally { process.env.PSLAB_PG_BIN = real; }
});

test('if the owned server cannot be stopped, its directory is kept and cleanup is reported as failed', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'leak-stop-failure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), { bin } = wrappedTools(dir, real, { failStop: true });
  let kept: string | undefined;
  try {
    process.env.PSLAB_PG_BIN = bin;
    const error = await runLeakLab({ approved: true, output: join(dir, 'run'), injectFailure: 'leases-open' }).then(() => null, e => e);
    assert.match(String(error?.message), /cleanup failed\. The owned PostgreSQL server may still be running, and its temporary files remain at \/tmp\/pslab-leak-[A-Za-z0-9]+\./);
    kept = String(error.message).match(/remain at (\/tmp\/pslab-leak-[A-Za-z0-9]+)\./)![1];
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'pool-exhaustion-failure.json'), 'utf8'));
    assert.equal(failure.cleanup, 'FAILED'); assert.equal(failure.stage, 'leak-reproduced');
    // The lab did not delete the directory of a server it could not confirm had stopped.
    assert.ok(existsSync(join(kept, 'data', 'postmaster.pid'))); assert.equal(spawnSync(join(real, 'pg_ctl'), ['-D', join(kept, 'data'), 'status']).status, 0);
  } finally {
    process.env.PSLAB_PG_BIN = real;
    if (kept) { spawnSync(join(real, 'pg_ctl'), ['-D', join(kept, 'data'), '-m', 'fast', '-w', '-t', '10', 'stop']); rmSync(kept, { recursive: true, force: true }); }
  }
  assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
});

test('a failed initdb is named as such, before any server starts', { timeout: 120000 }, async t => {
  const real = process.env.PSLAB_PG_BIN;
  if (!real) { t.skip('PSLAB_PG_BIN is required to wrap the real server tools.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'leak-initdb-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'initdb'), `#!/bin/sh\nif [ "$1" = --version ]; then exec "${real}/initdb" "$@"; fi\nexit 3\n`, { mode: 0o700 });
  for (const tool of ['pg_ctl', 'postgres']) writeFileSync(join(bin, tool), `#!/bin/sh\nexec "${real}/${tool}" "$@"\n`, { mode: 0o700 });
  try {
    process.env.PSLAB_PG_BIN = bin;
    await assert.rejects(runLeakLab({ approved: true, output: join(dir, 'run') }), /during setup\. Cleanup completed\. A local command failed: initdb \(exit status 3\)/);
    const failure = JSON.parse(readFileSync(join(dir, 'run', 'pool-exhaustion-failure.json'), 'utf8'));
    assert.equal(failure.failedCommand, 'initdb'); assert.equal(failure.exitStatus, 3); assert.equal(failure.cleanup, 'COMPLETE');
    assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
  } finally { process.env.PSLAB_PG_BIN = real; }
});

test('actual pool-exhaustion run starts unreviewed, accepts an explicit test review and exports verifiable reviewed and gap-only bundles', { timeout: 300000 }, async t => {
  const { inspectLeakReview, leakReviewTemplate, appendLeakReview } = await import('../src/pool-exhaustion-review.ts');
  const { validateLeak } = await import('../src/pool-exhaustion-validation.ts');
  const { exportLeakBundle } = await import('../src/pool-exhaustion-bundle.ts');
  const { verifyAnyBundle } = await import('../src/bundle-dispatch.ts');
  const dir = mkdtempSync(join(tmpdir(), 'leak-review-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = temporary(), output = join(dir, 'run'); await runLeakLab({ approved: true, output });
  const fresh = inspectLeakReview(output);
  assert.equal(fresh.status, 'READY_FOR_REVIEW'); assert.equal(fresh.reviewStatus, 'NOT_REVIEWED'); assert.equal(fresh.cause, null);
  assert.equal(fresh.samePlan, true); assert.equal(fresh.leak.leasesOpenAfterQuiet, PLANS.leak.failing); assert.equal(fresh.fixResult.leasesOpenAfterRecovery, 0);
  assert.equal(validateLeak(output).status, 'VALIDATION_BLOCKED');
  const gapsBefore = exportLeakBundle(output, join(dir, 'gaps-unreviewed'), { mode: 'gaps' });
  // Automated contract check only. This is not a human assessment of any incident.
  const reviewer = 'automated-integration-test', rationale = 'Automated integration test decision against measured local evidence.';
  appendLeakReview(output, { ...leakReviewTemplate(output, 'cause'), reviewer, decision: 'accept', rationale });
  appendLeakReview(output, { ...leakReviewTemplate(output, 'remedy'), reviewer, remedy: 'release-in-finally', rationale });
  const validation = validateLeak(output);
  assert.equal(validation.status, 'RESOLUTION_VALIDATED', JSON.stringify(validation.checks.filter(c => !c.passed)));
  const reviewed = exportLeakBundle(output, join(dir, 'reviewed')), gaps = exportLeakBundle(output, join(dir, 'gaps-accepted'), { mode: 'gaps' });
  for (const [name, e, at] of [['reviewed', reviewed, 'RESOLUTION_VALIDATED'], ['gaps-accepted', gaps, 'WITHHELD_IN_GAP_REPORT'], ['gaps-unreviewed', gapsBefore, 'WITHHELD_IN_GAP_REPORT']] as const) {
    const verified = verifyAnyBundle(join(dir, name), { expectedManifestHash: e.manifestHash }) as any;
    assert.equal(verified.integrity, 'VALID', name); assert.equal(verified.validationAtExport, at, name);
    assert.equal(verified.customerResolution, null, name); assert.equal(verified.communicationApproval, 'PENDING', name);
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 'gaps-unreviewed', 'validation.json'), 'utf8')).blockers[0], 'An applicable acceptance of the local cause is required.');
  assert.deepEqual(temporary(), before); assert.equal(ownedServers(), '');
});
