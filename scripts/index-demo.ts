import { mkdirSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LedgerError } from '../src/contracts.ts';
import { indexPlan, runIndexLab } from '../src/index-lab.ts';
import { inspectIndex, indexMarkdown } from '../src/index-evidence.ts';

const args = process.argv.slice(2);
try {
  if (args[0] === 'inspect') {
    if (args.length < 2 || args.length > 3 || args[2] !== undefined && !/^[a-f0-9]{64}$/.test(args[2])) throw new LedgerError('Use inspect RUN_DIRECTORY [MANIFEST_HASH].');
    const result = inspectIndex(args[1], args[2]);
    console.log(JSON.stringify({ ...result, run: undefined }, null, 2));
    console.log(indexMarkdown(result.run));
  } else {
    if (args.length > 1 || args.some(a => !['--dry-run','--approve-lab'].includes(a))) throw new LedgerError('Use --dry-run or --approve-lab. External URLs and custom SQL are unsupported.');
    if (args[0] !== '--approve-lab') {
      console.log(JSON.stringify(indexPlan(), null, 2));
      console.log('To execute: npm run demo:index -- --approve-lab');
    } else {
      mkdirSync('cases', { recursive: true, mode: 0o700 });
      if (lstatSync('cases').isSymbolicLink()) throw new LedgerError('Use a regular cases directory.');
      const output = resolve('cases', 'index-' + randomUUID());
      const result = await runIndexLab({ approved: true, output });
      console.log(indexMarkdown(result.run));
      console.log(`Cleanup: COMPLETE\nArtifacts: ${output}\nManifest hash: ${result.manifestHash}\nOpen: ${output}/index-report.html`);
    }
  }
} catch (error) {
  console.error(error instanceof LedgerError ? error.message : 'Index workflow failed. Check server tools, artifact paths and permissions.');
  process.exitCode = 1;
}
