import { mkdirSync, writeFileSync, rmSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, fail, validateArtifact } from './contracts.ts';
import { privacyFindings } from './intake.ts';
import { readBounded } from './ledger.ts';

// Shared mechanics for every lab's support bundle: reading and checking captured sources,
// writing an export, and checking an export's integrity. Each lab keeps its own outputs,
// manifest fields and rebuild step, so existing bundle bytes and hashes are unchanged.
export const MAX_FILE = 8*1024*1024, MAX_TOTAL = 16*1024*1024;
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const json = (value: unknown) => canonical(value) + '\n';
export type Mode = 'reviewed'|'gaps';

export type BundleLayout = {
  sourcePaths: readonly string[]; outputPaths: readonly string[];
  // Folders inside sources/, for labs that keep evidence per phase.
  sourceFolders: readonly string[];
  // The review history may be absent before anyone reviews the run.
  reviewPath: string; writeEmptyReview: boolean;
  // Sources must carry exactly the bundled probe catalog; no other SQL is accepted.
  probePath: string; probeCatalog: () => unknown;
};
export const bundlePaths = (layout: BundleLayout) => [...layout.outputPaths, ...layout.sourcePaths.map(p => 'sources/' + p)].sort();

export function directory(path: string) { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Bundle requires regular directories.'); }
export function checkMode(mode: string): asserts mode is Mode { if (!['reviewed','gaps'].includes(mode)) fail('Unknown bundle mode.'); }
function privacy(value: unknown) { if (privacyFindings(value).length) fail('Privacy gate blocked bundle source. Remove sensitive material before exporting.'); }

export function readSources(layout: BundleLayout, dir: string) {
  const root = resolve(dir); directory(root); for (const folder of layout.sourceFolders) directory(join(root, folder));
  const files: Record<string, string> = {};
  for (const path of layout.sourcePaths) {
    let raw: string;
    try { raw = readBounded(join(root, path), MAX_FILE); }
    catch (error) {
      if (path !== layout.reviewPath || (error as any).code !== 'ENOENT') throw error;
      // A dangling symlink is still an invalid source, even when its target is absent.
      try { lstatSync(join(root, path)); fail('Invalid review source.'); } catch (inner) { if ((inner as any).code !== 'ENOENT') throw inner; }
      raw = '';
    }
    if (path.endsWith('.jsonl')) for (const line of raw.split('\n').filter(Boolean)) privacy(JSON.parse(line));
    else if (path === layout.probePath) { if (canonical(JSON.parse(raw)) !== canonical(layout.probeCatalog())) fail('Bundle probe catalog differs from the bundled synthetic SQL.'); }
    else privacy(JSON.parse(raw));
    files[path] = raw;
  }
  if (Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0) > MAX_TOTAL) fail('Bundle source size limit exceeded.');
  return files;
}

export function writeSources(layout: BundleLayout, root: string, files: Record<string, string>) {
  for (const folder of layout.sourceFolders) mkdirSync(join(root, folder), { mode: 0o700 });
  for (const path of layout.sourcePaths) if (path !== layout.reviewPath || layout.writeEmptyReview || files[path]) writeFileSync(join(root, path), files[path], { flag: 'wx', mode: 0o600 });
}

// Writes every file once, never overwriting, and writes the manifest last so a partial export has no valid manifest.
export function writeExport(layout: BundleLayout, output: string, files: Record<string, string>, manifest: unknown) {
  if (Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0) > MAX_TOTAL) fail('Bundle output size limit exceeded.');
  const destination = resolve(output); directory(dirname(destination)); mkdirSync(destination, { mode: 0o700 });
  try {
    for (const folder of ['sources', ...layout.sourceFolders.map(f => 'sources/' + f)]) mkdirSync(join(destination, folder), { mode: 0o700 });
    for (const [path, text] of Object.entries(files)) writeFileSync(join(destination, path), text, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(destination, 'manifest.json'), json(manifest), { flag: 'wx', mode: 0o600 });
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
  return sha256(json(manifest));
}

export function manifestFiles(layout: BundleLayout, files: Record<string, string>) {
  return bundlePaths(layout).map(path => ({ path, sha256: sha256(files[path]), bytes: Buffer.byteLength(files[path]) }));
}

export function listFiles(layout: BundleLayout, root: string, prefix = ''): string[] {
  directory(join(root, prefix));
  return readdirSync(join(root, prefix)).flatMap(name => {
    const relative = prefix ? prefix + '/' + name : name, stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink()) fail('Symlinks are not permitted in a bundle.');
    if (stat.isDirectory()) {
      if (!['sources', ...layout.sourceFolders.map(f => 'sources/' + f)].includes(relative)) fail('Unexpected bundle directory.');
      return listFiles(layout, root, relative);
    }
    if (!stat.isFile()) fail('Unexpected bundle file type.');
    return [relative];
  });
}

// Checks the manifest, the trusted anchor, the file inventory and every digest. The caller then rebuilds its outputs.
export function checkIntegrity(layout: BundleLayout, dir: string, schema: object, options: { expectedManifestHash?: string; now?: Date }) {
  const root = resolve(dir), now = options.now ?? new Date(); directory(root);
  const raw = readBounded(join(root, 'manifest.json'), 65536), manifest = JSON.parse(raw);
  validateArtifact(manifest, schema);
  if (!Number.isFinite(now.getTime()) || new Date(manifest.generatedAt) > now) fail('Bundle verification clock is invalid or precedes export.');
  const manifestHash = sha256(raw), paths = bundlePaths(layout);
  if (options.expectedManifestHash !== undefined && options.expectedManifestHash !== manifestHash) fail('Bundle differs from the trusted manifest hash.');
  if (canonical(listFiles(layout, root).sort()) !== canonical([...paths, 'manifest.json'].sort())) fail('Bundle file inventory mismatch.');
  if (canonical(manifest.files.map((f: any) => f.path).sort()) !== canonical(paths)) fail('Manifest path inventory mismatch.');
  let total = 0;
  for (const file of manifest.files) {
    const text = readBounded(join(root, file.path), MAX_FILE); total += Buffer.byteLength(text);
    if (sha256(text) !== file.sha256 || Buffer.byteLength(text) !== file.bytes) fail('Bundle file digest or size mismatch.');
  }
  if (total > MAX_TOTAL) fail('Bundle size limit exceeded.');
  return { root, now, manifest, manifestHash };
}

// Rebuilt outputs must match the exported bytes exactly.
export function checkOutputs(layout: BundleLayout, root: string, rebuilt: Record<string, string>) {
  for (const path of layout.outputPaths) if (readBounded(join(root, path), MAX_FILE) !== rebuilt[path]) fail('Exported content disagrees with its evidence.');
}
