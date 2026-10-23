import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LedgerError, validateArtifact } from './contracts.ts';
import { parseIntake, privacyFindings } from './intake.ts';
import { markdown } from './gaps.ts';
import { inspectLabReview, formatLabReview, appendLabReview } from './lab-review.ts';
import { validateLab } from './lab-validation.ts';
import { exportBundle, verifyBundle } from './support-bundle.ts';
import { labPlan, runNativeLab } from './native-lab.ts';
import { poolingPlan, runPoolingLab } from './pooling-lab.ts';
import { inspectPoolingReview, formatPoolingReview, appendPoolingReview, REMEDIES, REMEDY_TEXT } from './pooling-review.ts';
import { validatePooling } from './pooling-validation.ts';
import { exportPoolingBundle } from './pooling-bundle.ts';
import { verifyAnyBundle } from './bundle-dispatch.ts';
import poolingReviewSchema from '../schemas/pooling-review-input.v1.json' with { type: 'json' };
import reviewSchema from '../schemas/review-input.v1.json' with { type: 'json' };

export type GuideIO = { ask(prompt: string): Promise<string | null>; say(text: string): void };
type Options = { casesRoot?: string; now?: () => Date; runLab?: typeof runNativeLab; runPoolingLab?: typeof runPoolingLab };
class Cancelled extends Error {}
const json = (v: unknown) => JSON.stringify(v, null, 2);
const safeText = (s: string) => !/[\x00-\x1f\x7f-\x9f]/.test(s) && s.length <= 8000 && !privacyFindings(s).length;
function regularDirectory(path: string) {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new LedgerError('Use a regular cases directory.');
}
function prepareRoot(root: string) {
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  regularDirectory(root);
}
async function answer(io: GuideIO, prompt: string, valid: (s: string) => boolean = () => true, fallback?: string) {
  while (true) {
    const raw = await io.ask(prompt);
    if (raw === null || raw === '/cancel') throw new Cancelled();
    const value = raw.trim() || fallback || '';
    if (!safeText(value)) { io.say('Input blocked. Remove sensitive material or control characters and retry.'); continue; }
    if (!valid(value)) { io.say('Choose a listed value or provide the requested text. Type /cancel to stop.'); continue; }
    return value;
  }
}
const choice = (io: GuideIO, prompt: string, values: string[]) => answer(io, prompt, s => values.includes(s));
const confirm = async (io: GuideIO, prompt: string) => (await answer(io, prompt + ' [yes/no, default no]: ', s => ['yes','no'].includes(s), 'no')) === 'yes';

const fields: [string, string, string[]?][] = [
  ['errorMessage','Sanitized error message'], ['sqlstate','SQLSTATE (five uppercase letters/digits)'],
  ['relation','Exact relation name'], ['environment','Affected environment'], ['branch','Sanitized branch identifier'],
  ['connectionMode','Connection mode', ['direct','pooled','unknown']], ['language','Application language'],
  ['framework','Framework'], ['connector','Database connector or ORM'], ['deployment','Deployment environment'],
  ['firstObservedAt','When was the failure first observed?'], ['recentChange','Recent change'],
  ['impact','Business impact'], ['reproductionStatus','Reproduction status'],
  ['dataSensitivity','Data sensitivity', ['synthetic','sanitized','unknown']],
];
async function intake(io: GuideIO, root: string) {
  io.say('Create an intake record. Use sanitized descriptions only. Leave optional answers blank for unknown.');
  const value: Record<string, string | number> = { schemaVersion: 1 };
  value.report = await answer(io, 'What happened? ', s => !!s && s !== 'unknown');
  value.expectedBehavior = await answer(io, 'What did you expect? ', s => !!s && s !== 'unknown');
  for (const [key, label, values] of fields) {
    value[key] = await answer(io, `${label}${values ? ' (' + values.join('/') + ')' : ''} [unknown]: `,
      s => (!values || values.includes(s)) && (key !== 'sqlstate' || /^([0-9A-Z]{5}|unknown)$/.test(s)), 'unknown');
  }
  const accepted = parseIntake(value), report = markdown(accepted);
  if (Buffer.byteLength(json(accepted)) + 1 > 65536) throw new LedgerError('Intake is too large. Use shorter sanitized descriptions.');
  io.say(json(accepted)); io.say(report);
  io.say('This records reported context and missing evidence. No database has been inspected or case scope verified.');
  if (!await confirm(io, 'Save this intake and gap report?')) return;
  prepareRoot(root);
  const dir = join(root, 'intake-' + randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  try {
    writeFileSync(join(dir, 'intake.json'), json(accepted) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(join(dir, 'evidence-gap-report.md'), report, { flag: 'wx', mode: 0o600 });
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  io.say(`Intake saved: ${dir}\nEvidence collection is pending. Local lab runs have their own synthetic intake.`);
}

export async function guideLabReview(io: GuideIO, dir: string, now: () => Date = () => new Date()) {
  let packet = inspectLabReview(dir, now());
  io.say(formatLabReview(packet));
  io.say(packet.status === 'READY_FOR_REVIEW'
    ? 'The evidence checks passed. Read the before/after comparison and the same-error control above, then decide whether they support the proposed local explanation.'
    : 'The report lists evidence gaps or expired observations. Read the blockers above before deciding what to investigate next.');
  io.say('review records your judgment and reason; export creates a report from the current evidence; back returns to the menu.');
  const action = await choice(io, 'Choose review, export, or back: ', ['review','export','back']);
  if (action === 'back') return;
  if (action === 'review') {
    const decisions = packet.status === 'READY_FOR_REVIEW' ? ['accept','reject','request-changes','back'] : ['reject','request-changes','back'];
    if (packet.status !== 'READY_FOR_REVIEW') io.say('Acceptance is blocked by the evidence issues above. A fresh lab run creates new evidence; it preserves this history.');
    io.say('accept: the evidence supports the proposed cause in this local lab. reject: you disagree with that explanation. request-changes: you need corrections or more evidence before deciding. back: leave without recording a decision.');
    io.say('Your typing is hidden. Enter one listed choice and press Return. You will see your decision and explanation before confirming the save.');
    const decision = await choice(io, `Decision (${decisions.join('/')}): `, decisions);
    if (decision === 'back') return;
    const reviewer = await answer(io, 'Reviewer name or identifier: ', s => /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,79}$/.test(s));
    const rationale = await answer(io, 'Explain your decision (10-2000 characters): ', s => s.length >= 10 && s.length <= 2000);
    const input = { schemaVersion: 1, comparisonHash: packet.comparisonHash, expectedReviewHead: packet.reviewHead, reviewer, decision, rationale };
    validateArtifact(input, reviewSchema);
    io.say(json(input)); io.say('This decision covers the local lab. Customer resolution and outgoing-message approval remain pending.');
    if (!await confirm(io, 'Record this review?')) return;
    const entry = appendLabReview(dir, input, now());
    io.say(`Review recorded: ${entry.hash}`);
    packet = inspectLabReview(dir, now());
    if (!await confirm(io, 'Continue to bundle export?')) return;
  }
  const validation = validateLab(dir, now());
  io.say(`Local validation: ${validation.status}`);
  if (validation.comparisonHash !== packet.comparisonHash || validation.reviewHead !== packet.reviewHead) throw new LedgerError('Investigation changed. Open it again before export.');
  const modes = validation.status === 'RESOLUTION_VALIDATED' ? ['reviewed','gaps','back'] : ['gaps','back'];
  if (modes.length === 2) io.say('Reviewed export is blocked. A gaps bundle preserves the investigation and identifies what remains unresolved.');
  const mode = await choice(io, `Export type (${modes.join('/')}): `, modes);
  if (mode === 'back') return;
  if (!await confirm(io, `Create and verify a new ${mode} bundle?`)) return;
  const output = join(dir, 'support-bundle-' + randomUUID());
  const exported = exportBundle(dir, output, { mode: mode as 'reviewed' | 'gaps', now: now(), expectedComparisonHash: packet.comparisonHash, expectedReviewHead: packet.reviewHead });
  io.say(`Bundle saved: ${output}`);
  io.say(`Manifest hash: ${exported.manifestHash}\nKeep this hash separately if you need to check this snapshot later.`);
  const verified = verifyBundle(output, { expectedManifestHash: exported.manifestHash, now: now() });
  io.say(json(verified));
  io.say(`Open in your browser: ${join(output, 'support-bundle.html')}`);
}

const reviewerPattern = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,79}$/;
async function poolingRemedy(io: GuideIO, dir: string, now: () => Date) {
  const packet = inspectPoolingReview(dir, now());
  if (!packet.cause || packet.status !== 'READY_FOR_REVIEW') { io.say('Remedy selection needs a current accepted cause review and fresh evidence.'); return false; }
  io.say('Choose which remedy the local validation should claim. Both were measured in this run:');
  for (const r of REMEDIES) io.say(`${r}: ${REMEDY_TEXT[r]}`);
  io.say('back: leave without selecting. The selection is bound to the accepted cause review shown above. Rejecting or re-accepting the cause later withdraws it.');
  io.say('Your typing is hidden. Enter one listed choice and press Return. You will see your selection and explanation before confirming the save.');
  const remedy = await choice(io, `Remedy (${[...REMEDIES, 'back'].join('/')}): `, [...REMEDIES, 'back']);
  if (remedy === 'back') return false;
  const reviewer = await answer(io, 'Reviewer name or identifier: ', s => reviewerPattern.test(s));
  const rationale = await answer(io, 'Explain your selection (10-2000 characters): ', s => s.length >= 10 && s.length <= 2000);
  const input = { schemaVersion: 1, scenario: 'pooling-session', kind: 'remedy', comparisonHash: packet.comparisonHash, expectedReviewHead: packet.reviewHead,
    reviewer, decision: 'select', remedy, causeReviewHash: packet.cause.reviewHash, rationale };
  validateArtifact(input, poolingReviewSchema);
  io.say(json(input)); io.say('Validation will claim only this remedy, scoped to the local experiment. Customer resolution and outgoing-message approval remain pending.');
  if (!await confirm(io, 'Record this remedy selection?')) return false;
  io.say(`Remedy selection recorded: ${appendPoolingReview(dir, input, now()).hash}`);
  return true;
}

export async function guidePoolingReview(io: GuideIO, dir: string, now: () => Date = () => new Date()) {
  let packet = inspectPoolingReview(dir, now());
  io.say(formatPoolingReview(packet));
  io.say(packet.status === 'READY_FOR_REVIEW'
    ? 'The evidence checks passed. Read the backend switch, the reset and timeout controls and both remedies above, then decide whether they support the proposed local explanation.'
    : 'The report lists expired or missing evidence. Read the blockers above before deciding what to investigate next.');
  const actions = ['review-cause', ...(packet.cause ? ['select-remedy'] : []), 'export', 'back'];
  io.say('review-cause records your judgment of the proposed cause. select-remedy chooses which remedy validation claims, after the cause is accepted. export creates a report from the current evidence. back returns to the menu.');
  const action = await choice(io, `Choose ${actions.join(', ')}: `, actions);
  if (action === 'back') return;
  if (action === 'review-cause') {
    const decisions = packet.status === 'READY_FOR_REVIEW' ? ['accept','reject','request-changes','back'] : ['reject','request-changes','back'];
    if (packet.status !== 'READY_FOR_REVIEW') io.say('Acceptance is blocked by the evidence issues above. A fresh lab run creates new evidence; it preserves this history.');
    io.say('accept: the evidence supports the proposed cause in this local experiment. reject: you disagree with that explanation. request-changes: you need corrections or more evidence before deciding. back: leave without recording a decision. Any new cause decision withdraws an earlier remedy selection.');
    io.say('Your typing is hidden. Enter one listed choice and press Return. You will see your decision and explanation before confirming the save.');
    const decision = await choice(io, `Decision (${decisions.join('/')}): `, decisions);
    if (decision === 'back') return;
    const reviewer = await answer(io, 'Reviewer name or identifier: ', s => reviewerPattern.test(s));
    const rationale = await answer(io, 'Explain your decision (10-2000 characters): ', s => s.length >= 10 && s.length <= 2000);
    const input = { schemaVersion: 1, scenario: 'pooling-session', kind: 'cause', comparisonHash: packet.comparisonHash, expectedReviewHead: packet.reviewHead,
      reviewer, decision, remedy: null, causeReviewHash: null, rationale };
    validateArtifact(input, poolingReviewSchema);
    io.say(json(input)); io.say('This decision covers the local experiment. It does not choose a remedy. Customer resolution and outgoing-message approval remain pending.');
    if (!await confirm(io, 'Record this cause review?')) return;
    io.say(`Cause review recorded: ${appendPoolingReview(dir, input, now()).hash}`);
    packet = inspectPoolingReview(dir, now());
    if (packet.cause && !await poolingRemedy(io, dir, now)) return;
    if (!packet.cause && !await confirm(io, 'Continue to bundle export?')) return;
  }
  if (action === 'select-remedy' && !await poolingRemedy(io, dir, now)) return;
  packet = inspectPoolingReview(dir, now());
  const validation = validatePooling(dir, now());
  io.say(`Local validation: ${validation.status}${validation.remedy ? ' for ' + validation.remedy : ''}`);
  if (validation.comparisonHash !== packet.comparisonHash || validation.reviewHead !== packet.reviewHead) throw new LedgerError('Investigation changed. Open it again before export.');
  const modes = validation.status === 'RESOLUTION_VALIDATED' ? ['reviewed','gaps','back'] : ['gaps','back'];
  if (modes.length === 2) io.say('Reviewed export is blocked. A gaps bundle preserves the investigation and identifies what remains unresolved.');
  const mode = await choice(io, `Export type (${modes.join('/')}): `, modes);
  if (mode === 'back') return;
  if (!await confirm(io, `Create and verify a new ${mode} bundle?`)) return;
  const output = join(dir, 'support-bundle-' + randomUUID());
  const exported = exportPoolingBundle(dir, output, { mode: mode as 'reviewed' | 'gaps', now: now(), expectedComparisonHash: packet.comparisonHash, expectedReviewHead: packet.reviewHead });
  io.say(`Bundle saved: ${output}`);
  io.say(`Manifest hash: ${exported.manifestHash}\nKeep this hash separately if you need to check this snapshot later.`);
  io.say(json(verifyAnyBundle(output, { expectedManifestHash: exported.manifestHash, now: now() })));
  io.say(`Open in your browser: ${join(output, 'support-bundle.html')}`);
}

async function selectRun(io: GuideIO, root: string) {
  if (!existsSync(root)) { io.say('No recorded runs yet. Choose 3 or 5 to run a synthetic lab.'); return; }
  regularDirectory(root);
  const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^(native|pooling)-[a-zA-Z0-9-]+$/.test(d.name)).map(d => d.name).sort();
  if (!dirs.length) { io.say('No recorded lab runs found. Choose 3 or 5 to create one.'); return; }
  if (dirs.length > 200) throw new LedgerError('Too many runs to list. Use the existing lab commands with an explicit directory.');
  io.say('Choose a recorded run. Its evidence and review history are checked after selection.');
  dirs.forEach((name, index) => io.say(`${index + 1}. ${name} (${name.startsWith('pooling-') ? 'PgBouncer session' : 'schema investigation'})`));
  const selected = await answer(io, 'Run number, or back: ', s => s === 'back' || /^(?:[1-9][0-9]*)$/.test(s) && Number(s) <= dirs.length);
  return selected === 'back' ? undefined : join(root, dirs[Number(selected) - 1]);
}

export async function runGuided(io: GuideIO, options: Options = {}) {
  const root = resolve(options.casesRoot ?? 'cases'), now = options.now ?? (() => new Date());
  io.say('Postgres Support Lab\nGuided intake and local investigation\nType /cancel at any prompt to finish. No decision defaults to acceptance.');
  try {
    while (true) {
      io.say('\n1. Create an intake and evidence gap report\n2. Review or export a recorded lab run\n3. Run the synthetic PostgreSQL lab\n4. Finish\n5. Run the synthetic PgBouncer lab');
      const selected = await choice(io, 'Choose 1, 2, 3, 4, or 5: ', ['1','2','3','4','5']);
      if (selected === '4') return;
      if (selected === '1') await intake(io, root);
      if (selected === '2') {
        const dir = await selectRun(io, root);
        if (dir && dir.split('/').at(-1)!.startsWith('pooling-')) await guidePoolingReview(io, dir, now);
        else if (dir) await guideLabReview(io, dir, now);
      }
      if (selected === '3') {
        io.say('This runs the bundled synthetic schema scenario. It does not inspect an intake record or a customer environment.');
        io.say(json(labPlan()));
        const approved = await choice(io, 'Type run lab to approve this plan, or back: ', ['run lab','back']);
        if (approved === 'back') continue;
        prepareRoot(root);
        const output = join(root, 'native-' + randomUUID());
        io.say('Running the approved disposable lab. Wait for cleanup to finish.');
        const report = await (options.runLab ?? runNativeLab)({ approved: true, output });
        io.say(`Cleanup: ${report.cleanup}\nArtifacts: ${output}`);
        await guideLabReview(io, output, now);
      }
      if (selected === '5') {
        io.say('This runs the bundled synthetic PgBouncer scenario with disposable PostgreSQL and PgBouncer processes. It does not inspect an intake record or a customer environment.');
        io.say(json(poolingPlan()));
        const approved = await choice(io, 'Type run lab to approve this plan, or back: ', ['run lab','back']);
        if (approved === 'back') continue;
        prepareRoot(root);
        const output = join(root, 'pooling-' + randomUUID());
        io.say('Running the approved disposable experiment. Wait for cleanup to finish.');
        const report = await (options.runPoolingLab ?? runPoolingLab)({ approved: true, output });
        io.say(`Cleanup: COMPLETE\nArtifacts: ${output}\nManifest hash: ${report.manifestHash}`);
        await guidePoolingReview(io, output, now);
      }
    }
  } catch (error) {
    if (error instanceof Cancelled) { io.say('Finished. Previously saved records are retained. Unconfirmed input was not saved.'); return; }
    if (error instanceof LedgerError) throw error;
    throw new LedgerError('Guided workflow failed. Check file permissions and PostgreSQL tool availability. Saved records are retained.');
  }
}
