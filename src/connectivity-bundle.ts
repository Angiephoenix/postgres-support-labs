import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, fail, validateArtifact } from './contracts.ts';
import { readJson } from './ledger.ts';
import { CONNECTIVITY_QUERIES } from './connectivity-evidence.ts';
import type { ConnectivityRun } from './connectivity-evidence.ts';
import { inspectConnectivityReview, connectivityEvidenceId, describeAttempt, CONNECTIVITY_REMEDY_TEXT } from './connectivity-review.ts';
import type { ConnectivityStep } from './connectivity-review.ts';
import { validateConnectivity } from './connectivity-validation.ts';
import { connectivityBundleHtml } from './connectivity-bundle-view.ts';
import { json, checkMode, readSources, writeSources, writeExport, manifestFiles, checkIntegrity, checkOutputs, bundlePaths } from './bundle-core.ts';
import type { BundleLayout, Mode } from './bundle-core.ts';
import manifestSchema from '../schemas/connectivity-export-manifest.v1.json' with { type: 'json' };

// Each version's rendered text is frozen so earlier bundles keep verifying. New exports use the latest version.
// bundle2 separates requested from reached TLS and labels the after-the-fact host-name check. bundle3 keeps that, says in
// gap-only exports that no remedy is validated, and scopes the LibreSSL note to the tested setup. The comparison is unchanged.
// Bundle4 keeps wording 3 and adds print revision 1 to the report; earlier bytes are unchanged.
export const CONNECTIVITY_TOOL_VERSIONS = ['0.1.0-connectivity-bundle1', '0.1.0-connectivity-bundle2', '0.1.0-connectivity-bundle3', '0.1.0-connectivity-bundle4'] as const;
export type ConnectivityToolVersion = typeof CONNECTIVITY_TOOL_VERSIONS[number];
export const CONNECTIVITY_TOOL_VERSION: ConnectivityToolVersion = '0.1.0-connectivity-bundle4';
const wordingOf = (version: ConnectivityToolVersion) => version === '0.1.0-connectivity-bundle1' ? 1 : version === '0.1.0-connectivity-bundle2' ? 2 : 3;
export const GAP_NO_REMEDY = 'No remedy is validated in this gap-only export.';
export const GAP_CHECKS_WITHHELD = `${GAP_NO_REMEDY} Validation checks and their results are withheld.`;
export const GAP_RUNBOOK_BOUNDARY = `${GAP_NO_REMEDY} The recorded experiment covers trusting the issuing CA for this lab server only. Customer resolution needs evidence from the customer’s environment after an approved change.`;
export const CONNECTIVITY_SOURCE_PATHS = ['connectivity-run.json','connectivity-probes.json','connectivity-plan.json','connectivity-manifest.json','connectivity-reviews.jsonl'];
export const CONNECTIVITY_OUTPUT_PATHS = ['case-summary.md','evidence-gap-report.md','probe-plan.json','evidence.jsonl','timeline.json','reproduction.md',
  'comparison.json','hypotheses.json','findings.json','validation.json','resolution-validation.md','customer-reply.md','engineering-escalation.md',
  'runbook-candidate.md','support-bundle.html'];
export const CONNECTIVITY_BUNDLE_PATHS = bundlePaths({ sourcePaths: CONNECTIVITY_SOURCE_PATHS, outputPaths: CONNECTIVITY_OUTPUT_PATHS } as BundleLayout);
type Binding = { expectedComparisonHash?: string; expectedReviewHead?: string };
const LAYOUT: BundleLayout = { sourcePaths: CONNECTIVITY_SOURCE_PATHS, outputPaths: CONNECTIVITY_OUTPUT_PATHS, sourceFolders: [],
  reviewPath: 'connectivity-reviews.jsonl', writeEmptyReview: false, probePath: 'connectivity-probes.json', probeCatalog: () => CONNECTIVITY_QUERIES };

function buildFiles(source: string, mode: Mode, now: Date, version: ConnectivityToolVersion = CONNECTIVITY_TOOL_VERSION) {
  checkMode(mode);
  if (!CONNECTIVITY_TOOL_VERSIONS.includes(version)) fail('Unsupported connectivity bundle tool version.');
  const wording = wordingOf(version);
  const inspected = inspectConnectivityReview(source, now), validation = validateConnectivity(source, now);
  if (mode === 'reviewed' && validation.status !== 'RESOLUTION_VALIDATED') fail('Reviewed export requires fresh evidence, an accepted local cause and a selected remedy. Use --gaps-only for an incomplete report.');
  const accepted = mode === 'reviewed';
  const review = accepted ? inspected : { ...inspected, cause: null, remedySelection: null };
  const run = readJson(join(source, 'connectivity-run.json')) as ConnectivityRun, generatedAt = now.toISOString();
  const remedy = accepted ? inspected.remedySelection!.remedy : null;
  const timeline = [{ at: run.collectedAt, label: 'Collected measured connectivity run', evidenceIds: review.evidence.map(e => e.id) },
    ...review.reviews.map(r => ({ at: r.recordedAt, label: r.input.kind === 'cause' ? 'Cause review: ' + r.input.decision : 'Remedy selected: ' + r.input.remedy, evidenceIds: [], reviewHash: r.hash }))]
    .sort((a, b) => a.at.localeCompare(b.at));
  const scope = 'Local PostgreSQL experiment with temporary certificates and synthetic credentials. Customer environment unverified. Customer resolution pending.';
  const headline = accepted ? `The reviewer accepted this explanation for the local experiment: ${review.candidateText}` : 'The investigation remains incomplete in this gap-only export. No supported cause or validated remedy is exported.';
  const f = review.failure, x = review.fix;
  const observed = `Recorded comparison: ${f.id} failed while verifying the certificate chain with ${f.failure?.code}, after TCP connected and the server agreed to TLS. ${x.id}, identical except that the client was given the issuing CA, connected with the chain verified and the host name ${x.tls?.serverName} checked.`;
  const line = (s: ConnectivityStep) => `- ${s.id} (${s.label}): ${describeAttempt(s, wording === 1 ? 1 : 2)}`;
  // From bundle3, a gap-only export withholds every validation claim, including from a run whose cause was accepted.
  const withholdValidation = wording >= 3 && !accepted;
  const references = review.evidence.map(e => `- ${e.id}: ${e.phase}; ${e.shape}`).join('\n');
  const pending = mode === 'gaps' ? ['Gap-only export requested; acceptance, remedy and validation claims are withheld.', ...validation.blockers] : validation.blockers;
  const remedyLine = remedy ? `Selected remedy: ${remedy}. ${CONNECTIVITY_REMEDY_TEXT[remedy]}` : 'Selected remedy: none exported.';
  const gapText = ['# Evidence gap report', '', scope, '', ...(pending.length ? pending.map(p => '- ' + p) : ['- No local evidence gaps at export.']), '',
    '## Customer evidence still required', '',
    '- The client library and its version, and how it is configured: sslmode, sslrootcert and the host name it connects to.',
    '- The exact error code, and whether it appears before or after PostgreSQL authentication.',
    '- Which CA issued the certificate the server presents to that client, and whether the client has that CA.',
    '- Post-change results after an approved customer change, with certificate checks still turned on.',
    '- Customer-message approval before sending a response.', ''].join('\n');
  const customer = ['# Customer reply draft', '', 'DRAFT: human communication approval pending.', '',
    accepted ? `We reproduced a similar error in a separate local test. The client was set to check the server's certificate, but it didn't have the certificate authority (CA) that issued it, so the connection stopped with "${f.failure?.code}" before the database checked the password. When we gave the client that CA and changed nothing else, it connected, and the certificate and host-name checks passed.`
      : 'The local investigation still needs evidence or review before we can provide a supported explanation.',
    '', 'This local result does not confirm what is happening in your environment. Some drivers treat sslmode=require as a full certificate check while others do not, so the same setting can behave differently between applications. Please tell us which client library and version you use, the sslmode and sslrootcert settings, the host name in your connection settings, and the exact error. Leave out passwords and full connection strings.',
    '', 'Please do not turn certificate checks off to work around this. Any change on your side needs its own approval and a check afterwards.', ''].join('\n');
  const engineering = ['# Engineering handoff draft', '', 'Internal draft. Escalation need has not been established.', '', scope, '', headline, '', observed, '', remedyLine, '',
    '## Baseline, failure and fix', '', line(review.baseline), line(f), line(x), '',
    '## Controls', '', ...review.controls.map(line), '',
    '## When escalation would be worth considering', '',
    '- The client uses sslmode=verify-full with the issuing CA and a host name on the certificate, and still fails certificate verification.',
    '- The certificate the client receives is not the one expected for that host, for example a different fingerprint or issuer.',
    '- A SQLSTATE 28000 refusal on its own is not enough: in this lab it came from the client turning TLS off. Check the client settings and the server rules first.', '',
    '## Configuration', '', `PostgreSQL ${review.configuration.postgresVersion}; Node ${run.versions.node}; pg ${run.versions.pg}; pg-connection-string ${run.versions.pgConnectionString}; ${run.versions.openssl}. Server certificate ${run.certificates.server.altNames}, SHA-256 ${run.certificates.server.fingerprint256}, issued by ${run.certificates.server.issuer}. Environment variables present (names only): ${run.environment.namesPresent.join(', ') || 'none'}; every connection setting was passed explicitly. Cleanup ${run.cleanup}.`, '',
    'Passwords, private keys and file paths are not retained. Connection strings are recorded only as labelled shapes.', '',
    '## Competing explanations', '', ...review.alternatives.map(a => `- ${a.explanation} (${a.status}): ${a.detail}`), '',
    '## Evidence references', '', references, '', `Source manifest: ${review.sourceManifestHash}`, `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, withholdValidation ? 'Validation: withheld in this gap-only export' : `Validation: ${validation.validationHash}`, '',
    '## Remaining uncertainty', '', 'The customer client, its settings, the certificate it receives, its network path, business impact and the need for escalation remain unverified.', ''].join('\n');
  const validationText = ['# Resolution validation', '', `Status at export: ${accepted ? validation.status : 'WITHHELD_IN_GAP_REPORT'}`, `Scope: ${validation.scope}`, `Remedy: ${accepted ? remedy : 'withheld'}`, `Checked: ${generatedAt}`, '',
    ...(withholdValidation ? [GAP_CHECKS_WITHHELD, ''] : [validation.basis, '', ...validation.checks.map(c => `- ${c.passed ? 'PASS' : 'PENDING'}: ${c.id}; references ${c.evidence.join(', ') || 'none'}`), '',
    validation.limitation, '']), 'Customer resolution: unset. Customer-message approval: pending.', ''].join('\n');
  const hypotheses = [
    { candidate: review.candidate, classification: accepted ? 'SUPPORTED_CAUSE' : 'UNVERIFIED_HYPOTHESIS', scope: 'local-lab', evidence: [f.id, x.id, review.baseline.id] },
    ...review.alternatives.map(a => ({ candidate: a.explanation, classification: a.status, scope: a.evidence.length ? 'local-lab' : 'customer', evidence: a.evidence, limitation: a.detail })),
  ];
  const { validationHash: _ignored, ...validationBody } = validation;
  // From bundle3, the gap-only JSON also drops the checks, their results and the acceptance and remedy references.
  const { checks: _c, basis: _b, verification: _v, remedy: _r, remedySelectionHash: _s, causeReviewHash: _h, ...gapBody } = validationBody as typeof validationBody & Record<string, unknown>;
  const withheld = withholdValidation ? { ...gapBody, status: 'WITHHELD_IN_GAP_REPORT', limitation: GAP_CHECKS_WITHHELD } : { ...validationBody, status: 'WITHHELD_IN_GAP_REPORT' };
  const status = accepted ? `RESOLUTION_VALIDATED (local-lab, ${remedy})` : 'GAP_REPORT';
  const files: Record<string, string> = {
    'case-summary.md': ['# Case summary', '', `Exported: ${generatedAt}`, `Status at export: ${status}`, `Run: ${review.runId}`, '', scope, '', headline, '', observed, '', remedyLine, '', 'Business impact: unknown.', '', `Comparison: ${review.comparisonHash}`, `Review head: ${review.reviewHead}`, '', 'Communication approval: pending.', ''].join('\n'),
    'evidence-gap-report.md': gapText,
    'probe-plan.json': json(readJson(join(source, 'connectivity-plan.json'))),
    'evidence.jsonl': run.attempts.map(a => json({ id: connectivityEvidenceId(a.phase), attempt: a })).join(''),
    'timeline.json': json({ schemaVersion: 1, runId: review.runId, events: timeline }),
    'reproduction.md': ['# Reproduce the local experiment', '', 'Requires Node.js 24, pinned dependencies, PostgreSQL 16, 17 or 18 server tools and openssl on PATH. Run from the project checkout as a regular OS user. ' + (wording >= 3 ? 'Tested with OpenSSL 3, and on macOS 12.7.6 with LibreSSL 2.8.3 as /usr/bin/openssl. Other LibreSSL versions have not been verified.' : 'macOS with LibreSSL has not been verified yet.'), '', '```sh', 'npm ci', 'npm run demo:connectivity -- --dry-run', 'npm run demo:connectivity -- --approve-lab', '```', '',
      'The command creates temporary certificates, starts a disposable PostgreSQL server on 127.0.0.1, runs the fixed connection attempts, retains new evidence and removes the server, keys and credentials. It requires explicit approval.', '', observed, '',
      'Recorded cleanup: COMPLETE. No database execution occurs during bundle export or validation.', '', 'Exact attempts and server rules: sources/connectivity-probes.json. Each new run needs its own review decisions.', ''].join('\n'),
    'comparison.json': json(review), 'hypotheses.json': json({ schemaVersion: 1, runId: review.runId, hypotheses }),
    'findings.json': json({ schemaVersion: 1, scenario: 'tls-trust', runId: review.runId, mode, generatedAt, finding: review.cause, remedySelection: review.remedySelection,
      comparisonHash: review.comparisonHash, reviewHead: review.reviewHead, customerResolution: null, communicationApproval: 'PENDING' }),
    'validation.json': json(accepted ? validation : { ...withheld, validationHash: hash(withheld) }),
    'resolution-validation.md': validationText, 'customer-reply.md': customer, 'engineering-escalation.md': engineering,
    'runbook-candidate.md': ['# Certificate not trusted: runbook candidate', '', 'DRAFT: publication and reuse review pending.', '', `Source run: ${review.runId}`, `Evidence status: ${status}`, '',
      '## Qualifying symptom', '', 'A client fails to connect with a certificate error such as "unable to verify the first certificate" or "self-signed certificate in certificate chain". Capture the exact error code, the client library and version, and the time.', '',
      '## Investigation steps', '', '1. Find which stage failed: connection-string parsing, TCP connect, TLS negotiation and verification, PostgreSQL authentication, session startup (the database is opened after the credentials are accepted), or the query.', '2. Record the effective sslmode, sslrootcert and host name the client actually uses. Connection-string options can replace settings passed in code.', '3. Check how this client library treats sslmode=require; some treat it as a full certificate check.', '4. Compare the certificate the client receives with the expected issuer and host name.', '5. Reproduce in an isolated lab with a verified baseline, then change only the trusted CA.', '6. Review the evidence before selecting a cause.', '7. Approve the change for its environment, keep certificate checks on, then repeat the original connection.', '',
      '## Confounders', '', 'A different, untrusted CA gives the same error code. A host name that is not on the certificate fails at the same stage with a different code. Turning verification off makes the error disappear without fixing it. A wrong password and an unknown role return the same SQLSTATE. Server log entries are supporting evidence; a missing entry is inconclusive.', '',
      '## Validation boundary', '', withholdValidation ? GAP_RUNBOOK_BOUNDARY : 'This source bundle validates only trusting the issuing CA for its lab server in the local experiment when the review and freshness gates pass. Customer resolution requires customer-scoped post-change evidence.', ''].join('\n'),
    'support-bundle.html': '',
  };
  const documents = Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.md')));
  files['support-bundle.html'] = connectivityBundleHtml({ review, validation, generatedAt, mode, run, timeline, documents, wording, print: version === '0.1.0-connectivity-bundle4' });
  return { files, review, validation, generatedAt, remedy };
}

export function exportConnectivityBundle(source: string, output: string, options: { mode?: Mode; now?: Date; toolVersion?: ConnectivityToolVersion } & Binding = {}) {
  const mode = options.mode ?? 'reviewed', now = options.now ?? new Date(), toolVersion = options.toolVersion ?? CONNECTIVITY_TOOL_VERSION; checkMode(mode);
  // Older versions stay available so their exports can be reproduced; new exports use the current version.
  if (!CONNECTIVITY_TOOL_VERSIONS.includes(toolVersion)) fail('Unsupported connectivity bundle tool version.');
  const captured = readSources(LAYOUT, source), staging = mkdtempSync(join(tmpdir(), 'pslab-conn-bundle-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const built = buildFiles(staging, mode, now, toolVersion), files = { ...built.files, ...Object.fromEntries(Object.entries(captured).map(([p, s]) => ['sources/' + p, s])) };
    // Recheck the exact comparison and decision head the caller inspected, using the captured snapshot.
    if (options.expectedComparisonHash !== undefined && options.expectedComparisonHash !== built.review.comparisonHash ||
        options.expectedReviewHead !== undefined && options.expectedReviewHead !== built.review.reviewHead) fail('Investigation changed before export. Inspect it again.');
    const manifest = { schemaVersion: 1, scenario: 'tls-trust', toolVersion, profile: 'local-lab', runId: built.review.runId,
      generatedAt: built.generatedAt, mode, comparisonHash: built.review.comparisonHash, reviewHead: built.review.reviewHead,
      sourceManifestHash: built.review.sourceManifestHash, remedy: built.remedy, redactionStatus: 'recognized-patterns-checked', communicationApproval: 'PENDING',
      files: manifestFiles(LAYOUT, files) };
    validateArtifact(manifest, manifestSchema);
    const manifestHash = writeExport(LAYOUT, output, files, manifest);
    return { status: 'EXPORTED', scenario: 'tls-trust', mode, runId: built.review.runId, remedy: built.remedy, files: CONNECTIVITY_BUNDLE_PATHS.length + 1,
      manifestHash, customerResolution: null, communicationApproval: 'PENDING' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function verifyConnectivityBundle(dir: string, options: { expectedManifestHash?: string; now?: Date } = {}) {
  const { root, now, manifest, manifestHash } = checkIntegrity(LAYOUT, dir, manifestSchema, options);
  // Rebuild every output from the captured sources at the recorded export time.
  const captured = readSources(LAYOUT, join(root, 'sources')), staging = mkdtempSync(join(tmpdir(), 'pslab-conn-verify-'));
  try {
    writeSources(LAYOUT, staging, captured);
    const rebuilt = buildFiles(staging, manifest.mode, new Date(manifest.generatedAt), manifest.toolVersion);
    if (rebuilt.review.runId !== manifest.runId || rebuilt.review.comparisonHash !== manifest.comparisonHash || rebuilt.review.reviewHead !== manifest.reviewHead ||
        rebuilt.review.sourceManifestHash !== manifest.sourceManifestHash || rebuilt.remedy !== manifest.remedy) fail('Manifest investigation binding mismatch.');
    checkOutputs(LAYOUT, root, rebuilt.files);
    const current = validateConnectivity(staging, now);
    return { integrity: 'VALID', semanticConsistency: 'VALID', anchorChecked: options.expectedManifestHash !== undefined, manifestHash,
      scenario: 'tls-trust', runId: manifest.runId, mode: manifest.mode, remedy: manifest.remedy, exportedAt: manifest.generatedAt, checkedAt: now.toISOString(),
      validationAtExport: manifest.mode === 'reviewed' ? rebuilt.validation.status : 'WITHHELD_IN_GAP_REPORT',
      currentEvidenceStatus: current.status, customerResolution: null, communicationApproval: 'PENDING',
      limitation: 'Verifies this exported snapshot. Later changes to the original run and complete unanchored rewrites are outside this check.' };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
