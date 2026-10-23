import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/contracts.ts';
import { leakManifest, LEAK_QUERIES } from '../src/pool-exhaustion-evidence.ts';
import type { LeakRun, LeakPhase, PhaseRecord } from '../src/pool-exhaustion-evidence.ts';
import { leakPlan } from '../src/pool-exhaustion-lab.ts';
import { leakReviewTemplate, appendLeakReview } from '../src/pool-exhaustion-review.ts';

// Contract-test fixture. It was recorded from one local run of the lab on Linux with PostgreSQL 16.13, pg 8.23.0 and
// pg-pool 3.14.0. The run ID, cluster fingerprint and times were replaced; every count, event, lease and session is as measured.
export function leakFixture(): LeakRun { return JSON.parse(readFileSync(new URL('./pool-exhaustion-run.fixture.json', import.meta.url), 'utf8')); }
export const FIXTURE_NOW = new Date('2026-10-15T12:10:00.000Z');
export const phaseOf = (run: LeakRun, phase: LeakPhase) => run.phases.find(p => p.phase === phase)!;
export const checkpointOf = (p: PhaseRecord, name: string) => p.checkpoints.find(c => c.name === name)!;

// A run directory holding the fixture, as the runner would leave it. Decisions use a clearly labelled automated test reviewer.
export function leakCase(t: any, change?: (run: LeakRun) => void) {
  const root = mkdtempSync(join(tmpdir(), 'leak-case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = leakFixture(); change?.(run);
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), canonical(value) + '\n');
  write('pool-exhaustion-run.json', run); write('pool-exhaustion-manifest.json', leakManifest(run));
  write('pool-exhaustion-probes.json', LEAK_QUERIES); write('pool-exhaustion-plan.json', { ...leakPlan(), runId: run.runId, approved: true });
  return { root, run, now: FIXTURE_NOW, expired: new Date('2026-10-15T13:00:00.000Z') };
}
export const TEST_REVIEWER = 'automated-test-reviewer';
export function acceptLeakCause(root: string, now: Date, decision = 'accept') {
  return appendLeakReview(root, { ...leakReviewTemplate(root, 'cause', now), reviewer: TEST_REVIEWER, decision,
    rationale: 'Synthetic test decision recorded by the automated suite.' }, now);
}
export function selectLeakRemedy(root: string, now: Date) {
  return appendLeakReview(root, { ...leakReviewTemplate(root, 'remedy', now), reviewer: TEST_REVIEWER, remedy: 'release-in-finally',
    rationale: 'Synthetic test remedy selection recorded by the automated suite.' }, now);
}
