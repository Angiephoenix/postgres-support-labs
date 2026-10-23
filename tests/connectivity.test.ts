import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { X509Certificate } from 'node:crypto';
import { hash } from '../src/contracts.ts';
import { checkConnectivityRun, inspectConnectivity, connectivityManifest, connectivityMarkdown, connectivityHtml, verifiedSuccess, CONNECTIVITY_QUERIES, PHASE_LABELS } from '../src/connectivity-evidence.ts';
import { inspectConnectivityReview, formatConnectivityReview, connectivityReviewTemplate } from '../src/connectivity-review.ts';
import { validateConnectivity } from '../src/connectivity-validation.ts';
import { exportConnectivityBundle, verifyConnectivityBundle, CONNECTIVITY_TOOL_VERSION } from '../src/connectivity-bundle.ts';
import { versionLine, classifyStartupLog, checkLabCertificates, outerSignatureAlgorithm } from '../src/connectivity-lab.ts';
import { verifyAnyBundle } from '../src/bundle-dispatch.ts';
import { connectivityFixture, connectivityCase, acceptConnectivityCause, selectConnectivityRemedy } from './connectivity-fixture.ts';

const NOW = new Date('2026-10-04T12:30:00.000Z');
const temp = (t: any) => { const dir = mkdtempSync(join(tmpdir(), 'connectivity-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const reviewed = (t: any) => { const c = connectivityCase(t); acceptConnectivityCause(c.root, c.now); selectConnectivityRemedy(c.root, c.now); return c; };
const at = (run: any, phase: string) => run.attempts.find((a: any) => a.phase === phase);
const { parse } = createRequire(import.meta.url)('pg-connection-string');

test('the pinned connection-string parser handles # and @ differently; only percent-encoding is reliable', () => {
  const url = (pw: string) => `postgres://pslab_app:${pw}@db.pslab.test:5432/pslab_conn?sslmode=verify-full`;
  assert.throws(() => parse(url('Lab#0123456789abcdef')), (e: any) => e.code === 'ERR_INVALID_URL');
  assert.equal(parse(url('Lab@0123456789abcdef')).password, 'Lab@0123456789abcdef');
  assert.equal(parse(url('Lab@0123456789abcdef')).host, 'db.pslab.test');
  assert.throws(() => parse(url('Lab#0123456789abcdef@x')), (e: any) => e.code === 'ERR_INVALID_URL');
  assert.equal(parse(url(encodeURIComponent('Lab#0123456789abcdef@x'))).password, 'Lab#0123456789abcdef@x');
});

test('a connection string replaces an explicit ssl object, and explicit settings are not changed by PG environment variables', () => {
  const explicit = { ca: 'synthetic-ca', servername: 'db.pslab.test' };
  const viaString = new Client({ connectionString: 'postgres://u@db.pslab.test:5432/d?sslmode=require', ssl: explicit } as any);
  assert.notEqual((viaString as any).connectionParameters.ssl.servername, 'db.pslab.test');
  const old = { ...process.env };
  try {
    Object.assign(process.env, { PGSSLMODE: 'disable', PGHOST: 'elsewhere.invalid', PGSSLROOTCERT: '/nonexistent' });
    const direct = new Client({ host: '127.0.0.1', port: 5432, user: 'u', password: 'x', database: 'd', ssl: explicit });
    const cp = (direct as any).connectionParameters;
    assert.equal(cp.host, '127.0.0.1'); assert.equal(cp.ssl, explicit); assert.equal(cp.ssl.servername, 'db.pslab.test');
  } finally { for (const k of ['PGSSLMODE', 'PGHOST', 'PGSSLROOTCERT']) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
});

test('the fixture passes, and its reports describe stages, scope and inconclusive logs without retaining secrets', () => {
  const run = connectivityFixture(), checked = checkConnectivityRun(run, NOW);
  assert.equal(checked.evidenceStatus, 'MEASURED');
  const md = connectivityMarkdown(run, NOW);
  assert.match(md, /Supplying the issuing CA, with nothing else changed/);
  assert.match(md, /The certificate failures still reached the server/);
  assert.match(md, /both returned SQLSTATE 28P01\. Only the server log told them apart/);
  assert.match(md, /A 28000 refusal on its own does not show that escalation is needed/);
  assert.match(md, /# alone failed to parse \(ERR_INVALID_URL\); @ alone parsed and connected; # and @ together failed to parse \(ERR_INVALID_URL\); the same password percent-encoded parsed and connected/);
  assert.match(md, /no entries \(inconclusive\)/);
  assert.match(md, /sslmode=require turned certificate checks on, like verify-full, and the parser printed a warning saying so/);
  // The parser prints its warning once per process, so a run without it still passes and says less.
  const unwarned = connectivityFixture(); at(unwarned, 'require-driver-default').parse.warnings = [];
  assert.match(connectivityMarkdown(unwarned, NOW), /sslmode=require turned certificate checks on, like verify-full\. With uselibpqcompat/);
  const html = connectivityHtml(run, NOW);
  assert.match(html, /\.table-wrap\{container-type:inline-size\}\n@container \(max-width:600px\)\{/);
  for (const text of [md, html]) { assert.doesNotMatch(text, /postgres:\/\//); assert.doesNotMatch(text, /Lab[#@][0-9a-f]{16}/); }
  for (const label of Object.values(PHASE_LABELS)) assert.doesNotMatch(label, /slow|fast/i);
  // Without the supporting log entries the report says the logs were inconclusive instead of claiming more.
  const quiet = connectivityFixture(); for (const p of ['untrusted-ca', 'wrong-ca', 'hostname-mismatch']) at(quiet, p).serverLog = [];
  assert.match(connectivityMarkdown(quiet, NOW), /did not record every one of these connections, which is inconclusive on its own/);
});

test('the run contract rejects retained secrets, unverified successes, changed failures and inconsistent stages', () => {
  const cases: [(r: any) => void, RegExp][] = [
    [r => { at(r, 'untrusted-ca').serverLog = []; at(r, 'baseline-verified').tls.authorizationError = 'Lab#0123456789abcdef'; }, /retained/],
    [r => { at(r, 'baseline-verified').session.ssl = false; }, /baseline-verified is not a verified TLS success/],
    [r => { at(r, 'baseline-verified').tls.authorized = false; }, /TLS authorization result and its error disagree/],
    [r => { at(r, 'trusted-ca-fix').tls.hostnameCheck = 'failed'; }, /certificate checks on, but the certificate was not verified/],
    [r => { at(r, 'untrusted-ca').failure.code = 'ERR_TLS_CERT_ALTNAME_INVALID'; }, /untrusted-ca did not fail certificate-chain verification/],
    [r => { at(r, 'require-libpq-compat').effective.tls.rejectUnauthorized = true; }, /certificate checking differs|certificate checks on, but the certificate was not verified/],
    [r => { at(r, 'trusted-ca-fix').effective.tls.serverName = 'other.pslab.test'; }, /Effective TLS settings differ/],
    [r => { at(r, 'untrusted-ca').stages.queryOk = 'passed'; }, /stages are inconsistent/],
    [r => { at(r, 'baseline-verified').tls.peerFingerprint = 'AA'; }, /not the lab server certificate/],
    [r => { at(r, 'unknown-role').failure.sqlstate = '28000'; at(r, 'unknown-role').failure.code = '28000'; }, /unknown-role did not fail with 28P01/],
    [r => { at(r, 'require-driver-default').effective.tls.rejectUnauthorized = false; }, /certificate checking differs|did not turn certificate checks on/],
    [r => { Object.assign(at(r, 'no-tls').failure, { code: '28P01', sqlstate: '28P01' }); }, /no-TLS control was not refused/],
    [r => { at(r, 'tcp-refused').effective.destination = '10.0.0.1'; }, /somewhere other than the lab server/],
    [r => { at(r, 'trusted-ca-fix').session.role = 'pslab_hash'; }, /Session identity differs/],
    [r => { r.certificates.server.altNames = 'DNS:localhost'; }, /expected name/],
  ];
  for (const [change, message] of cases) { const run = connectivityFixture(); change(run); assert.throws(() => checkConnectivityRun(run, NOW), message, String(message)); }
});

test('the run contract rejects contradictory TLS evidence and server errors recorded at the wrong stage', () => {
  const cases: [string, (r: any) => void, RegExp][] = [
    // Reproduced by review: both were accepted before these checks existed.
    ['SQLSTATE on a certificate failure', r => { at(r, 'untrusted-ca').failure.sqlstate = '28P01'; }, /client-side failure carries a PostgreSQL SQLSTATE/],
    ['authorization error on a verified success', r => { at(r, 'trusted-ca-fix').tls.authorizationError = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'; }, /TLS authorization result and its error disagree/],
    ['SQLSTATE on a host-name failure', r => { at(r, 'hostname-mismatch').failure.sqlstate = '08006'; }, /client-side failure carries a PostgreSQL SQLSTATE/],
    ['SQLSTATE on a refused TCP connection', r => { at(r, 'tcp-refused').failure.sqlstate = '08001'; }, /client-side failure carries a PostgreSQL SQLSTATE/],
    ['unauthorized session without an error', r => { at(r, 'require-libpq-compat').tls.authorizationError = null; }, /TLS authorization result and its error disagree/],
    ['completed handshake with checks on but unverified', r => { Object.assign(at(r, 'wrong-password').tls, { authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }); }, /handshake completed with certificate checks on/],
    ['certificate failure with a non-TLS code', r => { at(r, 'wrong-ca').failure.code = 'ECONNRESET'; }, /certificate-verification failure has no TLS verification code/],
    ['server code differs from its SQLSTATE', r => { at(r, 'wrong-password').failure.code = 'ECONNRESET'; }, /error code differs from its SQLSTATE/],
    ['non-authentication SQLSTATE at authentication', r => { Object.assign(at(r, 'wrong-password').failure, { code: '3D000', sqlstate: '3D000' }); }, /authentication failure without an authentication SQLSTATE/],
    ['missing database recorded as an authentication failure', r => { const a = at(r, 'wrong-database'); a.failure.stage = 'authenticated'; a.stages.authenticated = 'failed'; a.stages.sessionReady = 'not-reached'; }, /authentication failure without an authentication SQLSTATE|authentication stage and the protocol events disagree/],
    ['authentication passed without AuthenticationOk', r => { const a = at(r, 'wrong-password'); a.stages.authenticated = 'passed'; a.stages.sessionReady = 'failed'; a.failure.stage = 'sessionReady'; }, /authentication stage and the protocol events disagree/],
    ['session ready without ReadyForQuery', r => { at(r, 'baseline-verified').protocol = at(r, 'baseline-verified').protocol.filter((e: string) => e !== 'readyForQuery'); }, /session-startup stage and the protocol events disagree/],
    ['server error without an ErrorResponse', r => { at(r, 'wrong-database').protocol = ['authenticationSASL', 'authenticationSASLContinue', 'authenticationSASLFinal', 'authenticationOk']; }, /server SQLSTATE without an ErrorResponse/],
    ['protocol messages after a client-side failure', r => { at(r, 'untrusted-ca').protocol = ['errorMessage']; }, /protocol messages after a client-side failure/],
  ];
  for (const [name, change, message] of cases) { const run = connectivityFixture(); change(run); assert.throws(() => checkConnectivityRun(run, NOW), message, name); }
});

test('a missing database is refused after the credentials are accepted, unlike a wrong password or unknown role', () => {
  const run = connectivityFixture(), db = at(run, 'wrong-database');
  assert.equal(db.stages.authenticated, 'passed'); assert.equal(db.stages.sessionReady, 'failed');
  assert.deepEqual(db.failure, { stage: 'sessionReady', code: '3D000', sqlstate: '3D000' });
  assert.ok(db.protocol.indexOf('authenticationOk') >= 0 && db.protocol.indexOf('authenticationOk') < db.protocol.indexOf('errorMessage'));
  for (const p of ['wrong-password', 'unknown-role']) {
    assert.equal(at(run, p).stages.authenticated, 'failed', p); assert.equal(at(run, p).stages.sessionReady, 'not-reached', p);
    assert.equal(at(run, p).protocol.includes('authenticationOk'), false, p);
  }
  const md = connectivityMarkdown(run, NOW);
  assert.match(md, /\| Control: database that does not exist \| Failed at session startup \(database and session\): SQLSTATE 3D000 \|/);
  assert.match(md, /\| Control: wrong password \| Failed at PostgreSQL authentication: SQLSTATE 28P01 \|/);
  assert.match(md, /The server accepted the credentials \(AuthenticationOk\) and then refused the missing database with 3D000/);
});

test('run inspection checks the attempt catalog and manifest anchor', t => {
  const c = connectivityCase(t), anchor = hash(connectivityManifest(c.run));
  assert.equal(inspectConnectivity(c.root, anchor, c.now).anchorChecked, true);
  assert.throws(() => inspectConnectivity(c.root, '0'.repeat(64), c.now), /anchor/);
  writeFileSync(join(c.root, 'connectivity-probes.json'), JSON.stringify({ ...CONNECTIVITY_QUERIES, session: 'SELECT 1' }));
  assert.throws(() => inspectConnectivity(c.root, undefined, c.now), /integrity/);
});

test('review keeps the failure, fix and controls apart, and validation needs verification as well as encryption', t => {
  const c = connectivityCase(t);
  let p = inspectConnectivityReview(c.root, c.now);
  assert.equal(p.status, 'READY_FOR_REVIEW'); assert.equal(p.reviewStatus, 'NOT_REVIEWED');
  assert.equal(p.alternatives.find(a => /not the one that issued/.test(a.explanation))!.status, 'REPRODUCED_BEHAVIOR');
  assert.match(formatConnectivityReview(p), /only the trusted CA changed/);
  assert.equal(validateConnectivity(c.root, c.now).status, 'VALIDATION_BLOCKED');
  assert.throws(() => connectivityReviewTemplate(c.root, 'remedy', c.now), /Accept the cause/);
  acceptConnectivityCause(c.root, c.now); selectConnectivityRemedy(c.root, c.now);
  const v = validateConnectivity(c.root, c.now);
  assert.equal(v.status, 'RESOLUTION_VALIDATED'); assert.ok(v.checks.every(x => x.passed));
  assert.deepEqual(v.verification, { certificateChecks: true, chainVerified: true, hostnameCheck: 'passed', serverName: 'db.pslab.test', peerFingerprint: c.run.certificates.server.fingerprint256 });
  // The encrypted but unverified control never counts as a verified success, and it is not remedy evidence.
  assert.equal(verifiedSuccess(at(c.run, 'require-libpq-compat')), false);
  p = inspectConnectivityReview(c.root, c.now);
  assert.deepEqual(p.remedies['trust-issuing-ca'].evidence.map(s => s.id), ['attempt-trusted-ca-fix']);
  assert.equal(validateConnectivity(c.root, c.expired).status, 'VALIDATION_BLOCKED');
  acceptConnectivityCause(c.root, c.now, 'reject');
  p = inspectConnectivityReview(c.root, c.now); assert.equal(p.reviewStatus, 'REJECTED'); assert.equal(p.remedySelection, null);
});

test('reviewed and gap-only bundles export, verify through the dispatcher, keep secrets out and reject edits', t => {
  const c = reviewed(t), dir = temp(t);
  const exported = exportConnectivityBundle(c.root, join(dir, 'bundle'), { now: c.now });
  assert.equal(exported.scenario, 'tls-trust'); assert.equal(exported.remedy, 'trust-issuing-ca');
  const verified = verifyAnyBundle(join(dir, 'bundle'), { expectedManifestHash: exported.manifestHash, now: c.now }) as any;
  assert.equal(verified.integrity, 'VALID'); assert.equal(verified.validationAtExport, 'RESOLUTION_VALIDATED');
  assert.equal(verifyConnectivityBundle(join(dir, 'bundle'), { now: c.expired }).currentEvidenceStatus, 'VALIDATION_BLOCKED');
  const reply = readFileSync(join(dir, 'bundle', 'customer-reply.md'), 'utf8');
  assert.match(reply, /DRAFT: human communication approval pending/); assert.match(reply, /Please do not turn certificate checks off/);
  const escalation = readFileSync(join(dir, 'bundle', 'engineering-escalation.md'), 'utf8');
  assert.match(escalation, /Escalation need has not been established/); assert.match(escalation, /A SQLSTATE 28000 refusal on its own is not enough/);
  const html = readFileSync(join(dir, 'bundle', 'support-bundle.html'), 'utf8');
  for (const id of ['attempt-untrusted-ca', 'attempt-trusted-ca-fix', 'attempt-require-libpq-compat']) assert.ok(html.includes(`id="${id}"`) && html.includes(`href="#${id}"`), id);
  for (const file of ['customer-reply.md', 'engineering-escalation.md', 'support-bundle.html', 'comparison.json']) {
    const text = readFileSync(join(dir, 'bundle', file), 'utf8');
    assert.doesNotMatch(text, /postgres:\/\/|Lab[#@][0-9a-f]{16}|PRIVATE KEY/, file);
  }
  writeFileSync(join(dir, 'bundle', 'customer-reply.md'), reply.replace('DRAFT', 'FINAL'));
  assert.throws(() => verifyAnyBundle(join(dir, 'bundle'), { now: c.now }));
  const gaps = exportConnectivityBundle(c.root, join(dir, 'gaps'), { mode: 'gaps', now: c.now });
  assert.equal((verifyAnyBundle(join(dir, 'gaps'), { expectedManifestHash: gaps.manifestHash, now: c.now }) as any).validationAtExport, 'WITHHELD_IN_GAP_REPORT');
  const unreviewed = connectivityCase(t);
  assert.throws(() => exportConnectivityBundle(unreviewed.root, join(dir, 'refused'), { now: unreviewed.now }), /Reviewed export requires/);
});

test('bundle2 and later drafts and report separate requested TLS from reached TLS, and the after-the-fact host-name check from enforced identity', t => {
  const c = reviewed(t), dir = temp(t);
  assert.equal(CONNECTIVITY_TOOL_VERSION, '0.1.0-connectivity-bundle4');
  exportConnectivityBundle(c.root, join(dir, 'bundle'), { now: c.now });
  const md = readFileSync(join(dir, 'bundle', 'engineering-escalation.md'), 'utf8'), html = readFileSync(join(dir, 'bundle', 'support-bundle.html'), 'utf8');
  const lineOf = (id: string) => md.split('\n').find(l => l.startsWith(`- ${id} (`))!;
  // A parsing failure asked for TLS; it just never got that far.
  for (const p of ['password-hash-unencoded', 'password-both-unencoded']) {
    assert.match(lineOf('attempt-' + p), /sslmode verify-full requested, TLS not reached \(failed at connection-string parsing\)/, p);
    assert.doesNotMatch(lineOf('attempt-' + p), /TLS not requested/, p);
  }
  assert.match(lineOf('attempt-no-tls'), /TLS not requested \(sslmode disable\)/);
  assert.match(lineOf('attempt-tcp-refused'), /certificate checks on, CA issuing-ca, TLS name db\.pslab\.test; TLS not reached \(failed at TCP connection\)/);
  // With checks off, the host-name result is the lab's own check afterwards, not part of the connection.
  assert.match(lineOf('attempt-require-libpq-compat'), /chain not verified; host name matched in a check the lab ran afterwards, not enforced on this connection/);
  assert.doesNotMatch(lineOf('attempt-require-libpq-compat'), /host name passed/);
  assert.match(lineOf('attempt-trusted-ca-fix'), /chain and host name verified during the TLS handshake/);
  const row = (label: string) => html.split('<tr role="row">').find(r => r.includes(`>${label}</th>`))!;
  assert.match(row('Password with # left unencoded'), /verify-full requested; TLS not reached/);
  assert.match(row('Control: TLS turned off'), /TLS not requested \(sslmode disable\)/);
  assert.match(row('Control: port with nothing listening'), /on, CA issuing-ca; TLS not reached/);
  assert.doesNotMatch(html.replace(/<pre>[\s\S]*?<\/pre>/g, ''), /host name passed/);
  // Layout found in the rendering check: tables stack when their own container is narrow, cells don't split ordinary
  // words, and in print a row or a draft title stays with its content.
  assert.match(html, /\.table-wrap\{container-type:inline-size\}\n@container \(max-width:760px\)\{/);
  assert.match(html, /\.table-wrap th,\.table-wrap td\{overflow-wrap:break-word\}/);
  assert.match(html, /@media print\{\.results tr,details>summary\{break-inside:avoid\}\.results thead,details>summary\{break-after:avoid\}\}/);
  assert.doesNotMatch(html, /@media\(max-width:480px\)/);
});

test('existing bundle1 to bundle3 exports still render and verify byte for byte, and new exports use bundle4', t => {
  const c = reviewed(t), dir = temp(t);
  // Manifest hashes of this fixture's bundle1 exports, recorded from the code before bundle2 existed.
  const v1 = exportConnectivityBundle(c.root, join(dir, 'v1'), { now: c.now, toolVersion: '0.1.0-connectivity-bundle1' });
  const g1 = exportConnectivityBundle(c.root, join(dir, 'g1'), { mode: 'gaps', now: c.now, toolVersion: '0.1.0-connectivity-bundle1' });
  assert.equal(v1.manifestHash, '20a3e0d6e53c998dc43b042907e99a18d1da00fcc35b88f5bc153bbdc9674a2e');
  assert.equal(g1.manifestHash, 'c2d58860b5a2c599fed5c0964363728c59a4a33f0a8cec98cf98411a130e4fa9');
  for (const [d, h] of [['v1', v1.manifestHash], ['g1', g1.manifestHash]]) assert.equal((verifyAnyBundle(join(dir, d), { expectedManifestHash: h, now: c.now }) as any).integrity, 'VALID');
  const html1 = readFileSync(join(dir, 'v1', 'support-bundle.html'), 'utf8');
  assert.match(html1, /@media\(max-width:480px\)/); assert.doesNotMatch(html1, /container-type|break-inside:avoid/);
  assert.match(readFileSync(join(dir, 'v1', 'engineering-escalation.md'), 'utf8'), /attempt-password-hash-unencoded \(Password with # left unencoded\): Failed at connection-string parsing: ERR_INVALID_URL; TLS not requested/);
  // Manifest hashes of this fixture's bundle2 exports, recorded from the code before bundle3 existed.
  const v2 = exportConnectivityBundle(c.root, join(dir, 'v2'), { now: c.now, toolVersion: '0.1.0-connectivity-bundle2' });
  const g2 = exportConnectivityBundle(c.root, join(dir, 'g2'), { mode: 'gaps', now: c.now, toolVersion: '0.1.0-connectivity-bundle2' });
  assert.equal(v2.manifestHash, 'bfd8bb8da4d14afffc1de6ecce82d945c5dfe303c85d92edced180d90e49c074');
  assert.equal(g2.manifestHash, '98d03f5bd6ffdadb6226e39b7e8e60c2e1739783b0ac17be9d36ee0f9cabe97f');
  for (const [d, h] of [['v2', v2.manifestHash], ['g2', g2.manifestHash]]) assert.equal((verifyAnyBundle(join(dir, d), { expectedManifestHash: h, now: c.now }) as any).integrity, 'VALID');
  // Manifest hashes of this fixture's bundle3 exports, recorded from the code before bundle4 existed.
  const v3 = exportConnectivityBundle(c.root, join(dir, 'v3'), { now: c.now, toolVersion: '0.1.0-connectivity-bundle3' });
  const g3 = exportConnectivityBundle(c.root, join(dir, 'g3'), { mode: 'gaps', now: c.now, toolVersion: '0.1.0-connectivity-bundle3' });
  assert.equal(v3.manifestHash, '212e06448bf97432b2c2240a51f8a09140732704f2a9c565bdade20bccce39c0');
  assert.equal(g3.manifestHash, '21d61465b8516194f35233068a6863bff0c016fc5fe6d9da2f25b9de146cee8b');
  for (const [d, h] of [['v3', v3.manifestHash], ['g3', g3.manifestHash]]) assert.equal((verifyAnyBundle(join(dir, d), { expectedManifestHash: h, now: c.now }) as any).integrity, 'VALID');
  assert.doesNotMatch(readFileSync(join(dir, 'v3', 'support-bundle.html'), 'utf8'), /Print revision|print-records/);
  const v4 = exportConnectivityBundle(c.root, join(dir, 'v4'), { now: c.now });
  assert.equal(JSON.parse(readFileSync(join(dir, 'v4', 'manifest.json'), 'utf8')).toolVersion, '0.1.0-connectivity-bundle4');
  assert.equal((verifyAnyBundle(join(dir, 'v4'), { expectedManifestHash: v4.manifestHash, now: c.now }) as any).integrity, 'VALID');
  assert.equal(readFileSync(join(dir, 'v3', 'comparison.json'), 'utf8'), readFileSync(join(dir, 'v4', 'comparison.json'), 'utf8'));
  assert.equal(readFileSync(join(dir, 'v2', 'comparison.json'), 'utf8'), readFileSync(join(dir, 'v3', 'comparison.json'), 'utf8'));
  // The decision records are bound to the comparison, which neither renderer changes.
  assert.equal(readFileSync(join(dir, 'v1', 'comparison.json'), 'utf8'), readFileSync(join(dir, 'v2', 'comparison.json'), 'utf8'));
  assert.throws(() => exportConnectivityBundle(c.root, join(dir, 'bad'), { now: c.now, toolVersion: '0.1.0-connectivity-bundle9' as any }), /tool version/);
});

test('bundle3 gap-only exports say no remedy is validated and present the cause as a proposal, even for an accepted run', t => {
  const dir = temp(t), accepted = reviewed(t), unreviewed = connectivityCase(t);
  const read = (d: string, f: string) => readFileSync(join(dir, d, f), 'utf8');
  const withoutPre = (html: string) => html.replace(/<pre>[\s\S]*?<\/pre>/g, '');
  const finding = (html: string) => html.slice(html.indexOf('id="finding"'), html.indexOf('id="comparison"'));
  const remedySection = (html: string) => html.slice(html.indexOf('id="remedy"'), html.indexOf('id="alternatives"'));
  for (const [name, c] of [['accepted', accepted], ['unreviewed', unreviewed]] as const) {
    const g = exportConnectivityBundle(c.root, join(dir, name), { mode: 'gaps', now: c.now });
    assert.equal((verifyAnyBundle(join(dir, name), { expectedManifestHash: g.manifestHash, now: c.now }) as any).validationAtExport, 'WITHHELD_IN_GAP_REPORT', name);
    const html = read(name, 'support-bundle.html'), md = read(name, 'resolution-validation.md');
    assert.match(finding(html), /UNVERIFIED_HYPOTHESIS<\/span><p>Proposed explanation, awaiting review: The client checked the server certificate/, name);
    assert.match(finding(html), /No remedy is validated in this gap-only export\./, name);
    assert.match(remedySection(html), /No remedy is validated in this gap-only export\. Validation checks and their results are withheld\./, name);
    assert.doesNotMatch(remedySection(html), /<li><strong>(Passed|Pending):/, name);
    assert.match(md, /^Status at export: WITHHELD_IN_GAP_REPORT$/m, name);
    assert.match(md, /No remedy is validated in this gap-only export\. Validation checks and their results are withheld\./, name);
    assert.match(read(name, 'engineering-escalation.md'), /^Validation: withheld in this gap-only export$/m, name);
    const vj = JSON.parse(read(name, 'validation.json'));
    assert.equal(vj.status, 'WITHHELD_IN_GAP_REPORT', name); assert.equal(vj.limitation, 'No remedy is validated in this gap-only export. Validation checks and their results are withheld.', name);
    for (const key of ['checks', 'basis', 'verification', 'remedy', 'remedySelectionHash', 'causeReviewHash']) assert.ok(!(key in vj), `${name} validation.json ${key}`);
    const boundary = 'No remedy is validated in this gap-only export. The recorded experiment covers trusting the issuing CA for this lab server only. Customer resolution needs evidence from the customer’s environment after an approved change.';
    const runbook = read(name, 'runbook-candidate.md'), embedded = html.slice(html.indexOf('id="document-runbook-candidate"'), html.indexOf('</details>', html.indexOf('id="document-runbook-candidate"')));
    assert.ok(runbook.includes('## Validation boundary\n\n' + boundary + '\n'), `${name} runbook-candidate.md`);
    assert.ok(embedded.length > 0 && embedded.includes(boundary), `${name} runbook in support-bundle.html`);
    for (const [where, text] of [['runbook-candidate.md', runbook], ['embedded runbook', embedded]] as const) assert.doesNotMatch(text, /validates only trusting/, `${name} ${where}`);
    for (const [file, text] of [['support-bundle.html', withoutPre(html)], ['resolution-validation.md', md]] as const) {
      assert.doesNotMatch(text, /Validates trusting/, `${name} ${file}`); assert.doesNotMatch(text, /PASS:|Passed:/, `${name} ${file}`);
    }
  }
  // Reviewed bundle3 exports keep the validated wording, and the reproduction note is scoped to the tested LibreSSL setup.
  exportConnectivityBundle(accepted.root, join(dir, 'reviewed'), { now: accepted.now });
  const md = read('reviewed', 'resolution-validation.md');
  assert.match(md, /Validates trusting the issuing CA for this lab server/); assert.match(md, /^- PASS: chain-and-hostname-verified-after-fix;/m);
  assert.match(read('reviewed', 'runbook-candidate.md'), /This source bundle validates only trusting the issuing CA for its lab server in the local experiment when the review and freshness gates pass\./);
  assert.doesNotMatch(read('reviewed', 'runbook-candidate.md'), /No remedy is validated/);
  assert.match(finding(read('reviewed', 'support-bundle.html')), /SUPPORTED_CAUSE · local-lab<\/span><p>The client checked/);
  const repro = read('reviewed', 'reproduction.md');
  assert.match(repro, /Tested with OpenSSL 3, and on macOS 12\.7\.6 with LibreSSL 2\.8\.3 as \/usr\/bin\/openssl\. Other LibreSSL versions have not been verified\./);
  assert.doesNotMatch(repro, /has not been verified yet/);
  // bundle2 keeps its original wording, including in gap-only exports.
  exportConnectivityBundle(accepted.root, join(dir, 'g2'), { mode: 'gaps', now: accepted.now, toolVersion: '0.1.0-connectivity-bundle2' });
  assert.ok(Array.isArray(JSON.parse(read('g2', 'validation.json')).checks));
  assert.match(read('g2', 'runbook-candidate.md'), /This source bundle validates only trusting the issuing CA/);
  assert.match(read('g2', 'resolution-validation.md'), /Validates trusting/); assert.match(read('g2', 'reproduction.md'), /macOS with LibreSSL has not been verified yet\./);
});

test('the openssl version line is kept complete, bounded and free of control characters', t => {
  const mac = 'OpenSSL 3.6.4 25 Aug 2026 (Library: OpenSSL 3.6.4 25 Aug 2026)';
  assert.ok(mac.length > 60);
  assert.equal(versionLine(mac + '\n'), mac);
  assert.equal(versionLine('LibreSSL 2.8.3\n'), 'LibreSSL 2.8.3');
  assert.equal(versionLine('\n  OpenSSL 3.0.13 30 Jan 2024 \nsecond line'), 'OpenSSL 3.0.13 30 Jan 2024');
  const long = versionLine('OpenSSL ' + 'x'.repeat(400));
  assert.equal(long.length, 200); assert.match(long, / \[truncated\]$/);
  assert.throws(() => versionLine('\n \n'), /version/);
  assert.equal(versionLine('OpenSSL 3\u0007 bell'), 'OpenSSL 3 bell');
  // The run contract accepts the complete line, the reports show it whole, and over-long values are rejected.
  const run = connectivityFixture(); run.versions.openssl = mac;
  checkConnectivityRun(run, NOW);
  const c = connectivityCase(t, r => { r.versions.openssl = mac; }); acceptConnectivityCause(c.root, c.now); selectConnectivityRemedy(c.root, c.now);
  const dir = temp(t); exportConnectivityBundle(c.root, join(dir, 'b'), { now: c.now });
  assert.ok(readFileSync(join(dir, 'b', 'engineering-escalation.md'), 'utf8').includes(mac + '.'));
  const tooLong = connectivityFixture(); tooLong.versions.openssl = 'x'.repeat(201);
  assert.throws(() => checkConnectivityRun(tooLong, NOW));
});

test('a failed server start is reported by fixed log categories only, never raw lines or paths', () => {
  const log = [
    '2026-10-11 22:00:00 UTC [1] FATAL:  could not load server certificate file "/tmp/pslab-conn-AbC/tls/server.crt": ca md too weak',
    '2026-10-11 22:00:00 UTC [1] LOG:  database system is shut down'].join('\n');
  assert.deepEqual(classifyStartupLog(log), ['server-certificate-signature-too-weak']);
  assert.deepEqual(classifyStartupLog('FATAL:  could not load private key file "/tmp/x/server.key": bad decrypt'), ['private-key-load-failed']);
  assert.deepEqual(classifyStartupLog('FATAL:  private key file "/tmp/x/server.key" has group or world access'), ['private-key-permissions']);
  assert.deepEqual(classifyStartupLog('FATAL:  could not load server certificate file "/x": ee key too small'), ['server-key-too-small']);
  assert.deepEqual(classifyStartupLog('LOG:  could not bind IPv4 address "127.0.0.1": Address already in use\nFATAL:  could not create any TCP/IP sockets'), ['address-in-use', 'other-fatal']);
  // Only an explicit "Address already in use" counts as an occupied address; other bind failures stay neutral.
  assert.deepEqual(classifyStartupLog('LOG:  could not bind IPv4 address "127.0.0.1": Permission denied\nFATAL:  could not create any TCP/IP sockets'), ['bind-failed', 'other-fatal']);
  assert.deepEqual(classifyStartupLog('LOG:  could not bind IPv4 address "127.0.0.1": Cannot assign requested address\nFATAL:  could not create any TCP/IP sockets'), ['bind-failed', 'other-fatal']);
  assert.deepEqual(classifyStartupLog('FATAL:  something unexpected at /tmp/pslab-conn-AbC'), ['other-fatal']);
  assert.deepEqual(classifyStartupLog(''), []);
  assert.doesNotMatch(JSON.stringify(classifyStartupLog(log)), /tmp|server\.crt/);
});

test('generated certificates must be SHA-256 signed, with a CA-marked issuer and a server certificate it issued for db.pslab.test', t => {
  if (spawnSync('openssl', ['version']).status !== 0) { t.skip('openssl is required to make test certificates.'); return; }
  const dir = temp(t), sh = (...args: string[]) => assert.equal(spawnSync('openssl', args, { cwd: dir }).status, 0, args.join(' '));
  writeFileSync(join(dir, 'ca.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[noca]\nsubjectKeyIdentifier=hash\n');
  writeFileSync(join(dir, 'server.ext'), 'subjectAltName=DNS:db.pslab.test\n');
  const ca = (name: string, digest: string, section: string) => sh('req', '-config', 'ca.cnf', '-extensions', section, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', '1', '-subj', `/CN=${name}`, '-' + digest);
  const server = (name: string, issuer: string, digest: string) => { sh('req', '-config', 'ca.cnf', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', '/CN=db.pslab.test', '-sha256');
    sh('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.crt`, '-CAkey', `${issuer}.key`, '-set_serial', '2', '-out', `${name}.crt`, '-days', '1', '-extfile', 'server.ext', '-' + digest); };
  ca('good-ca', 'sha256', 'ca'); ca('other-ca', 'sha256', 'ca'); ca('sha1-ca', 'sha1', 'ca'); ca('plain-ca', 'sha256', 'noca');
  server('good', 'good-ca', 'sha256'); server('weak', 'good-ca', 'sha1'); server('by-plain', 'plain-ca', 'sha256');
  const pem = (n: string) => readFileSync(join(dir, n + '.crt'));
  // The algorithm is read from the outer signatureAlgorithm only: bytes inside the signature value that look like the
  // SHA-256 identifier must not change the result.
  const der = new X509Certificate(pem('weak')).raw, sha256Oid = Buffer.from('06092a864886f70d01010b0500', 'hex');
  assert.equal(outerSignatureAlgorithm(der), 'sha1WithRSAEncryption');
  const planted = Buffer.from(der); sha256Oid.copy(planted, planted.length - sha256Oid.length);
  assert.equal(new X509Certificate(planted).raw.subarray(-sha256Oid.length).toString('hex'), sha256Oid.toString('hex'));
  assert.equal(outerSignatureAlgorithm(planted), 'sha1WithRSAEncryption');
  assert.equal(outerSignatureAlgorithm(new X509Certificate(pem('good')).raw), 'sha256WithRSAEncryption');
  assert.throws(() => outerSignatureAlgorithm(Buffer.from('3003020101', 'hex')), /certificate check: certificate encoding is truncated/);
  assert.equal(outerSignatureAlgorithm(Buffer.from('300a3003020101300306012a', 'hex')), 'unknown');
  const facts = checkLabCertificates({ issuingCa: pem('good-ca'), server: pem('good'), untrustedCa: pem('other-ca') });
  assert.deepEqual(facts.server, { signatureAlgorithm: 'sha256WithRSAEncryption', ca: false, issuedByIssuingCa: true, hostMatches: true });
  assert.equal(facts.issuingCa.ca, true);
  assert.throws(() => checkLabCertificates({ issuingCa: pem('good-ca'), server: pem('weak'), untrustedCa: pem('other-ca') }), /certificate check: server certificate is signed with sha1WithRSAEncryption; SHA-256 is required/);
  assert.throws(() => checkLabCertificates({ issuingCa: pem('sha1-ca'), server: pem('good'), untrustedCa: pem('other-ca') }), /certificate check: issuing CA is signed with sha1WithRSAEncryption/);
  assert.throws(() => checkLabCertificates({ issuingCa: pem('plain-ca'), server: pem('by-plain'), untrustedCa: pem('other-ca') }), /certificate check: issuing CA is not marked as a CA/);
  assert.throws(() => checkLabCertificates({ issuingCa: pem('other-ca'), server: pem('good'), untrustedCa: pem('good-ca') }), /certificate check: server certificate was not issued by the issuing CA/);
});

test('connectivity CLI commands follow the same usage and dry-run rules as the other labs', t => {
  const c = connectivityCase(t), cli = resolve('src/cli.ts');
  const dry = spawnSync(process.execPath, [cli, 'connectivity', 'export', c.root, join(c.root, 'out'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0); assert.deepEqual(JSON.parse(dry.stdout), { operation: 'connectivity export', network: false, database: false, writes: false, wouldWrite: true, readsInput: false });
  const bad = spawnSync(process.execPath, [cli, 'connectivity', 'review-template', c.root, 'other'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Usage: connectivity compare/);
});
