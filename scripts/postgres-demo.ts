import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { labPlan, runNativeLab } from '../src/native-lab.ts';
import { LedgerError } from '../src/contracts.ts';

const args = process.argv.slice(2);
try {
  if (args.some(arg => !['--dry-run', '--approve-lab'].includes(arg)) || args.length > 1) throw new LedgerError('Use --dry-run or --approve-lab. No database URL or custom SQL is accepted.');
  if (!args.includes('--approve-lab')) {
    console.log(JSON.stringify(labPlan(), null, 2));
    console.log('To execute this plan: npm run demo:postgres -- --approve-lab');
  } else {
    mkdirSync('cases', { recursive: true, mode: 0o700 });
    const output = resolve('cases', 'native-' + randomUUID());
    const report = await runNativeLab({ approved: true, output });
    console.log('Actual PostgreSQL lab with synthetic data.');
    for (const [phase, snapshot] of Object.entries(report.snapshots)) console.log(`${phase}: ${snapshot.outcome}; SQLSTATE ${snapshot.sqlstate ?? 'none'}; migration ${snapshot.migrationApplied ? 'present' : 'absent'}; relation ${snapshot.relationPresent ? 'present' : 'absent'}`);
    console.log(`Cleanup: ${report.cleanup}`);
    console.log(`Artifacts: ${output}`);
    console.log('Cause and customer resolution remain unset. Human review is pending.');
  }
} catch (error) {
  console.error(error instanceof LedgerError ? error.message : 'Native lab failed. Check tool availability and output-directory permissions.');
  process.exitCode = 1;
}
