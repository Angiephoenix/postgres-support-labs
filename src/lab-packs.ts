import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, fail, validateArtifact } from './contracts.ts';
import { readBounded } from './ledger.ts';
import { labCatalog } from './native-lab.ts';
import { POOLING_QUERIES, POOLING_PHASES } from './pooling-evidence.ts';
import { REMEDIES } from './pooling-review.ts';
import { PHASES as SCHEMA_PHASES } from './support-bundle.ts';
import { INDEX_QUERIES, INDEX_PHASES } from './index-evidence.ts';
import { INDEX_REMEDIES } from './index-review.ts';
import { CONNECTIVITY_QUERIES, CONNECTIVITY_PHASES } from './connectivity-evidence.ts';
import { CONNECTIVITY_REMEDIES } from './connectivity-review.ts';
import { PERMISSIONS_QUERIES, PERMISSIONS_PHASES } from './permissions-evidence.ts';
import { PERMISSIONS_REMEDIES } from './permissions-review.ts';
import { LEAK_QUERIES, LEAK_PHASES } from './pool-exhaustion-evidence.ts';
import { LEAK_REMEDIES } from './pool-exhaustion-review.ts';
import packSchema from '../schemas/lab-pack.v1.json' with { type: 'json' };
import schemaManifest from '../schemas/export-manifest.v1.json' with { type: 'json' };
import poolingManifest from '../schemas/pooling-export-manifest.v1.json' with { type: 'json' };
import indexManifest from '../schemas/index-export-manifest.v1.json' with { type: 'json' };
import connectivityManifest from '../schemas/connectivity-export-manifest.v1.json' with { type: 'json' };
import permissionsManifest from '../schemas/permissions-export-manifest.v1.json' with { type: 'json' };
import leakManifest from '../schemas/pool-exhaustion-export-manifest.v1.json' with { type: 'json' };

// A lab pack describes one lab: its support question, phases, controls, fixes and bundle format.
// Pack files never contain SQL. A working pack pins the hash of the probe catalog bundled in code,
// so a pack and its lab's code cannot drift apart without loading failing.
export type LabPack = {
  schemaVersion: 1; id: string; title: string; status: 'working'|'planned'; question: string; exercises: string; profile: 'local-lab';
  probeCatalog: { source: 'native-lab'|'pooling-evidence'|'index-evidence'|'connectivity-evidence'|'permissions-evidence'|'pool-exhaustion-evidence'; sha256: string } | null;
  phases: string[]; controls: { phase: string; purpose: string }[]; remedies: string[]; competingExplanations: string[];
  bundle: { scenario: 'schema-resolution'|'pooling-session'|'slow-query-index'|'tls-trust'|'table-privilege'|'connection-leak'; toolVersions: string[] } | null; guide: string | null; stillToBuild: string[];
};

// The only code a working pack may refer to. Each entry is the lab's bundled, reviewed implementation.
// `controls` pins the phases each lab's comparison reads as controls (lab-review.ts, pooling-review.ts, index-review.ts, connectivity-review.ts).
const IMPLEMENTATIONS = {
  'schema-drift': { source: 'native-lab', catalog: () => labCatalog(), phases: () => SCHEMA_PHASES, remedies: () => ['apply-bundled-migration'], controls: ['search-path-control'],
    scenario: 'schema-resolution', versions: () => (schemaManifest as any).properties.toolVersion.enum as string[] },
  'pgbouncer-session': { source: 'pooling-evidence', catalog: () => POOLING_QUERIES, phases: () => [...POOLING_PHASES], remedies: () => [...REMEDIES], controls: ['direct-reset', 'timeout-control'],
    scenario: 'pooling-session', versions: () => (poolingManifest as any).properties.toolVersion.enum as string[] },
  'slow-query-index': { source: 'index-evidence', catalog: () => INDEX_QUERIES, phases: () => [...INDEX_PHASES], remedies: () => [...INDEX_REMEDIES],
    controls: ['stats-unanalyzed', 'stats-analyzed-repeat', 'index-applied-repeat', 'common-value'],
    scenario: 'slow-query-index', versions: () => (indexManifest as any).properties.toolVersion.enum as string[] },
  'connectivity': { source: 'connectivity-evidence', catalog: () => CONNECTIVITY_QUERIES, phases: () => [...CONNECTIVITY_PHASES], remedies: () => [...CONNECTIVITY_REMEDIES],
    controls: ['wrong-ca', 'hostname-mismatch', 'require-driver-default', 'require-libpq-compat', 'no-tls', 'wrong-password', 'unknown-role', 'wrong-database',
      'password-hash-unencoded', 'password-at-unencoded', 'password-both-unencoded', 'password-both-encoded', 'tcp-refused'],
    scenario: 'tls-trust', versions: () => (connectivityManifest as any).properties.toolVersion.enum as string[] },
  'permissions': { source: 'permissions-evidence', catalog: () => PERMISSIONS_QUERIES, phases: () => [...PERMISSIONS_PHASES], remedies: () => [...PERMISSIONS_REMEDIES],
    controls: ['wrong-role', 'schema-usage-missing', 'search-path-missing', 'wrong-role-after-fix'],
    scenario: 'table-privilege', versions: () => (permissionsManifest as any).properties.toolVersion.enum as string[] },
  'pool-exhaustion': { source: 'pool-exhaustion-evidence', catalog: () => LEAK_QUERIES, phases: () => [...LEAK_PHASES], remedies: () => [...LEAK_REMEDIES],
    controls: ['demand-beyond-capacity', 'slow-query', 'long-transaction', 'server-refusal', 'demand-beyond-capacity-after-fix'],
    scenario: 'connection-leak', versions: () => (leakManifest as any).properties.toolVersion.enum as string[] },
} as const;
// Version one has exactly these six labs. Planned labs stay listed until they are built.
export const PACK_IDS = ['schema-drift', 'pgbouncer-session', 'connectivity', 'permissions', 'slow-query-index', 'pool-exhaustion'] as const;
const DEFAULT_DIR = fileURLToPath(new URL('../packs/', import.meta.url));
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function checkPack(pack: LabPack) {
  const impl = (IMPLEMENTATIONS as Record<string, typeof IMPLEMENTATIONS[keyof typeof IMPLEMENTATIONS]>)[pack.id];
  if (pack.status === 'planned') {
    if (impl || pack.probeCatalog || pack.phases.length || pack.controls.length || pack.remedies.length || pack.bundle) fail(`Planned pack ${pack.id} must not claim an implementation.`);
    return;
  }
  if (!impl || !pack.probeCatalog || !pack.bundle || !pack.guide) fail(`Working pack ${pack.id} has no matching bundled implementation.`);
  if (pack.probeCatalog.source !== impl.source || pack.probeCatalog.sha256 !== hash(impl.catalog())) fail(`Pack ${pack.id} does not match its bundled probe catalog.`);
  if (!same(pack.phases, impl.phases())) fail(`Pack ${pack.id} phases differ from its lab.`);
  const controls = pack.controls.map(c => c.phase);
  if (new Set(controls).size !== controls.length) fail(`Pack ${pack.id} lists a control more than once.`);
  const missing = impl.controls.filter(c => !controls.includes(c)), unexpected = controls.filter(c => !(impl.controls as readonly string[]).includes(c));
  if (missing.length) fail(`Pack ${pack.id} is missing controls its lab runs: ${missing.join(', ')}.`);
  if (unexpected.length) fail(`Pack ${pack.id} names controls its lab does not run: ${unexpected.join(', ')}.`);
  if (!same([...pack.remedies].sort(), [...impl.remedies()].sort())) fail(`Pack ${pack.id} fixes differ from its lab.`);
  if (pack.bundle.scenario !== impl.scenario || !same(pack.bundle.toolVersions, impl.versions())) fail(`Pack ${pack.id} bundle versions differ from its lab.`);
}

function packDirectory(dir: string) { const stat = lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Pack directory must be a regular directory.'); }

// Loads and checks one pack against the code it describes. Other pack files are not read.
export function loadPack(id: typeof PACK_IDS[number], dir = DEFAULT_DIR): LabPack {
  packDirectory(dir);
  const pack = JSON.parse(readBounded(join(dir, id + '.json'), 65536)) as LabPack;
  validateArtifact(pack, packSchema);
  if (pack.id !== id) fail(`Pack file ${id}.json declares a different id.`);
  checkPack(pack);
  return pack;
}

// Checks every pack file. CI runs this through `lab packs --check`; lab runners do not depend on it.
export function loadPacks(dir = DEFAULT_DIR): LabPack[] {
  packDirectory(dir);
  if (!same(readdirSync(dir).sort(), [...PACK_IDS].map(id => id + '.json').sort())) fail('Pack directory must hold exactly the six version-one pack files.');
  return PACK_IDS.map(id => loadPack(id, dir));
}

// Lab runners call this before starting any server. Only the selected pack and the bundled code it
// pins are checked, so a broken planned or unrelated pack cannot stop a working lab.
// Execution uses only the SQL bundled in code.
export function requireWorkingPack(id: 'schema-drift'|'pgbouncer-session'|'slow-query-index'|'connectivity'|'permissions'|'pool-exhaustion', dir = DEFAULT_DIR) {
  const pack = loadPack(id, dir);
  if (pack.status !== 'working') fail(`Pack ${id} is not available to run.`);
  return pack;
}

export function formatPacks(packs: LabPack[]) {
  return packs.map(p => [`${p.title} (${p.id})`, `  Status: ${p.status === 'working' ? 'working' : 'planned, not built yet'}`, `  Question: ${p.question}`,
    ...(p.guide ? [`  Guide: ${p.guide}`] : []), ...(p.stillToBuild.length ? ['  Still to build:', ...p.stillToBuild.map(s => `  - ${s}`)] : [])].join('\n')).join('\n\n');
}
