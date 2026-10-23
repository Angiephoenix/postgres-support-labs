import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hash } from '../src/contracts.ts';
import { checkLeakRun, inspectLeak, leakManifest, leakMarkdown, leakHtml, outcomeOf, requestShape, originalHandler, fixedHandler, LEAK_QUERIES, LEAK_PHASES, PHASE_SPECS, PLANS, POOL_CONFIG, CODE_PATHS } from '../src/pool-exhaustion-evidence.ts';
import { leakPlan, runLeakLab } from '../src/pool-exhaustion-lab.ts';
import { leakFixture, FIXTURE_NOW, phaseOf, checkpointOf } from './pool-exhaustion-fixture.ts';

const rejects = (mutate: (run: any) => void, message: RegExp) => { const run: any = leakFixture(); mutate(run); assert.throws(() => checkLeakRun(run, FIXTURE_NOW), message); };
const leak = (r: any) => phaseOf(r, 'leak-reproduced'), fix = (r: any) => phaseOf(r, 'fix-applied');
const step = (p: any, s: string) => p.requests.filter((q: any) => q.step === s);
const leaseOf = (p: any, q: any) => p.leases.find((l: any) => l.lease === q.lease);
const eventAt = (p: any, seq: number) => p.events.find((e: any) => e.seq === seq);

test('outcomes come from the SQLSTATE and the exact server or pg-pool message, and anything else is "other"', () => {
  const server = (code: string, message: string) => Object.assign(new Error(message), { code, severity: 'FATAL' });
  assert.deepEqual(outcomeOf(Object.assign(new Error('division by zero'), { code: '22012', severity: 'ERROR' })), { outcome: 'division-by-zero', sqlstate: '22012' });
  assert.deepEqual(outcomeOf(new Error('timeout exceeded when trying to connect')), { outcome: 'pool-checkout-timeout', sqlstate: null });
  assert.deepEqual(outcomeOf(new Error('Connection terminated due to connection timeout')), { outcome: 'pool-connect-timeout', sqlstate: null });
  assert.equal(outcomeOf(server('53300', 'remaining connection slots are reserved for roles with the SUPERUSER attribute')).outcome, 'server-refused-reserved');
  assert.equal(outcomeOf(server('53300', 'sorry, too many clients already')).outcome, 'server-refused-full');
  assert.equal(outcomeOf(server('53300', 'too many connections for role "pslab_app"')).outcome, 'server-refused-role-limit');
  assert.equal(outcomeOf(new Error('Connection terminated unexpectedly')).outcome, 'connection-terminated');
  // A pool timeout message with a SQLSTATE, or a server code with another message, is not trusted as either.
  assert.equal(outcomeOf(server('53300', 'timeout exceeded when trying to connect')).outcome, 'other');
  assert.equal(outcomeOf(server('22012', 'remaining connection slots are reserved for roles with the SUPERUSER attribute')).outcome, 'other');
  assert.deepEqual(outcomeOf(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), { outcome: 'other', sqlstate: null });
});

test('the measured fixture passes and the evidence goes stale after an hour', () => {
  const checked = checkLeakRun(leakFixture(), FIXTURE_NOW);
  assert.equal(checked.evidenceStatus, 'MEASURED'); assert.equal(checked.reviewStatus, 'NOT_REVIEWED');
  assert.equal(checkLeakRun(leakFixture(), new Date('2026-10-15T13:00:00.000Z')).evidenceStatus, 'STALE');
});

test('the leak and the fix replay an identical request plan; only the handler differs', () => {
  const run = leakFixture();
  assert.deepEqual(requestShape(leak(run)), requestShape(fix(run)));
  assert.deepEqual(leak(run).checkpoints.map((c: any) => c.name), fix(run).checkpoints.map((c: any) => c.name));
  assert.equal(leak(run).planHash, fix(run).planHash); assert.equal(PHASE_SPECS['leak-reproduced'].handler, 'original'); assert.equal(PHASE_SPECS['fix-applied'].handler, 'fixed');
  // Dropping the recovery request leaves its lease without an owner, so the records reject it before the plans are compared.
  rejects(r => { fix(r).requests.pop(); }, /requests do not match the bundled plan/);
  rejects(r => { const p = fix(r), q = p.requests.pop(); p.leases = p.leases.filter((l: any) => l.lease !== q.lease); }, /requests do not match the bundled plan/);
  rejects(r => { step(fix(r), 'recovery')[0].step = 'probe'; }, /requests do not match the bundled plan/);
  rejects(r => { fix(r).planHash = phaseOf(r, 'demand-beyond-capacity').planHash; }, /plan mismatch/);
  rejects(r => { fix(r).handler = 'original'; }, /plan mismatch/);
});

test('a leak needs open leases on idle sessions that persist after a quiet period, and valid requests timing out', () => {
  rejects(r => { const s = checkpointOf(leak(r), 'after-quiet').sessions[0]; s.state = 'active'; }, /not idle outside a transaction at after-quiet/);
  rejects(r => { const s = checkpointOf(leak(r), 'after-failing').sessions[1]; s.inTransaction = true; s.state = 'idle in transaction'; }, /not idle outside a transaction at after-failing/);
  rejects(r => { leak(r).quietMs = 500; }, /quiet period was shorter/);
  rejects(r => { const q = step(leak(r), 'recovery')[0]; q.outcome = 'other'; }, /did not time out waiting for a client/);
  rejects(r => { checkpointOf(leak(r), 'probe-started').counters.waiting = 0; }, /probe was not seen waiting/);
  // Releasing a leaked lease is caught both against the pool events and as a release the original handler cannot make.
  rejects(r => { const p = leak(r), l = p.leases[0]; l.releaseSeq = checkpointOf(p, 'after-failing').seq - 1; }, /does not match its release event|leases and pool events disagree/);
});

test('the fix must release each failing request\'s client with the error before the checkpoint, and every later request must succeed', () => {
  rejects(r => { const p = fix(r), l = leaseOf(p, step(p, 'failing')[0]); l.releasedWithError = false; eventAt(p, l.releaseSeq).withError = false; }, /did not release its client with the error/);
  rejects(r => { const p = fix(r), l = leaseOf(p, step(p, 'failing')[0]); l.releasedWithError = false; }, /does not match its release event/);
  rejects(r => { const q = step(fix(r), 'probe')[0]; q.outcome = 'pool-checkout-timeout'; q.lease = null; }, /lease 4 is not owned|did not succeed/);
  rejects(r => { checkpointOf(fix(r), 'after-failing').counters.total = 3; checkpointOf(fix(r), 'after-failing').counters.idle = 3; }, /counters at after-failing differ from the pool's clients/);
});

test('leases, pool events, pool counters and server sessions must describe the same history', () => {
  rejects(r => { const p = leak(r); p.events = p.events.filter((e: any) => e.type !== 'acquire' || e.seq !== p.leases[0].acquireSeq); }, /leases and pool events disagree/);
  rejects(r => { leak(r).leases[0].backendPid += 1; }, /backend PID other than its client's/);
  rejects(r => { const p = leak(r); p.leases[1].request = p.leases[0].request; }, /not owned by exactly one request/);
  rejects(r => { const c = checkpointOf(phaseOf(r, 'baseline-valid-only'), 'completed'); c.counters.checkedOut = 1; c.counters.idle = 2; }, /counters at completed differ/);
  rejects(r => { const c = checkpointOf(phaseOf(r, 'baseline-valid-only'), 'completed'); c.counters.idle = 1; }, /do not add up/);
  rejects(r => { checkpointOf(leak(r), 'after-probe').sessions[0].pid += 100000; }, /session that is not one of the pool's clients at after-probe/);
  rejects(r => { checkpointOf(leak(r), 'after-probe').sessions.pop(); }, /server sessions at after-probe differ/);
  rejects(r => { checkpointOf(phaseOf(r, 'slow-query'), 'saturated').reached = false; }, /not reached within its time limit/);
  rejects(r => { leak(r).clientErrors.push({ seq: 9999, pool: 1, client: 1, outcome: 'connection-terminated', sqlstate: null }); }, /error event during measurement/);
  rejects(r => { const e = leak(r).events; [e[0].seq, e[1].seq] = [e[1].seq, e[0].seq]; }, /out of order/);
  rejects(r => { leak(r).events[0].pid = 1.5; }, /whole numbers/);
});

test('client checkout timeouts and server refusals cannot be relabelled as each other', () => {
  rejects(r => { const q = step(leak(r), 'probe')[0]; q.outcome = 'server-refused-reserved'; q.sqlstate = '53300'; }, /did not time out waiting for a client/);
  rejects(r => { const q = step(leak(r), 'probe')[0]; q.sqlstate = '53300'; }, /pool timeout carries a SQLSTATE/);
  rejects(r => { const q = step(phaseOf(r, 'server-refusal'), 'gated').find((x: any) => x.outcome !== 'ok'); q.outcome = 'pool-checkout-timeout'; q.sqlstate = null; }, /pool timeout carries|not PostgreSQL 53300 refusals|waited for a pool client/);
  rejects(r => { const q = step(phaseOf(r, 'server-refusal'), 'gated').find((x: any) => x.outcome !== 'ok'); q.sqlstate = '57P03'; }, /wrong SQLSTATE/);
  rejects(r => { const q = step(leak(r), 'failing')[0]; q.sqlstate = '22003'; }, /wrong SQLSTATE or no lease/);
});

test('controls must observe exhaustion and then recovery, without requiring an exact split of outcomes', () => {
  const demand = (r: any) => phaseOf(r, 'demand-beyond-capacity');
  rejects(r => { checkpointOf(demand(r), 'saturated').counters.waiting = 0; }, /exhaustion was not observed/);
  rejects(r => { for (const s of checkpointOf(demand(r), 'saturated').sessions) s.state = 'idle'; }, /exhaustion was not observed/);
  rejects(r => { for (const q of step(demand(r), 'busy')) if (q.outcome === 'pool-checkout-timeout') q.outcome = 'other'; }, /both successes and checkout timeouts/);
  rejects(r => { step(demand(r), 'recovery')[0].outcome = 'other'; }, /recovery request did not succeed/);
  rejects(r => { const c = checkpointOf(phaseOf(r, 'slow-query'), 'saturated'); for (const s of c.sessions) s.waitEvent = 'PgSleep'; }, /not running and waiting on the server at saturated/);
  rejects(r => { for (const q of step(phaseOf(r, 'long-transaction'), 'transaction')) q.via = 'handler'; }, /did not use the transaction harness|transaction harness was used outside/);
  rejects(r => { step(phaseOf(r, 'baseline-valid-only'), 'baseline')[0].via = 'transaction-harness'; }, /transaction harness was used outside/);
  rejects(r => { const p = phaseOf(r, 'long-transaction'); for (const s of checkpointOf(p, 'probe-settled').sessions) { s.state = 'idle'; s.inTransaction = false; } }, /not idle in an open transaction at probe-settled/);
  rejects(r => { phaseOf(r, 'server-refusal').slots.free = 6; }, /free connection slots/);
  rejects(r => { phaseOf(r, 'server-refusal').slots.clientBackends = 2; }, /free connection slots/);
  // The demand control checks for both outcomes, not their counts: the measured split is recorded as it happened.
  const run = leakFixture(), busy = step(demand(run), 'busy');
  assert.ok(busy.some((q: any) => q.outcome === 'ok') && busy.some((q: any) => q.outcome === 'pool-checkout-timeout'));
});

test('forced cleanup is recorded apart from the measurements and must match the leases left open', () => {
  const run = leakFixture(), t = Object.fromEntries(run.teardown.map(x => [x.phase, x]));
  assert.equal(t['leak-reproduced'].openLeases, PLANS.leak.failing); assert.equal(t['fix-applied'].openLeases, 0);
  // The fix is judged at checkpoints taken before teardown, so closing leaked clients cannot make the leak phase pass as fixed.
  assert.ok(checkpointOf(leak(run), 'after-recovery').seq <= leak(run).events.length + leak(run).clientErrors.length + 1);
  rejects(r => { r.teardown.find((x: any) => x.phase === 'leak-reproduced').openLeases = 0; }, /Teardown does not match the leases open/);
  rejects(r => { r.teardown[2].sessionsAfter = 1; }, /left sessions behind/);
  rejects(r => { r.teardown.reverse(); }, /missing or out of order/);
});

test('the run contract rejects other handler code, server settings, versions, paths and decisions', () => {
  rejects(r => { r.handlers.fixed = hash('another handler'); }, /handler code differs/);
  rejects(r => { r.server.maxConnections = 100; }, /server connection settings differ/);
  rejects(r => { r.postgresVersion = '15.8'; }, /PostgreSQL 16, 17 or 18/);
  rejects(r => { r.postgresVersion = '16.13 /tmp/pslab-leak-abc'; }, /private path/);
  rejects(r => { r.expiresAt = '2026-10-15T14:00:00.000Z'; }, /collection window/);
  rejects(r => { [r.phases[1], r.phases[2]] = [r.phases[2], r.phases[1]]; }, /phase identity, order or plan/);
  rejects(r => { r.cause = 'leak'; }, /constant mismatch/);
  rejects(r => { r.customerResolution = 'fixed'; }, /constant mismatch/);
});

test('the fix changes only how the handler releases its client', () => {
  // The function header names the handler, so it is left out of the comparison.
  const lines = (fn: Function) => fn.toString().split('\n').slice(1).map(l => l.trim()).filter(Boolean);
  const original = lines(originalHandler).filter(l => l !== 'client.release();');
  const fixedOnly = new Set(['let failure;', 'try {', '} catch (error) {', 'failure = error;', 'throw error;', '} finally {', 'client.release(failure);', '}']);
  const fixed = lines(fixedHandler).filter(l => !fixedOnly.has(l));
  assert.deepEqual(fixed, original.filter(l => l !== '}'));
  assert.ok(lines(originalHandler).includes('client.release();')); assert.ok(lines(fixedHandler).includes('client.release(failure);'));
  assert.equal(LEAK_QUERIES.handlers.original, originalHandler.toString()); assert.equal(LEAK_QUERIES.handlers.fixed, fixedHandler.toString());
});

test('reports describe the leak, each control and the fix, without claiming a cause', () => {
  const run = leakFixture(), md = leakMarkdown(run, FIXTURE_NOW), html = leakHtml(run, FIXTURE_NOW);
  assert.match(md, /Evidence: MEASURED\. Review: NOT_REVIEWED\./);
  assert.match(md, /3 requests failed with SQLSTATE 22012 and each kept its client checked out/);
  assert.match(md, /The pool did not recover on its own\./);
  assert.match(md, /The checkout timeout alone does not tell a leak from these\./);
  assert.match(md, /refused each later one with SQLSTATE 53300/);
  assert.match(md, /so releasing in finally does not remove checkout timeouts caused by demand\./);
  assert.match(md, /That cleanup is recorded separately and is not counted as a release\./);
  assert.match(md, /Human cause review, customer resolution and message approval remain pending\./);
  assert.match(md, /\| Control: transactions left open by the application \| transaction harness; original handler for warm-up, probe and recovery \|/);
  assert.doesNotMatch(md, /—/); assert.doesNotMatch(md, /idle_in_transaction_session_timeout|25P03|pool\.query/);
  assert.match(html, /<h1>Requests hang waiting for a connection\. Is it a leak\?<\/h1>/);
  assert.match(html, /MEASURED · HUMAN REVIEW PENDING/);
  assert.match(html, /data-label="Code path">fixed handler</);
  assert.doesNotMatch(html, /<script/);
  for (const phase of LEAK_PHASES) assert.ok(CODE_PATHS[phase]);
});

test('run inspection checks the probe catalog and manifest anchor', t => {
  const dir = mkdtempSync(join(tmpdir(), 'leak-inspect-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = leakFixture(), manifest = leakManifest(run);
  writeFileSync(join(dir, 'pool-exhaustion-run.json'), canonical(run)); writeFileSync(join(dir, 'pool-exhaustion-manifest.json'), canonical(manifest));
  writeFileSync(join(dir, 'pool-exhaustion-probes.json'), canonical(LEAK_QUERIES));
  const result = inspectLeak(dir, hash(manifest), FIXTURE_NOW);
  assert.equal(result.integrity, 'VALID'); assert.equal(result.anchorChecked, true);
  assert.throws(() => inspectLeak(dir, 'a'.repeat(64), FIXTURE_NOW), /differs from the supplied anchor/);
  writeFileSync(join(dir, 'pool-exhaustion-probes.json'), canonical({ ...LEAK_QUERIES, request: 'SELECT 1' }));
  assert.throws(() => inspectLeak(dir, undefined, FIXTURE_NOW), /integrity mismatch/);
  mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'link'));
  assert.throws(() => inspectLeak(join(dir, 'link'), undefined, FIXTURE_NOW), /regular pool-exhaustion run directory/);
});

test('the probe catalog is fixed SQL with bounded pools, and the plan keeps decisions unset', () => {
  assert.match(LEAK_QUERIES.request, /^SELECT count\(\*\)::int \/ \$1::int /);
  assert.doesNotMatch(LEAK_QUERIES.setup.join('\n'), /GRANT (ALL|INSERT|UPDATE|DELETE|CREATE)/);
  for (const sql of [LEAK_QUERIES.request, LEAK_QUERIES.busy, LEAK_QUERIES.gated, LEAK_QUERIES.sessions, LEAK_QUERIES.clientBackends, LEAK_QUERIES.settings, LEAK_QUERIES.identity]) assert.match(sql, /^SELECT /);
  assert.ok(POOL_CONFIG.max <= 8 && POOL_CONFIG.connectionTimeoutMillis > 0 && POOL_CONFIG.connectionTimeoutMillis <= 5000);
  assert.equal(PHASE_SPECS['leak-reproduced'].plan, PHASE_SPECS['fix-applied'].plan);
  const plan = leakPlan();
  assert.equal(plan.network, false); assert.equal(plan.approvalRequired, true); assert.equal(plan.cause, null); assert.equal(plan.customerResolution, null);
});

test('the runner requires explicit approval before creating anything', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'leak-approval-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(runLeakLab({ approved: false, output: join(dir, 'run') }), /requires --approve-lab/);
});

// Regression cases from review of 8c54fec. Each one was accepted by that version of the run contract.
const base = (r: any) => phaseOf(r, 'baseline-valid-only');
const rejectsAll = (mutate: (run: any) => void, message: RegExp, t?: any) => {
  rejects(mutate, message);
  // Unanchored inspection must refuse the same run, so the report is never built from it.
  if (!t) return;
  const dir = mkdtempSync(join(tmpdir(), 'leak-regression-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run: any = leakFixture(); mutate(run);
  writeFileSync(join(dir, 'pool-exhaustion-run.json'), canonical(run)); writeFileSync(join(dir, 'pool-exhaustion-manifest.json'), canonical(leakManifest(run)));
  writeFileSync(join(dir, 'pool-exhaustion-probes.json'), canonical(LEAK_QUERIES));
  assert.throws(() => inspectLeak(dir, undefined, FIXTURE_NOW), message);
};

test('review: a request lease must exist, belong to that request and match its pool and client', t => {
  // Six successful requests pointing at a lease that does not exist, with no events, no leases and an empty checkpoint.
  rejectsAll(r => { const p = base(r); for (const q of p.requests) q.lease = 999; p.events = []; p.leases = [];
    Object.assign(p.checkpoints[0], { seq: 1, counters: { total: 0, idle: 0, waiting: 0, checkedOut: 0 }, sessions: [] }); }, /lease 999 that does not exist|does not match the bundled plan|lease that does not exist/, t);
  rejects(r => { const p = base(r); p.requests[0].lease = p.requests[1].lease; }, /not owned by exactly one request|belongs to another request/);
});

test('review: acquire and release events each belong to exactly one lease, in order for each client', () => {
  // Lease 1 claims the release event of lease 6, which used the same client later.
  rejects(r => { const p = base(r); p.leases[0].releaseSeq = p.leases[5].releaseSeq; }, /release event .*more than one lease|not the next release of its client/);
  rejects(r => { const p = base(r); p.leases[3].acquireSeq = p.leases[0].acquireSeq; }, /acquire event .*more than one lease|leases repeat/);
});

test('review: the whole event history is checked, and nothing is recorded after the last checkpoint', () => {
  rejects(r => { const p = base(r), c = p.checkpoints.at(-1); p.events.push({ seq: c.seq, pool: 1, type: 'connect', client: 1, pid: p.events[0].pid, withError: false }); }, /after the last checkpoint|connected twice/);
  rejects(r => { const p = base(r), last = p.events.at(-1); p.events.push({ seq: last.seq + 1, pool: 1, type: 'remove', client: 1, pid: null, withError: false }); p.checkpoints.at(-1).seq = last.seq + 3; }, /counters at completed differ from the pool's clients/);
});

test('review: clients connected at the same time cannot share a backend PID', () => {
  rejects(r => { const p = base(r), shared = p.events.find((e: any) => e.type === 'connect' && e.client === 1).pid, old = p.events.find((e: any) => e.type === 'connect' && e.client === 2).pid;
    p.events.find((e: any) => e.type === 'connect' && e.client === 2).pid = shared;
    for (const l of p.leases) if (l.client === 2) l.backendPid = shared;
    for (const s of p.checkpoints.at(-1).sessions) if (s.pid === old) s.pid = shared; }, /share backend PID/);
});

test('review: teardown counts must match the clients the phase recorded', () => {
  rejects(r => { r.teardown[0].clientsEnded = 5; }, /Teardown of baseline-valid-only ended .* clients/);
  rejects(r => { r.teardown.find((x: any) => x.phase === 'server-refusal').clientsEnded = 5; }, /Teardown of server-refusal ended .* clients/);
});

test('review: each checkpoint has the kind and pool its plan gives it', () => {
  rejects(r => { Object.assign(base(r).checkpoints[0], { kind: 'live', counters: { total: 99, idle: 99, checkedOut: 0, waiting: 99 }, sessions: [] }); }, /checkpoint completed .*kind|planned checkpoints/);
  rejects(r => { checkpointOf(phaseOf(r, 'server-refusal'), 'recovered').pool = 1; }, /planned checkpoints|recovery did not use a new pool|counters at recovered differ/);
});

test('review: live checkpoints must agree with the recorded clients, leases and server PIDs', () => {
  // A demand checkpoint with one active session that belongs to none of the pool's clients.
  rejects(r => { checkpointOf(phaseOf(r, 'demand-beyond-capacity'), 'saturated').sessions = [{ pid: 4000000, state: 'active', waitEventType: 'Timeout', waitEvent: 'PgSleep', inTransaction: false }]; }, /session that is not one of the pool's clients/);
  rejects(r => { checkpointOf(phaseOf(r, 'demand-beyond-capacity'), 'saturated').counters = { total: 99, idle: 96, checkedOut: 3, waiting: 9 }; }, /more clients than its pool allows|idle clients/);
});

test('review: quiescent sessions must be idle outside a transaction, including after the fix', () => {
  rejects(r => { Object.assign(checkpointOf(fix(r), 'after-recovery').sessions[0], { state: 'idle in transaction', inTransaction: true }); }, /not idle outside a transaction at after-recovery/);
});

test('review: every phase must match its bundled request plan, not only its paired replay', () => {
  rejects(r => { for (const name of ['demand-beyond-capacity', 'demand-beyond-capacity-after-fix']) phaseOf(r, name as any).requests.push({ request: 999, step: 'probe', kind: 'failing', via: 'handler', outcome: 'other', sqlstate: null, lease: null }); }, /requests do not match the bundled plan/);
  rejects(r => { for (const p of [leak(r), fix(r)]) step(p, 'probe')[0].kind = 'failing'; }, /requests do not match the bundled plan/);
  rejects(r => { const p = phaseOf(r, 'long-transaction'); step(p, 'transaction')[0].via = 'handler'; }, /requests do not match the bundled plan/);
});

test('review: a checkpoint cannot be numbered before the requests its plan has finished', () => {
  rejects(r => { base(r).checkpoints[0].seq = 8; }, /recorded after the last checkpoint/);
  rejects(r => { checkpointOf(leak(r), 'after-failing').seq = 2; }, /still running at after-failing|differ from the pool events|counters at after-failing differ|not one of the pool's clients at after-failing/);
});

// Regression cases from review of 7961482. Each one was accepted by that version of the run contract.
test('review 2: live counters must match the recorded clients and sessions', t => {
  // One connected idle client and its server session, with counters claiming the pool is empty.
  rejectsAll(r => { checkpointOf(fix(r), 'probe-started').counters = { total: 0, idle: 0, checkedOut: 0, waiting: 0 }; }, /counters at probe-started differ from the pool's clients/, t);
});

test('review 2: every pool reference must be a pool the bundled plan uses', t => {
  rejectsAll(r => { const p = base(r); for (const e of p.events) e.pool = 0; for (const l of p.leases) l.pool = 0;
    Object.assign(p.checkpoints[0], { counters: { total: 0, idle: 0, waiting: 0, checkedOut: 0 }, sessions: [] }); }, /pool 0, which its plan does not use/, t);
});
