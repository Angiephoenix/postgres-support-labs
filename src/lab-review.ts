import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, hash, fail, validateArtifact } from './contracts.ts';
import { readJson, readLedgerSnapshot } from './ledger.ts';
import { readChain, appendChain } from './review-chain.ts';
import { labCatalog, labPlan } from './native-lab.ts';
import reviewSchema from '../schemas/review-input.v1.json' with { type: 'json' };
import type { TypedObservation, InvestigationCase } from './contracts.ts';

const phases = ['development', 'before', 'search-path-control', 'after'] as const;
type Phase = typeof phases[number];
const databases = { development: 'pslab_development', before: 'pslab_affected', 'search-path-control': 'pslab_search_path', after: 'pslab_affected' };
const kinds = ['target_identity', 'effective_context', 'relation_inventory', 'permissions', 'migration_state', 'failure_observation'] as const;
type Input = { schemaVersion: 1; comparisonHash: string; expectedReviewHead: string; reviewer: string;
  decision: 'accept'|'reject'|'request-changes'; rationale: string };

function exactKeys(value: any, names: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail('Unexpected lab artifact fields.');
}
function digest(value: unknown) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('Invalid lab artifact digest.'); }
function rootDirectory(dir: string) {
  const root = resolve(dir), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a regular lab output directory.');
  return root;
}
function clock(now: Date) { if (!Number.isFinite(now.getTime())) fail('Invalid review clock.'); return now.toISOString(); }
function result(o: TypedObservation) { return o.result as any; }

function comparison(dir: string, now: Date) {
  const root = rootDirectory(dir), run = readJson(join(root, 'run.json')) as any;
  exactKeys(run, ['schemaVersion', 'runId', 'profile', 'status', 'cleanup', 'failedStage', 'snapshots', 'migrationHash', 'clusterFingerprint', 'cause', 'resolution', 'reviewStatus', 'note']);
  if (run.schemaVersion !== 1 || run.profile !== 'local-lab' || run.status !== 'COMPLETE' || run.cleanup !== 'COMPLETE' || run.failedStage !== null || !/^[a-f0-9-]{36}$/.test(run.runId)) fail('A completed local lab run with successful cleanup is required.');
  digest(run.clusterFingerprint); digest(run.migrationHash);
  if (run.cause !== null || run.resolution !== null || run.reviewStatus !== 'NOT_REVIEWED') fail('Lab execution cannot supply a review decision.');
  exactKeys(run.snapshots, [...phases]);
  const catalog = labCatalog();
  if (canonical(readJson(join(root, 'probes.json'))) !== canonical(catalog) || run.migrationHash !== hash(catalog.migration)) fail('Lab probe catalog differs from the supported version.');
  if (canonical(readJson(join(root, 'plan.json'))) !== canonical({ ...labPlan(), runId: run.runId, approved: true })) fail('The retained lab plan is missing or inconsistent.');
  const cases: Partial<Record<Phase, { config: InvestigationCase; observations: Record<string, TypedObservation>; summary: any; head: string; fileHash: string; caseHash: string }>> = {};
  const blockers: string[] = [];
  for (const phase of phases) {
    const stored = run.snapshots[phase]; digest(stored?.headHash);
    const snapshot = readLedgerSnapshot(join(root, phase), now, stored.headHash);
    const c = snapshot.case;
    if (c.schemaVersion !== 3 || c.profile !== 'local-lab' || c.caseId !== phase) fail('A lab snapshot has the wrong profile or case identity.');
    if (snapshot.entries.length !== (phase === 'search-path-control' ? 7 : 6)) fail('Unexpected native lab evidence count.');
    const observations: Record<string, TypedObservation> = {};
    for (const entry of snapshot.entries) {
      const o = entry.observation;
      if (o.schemaVersion !== 3 || o.source.type !== 'local-lab' || o.source.runId !== run.runId || o.source.id !== 'schema-drift' || o.source.version !== '1' || o.collectorVersion !== 'native-lab-1') fail('Evidence belongs to another run or collector.');
      const qualified = o.probeId === 'qualified_control';
      const key = qualified ? 'qualified_control' : o.kind;
      if (observations[key] || qualified && (phase !== 'search-path-control' || o.kind !== 'failure_observation')) fail('Ambiguous native lab probe.');
      const query = qualified ? catalog.qualifiedQuery : catalog.queries[o.kind];
      if (o.queryHash !== hash(query) || !qualified && o.probeId !== o.kind) fail('Evidence query hash does not match the probe catalog.');
      if (o.kind === 'failure_observation' && o.result.queryShapeHash !== hash(query)) fail('Application query shape differs from its probe.');
      if (o.artifactId !== `${phase}-${o.kind}${qualified ? '-qualified' : ''}` || o.collectionScope !== 'single-lab-connection' || o.supersedes !== null) fail('Unexpected native lab observation identity.');
      if (canonical(o.parents) !== canonical(o.kind === 'target_identity' ? [] : [`${phase}-target_identity`])) fail('Unexpected native lab lineage.');
      if (snapshot.status.get(o.artifactId) !== 'CURRENT') blockers.push(`${phase}: ${o.artifactId} is ${snapshot.status.get(o.artifactId)}`);
      observations[key] = o;
    }
    if (kinds.some(kind => !observations[kind])) fail('Required native lab evidence is missing.');
    const identity = result(observations.target_identity), context = result(observations.effective_context);
    const inventory = result(observations.relation_inventory), migration = result(observations.migration_state);
    const failure = result(observations.failure_observation), qualified = observations.qualified_control;
    if (identity.clusterFingerprint !== run.clusterFingerprint || identity.expectedBranchFingerprint !== c.subject.expectedBranchFingerprint || identity.observedBranchFingerprint !== c.scope.branchFingerprint || identity.expectedBranchFingerprint !== identity.observedBranchFingerprint) fail('Lab target identity mismatch.');
    if (context.database !== databases[phase] || c.subject.schema !== 'app_data' || c.subject.relation !== 'project_labels' || c.subject.migrationId !== '002_project_labels' || c.subject.queryShapeHash !== hash(catalog.queries.failure_observation)) fail('Unexpected lab investigation subject.');
    for (const kind of ['relation_inventory', 'permissions', 'failure_observation', ...(qualified ? ['qualified_control'] : [])]) {
      const r = result(observations[kind]);
      if (r.schema !== c.subject.schema || r.relation !== c.subject.relation) fail('Evidence subject mismatch.');
    }
    if (c.intake.sqlstate !== '42P01') fail('Unexpected reported lab failure.');
    if (migration.migrationId !== c.subject.migrationId) fail('Migration identity mismatch.');
    if (snapshot.entries.some(e => e.observation.collectedAt !== observations.target_identity.collectedAt)) fail('Snapshot collection times disagree.');
    const summary = { caseId: phase, database: context.database, outcome: failure.outcome, sqlstate: failure.sqlstate,
      matchingRows: failure.matchingRows === null ? null : Number(failure.matchingRows),
      qualifiedRows: qualified ? Number(result(qualified).matchingRows) : null,
      migrationApplied: migration.applied, relationPresent: inventory.present, relationVisible: inventory.visible,
      searchPath: context.searchPath, branchFingerprint: c.scope.branchFingerprint, roleFingerprint: c.scope.roleFingerprint,
      queryShapeHash: c.subject.queryShapeHash, evidenceIds: snapshot.entries.map(e => e.observation.artifactId), headHash: snapshot.summary.headHash,
      coverage: failure.outcome === 'error' && failure.sqlstate === '42P01' ? 6 : 5,
      collectedAt: observations.target_identity.collectedAt };
    // Never trust cached result fields in run.json as independent evidence.
    if (canonical(summary) !== canonical(stored)) fail('Run summary differs from the recorded observations.');
    cases[phase] = { config: c, observations, summary, head: snapshot.summary.headHash, fileHash: snapshot.summary.ledgerFileHash, caseHash: snapshot.summary.caseHash };
  }
  const before = cases.before!, after = cases.after!, control = cases['search-path-control']!, development = cases.development!;
  if (canonical(before.config.scope) !== canonical(after.config.scope) || canonical(before.config.subject) !== canonical(after.config.subject) || canonical(before.config.intake) !== canonical(after.config.intake)) blockers.push('Before and after have incompatible case scope or intake.');
  if (before.summary.collectedAt > after.summary.collectedAt) blockers.push('Post-change evidence predates the original failure.');
  if (canonical(before.summary.searchPath) !== canonical(after.summary.searchPath)) blockers.push('Search path changed alongside the migration.');
  if (result(before.observations.effective_context).currentSchema !== result(after.observations.effective_context).currentSchema || result(before.observations.target_identity).serverVersion !== result(after.observations.target_identity).serverVersion) blockers.push('Effective schema or server version changed alongside the migration.');
  for (const phase of phases) {
    const c = cases[phase]!;
    if (c.config.scope.roleFingerprint !== before.config.scope.roleFingerprint || canonical(c.config.subject) !== canonical({ ...before.config.subject, expectedBranchFingerprint: c.config.scope.branchFingerprint })) blockers.push(`${phase}: incompatible role or subject.`);
    if (result(c.observations.permissions).schemaUsage !== true) blockers.push(`${phase}: schema access is unresolved.`);
  }
  if (!(before.summary.sqlstate === '42P01' && before.summary.migrationApplied === false && before.summary.relationPresent === false && after.summary.outcome === 'success' && after.summary.matchingRows === 1 && after.summary.migrationApplied === true && after.summary.relationPresent === true && after.summary.relationVisible === true && result(after.observations.permissions).relationSelect === true && before.summary.searchPath.includes('app_data'))) blockers.push('The missing-migration candidate lacks its required before-and-after observations.');
  if (!(control.summary.sqlstate === '42P01' && control.summary.migrationApplied === true && control.summary.relationPresent === true && control.summary.relationVisible === false && control.summary.qualifiedRows === 1 && result(control.observations.permissions).relationSelect === true && !control.summary.searchPath.includes('app_data'))) blockers.push('The search-path control is incomplete or inconsistent.');
  if (development.summary.outcome !== 'success' || development.summary.matchingRows !== 1) blockers.push('The development control did not succeed.');
  const fields: [string, (c: typeof before) => unknown][] = [
    ['migration applied', c => c.summary.migrationApplied], ['relation present', c => c.summary.relationPresent],
    ['relation visible', c => c.summary.relationVisible], ['relation SELECT', c => result(c.observations.permissions).relationSelect],
    ['query outcome', c => c.summary.outcome], ['SQLSTATE', c => c.summary.sqlstate], ['matching rows', c => c.summary.matchingRows],
    ['target fingerprint', c => c.config.scope.branchFingerprint], ['role fingerprint', c => c.config.scope.roleFingerprint],
    ['connection mode', c => c.config.scope.connectionMode], ['query shape hash', c => c.summary.queryShapeHash],
    ['search path', c => c.summary.searchPath], ['schema USAGE', c => result(c.observations.permissions).schemaUsage],
  ];
  const facts = fields.map(([field, get]) => ({ field, before: get(before), after: get(after) }));
  const material = { schemaVersion: 1, runId: run.runId, profile: 'local-lab', candidate: 'missing_migration',
    declaredChange: 'Apply bundled migration 002_project_labels', migrationHash: run.migrationHash,
    changed: facts.filter(f => canonical(f.before) !== canonical(f.after)), unchanged: facts.filter(f => canonical(f.before) === canonical(f.after)),
    controls: { development: development.summary, searchPath: control.summary },
    evidence: phases.map(phase => ({ phase, headHash: cases[phase]!.head, caseHash: cases[phase]!.caseHash,
      ledgerFileHash: cases[phase]!.fileHash, artifactIds: cases[phase]!.summary.evidenceIds })) };
  return { ...material, comparisonHash: hash(material), checkedAt: clock(now), blockers,
    status: blockers.length ? 'EVIDENCE_REQUIRED' : 'READY_FOR_REVIEW', cause: null, resolution: null };
}

function reviewHistory(root: string, runId: string, now: Date) {
  return readChain<Input>(root, 'reviews.jsonl', runId, hash({ runId, artifact: 'human-review-v1' }), input => validateArtifact(input, reviewSchema), now);
}

export function inspectLabReview(dir: string, now = new Date()) {
  const packet = comparison(dir, now), history = reviewHistory(rootDirectory(dir), packet.runId, now);
  const latest = history.entries.at(-1);
  const applicable = latest?.input.comparisonHash === packet.comparisonHash;
  const accepted = applicable && latest?.input.decision === 'accept' && packet.status === 'READY_FOR_REVIEW';
  const reviewStatus = !latest ? 'NOT_REVIEWED' : !applicable ? 'REVIEW_OUTDATED' : latest.input.decision === 'accept'
    ? accepted ? 'ACCEPTED_LOCAL_LAB' : 'EVIDENCE_REQUIRED' : latest.input.decision === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
  return { ...packet, reviewHead: history.head, reviewStatus, reviews: history.entries,
    cause: accepted ? { classification: 'SUPPORTED_CAUSE', candidate: packet.candidate, scope: 'local-lab', reviewHash: latest!.hash } : null,
    resolution: null,
    limitation: 'This review covers the recorded local reproduction. Customer cause, customer resolution and approval of outgoing messages remain outside this decision.' };
}
export function reviewTemplate(dir: string, now = new Date()) {
  const packet = inspectLabReview(dir, now);
  return { schemaVersion: 1, comparisonHash: packet.comparisonHash, expectedReviewHead: packet.reviewHead,
    reviewer: '', decision: 'request-changes', rationale: '' };
}
export function appendLabReview(dir: string, input: unknown, now = new Date()) {
  validateArtifact(input, reviewSchema);
  if ((input as Input).rationale.trim().length < 10) fail('Provide a substantive review rationale.');
  const value = input as Input, root = rootDirectory(dir);
  return appendChain<Input>(root, 'reviews.jsonl', '.review.lock', now, () => {
    const packet = inspectLabReview(root, now);
    if (value.comparisonHash !== packet.comparisonHash || value.expectedReviewHead !== packet.reviewHead) fail('Review input is outdated. Generate a fresh template and inspect the comparison.');
    if (value.decision === 'accept' && packet.status !== 'READY_FOR_REVIEW') fail('Evidence blockers prevent acceptance.');
    return { runId: packet.runId, sequence: packet.reviews.length + 1, previousHash: packet.reviewHead, previousAt: packet.reviews.at(-1)?.recordedAt, input: value };
  });
}

export function labReviewMarkdown(dir: string, now = new Date()) {
  return formatLabReview(inspectLabReview(dir, now));
}
export function formatLabReview(p: ReturnType<typeof inspectLabReview>) {
  const display = (value: unknown) => canonical(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return ['# Local PostgreSQL investigation review', '', `Run: ${p.runId}`, `Evidence: ${p.status}`, `Review: ${p.reviewStatus}`,
    `Comparison hash: ${p.comparisonHash}`, `Review head: ${p.reviewHead}`, '',
    'Candidate for human review: missing migration in the affected local database.', '',
    '## Changed after the bundled migration', '', '| Observation | Before | After |', '|---|---|---|',
    ...p.changed.map(f => `| ${f.field} | ${display(f.before)} | ${display(f.after)} |`), '',
    '## Unchanged context', '', ...p.unchanged.map(f => `- ${f.field}: ${display(f.before)}`), '',
    '## Same-error control', '',
    `The search-path control recorded SQLSTATE ${p.controls.searchPath.sqlstate}, migration applied=${p.controls.searchPath.migrationApplied}, relation present=${p.controls.searchPath.relationPresent}, relation visible=${p.controls.searchPath.relationVisible}, and qualified query matching rows=${p.controls.searchPath.qualifiedRows}.`, '',
    '## Evidence references', '', ...p.evidence.map(e => `- ${e.phase}: ${e.artifactIds.join(', ')}; ledger head ${e.headHash}`), '',
    ...(p.blockers.length ? ['## Blockers', '', ...p.blockers.map(b => `- ${b}`), ''] : []),
    ...(p.reviews.length ? ['## Review history', '', ...p.reviews.map(r => `- ${r.recordedAt}: ${r.input.reviewer}; ${r.input.decision}; rationale: ${display(r.input.rationale)}; review hash ${r.hash}`), ''] : []),
    `Cause: ${p.cause ? 'human-accepted missing migration, scoped to this local lab' : 'unset'}. Resolution: unset.`, '', p.limitation, '',
    'Review choices: accept, reject, or request-changes. Record a reviewer and rationale against this exact comparison hash.', ''].join('\n');
}
