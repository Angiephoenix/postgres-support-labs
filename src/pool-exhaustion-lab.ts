import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { delimiter, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Client, Pool } from 'pg';
import { canonical, hash, fail, LedgerError } from './contracts.ts';
import { LEAK_QUERIES as Q, LEAK_PHASES, PHASE_SPECS, PLANS, POOL_CONFIG, REFUSAL_POOL_CONFIG, SERVER_SETTINGS, SESSION_LIMITS, APP_ROLE,
  originalHandler, fixedHandler, transactionHarness, planHash, applicationName, outcomeOf, sqlstateOf, handlerHashes, checkLeakRun, leakManifest, leakMarkdown, leakHtml } from './pool-exhaustion-evidence.ts';
import type { LeakRun, LeakPhase, PhaseRecord, PoolEvent, Lease, RequestRecord, RequestKind, RequestStep, Checkpoint, ClientError, Counters, Session, Teardown, HandlerName } from './pool-exhaustion-evidence.ts';

const require = createRequire(import.meta.url);
function packageVersion(name: string) {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) { const p = JSON.parse(readFileSync(file, 'utf8')); if (p.name === name) return String(p.version); }
  }
  return fail(`Could not read the installed ${name} version.`);
}

export function leakPlan() {
  return { profile: 'local-lab', approvalRequired: true, network: false, connection: 'private Unix socket; TCP turned off',
    operations: ['Create a disposable PostgreSQL cluster with 8 connection slots, 2 of them reserved for superusers, and one synthetic role without a password',
      'Run an in-process request handler against a pg pool of 3 clients with an 800 ms checkout timeout. The original handler releases its client only when the query succeeds',
      'Send failing requests (SQLSTATE 22012), then valid requests before and after a quiet period, recording each checkout by request, client and backend PID with the pool\'s events, counters and server sessions',
      'Run controls that exhaust the pool through demand, a query held on the server, open transactions and a pool larger than the server allows',
      'Replay the same failing and valid requests with a handler that releases in finally, then close every client with time limits, confirm the owned server has stopped and remove the cluster'],
    retained: ['request outcomes as SQLSTATEs and fixed categories', 'checkouts, pool events, pool counters and server session states at fixed checkpoints', 'forced cleanup recorded apart from the measurements', 'anchorable manifest', 'HTML and Markdown experiment reports'],
    reviewStatus: 'NOT_REVIEWED', cause: null, customerResolution: null };
}
const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
function executable(name: string, directory?: string) {
  for (const dir of directory ? [directory] : (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { const file = join(dir, name); accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* next directory */ }
  }
  return fail('PostgreSQL server tools were not found. Set PSLAB_PG_BIN to their bin directory.');
}
// A failed command is reported by a fixed label and its exit status. Its output can hold paths, so it is withheld.
export class CommandFailure extends LedgerError {
  readonly label: string; readonly exitStatus: number|null;
  constructor(label: string, exitStatus: number|null) {
    super(`A local command failed: ${label}${exitStatus === null ? '' : ` (exit status ${exitStatus})`}. Raw process output is withheld.`);
    this.label = label; this.exitStatus = exitStatus;
  }
}
function command(file: string, args: string[], label: string) {
  const result = spawnSync(file, args, { env: env(), encoding: 'utf8', timeout: 60000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new CommandFailure(label, typeof result.status === 'number' ? result.status : null);
  return result.stdout;
}
function write(path: string, value: unknown) { writeFileSync(path, canonical(value) + '\n', { flag: 'wx', mode: 0o600 }); }
function one(rows: any[]) { if (rows.length !== 1) fail('Unexpected bounded probe row count.'); return rows[0]; }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Waits for a promise for at most `ms`. Shutdown never waits without a limit, because pg-pool's end() waits for leaked clients forever.
async function bounded(promise: Promise<unknown>, ms: number): Promise<'done'|'timed-out'> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timed-out'>(resolve => { timer = setTimeout(() => resolve('timed-out'), ms); });
  try { return await Promise.race([promise.then(() => 'done' as const, () => 'done' as const), limit]); } finally { clearTimeout(timer); }
}
// Environment names that could change a PostgreSQL client. Every setting is passed explicitly, so these are recorded by name only.
const WATCHED_ENV = ['NODE_OPTIONS', 'PGDATABASE', 'PGHOST', 'PGHOSTADDR', 'PGOPTIONS', 'PGPASSFILE', 'PGPASSWORD', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGUSER'];
const DATABASE = 'pslab_pool';
const CHECKPOINT_LIMIT_MS = 5000, SHUTDOWN_LIMIT_MS = 2000;
const VALID = { sql: Q.request, params: [1] }, FAILING = { sql: Q.request, params: [0] }, BUSY = { sql: Q.busy, params: [] }, GATED = { sql: Q.gated, params: [] };
const HANDLERS = { original: originalHandler, fixed: fixedHandler } as const;
type Tracked = { pool: Pool; index: number; clients: Set<Client>; ids: Map<Client, number>; open: Map<Client, Lease>; lastAcquire: Map<Client, number>;
  connects: number; removes: number; ended: boolean };
type Started = { record: RequestRecord; done: Promise<void>; settled: () => boolean };

export async function runLeakLab(options: { approved: boolean; output: string; injectFailure?: 'leases-open' }) {
  if (options.approved !== true) fail('Pool-exhaustion lab execution requires --approve-lab.');
  (await import('./lab-packs.ts')).requireWorkingPack('pool-exhaustion');
  if (!['linux','darwin'].includes(process.platform)) fail('Use macOS or Linux for the native pool-exhaustion lab.');
  if (process.getuid?.() === 0) fail('Run the lab as a regular user, without sudo.');
  const bins = Object.fromEntries(['initdb','pg_ctl','postgres'].map(n => [n, executable(n, process.env.PSLAB_PG_BIN)]));
  const majors = Object.values(bins).map(b => Number(command(b, ['--version'], `${b.split('/').pop()} --version`).match(/\(PostgreSQL\) (\d+)/)?.[1]));
  if (!majors.every(m => m === majors[0] && m >= 16 && m <= 18)) fail('Use matching PostgreSQL 16, 17 or 18 server tools.');
  mkdirSync(options.output, { mode: 0o700 });
  const output = realpathSync(options.output), runId = randomUUID(), collectedAt = new Date().toISOString();
  write(join(output, 'pool-exhaustion-plan.json'), { ...leakPlan(), runId, approved: true });
  write(join(output, 'pool-exhaustion-probes.json'), Q);
  // /tmp keeps the Unix socket path below platform limits, including macOS's shorter limit.
  const root = mkdtempSync('/tmp/pslab-leak-'), data = join(root, 'data'), socket = join(root, 'sock'), logPath = join(root, 'postgres.log');
  mkdirSync(socket, { mode: 0o700 });
  let failure: unknown, stage = 'setup', clusterFingerprint = '', postgresVersion = '', cleanup: 'PENDING'|'COMPLETE'|'FAILED' = 'PENDING';
  let server: LeakRun['server'] | undefined, observer: Client | undefined;
  const pools = new Set<Tracked>(), phases: PhaseRecord[] = [], teardown: Teardown[] = [];
  const interrupt = () => { failure ??= new Error('interrupted'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const check = () => { if (failure) fail('Pool-exhaustion experiment interrupted.'); };
  const limits = { statement_timeout: SESSION_LIMITS.statementTimeoutMs, query_timeout: SESSION_LIMITS.queryTimeoutMs, lock_timeout: SESSION_LIMITS.lockTimeoutMs };
  async function connectOwner(database: string) {
    check();
    const client = new Client({ host: socket, port: 5432, database, user: 'pslab_owner', password: 'unused-local-lab', ssl: false, options: '', application_name: 'pslab-observer',
      client_encoding: 'UTF8', connectionTimeoutMillis: 5000, ...limits } as any);
    client.on('error', () => { failure ??= new Error('observer connection lost'); });
    try { await client.connect(); return client; } catch { await client.end().catch(() => {}); return fail('Pool-exhaustion lab could not connect as the owner role.'); }
  }
  async function sessions(phase: LeakPhase): Promise<Session[]> {
    return (await observer!.query(Q.sessions, [applicationName(phase)])).rows.map((r: any) => ({ pid: r.pid, state: r.state, waitEventType: r.wait_event_type, waitEvent: r.wait_event, inTransaction: r.in_transaction }));
  }
  const clientBackends = async () => Number(one((await observer!.query(Q.clientBackends)).rows).connections);
  async function until(condition: () => Promise<boolean>|boolean, limit = CHECKPOINT_LIMIT_MS) {
    const deadline = Date.now() + limit;
    for (;;) { check(); if (await condition()) return true; if (Date.now() > deadline) return false; await sleep(10); }
  }

  // Records one phase: every pool event in order, each checkout as a lease owned by one request, client errors, and checkpoints.
  class PhaseRun {
    seq = 0; closed = false; nextClient = 0; nextLease = 0; nextRequest = 0; inFlight = 0; nextPool = 0;
    events: PoolEvent[] = []; leases: Lease[] = []; requests: RequestRecord[] = []; checkpoints: Checkpoint[] = []; clientErrors: ClientError[] = [];
    quietMs: number|null = null; slots: PhaseRecord['slots'] = null; tracked: Tracked[] = [];
    readonly collectedAt = new Date().toISOString(); readonly phase: LeakPhase; readonly handler: HandlerName;
    constructor(phase: LeakPhase, handler: HandlerName) { this.phase = phase; this.handler = handler; }
    push(e: Omit<PoolEvent, 'seq'>) { const seq = ++this.seq; this.events.push({ seq, ...e }); return seq; }
    error(t: Tracked, client: number|null, e: unknown) { if (!this.closed) this.clientErrors.push({ seq: ++this.seq, pool: t.index, client, ...outcomeOf(e) }); }
    newPool(config: typeof POOL_CONFIG | typeof REFUSAL_POOL_CONFIG) {
      const pool = new Pool({ host: socket, port: 5432, database: DATABASE, user: APP_ROLE, password: 'unused-local-lab', ssl: false, options: '', client_encoding: 'UTF8',
        application_name: applicationName(this.phase), allowExitOnIdle: false, ...config, ...limits } as any);
      const t: Tracked = { pool, index: ++this.nextPool, clients: new Set(), ids: new Map(), open: new Map(), lastAcquire: new Map(), connects: 0, removes: 0, ended: false };
      pools.add(t); this.tracked.push(t);
      // Every client gets an error listener as soon as it exists, so a server shutdown cannot crash the process through an unhandled error event.
      pool.on('connect', (client: Client) => {
        const id = ++this.nextClient; t.ids.set(client, id); t.clients.add(client); client.on('error', e => this.error(t, id, e));
        if (!this.closed) { t.connects++; this.push({ pool: t.index, type: 'connect', client: id, pid: (client as any).processID, withError: false }); }
      });
      pool.on('acquire', (client: Client) => { if (!this.closed) t.lastAcquire.set(client, this.push({ pool: t.index, type: 'acquire', client: t.ids.get(client)!, pid: null, withError: false })); });
      pool.on('release', (err: unknown, client: Client) => {
        if (this.closed) return;
        const seq = this.push({ pool: t.index, type: 'release', client: t.ids.get(client)!, pid: null, withError: Boolean(err) }), lease = t.open.get(client);
        if (lease) { lease.releaseSeq = seq; lease.releasedWithError = Boolean(err); t.open.delete(client); }
      });
      pool.on('remove', (client: Client) => { if (!this.closed) { t.removes++; this.push({ pool: t.index, type: 'remove', client: t.ids.get(client)!, pid: null, withError: false }); } });
      pool.on('error', (e: unknown, client: Client) => this.error(t, t.ids.get(client) ?? null, e));
      return t;
    }
    // Starts one request. The handler gets the pool through a wrapper that records which request each checkout belongs to.
    start(t: Tracked, step: RequestStep, kind: RequestKind, call: (pool: { connect: () => Promise<Client> }) => Promise<unknown>, via: RequestRecord['via'] = 'handler'): Started {
      check();
      const record: RequestRecord = { request: ++this.nextRequest, step, kind, via, outcome: 'other', sqlstate: null, lease: null };
      this.requests.push(record); this.inFlight++;
      let settled = false;
      const wrapper = { connect: async () => {
        const client: Client = await t.pool.connect();
        const lease: Lease = { lease: ++this.nextLease, request: record.request, pool: t.index, client: t.ids.get(client)!, backendPid: (client as any).processID,
          acquireSeq: t.lastAcquire.get(client)!, releaseSeq: null, releasedWithError: false };
        this.leases.push(lease); t.open.set(client, lease); record.lease = lease.lease;
        return client;
      } };
      const done = (async () => {
        try { await call(wrapper); record.outcome = 'ok'; }
        catch (e) { Object.assign(record, outcomeOf(e)); }
        finally { this.inFlight--; settled = true; }
      })();
      return { record, done, settled: () => settled };
    }
    request(t: Tracked, step: RequestStep, kind: RequestKind, request: { sql: string; params: unknown[] }) { return this.start(t, step, kind, pool => HANDLERS[this.handler](pool, request)); }
    // A quiescent checkpoint waits until no request is in flight, no client is connecting or being removed, and the server
    // shows one session per pool client. A live checkpoint waits only for its condition. Both give up at a fixed limit.
    async checkpoint(t: Tracked, name: string, kind: Checkpoint['kind'], condition: (c: Counters, s: Session[]) => boolean = () => true) {
      let snapshot!: Checkpoint;
      await until(async () => {
        const s = await sessions(this.phase), p = t.pool as any;
        const counters: Counters = { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount, checkedOut: p.totalCount - p.idleCount };
        // Every checkpoint waits until no client is connecting or being removed and the server shows one session per client;
        // a quiescent one also waits until no request is in flight or waiting.
        const stable = t.connects - t.removes === counters.total && s.length === counters.total;
        const quiet = stable && (kind === 'live' || (this.inFlight === 0 && counters.waiting === 0));
        const reached = quiet && condition(counters, s);
        snapshot = { name, kind, reached, seq: this.seq + 1, pool: t.index, counters, sessions: s };
        return reached;
      });
      this.checkpoints.push(snapshot);
      return snapshot;
    }
    heldPids(t: Tracked) { return [...t.open.values()].map(l => l.backendPid); }
    record(): PhaseRecord {
      return { phase: this.phase, collectedAt: this.collectedAt, handler: this.handler, planHash: planHash(PHASE_SPECS[this.phase].plan), applicationName: applicationName(this.phase),
        events: this.events, leases: this.leases, requests: this.requests, checkpoints: this.checkpoints, clientErrors: this.clientErrors, quietMs: this.quietMs, slots: this.slots };
    }
    // Forced cleanup. Measurement is closed first, so nothing closed here is recorded as a release by the code under test.
    async teardown(): Promise<Teardown> {
      this.closed = true;
      let openLeases = 0, clientsEnded = 0, clientEndTimeouts = 0, poolEnd: Teardown['poolEnd'] = 'resolved';
      for (const t of this.tracked) {
        openLeases += t.open.size;
        const result = await shutDown(t);
        clientsEnded += result.clientsEnded; clientEndTimeouts += result.clientEndTimeouts; if (result.poolEnd === 'timed-out') poolEnd = 'timed-out';
      }
      let after = (await sessions(this.phase)).length;
      if (after) { await until(async () => (after = (await sessions(this.phase)).length) === 0); }
      return { phase: this.phase, openLeases, clientsEnded, clientEndTimeouts, poolEnd, sessionsAfter: after };
    }
  }
  // Ends every client directly, then the pool, each with a time limit.
  async function shutDown(t: Tracked) {
    let clientsEnded = 0, clientEndTimeouts = 0;
    for (const client of t.clients) { if ((await bounded(client.end(), SHUTDOWN_LIMIT_MS)) === 'timed-out') clientEndTimeouts++; else clientsEnded++; }
    t.clients.clear();
    let poolEnd: Teardown['poolEnd'] = 'resolved';
    if (!t.ended) { t.ended = true; poolEnd = (await bounded(t.pool.end(), SHUTDOWN_LIMIT_MS)) === 'done' ? 'resolved' : 'timed-out'; }
    pools.delete(t);
    return { clientsEnded, clientEndTimeouts, poolEnd };
  }
  const gate = { hold: async () => { await observer!.query(Q.gateHold); }, release: async () => { if (one((await observer!.query(Q.gateRelease)).rows).released !== true) fail('The lab could not release its advisory lock.'); } };

  async function baseline(ph: PhaseRun) {
    const t = ph.newPool(POOL_CONFIG);
    for (let b = 0; b < PLANS.baseline.batches; b++) await Promise.all(Array.from({ length: PLANS.baseline.perBatch }, () => ph.request(t, 'baseline', 'valid', VALID).done));
    await ph.checkpoint(t, 'completed', 'quiescent');
  }
  // The same plan runs with the original and the fixed handler.
  async function leak(ph: PhaseRun) {
    const t = ph.newPool(POOL_CONFIG);
    await Promise.all(Array.from({ length: PLANS.leak.failing }, () => ph.request(t, 'failing', 'failing', FAILING).done));
    await ph.checkpoint(t, 'after-failing', 'quiescent');
    const probe = ph.request(t, 'probe', 'valid', VALID);
    await ph.checkpoint(t, 'probe-started', 'live', c => c.waiting >= 1 || probe.settled());
    await probe.done;
    await ph.checkpoint(t, 'after-probe', 'quiescent');
    // A timer can fire slightly before the measured time reaches its delay, so the quiet period is measured on a monotonic
    // clock and extended until it reaches the plan. In CI a single 1000 ms timer was once recorded as shorter than 1000 ms.
    const quietStart = performance.now(), elapsed = () => performance.now() - quietStart;
    while (elapsed() < PLANS.leak.quietMs) { await sleep(Math.ceil(PLANS.leak.quietMs - elapsed())); check(); }
    ph.quietMs = Math.floor(elapsed());
    await ph.checkpoint(t, 'after-quiet', 'quiescent');
    await ph.request(t, 'recovery', 'valid', VALID).done;
    await ph.checkpoint(t, 'after-recovery', 'quiescent');
  }
  async function warm(ph: PhaseRun, t: Tracked, n: number) {
    await Promise.all(Array.from({ length: n }, () => ph.request(t, 'warm', 'valid', VALID).done));
    await ph.checkpoint(t, 'warm', 'quiescent', c => c.total === POOL_CONFIG.max && c.idle === POOL_CONFIG.max);
  }
  async function recover(ph: PhaseRun, t: Tracked) {
    await ph.request(t, 'recovery', 'valid', VALID).done;
    await ph.checkpoint(t, 'recovered', 'quiescent');
  }
  async function demand(ph: PhaseRun) {
    const t = ph.newPool(POOL_CONFIG);
    await warm(ph, t, PLANS.demand.warm);
    const busy = Array.from({ length: PLANS.demand.busy }, () => ph.request(t, 'busy', 'busy', BUSY));
    await ph.checkpoint(t, 'saturated', 'live', (c, s) => c.checkedOut === POOL_CONFIG.max && c.waiting > 0 && s.some(x => x.state === 'active'));
    await Promise.all(busy.map(b => b.done));
    await ph.checkpoint(t, 'completed', 'quiescent');
    await recover(ph, t);
  }
  const heldAs = (ph: PhaseRun, t: Tracked, n: number, expected: (s?: Session) => boolean) => (c: Counters, s: Session[]) =>
    c.checkedOut === POOL_CONFIG.max && t.open.size === n && ph.heldPids(t).every(pid => expected(s.find(x => x.pid === pid)));
  const lockWait = (s?: Session) => s?.state === 'active' && s.waitEventType === 'Lock' && s.waitEvent === 'advisory';
  async function slowQuery(ph: PhaseRun) {
    const t = ph.newPool(POOL_CONFIG);
    await warm(ph, t, PLANS.slow.warm);
    await gate.hold();
    const held = Array.from({ length: PLANS.slow.gated }, () => ph.request(t, 'gated', 'gated', GATED));
    await ph.checkpoint(t, 'saturated', 'live', heldAs(ph, t, PLANS.slow.gated, lockWait));
    // The held queries cannot finish until the lab releases its lock, which happens only after the probe has settled.
    await ph.request(t, 'probe', 'valid', VALID).done;
    await ph.checkpoint(t, 'probe-settled', 'live', heldAs(ph, t, PLANS.slow.gated, lockWait));
    await gate.release();
    await Promise.all(held.map(h => h.done));
    await ph.checkpoint(t, 'completed', 'quiescent');
    await recover(ph, t);
  }
  async function longTransaction(ph: PhaseRun) {
    const t = ph.newPool(POOL_CONFIG);
    await warm(ph, t, PLANS.transaction.warm);
    let open!: () => void;
    const appGate = new Promise<void>(resolve => { open = resolve; });
    const idleInTransaction = (s?: Session) => s?.state === 'idle in transaction' && s.inTransaction;
    const held = Array.from({ length: PLANS.transaction.held }, () => ph.start(t, 'transaction', 'transaction', pool => transactionHarness(pool, VALID, appGate), 'transaction-harness'));
    await ph.checkpoint(t, 'saturated', 'live', heldAs(ph, t, PLANS.transaction.held, idleInTransaction));
    await ph.request(t, 'probe', 'valid', VALID).done;
    await ph.checkpoint(t, 'probe-settled', 'live', heldAs(ph, t, PLANS.transaction.held, idleInTransaction));
    open();
    await Promise.all(held.map(h => h.done));
    await ph.checkpoint(t, 'completed', 'quiescent');
    await recover(ph, t);
  }
  // Connections open one at a time, each held on the server, so exactly the free ordinary slots are taken before PostgreSQL refuses.
  async function refusal(ph: PhaseRun) {
    const t = ph.newPool(REFUSAL_POOL_CONFIG);
    const backends = await clientBackends();
    ph.slots = { clientBackends: backends, free: server!.maxConnections - server!.superuserReservedConnections - server!.reservedConnections - backends };
    await ph.checkpoint(t, 'slots', 'quiescent');
    await gate.hold();
    const held: Started[] = [];
    for (let i = 0; i < PLANS.refusal.gated; i++) {
      const h = ph.request(t, 'gated', 'gated', GATED); held.push(h);
      const ready = await until(async () => {
        if (h.settled()) return true;
        const lease = ph.leases.find(l => l.request === h.record.request && l.releaseSeq === null);
        return lease !== undefined && lockWait((await sessions(ph.phase)).find(s => s.pid === lease.backendPid));
      });
      if (!ready) fail('A refusal-control connection neither opened nor failed within its time limit.');
    }
    await ph.checkpoint(t, 'held', 'live', c => c.checkedOut === t.open.size);
    await gate.release();
    await Promise.all(held.map(h => h.done));
    await ph.checkpoint(t, 'completed', 'quiescent');
    t.ended = true;
    if ((await bounded(t.pool.end(), SHUTDOWN_LIMIT_MS)) === 'timed-out') fail('The refusal-control pool did not close within its time limit.');
    await ph.checkpoint(t, 'pool-closed', 'quiescent');
    await recover(ph, ph.newPool(POOL_CONFIG));
  }
  const RUNNERS = { baseline, leak, demand, slow: slowQuery, transaction: longTransaction, refusal } as const;

  let started = false;
  try {
    command(bins.initdb, ['-D', data, '-U', 'pslab_owner', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'], 'initdb');
    appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\nport = 5432\n` +
      `max_connections = ${SERVER_SETTINGS.maxConnections}\nsuperuser_reserved_connections = ${SERVER_SETTINGS.superuserReservedConnections}\nreserved_connections = ${SERVER_SETTINGS.reservedConnections}\nshared_buffers = '16MB'\n`);
    writeFileSync(join(data, 'pg_hba.conf'), Q.hba.join('\n') + '\n');
    started = true;
    command(bins.pg_ctl, ['-D', data, '-l', logPath, '-w', '-t', '15', 'start'], 'pg_ctl start');
    const owner = await connectOwner('postgres');
    try {
      const system = one((await owner.query("SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version, system_identifier::text AS identifier FROM pg_control_system()")).rows);
      if (realpathSync(system.directory) !== realpathSync(data)) fail('Owned PostgreSQL directory mismatch.');
      clusterFingerprint = hash(system.identifier); postgresVersion = system.version;
      await owner.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      await owner.query(`CREATE DATABASE ${DATABASE}`);
      await owner.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
      await owner.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${APP_ROLE}`);
    } finally { await owner.end().catch(() => {}); }
    observer = await connectOwner(DATABASE);
    for (const sql of Q.setup) await observer.query(sql);
    await observer.query('INSERT INTO lab_meta.identity VALUES ($1)', [runId]);
    if (one((await observer.query(Q.identity)).rows).run_id !== runId) fail('Pool-exhaustion target identity mismatch.');
    const s = one((await observer.query(Q.settings)).rows);
    server = { maxConnections: s.max_connections, superuserReservedConnections: s.superuser_reserved, reservedConnections: s.reserved };
    for (const phase of LEAK_PHASES) {
      stage = phase;
      // Each phase starts with only the observer connected, so earlier phases cannot affect its counts.
      if (!(await until(async () => (await clientBackends()) === 1))) fail(`Sessions from an earlier phase remained before ${phase}.`);
      const spec = PHASE_SPECS[phase], ph = new PhaseRun(phase, spec.handler);
      await RUNNERS[spec.plan](ph);
      phases.push(ph.record());
      if (options.injectFailure === 'leases-open' && phase === 'leak-reproduced') fail('Injected test failure while leases are open.');
      teardown.push(await ph.teardown());
    }
    check();
  } catch (error) { failure ??= error; }
  finally {
    // Close every remaining client and pool with time limits, then the observer, then stop the server.
    for (const t of [...pools]) await shutDown(t);
    if (observer) await bounded(observer.end(), SHUTDOWN_LIMIT_MS);
    const stopped = () => { const status = spawnSync(bins.pg_ctl, ['-D', data, 'status'], { env: env(), timeout: 15000 }).status; return !existsSync(join(data, 'postmaster.pid')) && (status === 3 || status === 4); };
    if (started && !stopped()) for (const mode of ['fast', 'immediate']) {
      try { command(bins.pg_ctl, ['-D', data, '-m', mode, '-w', '-t', '10', 'stop'], 'pg_ctl stop'); } catch { /* checked below */ }
      if (stopped()) break;
    }
    // The cluster directory is removed only once the owned server is confirmed stopped.
    if (started && !stopped()) { cleanup = 'FAILED'; failure ??= new Error('postgres cleanup'); }
    else { rmSync(root, { recursive: true, force: true }); cleanup = existsSync(root) ? 'FAILED' : 'COMPLETE'; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (failure) {
    write(join(output, 'pool-exhaustion-failure.json'), { runId, stage, cleanup, sqlstate: sqlstateOf(failure), cause: null,
      failedCommand: failure instanceof CommandFailure ? failure.label : null, exitStatus: failure instanceof CommandFailure ? failure.exitStatus : null });
    fail(cleanup === 'FAILED' ? `Pool-exhaustion cleanup failed. The owned PostgreSQL server may still be running, and its temporary files remain at ${root}.`
      : `Pool-exhaustion lab failed during ${stage}. Cleanup completed. ${failure instanceof LedgerError ? failure.message : 'Check the retained failure summary.'}`);
  }
  const run: LeakRun = { schemaVersion: 1, scenario: 'connection-leak', runId, profile: 'local-lab', collectedAt,
    expiresAt: new Date(Date.parse(collectedAt) + 3600000).toISOString(), postgresVersion, clusterFingerprint,
    versions: { node: process.version, pg: packageVersion('pg'), pgPool: packageVersion('pg-pool') },
    environment: { namesPresent: WATCHED_ENV.filter(n => process.env[n] !== undefined) }, server: server!, handlers: handlerHashes(),
    phases, teardown, cleanup: 'COMPLETE', classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED' };
  // Retain unexpected measurements for investigation; only a passing contract gets a manifest and report.
  write(join(output, 'pool-exhaustion-run.json'), run);
  checkLeakRun(run);
  const manifest = leakManifest(run); write(join(output, 'pool-exhaustion-manifest.json'), manifest);
  writeFileSync(join(output, 'pool-exhaustion-report.md'), leakMarkdown(run), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(output, 'pool-exhaustion-report.html'), leakHtml(run), { flag: 'wx', mode: 0o600 });
  return { run, manifestHash: hash(manifest) };
}
