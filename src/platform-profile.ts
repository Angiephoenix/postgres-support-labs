import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fail, validateArtifact } from './contracts.ts';
import { readBounded } from './ledger.ts';
import profileSchema from '../schemas/platform-profile.v1.json' with { type: 'json' };

// A platform profile holds documented facts about a managed platform, each with the exact source
// passage, its URL, retrieval time and hashes. It records documentation, never observations:
// nothing in a profile was tested against the platform or a customer environment.
export type Topic = 'pooling'|'ssl'|'connection-string';
export type PlatformProfile = {
  schemaVersion: 1; id: 'planetscale-postgres'; title: string; scope: string;
  sources: { id: string; url: string; markdownUrl: string; retrievedAt: string; markdownSha256: string; htmlSha256: string }[];
  facts: { id: string; topic: Topic; classification: 'DOCUMENTED_BEHAVIOR'; statement: string; sourceId: string; passage: string; passageSha256: string }[];
  customerQuestions: { id: string; topic: Topic; question: string; facts: string[] }[];
};
const sha256 = (text: string|Buffer) => createHash('sha256').update(text).digest('hex');
const DEFAULT_PATH = fileURLToPath(new URL('../profiles/planetscale-postgres.v1.json', import.meta.url));
const unique = (ids: string[]) => new Set(ids).size === ids.length;

export function loadProfile(path = DEFAULT_PATH): PlatformProfile {
  const profile = JSON.parse(readBounded(path, 262144)) as PlatformProfile;
  validateArtifact(profile, profileSchema);
  const sources = new Set(profile.sources.map(s => s.id)), facts = new Set(profile.facts.map(f => f.id));
  if (!unique(profile.sources.map(s => s.id)) || !unique([...facts]) || facts.size !== profile.facts.length || !unique(profile.customerQuestions.map(q => q.id))) fail('Profile ids must be unique.');
  for (const s of profile.sources) if (s.markdownUrl !== s.url + '.md') fail('Profile source Markdown URL must match its page URL.');
  for (const f of profile.facts) {
    if (!sources.has(f.sourceId)) fail(`Profile fact ${f.id} names an unknown source.`);
    if (sha256(f.passage) !== f.passageSha256) fail(`Profile fact ${f.id} passage does not match its hash.`);
  }
  for (const q of profile.customerQuestions) if (q.facts.some(id => !facts.has(id))) fail(`Customer question ${q.id} names an unknown fact.`);
  return profile;
}

// Rechecks a profile against freshly downloaded copies of its sources, saved as <source id>.md in dir.
// A retained passage shows only that its words are still on the page. Any change to a page can alter
// what a passage means in context, so every changed or missing page needs a person to review it.
// A missing passage is reported, and requires review, even when the page hash matches.
// missingPassages is null when the page copy is missing and could not be checked.
export function checkProfileSources(profile: PlatformProfile, dir: string) {
  const names = new Set(readdirSync(dir));
  const sources = profile.sources.map(s => {
    if (!names.has(s.id + '.md')) return { id: s.id, status: 'MISSING' as const, missingPassages: null };
    const body = readFileSync(join(dir, s.id + '.md'));
    const missingPassages = profile.facts.filter(f => f.sourceId === s.id && !body.includes(Buffer.from(f.passage))).map(f => f.id);
    return { id: s.id, status: missingPassages.length ? 'PASSAGES_CHANGED' as const : sha256(body) === s.markdownSha256 ? 'UNCHANGED' as const : 'PAGE_CHANGED_PASSAGES_PRESENT' as const, missingPassages };
  });
  return { profile: profile.id, checked: sources.length, sources,
    allPassagesPresent: sources.every(s => s.missingPassages !== null && s.missingPassages.length === 0),
    sourceReviewRequired: sources.some(s => s.status !== 'UNCHANGED') };
}
