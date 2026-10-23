import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { reportStyles, fontLicenses } from './report-theme.ts';

// The connectivity lab connects to a disposable PostgreSQL server on 127.0.0.1 with TLS. Connection strings
// name hosts under .pslab.test; db.pslab.test is the name on the server certificate. The runner never looks
// these names up: it always opens TCP to 127.0.0.1 and passes the connection string's host as the TLS server
// name, much like libpq's separate host and hostaddr settings. System DNS and /etc/hosts are not used or changed.
export const SERVER_NAME = 'db.pslab.test';
export const WRONG_SERVER_NAME = 'wrong.pslab.test';
export const DESTINATION = '127.0.0.1';

export const CONNECTIVITY_PHASES = ['baseline-verified', 'untrusted-ca', 'trusted-ca-fix',
  'wrong-ca', 'hostname-mismatch', 'require-driver-default', 'require-libpq-compat', 'no-tls',
  'wrong-password', 'unknown-role', 'wrong-database',
  'password-hash-unencoded', 'password-at-unencoded', 'password-both-unencoded', 'password-both-encoded', 'tcp-refused'] as const;
export type ConnectivityPhase = typeof CONNECTIVITY_PHASES[number];

// Which part of the connection each phase changes. Placeholders stand for values made fresh for each run.
// <port> is the lab server's port and <closed-port> a port with nothing listening. Passwords are never retained.
export type PhaseSpec = { role: 'pslab_app'|'pslab_hash'|'pslab_at'|'pslab_unknown'; password: 'correct'|'wrong'; encoding: 'encoded'|'unencoded';
  database: 'pslab_conn'|'pslab_missing'; port: 'lab'|'closed'; sslmode: 'verify-full'|'require'|'disable'; rootcert: 'issuing-ca'|'untrusted-ca'|null;
  libpqCompat: boolean; serverName: string };
const base: PhaseSpec = { role: 'pslab_app', password: 'correct', encoding: 'encoded', database: 'pslab_conn', port: 'lab', sslmode: 'verify-full', rootcert: 'issuing-ca', libpqCompat: false, serverName: SERVER_NAME };
export const PHASE_SPECS: Record<ConnectivityPhase, PhaseSpec> = {
  'baseline-verified': base,
  'untrusted-ca': { ...base, rootcert: null },
  'trusted-ca-fix': base,
  'wrong-ca': { ...base, rootcert: 'untrusted-ca' },
  'hostname-mismatch': { ...base, serverName: WRONG_SERVER_NAME },
  'require-driver-default': { ...base, sslmode: 'require', rootcert: null },
  'require-libpq-compat': { ...base, sslmode: 'require', rootcert: null, libpqCompat: true },
  'no-tls': { ...base, sslmode: 'disable', rootcert: null },
  'wrong-password': { ...base, password: 'wrong' },
  'unknown-role': { ...base, role: 'pslab_unknown' },
  'wrong-database': { ...base, database: 'pslab_missing' },
  'password-hash-unencoded': { ...base, role: 'pslab_hash', encoding: 'unencoded' },
  'password-at-unencoded': { ...base, role: 'pslab_at', encoding: 'unencoded' },
  'password-both-unencoded': { ...base, encoding: 'unencoded' },
  'password-both-encoded': base,
  'tcp-refused': { ...base, port: 'closed' },
};
// Synthetic password shapes. Each run fills <hex> with fresh random characters. pslab_app's password holds both # and @.
export const PASSWORD_SHAPES = { pslab_app: 'Lab#<hex>@x', pslab_hash: 'Lab#<hex>', pslab_at: 'Lab@<hex>', pslab_unknown: 'Lab#<hex>@x' } as const;

export const CONNECTIVITY_QUERIES = Object.freeze({
  session: "SELECT (SELECT run_id::text FROM lab_identity) AS run_id, current_user AS role, current_database() AS database, s.ssl, s.version AS tls_version FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()",
  hba: Object.freeze([`local all pslab_owner trust`, `hostssl all all ${DESTINATION}/32 scram-sha-256`, `hostnossl all all ${DESTINATION}/32 reject`, `host all all ::1/128 reject`]),
  certificates: Object.freeze({ issuingCa: '/CN=pslab-issuing-ca', server: `/CN=${SERVER_NAME} with subjectAltName DNS:${SERVER_NAME}`, untrustedCa: '/CN=pslab-untrusted-ca', validityDays: 1 }),
  phases: PHASE_SPECS, passwordShapes: PASSWORD_SHAPES,
});

// Stages are measured from client events and PostgreSQL protocol messages, not inferred from the server log.
// authenticated passes when the server sends AuthenticationOk. sessionReady passes when it then sends ReadyForQuery,
// after opening the requested database and starting the session. An error between the two is a startup failure
// with accepted credentials, such as a database that does not exist.
export const STAGES = ['parsed', 'tcpConnected', 'serverAcceptedTls', 'tlsVerified', 'authenticated', 'sessionReady', 'queryOk'] as const;
export type Stage = typeof STAGES[number];
const CLIENT_STAGES: readonly Stage[] = ['parsed', 'tcpConnected', 'serverAcceptedTls', 'tlsVerified'];
// Startup messages the server sent, in the order the client received them, until the connection was ready or failed.
// Parameter status and notice messages are left out.
export const PROTOCOL_EVENTS = ['authenticationCleartextPassword', 'authenticationMD5Password', 'authenticationSASL', 'authenticationSASLContinue', 'authenticationSASLFinal',
  'authenticationOk', 'backendKeyData', 'readyForQuery', 'errorMessage'] as const;
export type ProtocolEvent = typeof PROTOCOL_EVENTS[number];
export type Attempt = {
  phase: ConnectivityPhase; runId: string; collectedAt: string; shape: string;
  parse: { ok: boolean; errorCode: string|null; matches: { user: boolean; password: boolean; host: boolean; port: boolean; database: boolean }|null; warnings: string[] };
  effective: { attempted: boolean; destination: string|null; port: 'lab'|'closed'|null; tls: null|{ rejectUnauthorized: boolean; serverName: string|null; caSource: 'issuing-ca'|'untrusted-ca'|'default-trust-store'; customIdentityCheck: boolean } };
  stages: Record<Stage, 'passed'|'failed'|'not-reached'|'not-requested'>;
  failure: null|{ stage: Stage; code: string|null; sqlstate: string|null };
  protocol: ProtocolEvent[];
  tls: null|{ authorized: boolean; authorizationError: string|null; serverName: string|null; peerFingerprint: string; peerAltNames: string; hostnameCheck: 'passed'|'failed'; protocol: string|null };
  session: null|{ role: string; database: string; ssl: boolean; tlsVersion: string|null };
  serverLog: string[];
};
export type CertificateRecord = { subject: string; issuer: string; altNames: string|null; fingerprint256: string; validFrom: string; validTo: string };
export type ConnectivityRun = { schemaVersion: 1; scenario: 'tls-trust'; runId: string; profile: 'local-lab'; collectedAt: string; expiresAt: string;
  postgresVersion: string; clusterFingerprint: string; versions: { node: string; pg: string; pgConnectionString: string; openssl: string };
  environment: { namesPresent: string[] }; certificates: { issuingCa: CertificateRecord; server: CertificateRecord; untrustedCa: CertificateRecord };
  keyFiles: { mode: string; directoryMode: string }; cleanup: 'COMPLETE'; attempts: Attempt[];
  classification: 'REPRODUCED_BEHAVIOR'; cause: null; customerResolution: null; reviewStatus: 'NOT_REVIEWED' };

// The connection string each phase uses, written as labelled parts with every secret and path replaced.
// Only this description is retained, never the URL itself.
export function phaseShape(phase: ConnectivityPhase) {
  const s = PHASE_SPECS[phase];
  const password = s.password === 'wrong' ? 'a wrong password' : s.encoding === 'encoded' ? `the ${s.role} password, percent-encoded` : `the ${s.role} password, not encoded (${PASSWORD_SHAPES[s.role]})`;
  const options = [s.libpqCompat ? 'uselibpqcompat true' : null, `sslmode ${s.sslmode}`, s.rootcert ? `sslrootcert ${s.rootcert}` : 'no sslrootcert'].filter(Boolean).join(', ');
  return `user ${s.role}; ${password}; host ${s.serverName}; port ${s.port === 'lab' ? 'lab port' : 'closed port'}; database ${s.database}; ${options}`;
}

const str = (max = 200) => ({ type: 'string', minLength: 1, maxLength: max });
const nstr = (max = 200) => ({ type: ['string', 'null'], maxLength: max });
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const date = { type: 'string', format: 'date-time' };
const bool = { type: 'boolean' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const nullable = (rule: any) => ({ oneOf: [{ type: 'null' }, rule] });
const stageState = { enum: ['passed', 'failed', 'not-reached', 'not-requested'] };
const cert = object({ subject: str(), issuer: str(), altNames: nstr(), fingerprint256: { type: 'string', pattern: '^[A-F0-9:]{95}$' }, validFrom: date, validTo: date });
const attemptSchema = object({ phase: { enum: [...CONNECTIVITY_PHASES] }, runId: uuid, collectedAt: date, shape: str(300),
  parse: object({ ok: bool, errorCode: nstr(60), matches: nullable(object({ user: bool, password: bool, host: bool, port: bool, database: bool })), warnings: { type: 'array', maxItems: 4, items: { enum: ['sslmode-treated-as-verify-full', 'other-warning'] } } }),
  effective: object({ attempted: bool, destination: nstr(40), port: { enum: [null, 'lab', 'closed'] },
    tls: nullable(object({ rejectUnauthorized: bool, serverName: nstr(100), caSource: { enum: ['issuing-ca', 'untrusted-ca', 'default-trust-store'] }, customIdentityCheck: bool })) }),
  stages: object(Object.fromEntries(STAGES.map(st => [st, stageState]))),
  failure: nullable(object({ stage: { enum: [...STAGES] }, code: nstr(60), sqlstate: nstr(5) })),
  protocol: { type: 'array', maxItems: 12, items: { enum: [...PROTOCOL_EVENTS] } },
  tls: nullable(object({ authorized: bool, authorizationError: nstr(80), serverName: nstr(100), peerFingerprint: str(120), peerAltNames: { type: 'string', maxLength: 200 }, hostnameCheck: { enum: ['passed', 'failed'] }, protocol: nstr(20) })),
  session: nullable(object({ role: str(63), database: str(63), ssl: bool, tlsVersion: nstr(20) })),
  serverLog: { type: 'array', maxItems: 12, items: { enum: ['connection-received', 'connection-authorized', 'tls-error-logged', 'password-authentication-failed', 'role-does-not-exist', 'database-does-not-exist', 'rejected-without-encryption', 'no-hba-entry', 'other-error'] } } });
const schema = object({ schemaVersion: { const: 1 }, scenario: { const: 'tls-trust' }, runId: uuid, profile: { const: 'local-lab' }, collectedAt: date, expiresAt: date,
  postgresVersion: str(100), clusterFingerprint: digest, versions: object({ node: str(40), pg: str(20), pgConnectionString: str(20), openssl: str(200) }),
  environment: object({ namesPresent: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^[A-Z_]{2,40}$' } } }),
  certificates: object({ issuingCa: cert, server: cert, untrustedCa: cert }), keyFiles: object({ mode: { const: '0600' }, directoryMode: { const: '0700' } }),
  cleanup: { const: 'COMPLETE' }, classification: { const: 'REPRODUCED_BEHAVIOR' }, cause: { const: null }, customerResolution: { const: null }, reviewStatus: { const: 'NOT_REVIEWED' },
  attempts: { type: 'array', minItems: CONNECTIVITY_PHASES.length, maxItems: CONNECTIVITY_PHASES.length, items: attemptSchema } });

// Certificate-chain errors Node and OpenSSL report when the client cannot trust the server's issuer.
export const CHAIN_ERRORS = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_SIGNATURE_FAILURE'];
const TLS_VERIFY_ERRORS = [...CHAIN_ERRORS, 'ERR_TLS_CERT_ALTNAME_INVALID'];
const SECRET_SHAPES = [/Lab[#@][0-9a-f]{16}/, /Wrong-[0-9a-f]{16}/, /\/tmp\/pslab-conn-/, /BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/];
const allStates = (a: Attempt, state: string) => STAGES.every(st => a.stages[st] === state);
// A verified success: chain and hostname checks were on and passed, and the session was encrypted.
export function verifiedSuccess(a: Attempt) {
  return allStates(a, 'passed') && a.failure === null && a.effective.tls !== null && a.effective.tls.rejectUnauthorized && !a.effective.tls.customIdentityCheck &&
    a.tls !== null && a.tls.authorized && a.tls.authorizationError === null && a.tls.hostnameCheck === 'passed' && a.tls.serverName === a.effective.tls.serverName && a.session !== null && a.session.ssl;
}

// Each attempt's failure code, SQLSTATE, stages, TLS result and protocol messages must tell the same story.
function checkAttemptConsistency(a: Attempt) {
  const f = a.failure, has = (e: ProtocolEvent) => a.protocol.includes(e);
  if (f && CLIENT_STAGES.includes(f.stage)) {
    // Parsing, TCP and TLS are decided on the client before PostgreSQL sends any protocol message.
    if (f.sqlstate !== null) fail('A client-side failure carries a PostgreSQL SQLSTATE.');
    if (a.protocol.length) fail('The server sent protocol messages after a client-side failure.');
    if (f.stage === 'tlsVerified' && !TLS_VERIFY_ERRORS.includes(f.code ?? '')) fail('A certificate-verification failure has no TLS verification code.');
  }
  if (f?.sqlstate != null) {
    if (f.code !== f.sqlstate) fail('A server error code differs from its SQLSTATE.');
    if (!has('errorMessage')) fail('A server SQLSTATE without an ErrorResponse from the server.');
  }
  if ((a.stages.authenticated === 'passed') !== has('authenticationOk')) fail('The authentication stage and the protocol events disagree.');
  if ((a.stages.sessionReady === 'passed') !== has('readyForQuery')) fail('The session-startup stage and the protocol events disagree.');
  if (f?.stage === 'authenticated' && !/^28/.test(f.sqlstate ?? '')) fail('An authentication failure without an authentication SQLSTATE (class 28).');
  if (f?.stage === 'sessionReady' && (f.sqlstate === null || /^28/.test(f.sqlstate))) fail('A session-startup failure without a non-authentication SQLSTATE.');
  if (has('readyForQuery') && a.protocol.indexOf('readyForQuery') < a.protocol.indexOf('authenticationOk')) fail('ReadyForQuery arrived before AuthenticationOk.');
  if (has('errorMessage') && (a.protocol.at(-1) !== 'errorMessage' || f?.sqlstate == null)) fail('A server ErrorResponse during startup without a matching failure.');
  if (a.tls) {
    if (a.tls.authorized !== (a.tls.authorizationError === null)) fail('The TLS authorization result and its error disagree.');
    // With certificate checks on, Node completes a handshake only after verifying the chain and host name.
    if (a.effective.tls?.rejectUnauthorized && (!a.tls.authorized || a.tls.hostnameCheck !== 'passed')) fail('A TLS handshake completed with certificate checks on, but the certificate was not verified.');
  }
  if (a.stages.tlsVerified === 'passed' && !(a.tls && a.tls.authorized && a.tls.authorizationError === null && a.tls.hostnameCheck === 'passed')) fail('TLS verification passed without a verified TLS result.');
  if (a.stages.serverAcceptedTls === 'passed' && !a.effective.tls) fail('TLS stages recorded without effective TLS settings.');
}

export function checkConnectivityRun(value: unknown, now = new Date()) {
  validateArtifact(value, schema);
  const run = value as ConnectivityRun;
  if (!Number.isFinite(now.getTime())) fail('Invalid connectivity evidence clock.');
  const start = Date.parse(run.collectedAt), end = Date.parse(run.expiresAt);
  if (start > now.getTime() || end - start !== 3600000) fail('Invalid connectivity evidence collection window.');
  if (SECRET_SHAPES.some(rx => rx.test(canonical(run)))) fail('A password, private path, key or certificate body was retained.');
  if (run.certificates.server.altNames !== `DNS:${SERVER_NAME}`) fail('The server certificate does not carry the expected name.');
  const by = Object.fromEntries(run.attempts.map(a => [a.phase, a])) as Record<ConnectivityPhase, Attempt>;
  let previous = start;
  run.attempts.forEach((a, i) => {
    const spec = PHASE_SPECS[a.phase], time = Date.parse(a.collectedAt);
    if (a.phase !== CONNECTIVITY_PHASES[i] || a.runId !== run.runId || a.shape !== phaseShape(a.phase)) fail('Connectivity attempt identity or order mismatch.');
    if (time < previous || time > now.getTime() || time >= end) fail('Invalid connectivity attempt time.');
    previous = time;
    // Stages run in order: after the first failure nothing later passes, and a success fails nothing.
    const order = STAGES.map(st => a.stages[st]).filter(x => x !== 'not-requested');
    const firstFail = order.indexOf('failed');
    if (firstFail >= 0 ? order.slice(0, firstFail).some(x => x !== 'passed') || order.slice(firstFail + 1).some(x => x !== 'not-reached') || a.failure === null || a.stages[a.failure.stage] !== 'failed'
        : order.some(x => x !== 'passed') || a.failure !== null) fail('Connectivity stages are inconsistent.');
    checkAttemptConsistency(a);
    if (a.parse.ok !== (a.stages.parsed === 'passed') && !(a.parse.ok && a.failure?.code === 'PARSED_DESTINATION_DIFFERS')) fail('Parse result and stage disagree.');
    if (a.effective.attempted && (a.effective.destination !== DESTINATION || a.effective.port !== spec.port)) fail('A connection was attempted somewhere other than the lab server.');
    if (a.effective.tls && (spec.sslmode === 'disable' || a.effective.tls.serverName !== spec.serverName || a.effective.tls.caSource !== (spec.rootcert ?? 'default-trust-store') || a.effective.tls.customIdentityCheck))
      fail('Effective TLS settings differ from the phase.');
    if (a.effective.tls && a.effective.tls.rejectUnauthorized !== !spec.libpqCompat) fail('Effective certificate checking differs from the phase.');
    if (a.tls && a.effective.tls && a.tls.serverName !== a.effective.tls.serverName) fail('TLS server name differs from the effective setting.');
    if (a.tls && a.tls.peerFingerprint !== run.certificates.server.fingerprint256) fail('The TLS peer was not the lab server certificate.');
    if (a.session && (a.session.role !== spec.role || a.session.database !== spec.database)) fail('Session identity differs from the phase.');
  });
  // The scenario: a verified baseline, the same connection failing without the issuing CA, then succeeding with it.
  for (const p of ['baseline-verified', 'trusted-ca-fix', 'password-both-encoded'] as const) if (!verifiedSuccess(by[p])) fail(`${p} is not a verified TLS success.`);
  const chainFailure = (a: Attempt) => a.failure?.stage === 'tlsVerified' && CHAIN_ERRORS.includes(a.failure.code ?? '') && a.stages.serverAcceptedTls === 'passed';
  for (const p of ['untrusted-ca', 'wrong-ca', 'require-driver-default'] as const) if (!chainFailure(by[p])) fail(`${p} did not fail certificate-chain verification.`);
  const u = by['untrusted-ca'], f = by['trusted-ca-fix'];
  const constant = (a: Attempt) => canonical({ ...a.effective, tls: { ...a.effective.tls, caSource: null } });
  if (constant(u) !== constant(f) || u.effective.tls?.caSource !== 'default-trust-store' || f.effective.tls?.caSource !== 'issuing-ca') fail('The fix changed something other than the trusted CA.');
  // The behaviour is measured from the effective settings and the failure. The parser's warning is printed once per process, so it is optional.
  if (by['require-driver-default'].effective.tls?.rejectUnauthorized !== true) fail('sslmode=require did not turn certificate checks on with this driver.');
  const h = by['hostname-mismatch'];
  if (h.failure?.stage !== 'tlsVerified' || h.failure.code !== 'ERR_TLS_CERT_ALTNAME_INVALID' || h.effective.tls?.caSource !== 'issuing-ca') fail('Hostname mismatch did not fail the identity check.');
  const c = by['require-libpq-compat'];
  if (c.failure !== null || c.effective.tls?.rejectUnauthorized !== false || c.stages.tlsVerified !== 'not-requested' || c.tls?.authorized !== false || !c.session?.ssl) fail('The libpq-compatible control differs from an encrypted but unverified session.');
  const n = by['no-tls'];
  if (n.effective.tls !== null || n.stages.serverAcceptedTls !== 'not-requested' || n.failure?.sqlstate !== '28000' || n.failure.stage !== 'authenticated') fail('The no-TLS control was not refused by the server.');
  // A wrong password and an unknown role are refused during authentication. A missing database is refused after
  // the server accepted the credentials, while it starts the session.
  for (const [p, code, stage] of [['wrong-password', '28P01', 'authenticated'], ['unknown-role', '28P01', 'authenticated'], ['wrong-database', '3D000', 'sessionReady']] as const)
    if (by[p].failure?.sqlstate !== code || by[p].failure?.stage !== stage || by[p].stages.tlsVerified !== 'passed') fail(`${p} did not fail with ${code} at ${STAGE_LABELS[stage]} after TLS verification.`);
  if (by['tcp-refused'].failure?.stage !== 'tcpConnected' || by['tcp-refused'].failure?.code !== 'ECONNREFUSED') fail('The closed-port control did not fail at TCP connect.');
  // Password parsing is recorded as observed. A parse that succeeds must have read the intended values.
  for (const p of ['password-hash-unencoded', 'password-at-unencoded', 'password-both-unencoded'] as const) {
    const a = by[p];
    if (a.parse.ok ? !(a.parse.matches && Object.values(a.parse.matches).every(Boolean)) && !['parsed', 'authenticated', 'sessionReady'].includes(a.failure?.stage ?? '') : a.failure?.stage !== 'parsed') fail(`${p} result is inconsistent.`);
  }
  return { run, evidenceStatus: now.getTime() >= end ? 'STALE' : 'MEASURED', reviewStatus: 'NOT_REVIEWED' as const };
}

export function connectivityManifest(run: ConnectivityRun) {
  return { schemaVersion: 1, scenario: 'tls-trust', runHash: hash(run), catalogHash: hash(CONNECTIVITY_QUERIES) };
}
export function inspectConnectivity(dir: string, expectedHash?: string, now = new Date()) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular connectivity run directory.');
  const result = checkConnectivityRun(readJson(join(dir, 'connectivity-run.json')), now);
  const manifest = readJson(join(dir, 'connectivity-manifest.json'));
  if (canonical(manifest) !== canonical(connectivityManifest(result.run)) || canonical(readJson(join(dir, 'connectivity-probes.json'))) !== canonical(CONNECTIVITY_QUERIES)) fail('Connectivity artifact integrity mismatch.');
  const manifestHash = hash(manifest);
  if (expectedHash !== undefined && expectedHash !== manifestHash) fail('Connectivity manifest differs from the supplied anchor.');
  return { ...result, integrity: 'VALID', anchorChecked: expectedHash !== undefined, manifestHash };
}

export const PHASE_LABELS: Record<ConnectivityPhase, string> = {
  'baseline-verified': 'Baseline: verify-full with the issuing CA', 'untrusted-ca': 'Same connection without the issuing CA',
  'trusted-ca-fix': 'Same connection after supplying the issuing CA', 'wrong-ca': 'Control: a different, untrusted CA',
  'hostname-mismatch': 'Control: a host name not on the certificate', 'require-driver-default': 'Control: sslmode=require with this driver',
  'require-libpq-compat': 'Control: sslmode=require with uselibpqcompat=true', 'no-tls': 'Control: TLS turned off',
  'wrong-password': 'Control: wrong password', 'unknown-role': 'Control: role that does not exist', 'wrong-database': 'Control: database that does not exist',
  'password-hash-unencoded': 'Password with # left unencoded', 'password-at-unencoded': 'Password with @ left unencoded',
  'password-both-unencoded': 'Password with # and @ left unencoded', 'password-both-encoded': 'The same password percent-encoded',
  'tcp-refused': 'Control: port with nothing listening',
};
export const STAGE_LABELS: Record<Stage, string> = { parsed: 'connection-string parsing', tcpConnected: 'TCP connection', serverAcceptedTls: 'TLS request to the server',
  tlsVerified: 'TLS certificate verification (chain and host name)', authenticated: 'PostgreSQL authentication', sessionReady: 'session startup (database and session)', queryOk: 'the query' };
export const outcome = (a: Attempt) => a.failure ? `Failed at ${STAGE_LABELS[a.failure.stage]}: ${a.failure.sqlstate ? 'SQLSTATE ' + a.failure.sqlstate : a.failure.code ?? 'no code'}`
  : a.effective.tls?.rejectUnauthorized === false ? 'Connected, encrypted, certificate not verified' : a.effective.tls ? 'Connected, encrypted and verified' : 'Connected';
const logText = (a: Attempt) => a.serverLog.length ? a.serverLog.join(', ') : 'no entries (inconclusive)';

// The certificate failures' stages are measured on the client. Server log entries are supporting evidence only;
// a missing entry is reported as inconclusive, never as proof that the server was not reached.
export function reachedSentence(by: Record<ConnectivityPhase, Attempt>) {
  const failures = (['untrusted-ca', 'wrong-ca', 'hostname-mismatch'] as const).map(p => by[p]);
  const logged = failures.every(a => a.serverLog.includes('connection-received'));
  return 'The certificate failures still reached the server: in each one TCP connected and the server agreed to TLS before the client rejected the certificate. ' +
    (logged ? 'The server log also recorded each connection.' : 'The server log did not record every one of these connections, which is inconclusive on its own.');
}
export function missingDatabaseSentence(a: Attempt) {
  return a.stages.authenticated === 'passed' && a.protocol.includes('authenticationOk')
    ? `The server accepted the credentials (AuthenticationOk) and then refused the missing database with ${a.failure?.sqlstate} during session startup, so that error shows the password and role were accepted.`
    : `A missing database returned ${a.failure?.sqlstate}.`;
}
export function connectivityMarkdown(run: ConnectivityRun, now = new Date()) {
  const checked = checkConnectivityRun(run, now), by = Object.fromEntries(run.attempts.map(a => [a.phase, a])) as Record<ConnectivityPhase, Attempt>;
  const pw = (p: ConnectivityPhase) => by[p].parse.ok ? (by[p].failure ? 'f' + outcome(by[p]).slice(1) : 'parsed and connected') : `failed to parse (${by[p].parse.errorCode})`;
  return `# Connection strings, authentication and TLS\n\nEvidence: ${checked.evidenceStatus}. Review: NOT_REVIEWED.\n\n` +
    `This disposable local experiment starts PostgreSQL with TLS required, on ${DESTINATION} only. Connection strings name the host ${SERVER_NAME}; the runner always connects to ${DESTINATION} and checks the certificate against the name in the connection string. Passwords, private keys and file paths are not retained.\n\n` +
    '| Check | Result | Server log |\n|---|---|---|\n' + run.attempts.map(a => `| ${PHASE_LABELS[a.phase]} | ${outcome(a)} | ${logText(a)} |`).join('\n') +
    `\n\nWithout the issuing CA, the same connection failed while verifying the certificate chain (${by['untrusted-ca'].failure?.code}). Supplying the issuing CA, with nothing else changed, made it succeed with chain and host-name checks turned on and passing.\n\n` +
    `${reachedSentence(by)}\n\n` +
    `With the recorded driver versions (pg ${run.versions.pg}, pg-connection-string ${run.versions.pgConnectionString}, Node ${run.versions.node}), sslmode=require turned certificate checks on, like verify-full${by['require-driver-default'].parse.warnings.includes('sslmode-treated-as-verify-full') ? ', and the parser printed a warning saying so' : ''}. With uselibpqcompat=true it connected encrypted without verifying the certificate. That control is not a fix.\n\n` +
    `A wrong password and a role that does not exist both returned SQLSTATE 28P01. ${by['unknown-role'].serverLog.includes('role-does-not-exist') && !by['wrong-password'].serverLog.includes('role-does-not-exist') ? 'Only the server log told them apart.' : 'The client error alone did not tell them apart, and the server log entries were inconclusive.'} ${missingDatabaseSentence(by['wrong-database'])} With TLS turned off, the server refused the connection with 28000. A 28000 refusal on its own does not show that escalation is needed.\n\n` +
    `Password parsing with this parser: # alone ${pw('password-hash-unencoded')}; @ alone ${pw('password-at-unencoded')}; # and @ together ${pw('password-both-unencoded')}; the same password percent-encoded ${pw('password-both-encoded')}.\n\n` +
    'Next questions: Which client library and version does the application use? What sslmode and sslrootcert does it set, and which host name does it connect to? What exact error code does it report, and at which stage? Which CA issued the server certificate it receives?\n\n' +
    'Scope: synthetic local PostgreSQL with temporary certificates. Human cause review, customer resolution and message approval remain pending.\n';
}
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
export function connectivityHtml(run: ConnectivityRun, now = new Date()) {
  const checked = checkConnectivityRun(run, now);
  const paragraphs = connectivityMarkdown(run, now).split('\n\n').filter(p => !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('Evidence:'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'"><title>Connection strings, authentication and TLS | Postgres Support Lab</title><style>${reportStyles}

/* Certificate fingerprints are long unbroken tokens; let them wrap. */
.panel p,.panel li,.lede{overflow-wrap:anywhere}
/* When the table has less than 600px, including beside the sidebar, each check gets its own block, with its values underneath. Explicit roles keep table semantics when rows use grid layout. */
.table-wrap{container-type:inline-size}
@container (max-width:600px){.results,.results thead,.results tbody{display:block}.results tr{display:grid;grid-template-columns:minmax(0,1fr);border-bottom:1px solid var(--line)}.results th,.results td{border-bottom:0;padding:6px 10px;overflow-wrap:anywhere}.results tr>:first-child{padding-bottom:0}}</style></head><body><a class="skip" href="#results">Skip to results</a><aside><div class="brand"><span class="brand-mark">P</span>Postgres Support Lab</div><p class="tag">Local PostgreSQL investigation</p><nav><a href="#results">Measured results</a><a href="#interpretation">Interpretation</a><a href="#evidence">Evidence</a></nav></aside><main><header><p class="eyebrow">Connectivity / TLS</p><h1>Why won’t the app trust the database’s certificate?</h1><p class="lede">In this local test, a connection that required certificate checks failed until the client was given the CA that issued the server’s certificate. With only that change, it connected with the chain and host-name checks passing. Nobody has reviewed these results yet.</p><p class="status">${checked.evidenceStatus} · HUMAN REVIEW PENDING</p><p class="meta">Run ${escape(run.runId)}<br>Evidence collected ${escape(run.collectedAt)}<br>Freshness window ends ${escape(run.expiresAt)}<br>This page is a snapshot. Re-run inspection to check freshness.</p></header><section class="panel" id="results"><h2>Measured results</h2><div class="table-wrap"><table class="results" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Check</th><th role="columnheader" scope="col">Result</th><th role="columnheader" scope="col">Server log</th></tr></thead><tbody role="rowgroup">${run.attempts.map(a => `<tr role="row"><th role="rowheader" scope="row">${escape(PHASE_LABELS[a.phase])}</th><td role="cell">${escape(outcome(a))}</td><td role="cell">${escape(logText(a))}</td></tr>`).join('')}</tbody></table></div></section><section class="panel document" id="interpretation"><h2>What the comparison tells us</h2>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</section><section class="panel" id="evidence"><h2>Evidence and limitations</h2><p>PostgreSQL ${escape(run.postgresVersion)}. Loopback only. Cleanup complete, including the temporary keys. Server certificate ${escape(run.certificates.server.altNames)}, SHA-256 ${escape(run.certificates.server.fingerprint256)}.</p><p>Connection strings are retained only as shapes with passwords and paths replaced. Hashes check consistency against a separately retained anchor. They cannot authenticate a collector or detect a complete unanchored rewrite. HTML and Markdown are derived views; inspect the JSON artifacts for verification.</p><details><summary>Measured attempts</summary><pre>${escape(JSON.stringify(run, null, 2))}</pre></details></section><footer>Independent project. Customer cause and resolution remain unset.${fontLicenses.map(l => `<details class="license"><summary>${escape(l.name)} font license</summary><pre>${escape(l.text)}</pre></details>`).join('')}</footer></main></body></html>`;
}
