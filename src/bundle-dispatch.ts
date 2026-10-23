import { join, resolve } from 'node:path';
import { fail } from './contracts.ts';
import { readBounded } from './ledger.ts';
import { verifyBundle } from './support-bundle.ts';
import { verifyPoolingBundle, POOLING_TOOL_VERSIONS } from './pooling-bundle.ts';
import { verifyIndexBundle, INDEX_TOOL_VERSIONS } from './index-bundle.ts';
import { verifyConnectivityBundle, CONNECTIVITY_TOOL_VERSIONS } from './connectivity-bundle.ts';
import { verifyPermissionsBundle, PERMISSIONS_TOOL_VERSIONS } from './permissions-bundle.ts';
import { verifyLeakBundle, LEAK_TOOL_VERSIONS } from './pool-exhaustion-bundle.ts';

// Chooses a verifier from the manifest. Unknown scenario or version combinations are refused.
export function verifyAnyBundle(dir: string, options: { expectedManifestHash?: string; now?: Date } = {}) {
  let manifest: any;
  try { manifest = JSON.parse(readBounded(join(resolve(dir), 'manifest.json'), 65536)); }
  catch { return fail('Bundle manifest is missing or invalid.'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Bundle manifest is missing or invalid.');
  if (Object.hasOwn(manifest, 'scenario')) {
    if (manifest.scenario === 'pooling-session' && (POOLING_TOOL_VERSIONS as readonly string[]).includes(manifest.toolVersion)) return verifyPoolingBundle(dir, options);
    if (manifest.scenario === 'slow-query-index' && (INDEX_TOOL_VERSIONS as readonly string[]).includes(manifest.toolVersion)) return verifyIndexBundle(dir, options);
    if (manifest.scenario === 'tls-trust' && (CONNECTIVITY_TOOL_VERSIONS as readonly string[]).includes(manifest.toolVersion)) return verifyConnectivityBundle(dir, options);
    if (manifest.scenario === 'table-privilege' && (PERMISSIONS_TOOL_VERSIONS as readonly string[]).includes(manifest.toolVersion)) return verifyPermissionsBundle(dir, options);
    if (manifest.scenario === 'connection-leak' && (LEAK_TOOL_VERSIONS as readonly string[]).includes(manifest.toolVersion)) return verifyLeakBundle(dir, options);
    fail('Unsupported bundle scenario or version.');
  }
  // Schema-resolution bundles predate the scenario field; their verifier checks its own version list.
  return verifyBundle(dir, options);
}
