import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/contracts.ts';
import { poolingManifest, POOLING_QUERIES } from '../src/pooling-evidence.ts';
import { poolingPlan } from '../src/pooling-lab.ts';
import { poolingFixture } from './pooling-fixture.ts';
import { poolingReviewTemplate, appendPoolingReview } from '../src/pooling-review.ts';

// Contract-test fixture only: a retained pooling run directory built from synthetic observations.
// No database was queried to produce it, and its decisions use clearly labeled test reviewers.
export function poolingCase(t: any, change?: (run: any) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pooling-case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = poolingFixture(); change?.(run);
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), canonical(value) + '\n');
  write('pooling-run.json', run); write('pooling-manifest.json', poolingManifest(run));
  write('pooling-probes.json', POOLING_QUERIES); write('pooling-plan.json', { ...poolingPlan(), runId: run.runId, approved: true });
  return { root, run, now: new Date('2026-09-28T12:30:00.000Z'), expired: new Date('2026-09-28T13:00:00.000Z') };
}
export const TEST_REVIEWER = 'automated-test-reviewer';
export function acceptCause(root: string, now: Date, decision = 'accept') {
  return appendPoolingReview(root, { ...poolingReviewTemplate(root, 'cause', now), reviewer: TEST_REVIEWER, decision,
    rationale: 'Synthetic test decision recorded by the automated suite.' }, now);
}
export function selectRemedy(root: string, now: Date, remedy = 'protocol-prepared') {
  return appendPoolingReview(root, { ...poolingReviewTemplate(root, 'remedy', now), reviewer: TEST_REVIEWER, remedy,
    rationale: 'Synthetic test remedy selection recorded by the automated suite.' }, now);
}
