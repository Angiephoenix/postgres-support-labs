import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, existsSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { delimiter, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes, X509Certificate } from 'node:crypto';
import { createServer, Socket } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { canonical, hash, fail, LedgerError } from './contracts.ts';
import { CONNECTIVITY_QUERIES as Q, CONNECTIVITY_PHASES, PHASE_SPECS, SERVER_NAME, DESTINATION, STAGES, PROTOCOL_EVENTS, phaseShape, checkConnectivityRun, connectivityManifest, connectivityMarkdown, connectivityHtml } from './connectivity-evidence.ts';
import type { ConnectivityRun, Attempt, ConnectivityPhase, Stage, CertificateRecord } from './connectivity-evidence.ts';

const require = createRequire(import.meta.url);
const { parse } = require('pg-connection-string') as { parse: (s: string) => any };
// Reads an installed package's version from its package.json, found by walking up from its entry point.
function packageVersion(name: string) {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) { const p = JSON.parse(readFileSync(file, 'utf8')); if (p.name === name) return String(p.version); }
  }
  return fail(`Could not read the installed ${name} version.`);
}

export function connectivityPlan() {
  return { profile: 'local-lab', approvalRequired: true, network: 'loopback only', connection: `TCP on ${DESTINATION} at a random port, TLS required by the server; setup over a private Unix socket`,
    operations: ['Check that openssl can create the temporary certificates, before starting PostgreSQL',
      'Create a temporary issuing CA, a server certificate for db.pslab.test and an untrusted CA, valid for one day',
      'Create a disposable PostgreSQL cluster that accepts only TLS connections from 127.0.0.1 with SCRAM passwords',
      'Connect with fixed connection-string variants, recording each stage from parsing to query',
      'Stop the owned server and remove the cluster, keys, certificates and credentials'],
    retained: ['connection-string shapes without passwords or paths', 'effective TLS settings and results', 'certificate fingerprints and names', 'anchorable manifest', 'HTML and Markdown experiment reports'],
    reviewStatus: 'NOT_REVIEWED', cause: null, customerResolution: null };
}
// The first non-empty line of a tool's version output, with control characters removed. Kept whole up to 200
// characters, so long OpenSSL lines such as "OpenSSL 3.6.4 25 Aug 2026 (Library: ...)" are not cut off; anything
// longer is shortened with an explicit marker.
export function versionLine(text: string) {
  const line = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').split('\n').map(l => l.trim().replace(/\s+/g, ' ')).find(Boolean);
  if (!line) return fail('The openssl version output was empty.');
  return line.length <= 200 ? line : line.slice(0, 188) + ' [truncated]';
}
const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
function executable(name: string, directory?: string) {
  for (const dir of directory ? [directory] : (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { const file = join(dir, name); accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* next directory */ }
  }
  return fail(name === 'openssl' ? 'openssl was not found on PATH. The connectivity lab needs it to create temporary certificates.' : 'PostgreSQL server tools were not found. Set PSLAB_PG_BIN to their bin directory.');
}
// A failed command is reported by a fixed label and its exit status. Its output can hold paths or key material, so it is withheld.
export class CommandFailure extends LedgerError {
  readonly label: string; readonly exitStatus: number|null;
  constructor(label: string, exitStatus: number|null) {
    super(`A local command failed: ${label}${exitStatus === null ? '' : ` (exit status ${exitStatus})`}. Raw process output is withheld.`);
    this.label = label; this.exitStatus = exitStatus;
  }
}
function command(file: string, args: string[], label: string, cwd?: string) {
  const result = spawnSync(file, args, { env: env(), encoding: 'utf8', timeout: 60000, maxBuffer: 65536, cwd });
  if (result.error || result.status !== 0) throw new CommandFailure(label, typeof result.status === 'number' ? result.status : null);
  return result.stdout;
}
// Why a server failed to start, as fixed categories read from its log. Raw lines, paths and values are never retained.
const STARTUP_LOG_RULES: [RegExp, string][] = [[/md too weak/, 'server-certificate-signature-too-weak'], [/ee key too small|key too small/, 'server-key-too-small'],
  [/private key file .* has group or world access/, 'private-key-permissions'], [/could not load private key file/, 'private-key-load-failed'],
  [/could not load server certificate file/, 'server-certificate-load-failed'], [/Address already in use/, 'address-in-use'],
  // Other bind failures, such as "Permission denied" or "Cannot assign requested address", are not evidence of an occupied address.
  [/could not bind/, 'bind-failed']];
export function classifyStartupLog(text: string) {
  const out: string[] = [];
  for (const line of text.split('\n').filter(l => /FATAL|could not bind|Address already in use/.test(l))) {
    const label = STARTUP_LOG_RULES.find(([re]) => re.test(line))?.[1] ?? 'other-fatal';
    if (!out.includes(label)) out.push(label);
  }
  return out;
}
// The generated certificates must be SHA-256 signed, the CAs marked as CAs, and the server certificate issued by the
// issuing CA for db.pslab.test. Some openssl builds have weaker defaults; this stops the run before PostgreSQL starts.
const SIGNATURE_OIDS: Record<string, string> = { '2a864886f70d01010b': 'sha256WithRSAEncryption', '2a864886f70d01010c': 'sha384WithRSAEncryption', '2a864886f70d01010d': 'sha512WithRSAEncryption',
  '2a864886f70d010105': 'sha1WithRSAEncryption', '2a864886f70d010104': 'md5WithRSAEncryption' };
// Reads one DER element's tag and content bounds. Lengths over four bytes are not needed for a certificate.
function derElement(der: Buffer, at: number) {
  if (at + 2 > der.length) fail('certificate check: certificate encoding is truncated.');
  const tag = der[at], first = der[at + 1];
  let length = first, header = 2;
  if (first & 0x80) {
    const bytes = first & 0x7f;
    if (bytes < 1 || bytes > 4 || at + 2 + bytes > der.length) fail('certificate check: certificate encoding is not supported.');
    length = 0; for (let i = 0; i < bytes; i++) length = length * 256 + der[at + 2 + i];
    header = 2 + bytes;
  }
  const start = at + header, end = start + length;
  if (end > der.length) fail('certificate check: certificate encoding is truncated.');
  return { tag, start, end };
}
// The certificate's own signature algorithm, read structurally: Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm,
// signatureValue }. Only the OID of the second element is read, so bytes inside the signature value cannot affect the result.
export function outerSignatureAlgorithm(der: Buffer) {
  const certificate = derElement(der, 0), tbs = derElement(der, certificate.start), algorithm = derElement(der, tbs.end);
  if (certificate.tag !== 0x30 || tbs.tag !== 0x30 || algorithm.tag !== 0x30 || algorithm.end > certificate.end) return 'unknown';
  const oid = derElement(der, algorithm.start);
  return oid.tag === 0x06 && oid.end <= algorithm.end ? SIGNATURE_OIDS[der.subarray(oid.start, oid.end).toString('hex')] ?? 'unknown' : 'unknown';
}
const signatureAlgorithm = (c: X509Certificate) => outerSignatureAlgorithm(c.raw);
export function checkLabCertificates(pem: { issuingCa: Buffer; server: Buffer; untrustedCa: Buffer }) {
  const issuing = new X509Certificate(pem.issuingCa), server = new X509Certificate(pem.server), untrusted = new X509Certificate(pem.untrustedCa);
  const named: [string, X509Certificate][] = [['issuing CA', issuing], ['server certificate', server], ['untrusted CA', untrusted]];
  for (const [name, c] of named) { const alg = signatureAlgorithm(c); if (alg !== 'sha256WithRSAEncryption') fail(`certificate check: ${name} is signed with ${alg}; SHA-256 is required.`); }
  for (const [name, c] of [named[0], named[2]]) if (!c.ca || !c.verify(c.publicKey)) fail(`certificate check: ${name} is not marked as a CA, or is not self-signed.`);
  if (server.ca) fail('certificate check: server certificate is marked as a CA.');
  const issuedByIssuingCa = server.checkIssued(issuing) && server.verify(issuing.publicKey);
  if (!issuedByIssuingCa) fail('certificate check: server certificate was not issued by the issuing CA.');
  const hostMatches = server.checkHost(SERVER_NAME) === SERVER_NAME;
  if (!hostMatches) fail(`certificate check: server certificate does not name ${SERVER_NAME}.`);
  return { issuingCa: { signatureAlgorithm: signatureAlgorithm(issuing), ca: true }, server: { signatureAlgorithm: signatureAlgorithm(server), ca: false, issuedByIssuingCa, hostMatches },
    untrustedCa: { signatureAlgorithm: signatureAlgorithm(untrusted), ca: true } };
}
function write(path: string, value: unknown) { writeFileSync(path, canonical(value) + '\n', { flag: 'wx', mode: 0o600 }); }
function one(rows: any[]) { if (rows.length !== 1) fail('Unexpected bounded probe row count.'); return rows[0]; }
const sqlstateOf = (e: any) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e?.severity === 'string' ? e.code : null;
const codeOf = (e: any) => typeof e?.code === 'string' && /^[A-Za-z0-9_]{2,60}$/.test(e.code) ? e.code : null;
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8).padStart(4, '0');
function certificate(path: string): CertificateRecord {
  const c = new X509Certificate(readFileSync(path));
  return { subject: c.subject.replace(/\n/g, ', '), issuer: c.issuer.replace(/\n/g, ', '), altNames: c.subjectAltName ?? null, fingerprint256: c.fingerprint256, validFrom: new Date(c.validFrom).toISOString(), validTo: new Date(c.validTo).toISOString() };
}
async function freePort() {
  return new Promise<number>((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, DESTINATION, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
}
// Environment names that could change a PostgreSQL or TLS client. The runner passes every setting explicitly,
// so these are recorded by name only; a setting that turns off certificate checks for the whole process is refused.
const WATCHED_ENV = ['NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'PGDATABASE', 'PGHOST', 'PGHOSTADDR', 'PGPASSFILE', 'PGPASSWORD', 'PGPORT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLMODE', 'PGSSLNEGOTIATION', 'PGSSLROOTCERT', 'PGUSER'];

export async function runConnectivityLab(options: { approved: boolean; output: string }) {
  if (options.approved !== true) fail('Connectivity lab execution requires --approve-lab.');
  (await import('./lab-packs.ts')).requireWorkingPack('connectivity');
  if (!['linux','darwin'].includes(process.platform)) fail('Use macOS or Linux for the native connectivity lab.');
  if (process.getuid?.() === 0) fail('Run the lab as a regular user, without sudo.');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '1') fail('NODE_TLS_REJECT_UNAUTHORIZED is set and would weaken certificate checks. Unset it before running the lab.');
  const bins = Object.fromEntries(['initdb','pg_ctl','postgres'].map(n => [n, executable(n, process.env.PSLAB_PG_BIN)]));
  const majors = Object.values(bins).map(b => Number(command(b, ['--version'], `${b.split('/').pop()} --version`).match(/\(PostgreSQL\) (\d+)/)?.[1]));
  if (!majors.every(m => m === majors[0] && m >= 16 && m <= 18)) fail('Use matching PostgreSQL 16, 17 or 18 server tools.');
  const openssl = executable('openssl'), opensslVersion = versionLine(command(openssl, ['version'], 'openssl version'));
  mkdirSync(options.output, { mode: 0o700 });
  const output = realpathSync(options.output), runId = randomUUID(), collectedAt = new Date().toISOString();
  write(join(output, 'connectivity-plan.json'), { ...connectivityPlan(), runId, approved: true });
  write(join(output, 'connectivity-probes.json'), Q);
  const root = mkdtempSync('/tmp/pslab-conn-'), data = join(root, 'data'), socket = join(root, 'sock'), tls = join(root, 'tls');
  mkdirSync(socket, { mode: 0o700 }); mkdirSync(tls, { mode: 0o700 });
  let failure: unknown, stage = 'certificates', clusterFingerprint = '', postgresVersion = '', cleanup = 'PENDING', port = 0, closedPort = 0;
  let certificates: ConnectivityRun['certificates'] | undefined, keyFiles: ConnectivityRun['keyFiles'] | undefined, startupLog: string[] = [];
  const clients = new Set<Client>(), attempts: Attempt[] = [];
  const interrupt = () => { failure ??= new Error('interrupted'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const check = () => { if (failure) fail('Connectivity experiment interrupted.'); };
  const secret = () => randomBytes(8).toString('hex');
  const passwords = { pslab_app: `Lab#${secret()}@x`, pslab_hash: `Lab#${secret()}`, pslab_at: `Lab@${secret()}`, pslab_unknown: `Lab#${secret()}@x` } as const;
  const logPath = join(root, 'postgres.log');
  const logSize = () => existsSync(logPath) ? statSync(logPath).size : 0;
  function logCategories(from: number) {
    const text = readFileSync(logPath, 'utf8').slice(from), out: string[] = [];
    const rules: [RegExp, string][] = [[/connection received/, 'connection-received'], [/connection authorized/, 'connection-authorized'],
      [/could not accept SSL connection|SSL error|alert/i, 'tls-error-logged'], [/password authentication failed/, 'password-authentication-failed'],
      [/Role "[^"]*" does not exist/, 'role-does-not-exist'], [/database "[^"]*" does not exist/, 'database-does-not-exist'],
      [/rejects connection.*no encryption/, 'rejected-without-encryption'], [/no pg_hba\.conf entry/, 'no-hba-entry']];
    for (const line of text.split('\n').filter(Boolean)) {
      const found = rules.find(([re]) => re.test(line));
      const label = found ? found[1] : /FATAL|ERROR/.test(line) ? 'other-error' : null;
      if (label && !out.includes(label)) out.push(label);
    }
    return out;
  }
  async function attempt(phase: ConnectivityPhase): Promise<Attempt> {
    check();
    const spec = PHASE_SPECS[phase], role = spec.role, realPassword = passwords[role];
    const password = spec.password === 'wrong' ? `Wrong-${secret()}` : spec.encoding === 'encoded' ? encodeURIComponent(realPassword) : realPassword;
    const usedPassword = spec.password === 'wrong' ? password : realPassword;
    const query = [spec.libpqCompat ? 'uselibpqcompat=true' : null, `sslmode=${spec.sslmode}`, spec.rootcert ? `sslrootcert=${join(tls, spec.rootcert + '.crt')}` : null].filter(Boolean).join('&');
    const url = `postgres://${role}:${password}@${spec.serverName}:${spec.port === 'lab' ? port : closedPort}/${spec.database}?${query}`;
    const reached = Object.fromEntries(STAGES.map(s => [s, false])) as Record<Stage, boolean>;
    const stages = Object.fromEntries(STAGES.map(s => [s, 'not-reached'])) as Attempt['stages'];
    const result: Attempt = { phase, runId, collectedAt: new Date().toISOString(), shape: phaseShape(phase),
      parse: { ok: false, errorCode: null, matches: null, warnings: [] }, effective: { attempted: false, destination: null, port: null, tls: null },
      stages, failure: null, protocol: [], tls: null, session: null, serverLog: [] };
    const warnings: string[] = [], onWarning = (w: Error) => { warnings.push(/aliases for 'verify-full'/.test(w.message) ? 'sslmode-treated-as-verify-full' : 'other-warning'); };
    process.on('warning', onWarning);
    let parsed: any;
    try { parsed = parse(url); } catch (e) { result.parse.errorCode = codeOf(e) ?? 'PARSE_ERROR'; }
    await new Promise(r => setImmediate(r)); process.removeListener('warning', onWarning);
    result.parse.warnings = warnings;
    // TLS stages apply only when TLS is requested, and verification only when it is turned on.
    const tlsRequested = spec.sslmode !== 'disable';
    const settle = (applies: Record<Stage, boolean>, failure: { code: string|null; sqlstate: string|null }|null) => {
      let failedAt: Stage|null = null;
      for (const s of STAGES) {
        if (!applies[s]) stages[s] = 'not-requested';
        else if (reached[s]) stages[s] = 'passed';
        else if (failure && !failedAt) { stages[s] = 'failed'; failedAt = s; }
      }
      result.failure = failure && failedAt ? { stage: failedAt, ...failure } : null;
    };
    const all = (tls: boolean, verify: boolean) => ({ parsed: true, tcpConnected: true, serverAcceptedTls: tls, tlsVerified: verify, authenticated: true, sessionReady: true, queryOk: true });
    if (!parsed) { settle(all(tlsRequested, tlsRequested), { code: result.parse.errorCode, sqlstate: null }); return result; }
    result.parse.ok = true;
    const matches = { user: parsed.user === role, password: parsed.password === usedPassword, host: parsed.host === spec.serverName,
      port: String(parsed.port) === String(spec.port === 'lab' ? port : closedPort), database: parsed.database === spec.database };
    result.parse.matches = matches;
    // A misread host or port would send a real client somewhere else, so nothing is attempted.
    if (!matches.host || !matches.port) { settle(all(tlsRequested, tlsRequested), { code: 'PARSED_DESTINATION_DIFFERS', sqlstate: null }); return result; }
    reached.parsed = true;
    const ssl = parsed.ssl === false || parsed.ssl === undefined ? false : { ...parsed.ssl, servername: spec.serverName };
    const before = logSize();
    const client = new Client({ host: DESTINATION, port: Number(parsed.port), user: parsed.user, password: parsed.password, database: parsed.database,
      ssl, sslnegotiation: 'postgres', options: '', application_name: 'pslab-connectivity', client_encoding: 'UTF8', connectionTimeoutMillis: 3000, query_timeout: 5000 } as any);
    // The effective settings the driver will use, read back from the client before connecting.
    const cp = (client as any).connectionParameters, eff = cp.ssl;
    const caSource = !eff || !eff.ca ? 'default-trust-store' : eff.ca === readFileSync(join(tls, 'issuing-ca.crt'), 'utf8') ? 'issuing-ca' : eff.ca === readFileSync(join(tls, 'untrusted-ca.crt'), 'utf8') ? 'untrusted-ca' : fail('Unexpected CA in effective settings.');
    result.effective = { attempted: true, destination: cp.host, port: spec.port,
      tls: eff ? { rejectUnauthorized: eff.rejectUnauthorized !== false, serverName: eff.servername ?? null, caSource, customIdentityCheck: typeof eff.checkServerIdentity === 'function' } : null };
    if (cp.host !== DESTINATION || cp.port !== Number(parsed.port) || cp.user !== parsed.user || cp.database !== parsed.database || cp.password !== parsed.password) fail('Effective connection settings differ from the intended ones.');
    const conn = (client as any).connection;
    conn.stream.once('connect', () => { reached.tcpConnected = true; });
    conn.once('sslconnect', () => {
      reached.serverAcceptedTls = true;
      const s = conn.stream as TLSSocket;
      s.once('secureConnect', () => {
        const peer = s.getPeerCertificate();
        result.tls = { authorized: s.authorized, authorizationError: s.authorizationError ? String((s.authorizationError as any).code ?? s.authorizationError) : null,
          serverName: (s as any).servername || null, peerFingerprint: peer.fingerprint256, peerAltNames: peer.subjectaltname ?? '',
          hostnameCheck: checkServerIdentity(spec.serverName, peer) === undefined ? 'passed' : 'failed', protocol: s.getProtocol() };
        reached.tlsVerified = s.authorized && result.tls.hostnameCheck === 'passed';
      });
    });
    // Startup messages from the server, recorded until the connection is ready or fails. AuthenticationOk marks
    // accepted credentials; ReadyForQuery marks a started session in the requested database.
    let recording = true;
    for (const name of PROTOCOL_EVENTS) conn.on(name, () => {
      if (!recording) return;
      result.protocol.push(name);
      if (name === 'authenticationOk') reached.authenticated = true;
      if (name === 'readyForQuery' && reached.authenticated) reached.sessionReady = true;
    });
    clients.add(client);
    let caught: { code: string|null; sqlstate: string|null }|null = null;
    try {
      try { await client.connect(); } finally { recording = false; }
      const row = one((await client.query(Q.session)).rows);
      if (row.run_id !== runId) fail('Connectivity target identity mismatch.');
      result.session = { role: row.role, database: row.database, ssl: row.ssl, tlsVersion: row.tls_version };
      reached.queryOk = true;
    } catch (e) {
      if (e instanceof LedgerError) throw e;
      caught = { code: codeOf(e), sqlstate: sqlstateOf(e) };
    } finally { clients.delete(client); await client.end().catch(() => {}); }
    settle(all(Boolean(ssl), Boolean(ssl) && (ssl as any).rejectUnauthorized !== false), caught);
    await new Promise(r => setTimeout(r, 250));
    result.serverLog = logCategories(before);
    return result;
  }
  try {
    // Certificates first, so a missing or incompatible openssl stops the run before PostgreSQL starts.
    // The digest and extensions are set explicitly, and a private config file is used, so the result does not depend on
    // the defaults of the installed openssl or LibreSSL or on the system openssl.cnf.
    const ossl = (label: string, args: string[]) => command(openssl, args, `openssl: ${label}`, tls);
    writeFileSync(join(tls, 'lab.cnf'), '[req]\ndistinguished_name = dn\n[dn]\n[ca]\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\n', { mode: 0o600 });
    writeFileSync(join(tls, 'server.ext'), `basicConstraints = CA:FALSE\nkeyUsage = critical, digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:${SERVER_NAME}\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid\n`, { mode: 0o600 });
    const ca = (name: string, cn: string) => ossl(name, ['req', '-config', 'lab.cnf', '-extensions', 'ca', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', '1', '-subj', `/CN=${cn}`]);
    ca('issuing-ca', 'pslab-issuing-ca');
    ossl('server request', ['req', '-config', 'lab.cnf', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', 'server.key', '-out', 'server.csr', '-subj', `/CN=${SERVER_NAME}`]);
    ossl('server certificate', ['x509', '-req', '-in', 'server.csr', '-CA', 'issuing-ca.crt', '-CAkey', 'issuing-ca.key', '-CAcreateserial', '-sha256', '-out', 'server.crt', '-days', '1', '-extfile', 'server.ext']);
    ca('untrusted-ca', 'pslab-untrusted-ca');
    checkLabCertificates({ issuingCa: readFileSync(join(tls, 'issuing-ca.crt')), server: readFileSync(join(tls, 'server.crt')), untrustedCa: readFileSync(join(tls, 'untrusted-ca.crt')) });
    for (const key of ['issuing-ca.key', 'server.key', 'untrusted-ca.key']) chmodSync(join(tls, key), 0o600);
    const keyModes = ['issuing-ca.key', 'server.key', 'untrusted-ca.key'].map(k => mode(join(tls, k)));
    if (!keyModes.every(m => m === '0600') || mode(tls) !== '0700') fail('Temporary key files or their directory are not private.');
    keyFiles = { mode: '0600', directoryMode: '0700' };
    certificates = { issuingCa: certificate(join(tls, 'issuing-ca.crt')), server: certificate(join(tls, 'server.crt')), untrustedCa: certificate(join(tls, 'untrusted-ca.crt')) };
    if (certificates.server.altNames !== `DNS:${SERVER_NAME}`) fail('The server certificate does not carry the expected name.');
    stage = 'setup';
    command(bins.initdb, ['-D', data, '-U', 'pslab_owner', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'], 'initdb');
    port = await freePort(); closedPort = await freePort();
    appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = '${DESTINATION}'\nport = ${port}\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\nmax_connections = 12\nshared_buffers = '16MB'\nssl = on\nssl_cert_file = '${join(tls, 'server.crt')}'\nssl_key_file = '${join(tls, 'server.key')}'\npassword_encryption = 'scram-sha-256'\nlog_connections = on\n`);
    writeFileSync(join(data, 'pg_hba.conf'), Q.hba.join('\n') + '\n');
    try { command(bins.pg_ctl, ['-D', data, '-l', logPath, '-w', '-t', '15', 'start'], 'pg_ctl start'); }
    catch (e) {
      // The log is supporting detail only: if it can't be read, keep an empty list and rethrow the original failure.
      try { startupLog = existsSync(logPath) ? classifyStartupLog(readFileSync(logPath, 'utf8')) : []; } catch { startupLog = []; }
      throw e;
    }
    const owner = new Client({ host: socket, port, database: 'postgres', user: 'pslab_owner', password: 'unused-local-lab', ssl: false, options: '', application_name: 'pslab-connectivity' });
    clients.add(owner); await owner.connect();
    const system = one((await owner.query("SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version, system_identifier::text AS identifier FROM pg_control_system()")).rows);
    if (realpathSync(system.directory) !== realpathSync(data)) fail('Owned PostgreSQL directory mismatch.');
    clusterFingerprint = hash(system.identifier); postgresVersion = system.version;
    for (const role of ['pslab_app', 'pslab_hash', 'pslab_at'] as const) {
      const literal = (await owner.query('SELECT quote_literal($1::text) AS q', [passwords[role]])).rows[0].q;
      await owner.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal}`);
    }
    await owner.query('CREATE DATABASE pslab_conn'); clients.delete(owner); await owner.end();
    const setup = new Client({ host: socket, port, database: 'pslab_conn', user: 'pslab_owner', password: 'unused-local-lab', ssl: false, options: '' });
    clients.add(setup); await setup.connect();
    await setup.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE TABLE lab_identity (run_id uuid NOT NULL); GRANT SELECT ON lab_identity TO pslab_app, pslab_hash, pslab_at');
    await setup.query('INSERT INTO lab_identity VALUES ($1)', [runId]); clients.delete(setup); await setup.end();
    stage = 'connections';
    for (const phase of CONNECTIVITY_PHASES) attempts.push(await attempt(phase));
    check();
  } catch (error) { failure ??= error; }
  finally {
    for (const c of clients) await c.end().catch(() => {});
    if (existsSync(join(data, 'postmaster.pid'))) {
      try { command(bins.pg_ctl, ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop'], 'pg_ctl stop'); } catch { cleanup = 'FAILED'; failure ??= new Error('postgres cleanup'); }
    }
    if (cleanup !== 'FAILED') { rmSync(root, { recursive: true, force: true }); cleanup = existsSync(root) ? 'FAILED' : 'COMPLETE'; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (failure) {
    write(join(output, 'connectivity-failure.json'), { runId, stage, cleanup, sqlstate: sqlstateOf(failure), cause: null,
      failedCommand: failure instanceof CommandFailure ? failure.label : null, exitStatus: failure instanceof CommandFailure ? failure.exitStatus : null, startupLog });
    fail(cleanup === 'FAILED' ? `Connectivity cleanup failed. Owned temporary files, including private keys, remain at ${root}.` : `Connectivity lab failed during ${stage}. Cleanup completed. ${failure instanceof LedgerError ? failure.message : 'Check the retained failure summary.'}`);
  }
  const versions = { node: process.version, pg: packageVersion('pg'), pgConnectionString: packageVersion('pg-connection-string'), openssl: opensslVersion };
  const run: ConnectivityRun = { schemaVersion: 1, scenario: 'tls-trust', runId, profile: 'local-lab', collectedAt,
    expiresAt: new Date(Date.parse(collectedAt) + 3600000).toISOString(), postgresVersion, clusterFingerprint, versions,
    environment: { namesPresent: WATCHED_ENV.filter(n => process.env[n] !== undefined) }, certificates: certificates!, keyFiles: keyFiles!,
    cleanup: 'COMPLETE', attempts, classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED' };
  // Retain unexpected measurements for investigation; only a passing contract gets a manifest and report.
  write(join(output, 'connectivity-run.json'), run);
  checkConnectivityRun(run);
  const manifest = connectivityManifest(run); write(join(output, 'connectivity-manifest.json'), manifest);
  writeFileSync(join(output, 'connectivity-report.md'), connectivityMarkdown(run), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(output, 'connectivity-report.html'), connectivityHtml(run), { flag: 'wx', mode: 0o600 });
  return { run, manifestHash: hash(manifest) };
}
