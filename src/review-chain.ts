import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, hash, fail } from './contracts.ts';
import { readBounded } from './ledger.ts';

// Shared append-only decision history. Each scenario supplies its own file, seed and input check.
export type ChainEntry<I> = { sequence: number; runId: string; recordedAt: string; previousHash: string; input: I; hash: string };
const LIMIT = 65536;

function exactKeys(value: any, names: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail('Unexpected lab artifact fields.');
}
export function chainClock(now: Date) { if (!Number.isFinite(now.getTime())) fail('Invalid review clock.'); return now.toISOString(); }

export function readChain<I extends { expectedReviewHead: string }>(root: string, file: string, runId: string, seed: string, check: (input: unknown) => void, now: Date) {
  const path = join(root, file);
  const raw = existsSync(path) ? readBounded(path, LIMIT) : '';
  if (raw && !raw.endsWith('\n')) fail('Review history is truncated.');
  let head = seed;
  const entries: ChainEntry<I>[] = [];
  for (const line of raw ? raw.slice(0, -1).split('\n') : []) {
    let entry: ChainEntry<I>;
    try { entry = JSON.parse(line); } catch { return fail('Review history contains invalid JSON.'); }
    exactKeys(entry, ['sequence', 'runId', 'recordedAt', 'previousHash', 'input', 'hash']);
    check(entry.input);
    if (entry.sequence !== entries.length + 1 || entry.runId !== runId || entry.previousHash !== head || entry.input.expectedReviewHead !== head) fail('Review history chain mismatch.');
    const time = new Date(entry.recordedAt);
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== entry.recordedAt || entry.recordedAt > chainClock(now) || entries.length && entry.recordedAt < entries.at(-1)!.recordedAt) fail('Review time is invalid.');
    const { hash: stored, ...body } = entry;
    if (stored !== hash(body)) fail('Review history hash mismatch.');
    head = stored; entries.push(entry);
  }
  return { raw, head, entries };
}

// Takes an exclusive lock, lets the caller re-check current state, then atomically replaces the file.
export function appendChain<I>(root: string, file: string, lockName: string, now: Date, prepare: () => { runId: string; sequence: number; previousHash: string; previousAt?: string; input: I }) {
  let lock: number;
  try { lock = openSync(join(root, lockName), 'wx', 0o600); } catch { return fail('Review history is locked or unavailable.'); }
  try {
    const next = prepare();
    if (next.previousAt && chainClock(now) < next.previousAt) fail('Review clock moved backwards.');
    const body = { sequence: next.sequence, runId: next.runId, recordedAt: chainClock(now), previousHash: next.previousHash, input: next.input };
    const entry = { ...body, hash: hash(body) };
    const path = join(root, file), raw = existsSync(path) ? readBounded(path, LIMIT) : '';
    const content = raw + canonical(entry) + '\n';
    if (Buffer.byteLength(content) > LIMIT) fail('Review history size limit reached.');
    const temp = join(root, '.review-' + randomUUID() + '.tmp');
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp, path); } finally { if (existsSync(temp)) unlinkSync(temp); }
    return entry as ChainEntry<I>;
  } finally { closeSync(lock); unlinkSync(join(root, lockName)); }
}
