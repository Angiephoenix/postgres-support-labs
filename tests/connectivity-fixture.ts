import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hash } from '../src/contracts.ts';
import { CONNECTIVITY_PHASES, CONNECTIVITY_QUERIES as Q, PHASE_SPECS, STAGES, DESTINATION, SERVER_NAME, phaseShape, connectivityManifest } from '../src/connectivity-evidence.ts';
import type { ConnectivityRun, Attempt, ConnectivityPhase, Stage, ProtocolEvent } from '../src/connectivity-evidence.ts';
import { connectivityPlan } from '../src/connectivity-lab.ts';
import { connectivityReviewTemplate, appendConnectivityReview } from '../src/connectivity-review.ts';

// Contract-test fixture only. No database or TLS connection produced these attempts. The outcomes copy the
// shape of a measured run; fingerprints and times are synthetic, and decisions use clearly labelled test reviewers.
// The protocol sequences copy those recorded in a real run on PostgreSQL 16.13 with pg 8.23.0.
const FP = (n: string) => Array.from({ length: 32 }, () => n).join(':');
const SERVER_FP = FP('AB');
const cert = (subject: string, altNames: string|null, fp: string) => ({ subject, issuer: 'CN=pslab-issuing-ca', altNames, fingerprint256: fp, validFrom: '2026-10-04T11:59:00.000Z', validTo: '2026-10-05T11:59:00.000Z' });
type Outcome = { reached: Stage[]; fail?: { stage: Stage; code: string|null; sqlstate: string|null }; verify?: boolean; parseError?: string; warnings?: string[]; log: string[]; protocol?: ProtocolEvent[] };
const tlsVerified: Stage[] = ['parsed', 'tcpConnected', 'serverAcceptedTls', 'tlsVerified'];
const SCRAM: ProtocolEvent[] = ['authenticationSASL', 'authenticationSASLContinue'];
const READY: ProtocolEvent[] = [...SCRAM, 'authenticationSASLFinal', 'authenticationOk', 'backendKeyData', 'readyForQuery'];
const OUTCOMES: Record<ConnectivityPhase, Outcome> = {
  'baseline-verified': { reached: [...STAGES], log: ['connection-received', 'connection-authorized'] },
  'untrusted-ca': { reached: ['parsed', 'tcpConnected', 'serverAcceptedTls'], fail: { stage: 'tlsVerified', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', sqlstate: null }, log: ['connection-received', 'tls-error-logged'] },
  'trusted-ca-fix': { reached: [...STAGES], log: ['connection-received', 'connection-authorized'] },
  'wrong-ca': { reached: ['parsed', 'tcpConnected', 'serverAcceptedTls'], fail: { stage: 'tlsVerified', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', sqlstate: null }, log: ['connection-received', 'tls-error-logged'] },
  'hostname-mismatch': { reached: ['parsed', 'tcpConnected', 'serverAcceptedTls'], fail: { stage: 'tlsVerified', code: 'ERR_TLS_CERT_ALTNAME_INVALID', sqlstate: null }, log: ['connection-received', 'tls-error-logged'] },
  'require-driver-default': { reached: ['parsed', 'tcpConnected', 'serverAcceptedTls'], fail: { stage: 'tlsVerified', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', sqlstate: null }, warnings: ['sslmode-treated-as-verify-full'], log: ['connection-received', 'tls-error-logged'] },
  'require-libpq-compat': { reached: ['parsed', 'tcpConnected', 'serverAcceptedTls', 'authenticated', 'sessionReady', 'queryOk'], verify: false, log: ['connection-received', 'connection-authorized'] },
  'no-tls': { reached: ['parsed', 'tcpConnected'], fail: { stage: 'authenticated', code: '28000', sqlstate: '28000' }, log: ['connection-received', 'rejected-without-encryption'], protocol: ['errorMessage'] },
  'wrong-password': { reached: tlsVerified, fail: { stage: 'authenticated', code: '28P01', sqlstate: '28P01' }, log: ['connection-received', 'password-authentication-failed'], protocol: [...SCRAM, 'errorMessage'] },
  'unknown-role': { reached: tlsVerified, fail: { stage: 'authenticated', code: '28P01', sqlstate: '28P01' }, log: ['connection-received', 'password-authentication-failed', 'role-does-not-exist'], protocol: [...SCRAM, 'errorMessage'] },
  'wrong-database': { reached: [...tlsVerified, 'authenticated'], fail: { stage: 'sessionReady', code: '3D000', sqlstate: '3D000' }, log: ['connection-received', 'connection-authorized', 'database-does-not-exist'],
    protocol: [...SCRAM, 'authenticationSASLFinal', 'authenticationOk', 'errorMessage'] },
  'password-hash-unencoded': { reached: [], parseError: 'ERR_INVALID_URL', fail: { stage: 'parsed', code: 'ERR_INVALID_URL', sqlstate: null }, log: [] },
  'password-at-unencoded': { reached: [...STAGES], log: ['connection-received', 'connection-authorized'] },
  'password-both-unencoded': { reached: [], parseError: 'ERR_INVALID_URL', fail: { stage: 'parsed', code: 'ERR_INVALID_URL', sqlstate: null }, log: [] },
  'password-both-encoded': { reached: [...STAGES], log: ['connection-received', 'connection-authorized'] },
  'tcp-refused': { reached: ['parsed'], fail: { stage: 'tcpConnected', code: 'ECONNREFUSED', sqlstate: null }, log: [] },
};

export function connectivityAttempt(phase: ConnectivityPhase, runId: string, collectedAt: string): Attempt {
  const spec = PHASE_SPECS[phase], o = OUTCOMES[phase], tlsOn = spec.sslmode !== 'disable', verifying = tlsOn && !spec.libpqCompat;
  const applies: Record<Stage, boolean> = { parsed: true, tcpConnected: true, serverAcceptedTls: tlsOn, tlsVerified: verifying, authenticated: true, sessionReady: true, queryOk: true };
  const stages = Object.fromEntries(STAGES.map(st => [st, !applies[st] ? 'not-requested' : o.reached.includes(st) ? 'passed' : o.fail?.stage === st ? 'failed' : 'not-reached'])) as Attempt['stages'];
  const parsedOk = !o.parseError, attempted = parsedOk;
  const handshake = o.reached.includes('tlsVerified') || (tlsOn && !verifying && o.reached.includes('serverAcceptedTls'));
  return structuredClone({ phase, runId, collectedAt, shape: phaseShape(phase),
    parse: { ok: parsedOk, errorCode: o.parseError ?? null, matches: parsedOk ? { user: true, password: true, host: true, port: true, database: true } : null, warnings: o.warnings ?? [] },
    effective: { attempted, destination: attempted ? DESTINATION : null, port: attempted ? spec.port : null,
      tls: attempted && tlsOn ? { rejectUnauthorized: !spec.libpqCompat, serverName: spec.serverName, caSource: spec.rootcert ?? 'default-trust-store', customIdentityCheck: false } : null },
    stages, failure: o.fail ?? null, protocol: o.protocol ?? (o.reached.includes('sessionReady') ? READY : []),
    tls: handshake ? { authorized: verifying, authorizationError: verifying ? null : 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', serverName: spec.serverName, peerFingerprint: SERVER_FP, peerAltNames: `DNS:${SERVER_NAME}`, hostnameCheck: 'passed', protocol: 'TLSv1.3' } : null,
    session: o.reached.includes('queryOk') ? { role: spec.role, database: spec.database, ssl: tlsOn, tlsVersion: 'TLSv1.3' } : null,
    serverLog: o.log }) as Attempt;
}

export function connectivityFixture(): ConnectivityRun {
  const runId = '33333333-3333-4333-8333-333333333333', collectedAt = '2026-10-04T12:00:00.000Z';
  return { schemaVersion: 1, scenario: 'tls-trust', runId, profile: 'local-lab', collectedAt, expiresAt: '2026-10-04T13:00:00.000Z',
    postgresVersion: '16.13', clusterFingerprint: hash('synthetic-test-cluster'),
    versions: { node: 'v24.21.0', pg: '8.23.0', pgConnectionString: '2.14.0', openssl: 'OpenSSL 3.0.13 30 Jan 2024' },
    environment: { namesPresent: [] },
    certificates: { issuingCa: cert('CN=pslab-issuing-ca', null, FP('11')), server: cert(`CN=${SERVER_NAME}`, `DNS:${SERVER_NAME}`, SERVER_FP), untrustedCa: { ...cert('CN=pslab-untrusted-ca', null, FP('22')), issuer: 'CN=pslab-untrusted-ca' } },
    keyFiles: { mode: '0600', directoryMode: '0700' }, cleanup: 'COMPLETE', classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED',
    attempts: CONNECTIVITY_PHASES.map((p, i) => connectivityAttempt(p, runId, `2026-10-04T12:00:${String(i).padStart(2, '0')}.000Z`)) };
}

export function connectivityCase(t: any, change?: (run: ConnectivityRun) => void) {
  const root = mkdtempSync(join(tmpdir(), 'connectivity-case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = connectivityFixture(); change?.(run);
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), canonical(value) + '\n');
  write('connectivity-run.json', run); write('connectivity-manifest.json', connectivityManifest(run));
  write('connectivity-probes.json', Q); write('connectivity-plan.json', { ...connectivityPlan(), runId: run.runId, approved: true });
  return { root, run, now: new Date('2026-10-04T12:30:00.000Z'), expired: new Date('2026-10-04T13:00:00.000Z') };
}
export const TEST_REVIEWER = 'automated-test-reviewer';
export function acceptConnectivityCause(root: string, now: Date, decision = 'accept') {
  return appendConnectivityReview(root, { ...connectivityReviewTemplate(root, 'cause', now), reviewer: TEST_REVIEWER, decision,
    rationale: 'Synthetic test decision recorded by the automated suite.' }, now);
}
export function selectConnectivityRemedy(root: string, now: Date) {
  return appendConnectivityReview(root, { ...connectivityReviewTemplate(root, 'remedy', now), reviewer: TEST_REVIEWER, remedy: 'trust-issuing-ca',
    rationale: 'Synthetic test remedy selection recorded by the automated suite.' }, now);
}
