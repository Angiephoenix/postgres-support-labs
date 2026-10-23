import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { reportStyles, fontLicenses } from './report-theme.ts';

// The pool-exhaustion lab starts a disposable PostgreSQL cluster on a private Unix socket with TCP turned off and runs
// an in-process request handler against a small pg Pool. The original handler releases its client only when the query
// succeeds, so every failing request leaves a client checked out. Controls exhaust the same pool for other reasons:
// legitimate demand, a slow query, long transactions, and PostgreSQL refusing new connections.
export const APP_ROLE = 'pslab_app';
export const LEAK_PHASES = ['baseline-valid-only', 'leak-reproduced', 'demand-beyond-capacity', 'slow-query', 'long-transaction', 'server-refusal',
  'fix-applied', 'demand-beyond-capacity-after-fix'] as const;
export type LeakPhase = typeof LEAK_PHASES[number];

// The code under test. The original handler releases its client only when the query succeeds.
export async function originalHandler(pool, request) {
  const client = await pool.connect();
  const result = await client.query(request.sql, request.params);
  client.release();
  return result.rows;
}
// The fix: release in finally, passing the error when the query failed, so a client in an unknown state is discarded instead of reused.
export async function fixedHandler(pool, request) {
  const client = await pool.connect();
  let failure;
  try {
    const result = await client.query(request.sql, request.params);
    return result.rows;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    client.release(failure);
  }
}
// Control harness for the long-transaction phase only. It is not the code under test, and it always releases its client.
export async function transactionHarness(pool, request, gate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(request.sql, request.params);
    await gate;
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

// Every phase uses this pool configuration except the server-refusal control, whose pool allows more clients than the
// server has ordinary connection slots. Idle clients are kept, so pool counts change only through requests.
export const POOL_CONFIG = Object.freeze({ max: 3, connectionTimeoutMillis: 800, idleTimeoutMillis: 0 });
export const REFUSAL_POOL_CONFIG = Object.freeze({ max: 8, connectionTimeoutMillis: 800, idleTimeoutMillis: 0 });
export const SERVER_SETTINGS = Object.freeze({ maxConnections: 8, superuserReservedConnections: 2, reservedConnections: 0 });
// Safety limits on every lab session. Requests held by the lab's advisory lock wait under lock_timeout until it is released.
export const SESSION_LIMITS = Object.freeze({ statementTimeoutMs: 15000, queryTimeoutMs: 20000, lockTimeoutMs: 10000 });
// Request counts and waits for each phase. Phases with the same plan replay the same requests in the same order.
export const PLANS = Object.freeze({
  baseline: Object.freeze({ batches: 2, perBatch: 3 }),
  leak: Object.freeze({ failing: 3, quietMs: 1000 }),
  demand: Object.freeze({ warm: 3, busy: 12 }),
  slow: Object.freeze({ warm: 3, gated: 3 }),
  transaction: Object.freeze({ warm: 3, held: 3 }),
  refusal: Object.freeze({ gated: 8 }),
});
export type PlanName = keyof typeof PLANS;
export type HandlerName = 'original'|'fixed';
export const PHASE_SPECS: Record<LeakPhase, { plan: PlanName; handler: HandlerName }> = {
  'baseline-valid-only': { plan: 'baseline', handler: 'original' },
  'leak-reproduced': { plan: 'leak', handler: 'original' },
  'demand-beyond-capacity': { plan: 'demand', handler: 'original' },
  'slow-query': { plan: 'slow', handler: 'original' },
  'long-transaction': { plan: 'transaction', handler: 'original' },
  'server-refusal': { plan: 'refusal', handler: 'original' },
  'fix-applied': { plan: 'leak', handler: 'fixed' },
  'demand-beyond-capacity-after-fix': { plan: 'demand', handler: 'fixed' },
};
export const planHash = (plan: PlanName) => hash({ plan, steps: PLANS[plan], pool: plan === 'refusal' ? REFUSAL_POOL_CONFIG : POOL_CONFIG });
export const applicationName = (phase: LeakPhase) => 'pslab-pool-' + phase;

// Every statement and every piece of handler code the lab runs. Nothing here comes from a user, a pack or a bundle.
export const LEAK_QUERIES = Object.freeze({
  setup: Object.freeze([
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
    'CREATE SCHEMA app_data', 'CREATE SCHEMA lab_meta',
    'CREATE TABLE lab_meta.identity (run_id uuid NOT NULL)',
    'CREATE TABLE app_data.tasks (id integer PRIMARY KEY, project_id integer NOT NULL, title text NOT NULL)',
    "INSERT INTO app_data.tasks SELECT g, 1 + g % 3, 'Synthetic task ' || g FROM generate_series(1, 12) AS g",
    'GRANT USAGE ON SCHEMA app_data, lab_meta TO pslab_app',
    'GRANT SELECT ON app_data.tasks, lab_meta.identity TO pslab_app',
  ]),
  // One request query. The parameter is the number of project members, and zero members divides by zero (SQLSTATE 22012).
  request: 'SELECT count(*)::int / $1::int AS tasks_per_member FROM app_data.tasks',
  // A request that holds its connection for at least 400 ms, for the demand controls.
  busy: 'SELECT pg_sleep(0.4)',
  // A request that waits on the server until the lab releases its advisory lock, for the slow-query and refusal controls.
  gated: 'SELECT pg_advisory_xact_lock_shared(4242)',
  gateHold: 'SELECT pg_advisory_lock(4242)',
  gateRelease: 'SELECT pg_advisory_unlock(4242) AS released',
  identity: 'SELECT run_id::text AS run_id FROM lab_meta.identity',
  sessions: "SELECT pid, state, wait_event_type, wait_event, xact_start IS NOT NULL AS in_transaction FROM pg_catalog.pg_stat_activity " +
    "WHERE datname = current_database() AND application_name = $1 AND backend_type = 'client backend' ORDER BY pid",
  clientBackends: "SELECT count(*)::int AS connections FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend'",
  settings: "SELECT current_setting('max_connections')::int AS max_connections, current_setting('superuser_reserved_connections')::int AS superuser_reserved, " +
    "current_setting('reserved_connections')::int AS reserved",
  hba: Object.freeze(['local all all trust']),
  handlers: Object.freeze({ original: originalHandler.toString(), fixed: fixedHandler.toString(), transaction: transactionHarness.toString() }),
  plans: PLANS, phases: PHASE_SPECS, pool: POOL_CONFIG, refusalPool: REFUSAL_POOL_CONFIG, server: SERVER_SETTINGS, limits: SESSION_LIMITS,
});
export const handlerHashes = () => ({ original: hash(LEAK_QUERIES.handlers.original), fixed: hash(LEAK_QUERIES.handlers.fixed), transaction: hash(LEAK_QUERIES.handlers.transaction) });

// Request outcomes, read from the SQLSTATE and the server or pg-pool message. The message itself is not retained.
// The pool's own timeouts have no SQLSTATE; server refusals all share 53300 and differ only by message.
export const OUTCOMES = ['ok', 'division-by-zero', 'pool-checkout-timeout', 'pool-connect-timeout', 'server-refused-reserved', 'server-refused-full',
  'server-refused-role-limit', 'connection-terminated', 'other'] as const;
export type Outcome = typeof OUTCOMES[number];
export const sqlstateOf = (e: any) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e?.severity === 'string' ? e.code as string : null;
export function outcomeOf(error: unknown): { outcome: Outcome; sqlstate: string|null } {
  const sqlstate = sqlstateOf(error), message = String((error as any)?.message ?? '');
  const outcome: Outcome =
    sqlstate === '22012' && message === 'division by zero' ? 'division-by-zero'
    : sqlstate === '53300' && /^remaining connection slots are reserved for roles with /.test(message) ? 'server-refused-reserved'
    : sqlstate === '53300' && message === 'sorry, too many clients already' ? 'server-refused-full'
    : sqlstate === '53300' && /^too many connections for role "[^"]+"$/.test(message) ? 'server-refused-role-limit'
    : sqlstate === null && message === 'timeout exceeded when trying to connect' ? 'pool-checkout-timeout'
    : sqlstate === null && message === 'Connection terminated due to connection timeout' ? 'pool-connect-timeout'
    : sqlstate === null && message === 'Connection terminated unexpectedly' ? 'connection-terminated'
    : 'other';
  return { outcome, sqlstate };
}

export type RequestKind = 'valid'|'failing'|'busy'|'gated'|'transaction';
export type RequestStep = 'baseline'|'warm'|'failing'|'probe'|'recovery'|'busy'|'gated'|'transaction';
export type Counters = { total: number; idle: number; waiting: number; checkedOut: number };
export type Session = { pid: number; state: string|null; waitEventType: string|null; waitEvent: string|null; inTransaction: boolean };
// Pool events in the order pg-pool emitted them. `pool` numbers the pools used in a phase; `pid` is the backend PID of a new client.
export type PoolEvent = { seq: number; pool: number; type: 'connect'|'acquire'|'release'|'remove'; client: number; pid: number|null; withError: boolean };
// A lease is one checkout by one request, from pg-pool's acquire event to its release event.
export type Lease = { lease: number; request: number; pool: number; client: number; backendPid: number; acquireSeq: number; releaseSeq: number|null; releasedWithError: boolean };
export type RequestRecord = { request: number; step: RequestStep; kind: RequestKind; via: 'handler'|'transaction-harness'; outcome: Outcome; sqlstate: string|null; lease: number|null };
export type ClientError = { seq: number; pool: number; client: number|null; outcome: Outcome; sqlstate: string|null };
// A quiescent checkpoint is taken with no request in flight and no client connecting; a live one while requests are held.
export type Checkpoint = { name: string; kind: 'quiescent'|'live'; reached: boolean; seq: number; pool: number; counters: Counters; sessions: Session[] };
export type PhaseRecord = { phase: LeakPhase; collectedAt: string; handler: HandlerName; planHash: string; applicationName: string;
  events: PoolEvent[]; leases: Lease[]; requests: RequestRecord[]; checkpoints: Checkpoint[]; clientErrors: ClientError[];
  quietMs: number|null; slots: { clientBackends: number; free: number }|null };
// Forced cleanup after each phase's measurement closed. Nothing here counts as a release by the code under test.
export type Teardown = { phase: LeakPhase; openLeases: number; clientsEnded: number; clientEndTimeouts: number; poolEnd: 'resolved'|'timed-out'; sessionsAfter: number };
export type LeakRun = { schemaVersion: 1; scenario: 'connection-leak'; runId: string; profile: 'local-lab'; collectedAt: string; expiresAt: string;
  postgresVersion: string; clusterFingerprint: string; versions: { node: string; pg: string; pgPool: string };
  environment: { namesPresent: string[] };
  server: { maxConnections: number; superuserReservedConnections: number; reservedConnections: number };
  handlers: { original: string; fixed: string; transaction: string };
  phases: PhaseRecord[]; teardown: Teardown[];
  cleanup: 'COMPLETE'; classification: 'REPRODUCED_BEHAVIOR'; cause: null; customerResolution: null; reviewStatus: 'NOT_REVIEWED' };

const str = (max = 200) => ({ type: 'string', minLength: 1, maxLength: max });
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const date = { type: 'string', format: 'date-time' };
const bool = { type: 'boolean' };
// The artifact validator knows only `number`; checkLeakRun requires every number to be a whole number of zero or more.
const count = () => ({ type: 'number' });
const id = { type: 'number' };
const nid = { type: ['number', 'null'] };
const pid = { type: 'number' };
const sqlstate = { type: ['string', 'null'], pattern: '^[0-9A-Z]{5}$' };
const nname = { type: ['string', 'null'], pattern: '^[A-Za-z][A-Za-z ]{0,63}$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const list = (items: unknown, max: number) => ({ type: 'array', maxItems: max, items });
const counters = object({ total: count(), idle: count(), waiting: count(), checkedOut: count() });
const session = object({ pid, state: { enum: [null, 'idle', 'active', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call', 'disabled', 'starting'] },
  waitEventType: nname, waitEvent: nname, inTransaction: bool });
const phaseSchema = object({ phase: { enum: [...LEAK_PHASES] }, collectedAt: date, handler: { enum: ['original', 'fixed'] }, planHash: digest, applicationName: { type: 'string', pattern: '^pslab-pool-[a-z-]{1,50}$' },
  events: list(object({ seq: id, pool: id, type: { enum: ['connect', 'acquire', 'release', 'remove'] }, client: id, pid: { oneOf: [{ type: 'null' }, pid] }, withError: bool }), 400),
  leases: list(object({ lease: id, request: id, pool: id, client: id, backendPid: pid, acquireSeq: id, releaseSeq: nid, releasedWithError: bool }), 100),
  requests: list(object({ request: id, step: { enum: ['baseline', 'warm', 'failing', 'probe', 'recovery', 'busy', 'gated', 'transaction'] }, kind: { enum: ['valid', 'failing', 'busy', 'gated', 'transaction'] },
    via: { enum: ['handler', 'transaction-harness'] }, outcome: { enum: [...OUTCOMES] }, sqlstate, lease: nid }), 100),
  checkpoints: list(object({ name: { type: 'string', pattern: '^[a-z-]{1,40}$' }, kind: { enum: ['quiescent', 'live'] }, reached: bool, seq: id, pool: id, counters, sessions: list(session, 20) }), 20),
  clientErrors: list(object({ seq: id, pool: id, client: nid, outcome: { enum: [...OUTCOMES] }, sqlstate }), 50),
  quietMs: { type: ['number', 'null'] }, slots: { oneOf: [{ type: 'null' }, object({ clientBackends: count(), free: count() })] } });
const schema = object({ schemaVersion: { const: 1 }, scenario: { const: 'connection-leak' }, runId: uuid, profile: { const: 'local-lab' }, collectedAt: date, expiresAt: date,
  postgresVersion: str(100), clusterFingerprint: digest, versions: object({ node: str(40), pg: str(20), pgPool: str(20) }),
  environment: object({ namesPresent: list({ type: 'string', pattern: '^[A-Z_]{2,40}$' }, 20) }),
  server: object({ maxConnections: count(), superuserReservedConnections: count(), reservedConnections: count() }),
  handlers: object({ original: digest, fixed: digest, transaction: digest }),
  phases: { type: 'array', minItems: LEAK_PHASES.length, maxItems: LEAK_PHASES.length, items: phaseSchema },
  teardown: { type: 'array', minItems: LEAK_PHASES.length, maxItems: LEAK_PHASES.length,
    items: object({ phase: { enum: [...LEAK_PHASES] }, openLeases: count(), clientsEnded: count(), clientEndTimeouts: count(), poolEnd: { enum: ['resolved', 'timed-out'] }, sessionsAfter: count() }) },
  cleanup: { const: 'COMPLETE' }, classification: { const: 'REPRODUCED_BEHAVIOR' }, cause: { const: null }, customerResolution: { const: null }, reviewStatus: { const: 'NOT_REVIEWED' } });

const SECRET_SHAPES = [/\/tmp\/pslab-leak-/, /postgres(ql)?:\/\//];
type Expected = { step: RequestStep; kind: RequestKind; via: RequestRecord['via'] };
const times = (n: number, step: RequestStep, kind: RequestKind, via: RequestRecord['via'] = 'handler'): Expected[] => Array.from({ length: n }, () => ({ step, kind, via }));
// The requests each plan sends, in the order the runner sends them. Every phase is checked against its plan on its own.
export const PLAN_REQUESTS: Record<PlanName, readonly Expected[]> = {
  baseline: times(PLANS.baseline.batches * PLANS.baseline.perBatch, 'baseline', 'valid'),
  leak: [...times(PLANS.leak.failing, 'failing', 'failing'), ...times(1, 'probe', 'valid'), ...times(1, 'recovery', 'valid')],
  demand: [...times(PLANS.demand.warm, 'warm', 'valid'), ...times(PLANS.demand.busy, 'busy', 'busy'), ...times(1, 'recovery', 'valid')],
  slow: [...times(PLANS.slow.warm, 'warm', 'valid'), ...times(PLANS.slow.gated, 'gated', 'gated'), ...times(1, 'probe', 'valid'), ...times(1, 'recovery', 'valid')],
  transaction: [...times(PLANS.transaction.warm, 'warm', 'valid'), ...times(PLANS.transaction.held, 'transaction', 'transaction', 'transaction-harness'), ...times(1, 'probe', 'valid'), ...times(1, 'recovery', 'valid')],
  refusal: [...times(PLANS.refusal.gated, 'gated', 'gated'), ...times(1, 'recovery', 'valid')],
};
// The checkpoints each plan takes, in order, with their kind and pool. `settled` lists the steps whose requests have all
// finished before the checkpoint; `pending` lists the steps none of whose requests has started.
type ExpectedCheckpoint = { name: string; kind: Checkpoint['kind']; pool: number; settled: RequestStep[]; pending: RequestStep[] };
const cp = (name: string, kind: Checkpoint['kind'], settled: RequestStep[], pending: RequestStep[], pool = 1): ExpectedCheckpoint => ({ name, kind, pool, settled, pending });
export const PLAN_CHECKPOINTS: Record<PlanName, readonly ExpectedCheckpoint[]> = {
  baseline: [cp('completed', 'quiescent', ['baseline'], [])],
  leak: [cp('after-failing', 'quiescent', ['failing'], ['probe', 'recovery']), cp('probe-started', 'live', ['failing'], ['recovery']),
    cp('after-probe', 'quiescent', ['failing', 'probe'], ['recovery']), cp('after-quiet', 'quiescent', ['failing', 'probe'], ['recovery']),
    cp('after-recovery', 'quiescent', ['failing', 'probe', 'recovery'], [])],
  demand: [cp('warm', 'quiescent', ['warm'], ['busy', 'recovery']), cp('saturated', 'live', ['warm'], ['recovery']),
    cp('completed', 'quiescent', ['warm', 'busy'], ['recovery']), cp('recovered', 'quiescent', ['warm', 'busy', 'recovery'], [])],
  slow: [cp('warm', 'quiescent', ['warm'], ['gated', 'probe', 'recovery']), cp('saturated', 'live', ['warm'], ['probe', 'recovery']),
    cp('probe-settled', 'live', ['warm', 'probe'], ['recovery']), cp('completed', 'quiescent', ['warm', 'gated', 'probe'], ['recovery']),
    cp('recovered', 'quiescent', ['warm', 'gated', 'probe', 'recovery'], [])],
  transaction: [cp('warm', 'quiescent', ['warm'], ['transaction', 'probe', 'recovery']), cp('saturated', 'live', ['warm'], ['probe', 'recovery']),
    cp('probe-settled', 'live', ['warm', 'probe'], ['recovery']), cp('completed', 'quiescent', ['warm', 'transaction', 'probe'], ['recovery']),
    cp('recovered', 'quiescent', ['warm', 'transaction', 'probe', 'recovery'], [])],
  refusal: [cp('slots', 'quiescent', [], ['gated', 'recovery']), cp('held', 'live', [], ['recovery']), cp('completed', 'quiescent', ['gated'], ['recovery']),
    cp('pool-closed', 'quiescent', ['gated'], ['recovery']), cp('recovered', 'quiescent', ['gated', 'recovery'], [], 2)],
};
// The pools each plan uses. Only the refusal control opens a second pool, for its recovery request.
export const PLAN_POOLS: Record<PlanName, readonly number[]> = { baseline: [1], leak: [1], demand: [1], slow: [1], transaction: [1], refusal: [1, 2] };
const poolMax = (p: PhaseRecord, pool: number) => PHASE_SPECS[p.phase].plan === 'refusal' && pool === 1 ? REFUSAL_POOL_CONFIG.max : POOL_CONFIG.max;

// Replays a phase's pool events in order, across every pool it used, up to `before`. Each client connects once, with a
// backend PID no other connected client of the phase holds, is checked out and released in turn, and is removed only when idle.
function replay(p: PhaseRecord, before = Infinity) {
  const clients = new Map<string, { pool: number; client: number; pid: number; out: boolean; removed: boolean }>();
  for (const e of p.events) {
    if (e.seq >= before) break;
    const key = `${e.pool}:${e.client}`, c = clients.get(key);
    if (e.type === 'connect') {
      if (c) fail(`In ${p.phase}, client ${e.client} of pool ${e.pool} connected twice.`);
      if ([...clients.values()].some(x => !x.removed && x.pid === e.pid)) fail(`In ${p.phase}, two connected clients share backend PID ${e.pid}.`);
      clients.set(key, { pool: e.pool, client: e.client, pid: e.pid!, out: false, removed: false });
    } else if (!c || c.removed) fail(`In ${p.phase}, a pool event names a client that is not connected.`);
    else if (e.type === 'acquire') { if (c.out) fail(`In ${p.phase}, a checked-out client was acquired again.`); c.out = true; }
    else if (e.type === 'release') { if (!c.out) fail(`In ${p.phase}, a client was released without being checked out.`); c.out = false; }
    else { if (c.out) fail(`In ${p.phase}, a checked-out client was removed.`); c.removed = true; }
  }
  return [...clients.values()];
}
function stateAt(p: PhaseRecord, c: Checkpoint) {
  const clients = replay(p, c.seq).filter(x => x.pool === c.pool && !x.removed);
  return { live: new Map(clients.map(x => [x.client, x.pid])), out: new Set(clients.filter(x => x.out).map(x => x.client)), outPids: clients.filter(x => x.out).map(x => x.pid) };
}
const openAt = (p: PhaseRecord, cp: Checkpoint) => p.leases.filter(l => l.pool === cp.pool && l.acquireSeq < cp.seq && (l.releaseSeq === null || l.releaseSeq >= cp.seq));
const ids = (xs: { lease: number }[]) => xs.map(x => x.lease).sort((a, b) => a - b);
const pidsOf = (s: Session[]) => s.map(x => x.pid).sort((a, b) => a - b);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const isIdle = (s?: Session) => s?.state === 'idle' && !s.inTransaction;
// Request sequence of a phase without measured outcomes, so a phase can be compared with its plan and with its replay.
export const requestShape = (p: PhaseRecord) => p.requests.map(q => ({ request: q.request, step: q.step, kind: q.kind, via: q.via }));
export const plannedShape = (plan: PlanName) => PLAN_REQUESTS[plan].map((x, i) => ({ request: i + 1, ...x }));

// Checks that requests, leases, pool events, pool counters and server sessions in one phase describe the same history.
function checkPhaseRecords(p: PhaseRecord) {
  const plan = PHASE_SPECS[p.phase].plan;
  if (canonical(requestShape(p)) !== canonical(plannedShape(plan))) fail(`In ${p.phase}, the requests do not match the bundled plan.`);
  const expected = PLAN_CHECKPOINTS[plan];
  if (canonical(p.checkpoints.map(c => [c.name, c.kind, c.pool])) !== canonical(expected.map(c => [c.name, c.kind, c.pool]))) fail(`${p.phase} did not take its planned checkpoints, with their planned kind and pool.`);
  // Pool events and client errors share one sequence. A checkpoint's number is the next one after everything it covers,
  // and the last checkpoint closes the measurement, so nothing is numbered after it.
  const numbered = [...p.events.map(e => e.seq), ...p.clientErrors.map(e => e.seq)], last = p.checkpoints.at(-1)!.seq;
  if (p.events.some((e, i) => i && e.seq <= p.events[i - 1].seq) || p.checkpoints.some((c, i) => i && c.seq < p.checkpoints[i - 1].seq)) fail(`In ${p.phase}, events or checkpoints are out of order.`);
  if (new Set(numbered).size !== numbered.length) fail(`In ${p.phase}, event numbers repeat.`);
  if (numbered.some(n => n >= last)) fail(`In ${p.phase}, an event was recorded after the last checkpoint.`);
  if (p.events.some(e => (e.type === 'connect') !== (e.pid !== null) || (e.type !== 'release' && e.withError))) fail(`In ${p.phase}, a pool event has fields that do not belong to its type.`);
  // Every pool reference must be one of the pools the plan uses; pool 0 or any other number is refused.
  const pools = PLAN_POOLS[plan];
  for (const [what, refs] of [['an event', p.events], ['a lease', p.leases], ['a client error', p.clientErrors], ['a checkpoint', p.checkpoints]] as const)
    for (const x of refs as readonly { pool: number }[]) if (!pools.includes(x.pool)) fail(`In ${p.phase}, ${what} names pool ${x.pool}, which its plan does not use.`);
  const clients = replay(p), pidOf = new Map(clients.map(c => [`${c.pool}:${c.client}`, c.pid]));
  // Each acquire and each release event belongs to exactly one lease, and a lease ends at its client's next release.
  const bySeq = new Map(p.events.map(e => [e.seq, e]));
  const acquires = p.events.filter(e => e.type === 'acquire'), releases = p.events.filter(e => e.type === 'release');
  const releaseRefs = p.leases.filter(l => l.releaseSeq !== null).map(l => l.releaseSeq!);
  if (new Set(p.leases.map(l => l.lease)).size !== p.leases.length) fail(`In ${p.phase}, leases repeat.`);
  if (new Set(p.leases.map(l => l.acquireSeq)).size !== p.leases.length) fail(`In ${p.phase}, an acquire event is claimed by more than one lease.`);
  if (new Set(releaseRefs).size !== releaseRefs.length) fail(`In ${p.phase}, a release event is claimed by more than one lease.`);
  if (acquires.length !== p.leases.length || releases.length !== releaseRefs.length) fail(`In ${p.phase}, leases and pool events disagree.`);
  for (const l of p.leases) {
    const a = bySeq.get(l.acquireSeq);
    if (a?.type !== 'acquire' || a.client !== l.client || a.pool !== l.pool) fail(`In ${p.phase}, lease ${l.lease} does not match its acquire event.`);
    const next = p.events.find(e => e.seq > a.seq && e.pool === l.pool && e.client === l.client && (e.type === 'release' || e.type === 'acquire'));
    if (l.releaseSeq === null ? next !== undefined : next?.seq !== l.releaseSeq) fail(`In ${p.phase}, lease ${l.lease} does not end at the next release of its client.`);
    if (l.releaseSeq !== null && (next!.type !== 'release' || next!.withError !== l.releasedWithError)) fail(`In ${p.phase}, lease ${l.lease} does not match its release event.`);
    if (l.releaseSeq === null && l.releasedWithError) fail(`In ${p.phase}, an open lease is marked as released with an error.`);
    if (pidOf.get(`${l.pool}:${l.client}`) !== l.backendPid) fail(`In ${p.phase}, lease ${l.lease} has a backend PID other than its client's.`);
    const owners = p.requests.filter(q => q.lease === l.lease);
    if (owners.length !== 1 || owners[0].request !== l.request) fail(`In ${p.phase}, lease ${l.lease} is not owned by exactly one request.`);
  }
  const leases = new Map(p.leases.map(l => [l.lease, l]));
  for (const q of p.requests) {
    if (q.lease !== null && !leases.has(q.lease)) fail(`In ${p.phase}, request ${q.request} names lease ${q.lease} that does not exist.`);
    if (q.lease !== null && leases.get(q.lease)!.request !== q.request) fail(`In ${p.phase}, request ${q.request} names a lease that belongs to another request.`);
    if (q.outcome === 'ok' && (q.sqlstate !== null || q.lease === null)) fail(`In ${p.phase}, a successful request has no lease or has a SQLSTATE.`);
    // A request refused before it got a client never holds a lease.
    if (['pool-checkout-timeout', 'pool-connect-timeout', 'server-refused-reserved', 'server-refused-full', 'server-refused-role-limit'].includes(q.outcome) && q.lease !== null) fail(`In ${p.phase}, a request that never got a client holds a lease.`);
    if (q.outcome === 'division-by-zero' && (q.sqlstate !== '22012' || q.lease === null)) fail(`In ${p.phase}, a failing query has the wrong SQLSTATE or no lease.`);
    if (q.outcome.startsWith('server-refused') && q.sqlstate !== '53300') fail(`In ${p.phase}, a server refusal has the wrong SQLSTATE.`);
    if (['pool-checkout-timeout', 'pool-connect-timeout'].includes(q.outcome) && q.sqlstate !== null) fail(`In ${p.phase}, a pool timeout carries a SQLSTATE.`);
  }
  p.checkpoints.forEach((c, i) => {
    const { live, out } = stateAt(p, c), open = openAt(p, c), plan = expected[i], idleClients = live.size - out.size;
    if (canonical(sorted(open.map(l => l.client))) !== canonical(sorted([...out]))) fail(`In ${p.phase}, the leases open at ${c.name} differ from the pool events.`);
    if (c.counters.idle + c.counters.checkedOut !== c.counters.total) fail(`In ${p.phase}, the pool counters at ${c.name} do not add up.`);
    if (c.counters.total > poolMax(p, c.pool)) fail(`In ${p.phase}, the counters at ${c.name} show more clients than its pool allows.`);
    // No checkpoint in these plans falls while a client is connecting or being removed: quiescent checkpoints wait for that,
    // and live ones are taken on a warmed pool or after the connecting request has settled, with the runner waiting until the
    // pool's count matches its connected clients. So at every checkpoint the counters and sessions match the replayed clients exactly.
    if (c.counters.total !== live.size || c.counters.checkedOut !== out.size || c.counters.idle !== idleClients) fail(`In ${p.phase}, the counters at ${c.name} differ from the pool's clients.`);
    if (new Set(c.sessions.map(s => s.pid)).size !== c.sessions.length || c.sessions.some(s => ![...live.values()].includes(s.pid))) fail(`In ${p.phase}, the server shows a session that is not one of the pool's clients at ${c.name}.`);
    if (canonical(pidsOf(c.sessions)) !== canonical(sorted([...live.values()]))) fail(`In ${p.phase}, the server sessions at ${c.name} differ from the pool's clients.`);
    // The requests the plan has finished before this checkpoint got and returned their clients before it; later ones had not started.
    for (const q of p.requests) {
      if (q.lease === null) continue;
      const l = leases.get(q.lease)!;
      if (plan.settled.includes(q.step) && (l.acquireSeq >= c.seq || (l.releaseSeq !== null && l.releaseSeq >= c.seq))) fail(`In ${p.phase}, a ${q.step} request was still running at ${c.name}.`);
      if (plan.pending.includes(q.step) && l.acquireSeq < c.seq) fail(`In ${p.phase}, a ${q.step} request started before ${c.name}.`);
    }
    if (c.kind === 'quiescent') {
      // With nothing in flight, pool counters, events and server sessions must all agree, and every session is idle.
      if (c.counters.waiting !== 0) fail(`In ${p.phase}, a request was waiting at quiescent checkpoint ${c.name}.`);
      if (!c.sessions.every(s => isIdle(s))) fail(`In ${p.phase}, a session was not idle outside a transaction at ${c.name}.`);
    }
  });
}

const by = (p: PhaseRecord) => Object.fromEntries(p.checkpoints.map(c => [c.name, c])) as Record<string, Checkpoint>;
const steps = (p: PhaseRecord, step: RequestStep) => p.requests.filter(q => q.step === step);
const outcomes = (qs: RequestRecord[]) => qs.map(q => q.outcome);
const all = (qs: RequestRecord[], o: Outcome) => qs.length > 0 && qs.every(q => q.outcome === o);
const leaseOf = (p: PhaseRecord, q: RequestRecord) => p.leases.find(l => l.lease === q.lease)!;
const sessionFor = (cp: Checkpoint, l: Lease) => cp.sessions.find(s => s.pid === l.backendPid);

// The same requests, warm-up, recovery and checkpoints both times. Outcomes differ only through the handler.
function checkLeakPlan(p: PhaseRecord, fixed: boolean) {
  const cp = by(p), failing = steps(p, 'failing'), probe = steps(p, 'probe'), recovery = steps(p, 'recovery'), n = PLANS.leak.failing;
  if (failing.length !== n || probe.length !== 1 || recovery.length !== 1 || p.requests.length !== n + 2) fail(`${p.phase} did not replay the leak request plan.`);
  if (!failing.every(q => q.kind === 'failing' && q.outcome === 'division-by-zero')) fail(`In ${p.phase}, the failing requests did not fail with SQLSTATE 22012.`);
  if (p.quietMs === null || p.quietMs < PLANS.leak.quietMs || p.quietMs <= POOL_CONFIG.connectionTimeoutMillis) fail(`In ${p.phase}, the quiet period was shorter than the plan.`);
  if (cp['after-failing'].counters.waiting !== 0) fail(`In ${p.phase}, a request was waiting after the failing requests settled.`);
  const failingLeases = failing.map(q => leaseOf(p, q));
  if (!fixed) {
    // The leak: each failing request still holds its client, on an idle server session, after everything has settled.
    for (const name of ['after-failing', 'after-probe', 'after-quiet', 'after-recovery']) {
      const open = openAt(p, cp[name]);
      if (canonical(ids(open)) !== canonical(ids(failingLeases)) || open.length !== POOL_CONFIG.max) fail(`In ${p.phase}, the failing requests' leases were not all open at ${name}.`);
      if (!open.every(l => isIdle(sessionFor(cp[name], l)))) fail(`In ${p.phase}, a leaked lease's server session was not idle at ${name}.`);
    }
    if (p.leases.some(l => l.releaseSeq !== null)) fail(`In ${p.phase}, the original handler released a client after a failed query.`);
    if (cp['probe-started'].counters.waiting !== 1 || cp['probe-started'].counters.checkedOut !== POOL_CONFIG.max) fail(`In ${p.phase}, the probe was not seen waiting for a client.`);
    if (!all(probe, 'pool-checkout-timeout') || !all(recovery, 'pool-checkout-timeout')) fail(`In ${p.phase}, the valid requests did not time out waiting for a client, before and after the quiet period.`);
  } else {
    // The fix: every failing request released its client with the error, so the pool discarded it.
    if (!failingLeases.every(l => l.releaseSeq !== null && l.releasedWithError && l.releaseSeq < cp['after-failing'].seq)) fail(`In ${p.phase}, a failing request did not release its client with the error.`);
    for (const name of ['after-failing', 'after-probe', 'after-quiet', 'after-recovery']) if (openAt(p, cp[name]).length !== 0) fail(`In ${p.phase}, a lease was still open at ${name}.`);
    if (cp['after-failing'].counters.total !== 0) fail(`In ${p.phase}, a client released with an error stayed in the pool.`);
    if (cp['probe-started'].counters.waiting !== 0) fail(`In ${p.phase}, the probe waited for a client.`);
    if (!all(probe, 'ok') || !all(recovery, 'ok') || [...probe, ...recovery].some(q => leaseOf(p, q).releasedWithError)) fail(`In ${p.phase}, the valid requests did not succeed.`);
  }
}

// Demand beyond capacity: every client busy, requests waiting, some timing out, and full recovery once the load ends.
function checkDemand(p: PhaseRecord) {
  const cp = by(p), busy = steps(p, 'busy'), o = outcomes(busy);
  if (steps(p, 'warm').length !== PLANS.demand.warm || !all(steps(p, 'warm'), 'ok') || busy.length !== PLANS.demand.busy) fail(`${p.phase} did not replay the demand request plan.`);
  if (cp.warm.counters.total !== POOL_CONFIG.max || cp.warm.counters.idle !== POOL_CONFIG.max) fail(`In ${p.phase}, the pool was not warm before the load.`);
  const s = cp.saturated;
  const busyPids = stateAt(p, s).outPids;
  if (s.counters.checkedOut !== POOL_CONFIG.max || s.counters.waiting < 1 || !s.sessions.some(x => x.state === 'active' && busyPids.includes(x.pid))) fail(`In ${p.phase}, exhaustion was not observed: every client busy, requests waiting and a checked-out client's query running.`);
  // Each busy request holds its client for at least 400 ms, so with 12 requests, 3 clients and an 800 ms checkout timeout,
  // the last requests cannot get a client in time. The count of each outcome is recorded, not required.
  if (o.some(x => x !== 'ok' && x !== 'pool-checkout-timeout') || !o.includes('ok') || !o.includes('pool-checkout-timeout')) fail(`In ${p.phase}, the load did not produce both successes and checkout timeouts, and nothing else.`);
  checkRecovered(p, ['completed', 'recovered']);
}
function checkRecovered(p: PhaseRecord, names: string[]) {
  const cp = by(p);
  for (const name of names) if (openAt(p, cp[name]).length !== 0 || !cp[name].sessions.every(s => isIdle(s))) fail(`In ${p.phase}, the pool had not recovered at ${name}.`);
  if (!all(steps(p, 'recovery'), 'ok') || steps(p, 'recovery').length !== 1) fail(`In ${p.phase}, the recovery request did not succeed.`);
}
// Slow queries and long transactions: the held requests exhaust the pool and a probe times out; once they finish, it recovers.
function checkHeld(p: PhaseRecord, step: 'gated'|'transaction', expected: (s?: Session) => boolean, label: string) {
  const cp = by(p), held = steps(p, step), plan = step === 'gated' ? PLANS.slow.gated : PLANS.transaction.held;
  if (steps(p, 'warm').length !== 3 || !all(steps(p, 'warm'), 'ok') || held.length !== plan || steps(p, 'probe').length !== 1) fail(`${p.phase} did not replay its request plan.`);
  if (step === 'transaction' && !held.every(q => q.via === 'transaction-harness')) fail(`In ${p.phase}, the held transactions did not use the transaction harness.`);
  const heldLeases = held.map(q => leaseOf(p, q));
  for (const name of ['saturated', 'probe-settled']) {
    const open = openAt(p, cp[name]);
    if (canonical(ids(open)) !== canonical(ids(heldLeases)) || !open.every(l => expected(sessionFor(cp[name], l)))) fail(`In ${p.phase}, the held requests were not ${label} at ${name}.`);
  }
  if (cp.saturated.counters.checkedOut !== POOL_CONFIG.max) fail(`In ${p.phase}, the held requests did not occupy every client.`);
  if (!all(steps(p, 'probe'), 'pool-checkout-timeout')) fail(`In ${p.phase}, the probe did not time out waiting for a client.`);
  if (!all(held, 'ok') || heldLeases.some(l => l.releaseSeq === null || l.releasedWithError || l.releaseSeq >= cp.completed.seq)) fail(`In ${p.phase}, the held requests did not finish and release their clients.`);
  checkRecovered(p, ['completed', 'recovered']);
}
// PostgreSQL refusing connections: the pool allows more clients than the server has free ordinary slots. Connections
// open one at a time, so exactly the free slots are accepted and every later attempt is refused with 53300.
function checkRefusal(p: PhaseRecord, run: LeakRun) {
  const cp = by(p), gated = steps(p, 'gated'), ok = gated.filter(q => q.outcome === 'ok'), refused = gated.filter(q => q.outcome !== 'ok');
  if (gated.length !== PLANS.refusal.gated || p.slots === null) fail(`${p.phase} did not replay the refusal request plan.`);
  const free = run.server.maxConnections - run.server.superuserReservedConnections - run.server.reservedConnections - p.slots.clientBackends;
  if (p.slots.free !== free || p.slots.clientBackends !== 1 || free >= PLANS.refusal.gated || free < 1) fail(`In ${p.phase}, the free connection slots were not recorded correctly.`);
  if (ok.length !== free || canonical(gated.slice(0, free).map(q => q.outcome)) !== canonical(ok.map(() => 'ok'))) fail(`In ${p.phase}, the accepted connections differ from the free slots.`);
  if (!all(refused, 'server-refused-reserved')) fail(`In ${p.phase}, the refused connections were not PostgreSQL 53300 refusals for reserved slots.`);
  if (p.requests.some(q => q.outcome === 'pool-checkout-timeout')) fail(`In ${p.phase}, a request waited for a pool client instead of being refused by the server.`);
  if (cp.held.counters.checkedOut !== free || openAt(p, cp.held).length !== free || cp.held.counters.total !== free) fail(`In ${p.phase}, the held connections differ from the accepted ones.`);
  if (cp['pool-closed'].counters.total !== 0 || cp['pool-closed'].sessions.length !== 0) fail(`In ${p.phase}, the refusal pool's sessions remained after it closed.`);
  if (cp.recovered.pool === cp.held.pool) fail(`In ${p.phase}, recovery did not use a new pool.`);
  checkRecovered(p, ['completed', 'recovered']);
}

export function checkLeakRun(value: unknown, now = new Date()) {
  validateArtifact(value, schema);
  const run = value as LeakRun;
  if (!Number.isFinite(now.getTime())) fail('Invalid pool-exhaustion evidence clock.');
  const numbers = (v: unknown): number[] => typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(numbers) : [];
  if (numbers(run).some(n => !Number.isSafeInteger(n) || n < 0)) fail('Pool-exhaustion counts, numbers and PIDs must be whole numbers of zero or more.');
  const start = Date.parse(run.collectedAt), end = Date.parse(run.expiresAt);
  if (start > now.getTime() || end - start !== 3600000) fail('Invalid pool-exhaustion evidence collection window.');
  if (SECRET_SHAPES.some(rx => rx.test(canonical(run)))) fail('A private path or connection string was retained.');
  if (!/^(16|17|18)\.[0-9]+( |$)/.test(run.postgresVersion)) fail('The retained evidence is not from PostgreSQL 16, 17 or 18.');
  if (canonical(run.server) !== canonical(SERVER_SETTINGS)) fail('The server connection settings differ from the fixed experiment.');
  if (canonical(run.handlers) !== canonical(handlerHashes())) fail('The handler code differs from the bundled handlers.');
  const phases = Object.fromEntries(run.phases.map(p => [p.phase, p])) as Record<LeakPhase, PhaseRecord>;
  let previous = start;
  run.phases.forEach((p, i) => {
    const spec = PHASE_SPECS[p.phase], time = Date.parse(p.collectedAt);
    if (p.phase !== LEAK_PHASES[i] || p.handler !== spec.handler || p.planHash !== planHash(spec.plan) || p.applicationName !== applicationName(p.phase)) fail('Pool-exhaustion phase identity, order or plan mismatch.');
    if (time < previous || time > now.getTime() || time >= end) fail('Invalid pool-exhaustion phase time.');
    previous = time;
    if (p.checkpoints.some(c => !c.reached)) fail(`In ${p.phase}, a checkpoint was not reached within its time limit.`);
    // No client reported an error event while the phase was measured.
    if (p.clientErrors.length) fail(`In ${p.phase}, a client reported an error event during measurement.`);
    if ((p.quietMs !== null) !== (spec.plan === 'leak') || (p.slots !== null) !== (spec.plan === 'refusal')) fail(`In ${p.phase}, plan-specific fields do not match the plan.`);
    if (p.requests.some(q => q.via === 'transaction-harness') !== (spec.plan === 'transaction')) fail(`In ${p.phase}, the transaction harness was used outside its control.`);
    checkPhaseRecords(p);
  });
  const base = phases['baseline-valid-only'];
  if (steps(base, 'baseline').length !== PLANS.baseline.batches * PLANS.baseline.perBatch || !all(base.requests, 'ok') || openAt(base, by(base).completed).length !== 0) fail('The baseline did not complete valid requests and release every client.');
  // The leak and the fix replay the same request plan; only the handler differs.
  const leak = phases['leak-reproduced'], fix = phases['fix-applied'];
  if (canonical(requestShape(leak)) !== canonical(requestShape(fix)) || leak.planHash !== fix.planHash) fail('The leak and fix phases did not replay identical request plans.');
  checkLeakPlan(leak, false); checkLeakPlan(fix, true);
  const demand = phases['demand-beyond-capacity'], demandAfter = phases['demand-beyond-capacity-after-fix'];
  if (canonical(requestShape(demand)) !== canonical(requestShape(demandAfter))) fail('The demand phases did not replay identical request plans.');
  checkDemand(demand); checkDemand(demandAfter);
  checkHeld(phases['slow-query'], 'gated', s => s?.state === 'active' && s.waitEventType === 'Lock' && s.waitEvent === 'advisory', 'running and waiting on the server');
  checkHeld(phases['long-transaction'], 'transaction', s => s?.state === 'idle in transaction' && s.inTransaction, 'idle in an open transaction');
  checkRefusal(phases['server-refusal'], run);
  // Forced cleanup is recorded apart from the measurements. It closed the leaked clients only after the leak phase was measured.
  if (canonical(run.teardown.map(t => t.phase)) !== canonical([...LEAK_PHASES])) fail('Pool teardown records are missing or out of order.');
  const teardown = Object.fromEntries(run.teardown.map(t => [t.phase, t])) as Record<LeakPhase, Teardown>;
  if (teardown['leak-reproduced'].openLeases !== PLANS.leak.failing || teardown['fix-applied'].openLeases !== 0) fail('Teardown does not match the leases open at the end of the leak and fix phases.');
  if (run.teardown.some(t => t.sessionsAfter !== 0 || t.clientEndTimeouts !== 0)) fail('A pool left sessions behind after teardown.');
  for (const p of run.phases) {
    if (teardown[p.phase].openLeases !== p.leases.filter(l => l.releaseSeq === null).length) fail(`Teardown of ${p.phase} does not match its open leases.`);
    // Teardown ends every client the phase connected, including any its pool had already closed, each once.
    const connected = p.events.filter(e => e.type === 'connect').length, t = teardown[p.phase];
    if (t.clientsEnded + t.clientEndTimeouts !== connected) fail(`Teardown of ${p.phase} ended ${t.clientsEnded + t.clientEndTimeouts} clients, but the phase connected ${connected}.`);
  }
  return { run, evidenceStatus: now.getTime() >= end ? 'STALE' : 'MEASURED', reviewStatus: 'NOT_REVIEWED' as const };
}

export function leakManifest(run: LeakRun) {
  return { schemaVersion: 1, scenario: 'connection-leak', runHash: hash(run), catalogHash: hash(LEAK_QUERIES) };
}
export function inspectLeak(dir: string, expectedHash?: string, now = new Date()) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular pool-exhaustion run directory.');
  const result = checkLeakRun(readJson(join(dir, 'pool-exhaustion-run.json')), now);
  const manifest = readJson(join(dir, 'pool-exhaustion-manifest.json'));
  if (canonical(manifest) !== canonical(leakManifest(result.run)) || canonical(readJson(join(dir, 'pool-exhaustion-probes.json'))) !== canonical(LEAK_QUERIES)) fail('Pool-exhaustion artifact integrity mismatch.');
  const manifestHash = hash(manifest);
  if (expectedHash !== undefined && expectedHash !== manifestHash) fail('Pool-exhaustion manifest differs from the supplied anchor.');
  return { ...result, integrity: 'VALID', anchorChecked: expectedHash !== undefined, manifestHash };
}

export const PHASE_LABELS: Record<LeakPhase, string> = {
  'baseline-valid-only': 'Baseline: valid requests only',
  'leak-reproduced': 'Failing requests, then valid requests',
  'demand-beyond-capacity': 'Control: more concurrent requests than clients',
  'slow-query': 'Control: queries held running on the server',
  'long-transaction': 'Control: transactions left open by the application',
  'server-refusal': 'Control: a pool larger than the server allows',
  'fix-applied': 'The same failing and valid requests, with the fixed handler',
  'demand-beyond-capacity-after-fix': 'Control: more concurrent requests than clients, with the fixed handler',
};
export const CODE_PATHS: Record<LeakPhase, string> = {
  'baseline-valid-only': 'original handler', 'leak-reproduced': 'original handler', 'demand-beyond-capacity': 'original handler',
  'slow-query': 'original handler', 'long-transaction': 'transaction harness; original handler for warm-up, probe and recovery',
  'server-refusal': 'original handler', 'fix-applied': 'fixed handler', 'demand-beyond-capacity-after-fix': 'fixed handler',
};
const OUTCOME_TEXT: Record<Outcome, string> = { ok: 'succeeded', 'division-by-zero': 'SQLSTATE 22012, division by zero', 'pool-checkout-timeout': 'pool checkout timeout, no SQLSTATE',
  'pool-connect-timeout': 'pool connection timeout, no SQLSTATE', 'server-refused-reserved': 'SQLSTATE 53300, remaining slots reserved', 'server-refused-full': 'SQLSTATE 53300, too many clients',
  'server-refused-role-limit': 'SQLSTATE 53300, role connection limit', 'connection-terminated': 'connection terminated', other: 'another error' };
export function outcomeSummary(p: PhaseRecord) {
  const counts = new Map<Outcome, number>();
  for (const q of p.requests) counts.set(q.outcome, (counts.get(q.outcome) ?? 0) + 1);
  return [...counts].map(([o, n]) => `${n} ${OUTCOME_TEXT[o]}`).join('; ');
}
const last = (p: PhaseRecord) => p.checkpoints.at(-1)!;
export const openAtEnd = (p: PhaseRecord) => openAt(p, last(p)).length;
// Leases open at a named checkpoint, for the review and validation code.
export const openLeasesAt = (p: PhaseRecord, name: string) => openAt(p, p.checkpoints.find(c => c.name === name)!);
// The lines that differ between the bundled original and fixed handlers, leaving out the function header.
export function handlerChange() {
  const lines = (source: string) => source.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
  const original = lines(LEAK_QUERIES.handlers.original), fixed = lines(LEAK_QUERIES.handlers.fixed);
  return { removed: original.filter(l => !fixed.includes(l)), added: fixed.filter(l => !original.includes(l)) };
}
export function sessionSummary(p: PhaseRecord, cp = last(p)) {
  const counts = new Map<string, number>();
  for (const s of cp.sessions) counts.set(s.state ?? 'unknown', (counts.get(s.state ?? 'unknown') ?? 0) + 1);
  return counts.size ? [...counts].map(([s, n]) => `${n} ${s}`).join(', ') : 'none';
}

export function leakMarkdown(run: LeakRun, now = new Date()) {
  const checked = checkLeakRun(run, now), ph = Object.fromEntries(run.phases.map(p => [p.phase, p])) as Record<LeakPhase, PhaseRecord>;
  const leak = ph['leak-reproduced'], demand = ph['demand-beyond-capacity'], refusal = ph['server-refusal'];
  const demandCounts = (p: PhaseRecord) => `${steps(p, 'busy').filter(q => q.outcome === 'ok').length} succeeded and ${steps(p, 'busy').filter(q => q.outcome === 'pool-checkout-timeout').length} timed out`;
  return `# Application pool exhaustion\n\nEvidence: ${checked.evidenceStatus}. Review: NOT_REVIEWED.\n\n` +
    `This disposable local experiment starts PostgreSQL on a private Unix socket with TCP turned off, and runs an in-process request handler against a pg pool of ${POOL_CONFIG.max} clients with an ${POOL_CONFIG.connectionTimeoutMillis} ms checkout timeout. The original handler releases its client only when its query succeeds. Each phase records every checkout by request, client and backend PID, the pool's events and counters, and the server sessions at fixed checkpoints.\n\n` +
    '| Phase | Code path | All requests in the phase | Open checkouts at the end | Server sessions at the end |\n|---|---|---|---|---|\n' +
    run.phases.map(p => `| ${PHASE_LABELS[p.phase]} | ${CODE_PATHS[p.phase]} | ${outcomeSummary(p)} | ${openAtEnd(p)} | ${sessionSummary(p)} |`).join('\n') +
    `\n\nWith the original handler, ${PLANS.leak.failing} requests failed with SQLSTATE 22012 and each kept its client checked out. After they settled, the pool had all ${POOL_CONFIG.max} clients checked out, the server showed each of their sessions as idle, and nothing was running. A valid request then waited and failed with the pool's checkout timeout, which has no SQLSTATE. After ${leak.quietMs} ms with no load, the same checkouts were still open and another valid request timed out the same way. The pool did not recover on its own.\n\n` +
    `More concurrent requests than clients gave the same checkout timeout: ${demandCounts(demand)}, while the server showed queries running. Once the load ended, every client was released and the next request succeeded. Queries held running on the server and transactions left open by the application also exhausted the pool, with sessions shown as active and as idle in transaction. Both recovered when the queries and transactions finished. The checkout timeout alone does not tell a leak from these.\n\n` +
    `A pool that allows more clients than the server has free ordinary connection slots behaved differently. ${refusal.slots!.free} connections were accepted, and the server refused each later one with SQLSTATE 53300, because the remaining slots are reserved for superusers. That is a server error on connect, not a pool checkout timeout.\n\n` +
    `With the fixed handler, which releases its client in finally and passes the error when the query failed, the same request plan left no client checked out. The pool discarded the ${PLANS.leak.failing} clients whose queries failed, and the later valid requests succeeded before and after the quiet period. The demand control still produced checkout timeouts with the fixed handler (${demandCounts(ph['demand-beyond-capacity-after-fix'])}), so releasing in finally does not remove checkout timeouts caused by demand.\n\n` +
    'Connections left checked out by the original handler were closed by forced cleanup after the leak phase was measured. That cleanup is recorded separately and is not counted as a release.\n\n' +
    'Next questions: Does the application release its client on every code path, including when a query fails? Do pool checkout timeouts continue after the load drops? At those times, does the server show idle sessions for the application while the pool reports every client in use? Are any errors SQLSTATE 53300 from the server rather than pool timeouts?\n\n' +
    'Scope: synthetic local PostgreSQL and an in-process synthetic handler. Human cause review, customer resolution and message approval remain pending.\n';
}
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
export function leakHtml(run: LeakRun, now = new Date()) {
  const checked = checkLeakRun(run, now);
  const paragraphs = leakMarkdown(run, now).split('\n\n').filter(p => !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('Evidence:'));
  const cell = (label: string, value: string) => `<td role="cell" data-label="${escape(label)}">${escape(value)}</td>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'"><title>Application pool exhaustion | Postgres Support Lab</title><style>${reportStyles}

.panel p,.panel li,.lede{overflow-wrap:anywhere}
/* When the table has less than 600px, including beside the sidebar, each phase gets its own block, with each value labelled. Explicit roles keep table semantics when rows use grid layout. */
.table-wrap{container-type:inline-size}
@container (max-width:600px){.results,.results thead,.results tbody{display:block}.results thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.results tr{display:grid;grid-template-columns:minmax(0,1fr);border-bottom:1px solid var(--line)}.results th,.results td{border-bottom:0;padding:4px 10px;overflow-wrap:anywhere}.results td::before{content:attr(data-label) ": ";font-weight:600}}</style></head><body><a class="skip" href="#results">Skip to results</a><aside><div class="brand"><span class="brand-mark">P</span>Postgres Support Lab</div><p class="tag">Local PostgreSQL investigation</p><nav><a href="#results">Measured results</a><a href="#interpretation">Interpretation</a><a href="#evidence">Evidence</a></nav></aside><main><header><p class="eyebrow">Application pool exhaustion</p><h1>Requests hang waiting for a connection. Is it a leak?</h1><p class="lede">In this local test, failing requests kept their pool clients, and later requests timed out even with no load. The same timeout also came from busy, slow and long-running work, which recovered on its own. With the client released in finally, the same requests left no client checked out. Nobody has reviewed these results yet.</p><p class="status">${checked.evidenceStatus} · HUMAN REVIEW PENDING</p><p class="meta">Run ${escape(run.runId)}<br>Evidence collected ${escape(run.collectedAt)}<br>Freshness window ends ${escape(run.expiresAt)}<br>This page is a snapshot. Re-run inspection to check freshness.</p></header><section class="panel" id="results"><h2>Measured results</h2><div class="table-wrap"><table class="results" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Phase</th><th role="columnheader" scope="col">Code path</th><th role="columnheader" scope="col">All requests in the phase</th><th role="columnheader" scope="col">Open checkouts at the end</th><th role="columnheader" scope="col">Server sessions at the end</th></tr></thead><tbody role="rowgroup">${run.phases.map(p => `<tr role="row"><th role="rowheader" scope="row">${escape(PHASE_LABELS[p.phase])}</th>${cell('Code path', CODE_PATHS[p.phase])}${cell('All requests in the phase', outcomeSummary(p))}${cell('Open checkouts at the end', String(openAtEnd(p)))}${cell('Server sessions at the end', sessionSummary(p))}</tr>`).join('')}</tbody></table></div></section><section class="panel document" id="interpretation"><h2>What the comparison tells us</h2>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</section><section class="panel" id="evidence"><h2>Evidence and limitations</h2><p>PostgreSQL ${escape(run.postgresVersion)}, pg ${escape(run.versions.pg)}, pg-pool ${escape(run.versions.pgPool)}. Private Unix socket only, TCP turned off. Synthetic data and a synthetic role without a password. Cleanup complete.</p><p>Error messages are kept only as fixed categories with their SQLSTATE. Elapsed times are not used as evidence, except that the quiet period lasted at least as long as planned. Hashes check consistency against a separately retained anchor. They cannot authenticate a collector or detect a complete unanchored rewrite. HTML and Markdown are derived views; inspect the JSON artifacts for verification.</p><details><summary>Measured phases, leases and checkpoints</summary><pre>${escape(JSON.stringify(run, null, 2))}</pre></details></section><footer>Independent project. Customer cause and resolution remain unset.${fontLicenses.map(l => `<details class="license"><summary>${escape(l.name)} font license</summary><pre>${escape(l.text)}</pre></details>`).join('')}</footer></main></body></html>`;
}
