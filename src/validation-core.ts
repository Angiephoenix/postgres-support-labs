import { hash } from './contracts.ts';

// Every lab validates a selected fix the same way: named checks against retained local evidence,
// any blockers, and fixed statements that customer resolution and message approval stay open.
// Key order does not affect the hash or the exported JSON, because both use canonical (sorted) keys.
export type ValidationCheck = { id: string; passed: boolean; evidence: string[] };
export function validationRecord(fields: Record<string, unknown>, checks: ValidationCheck[], blockers: string[], limitation: string) {
  const material = { schemaVersion: 1, artifactType: 'validation', scope: 'local-lab', ...fields,
    status: checks.every(c => c.passed) ? 'RESOLUTION_VALIDATED' : 'VALIDATION_BLOCKED', checks, blockers,
    customerResolution: null, communicationApproval: 'PENDING', limitation };
  return { ...material, validationHash: hash(material) };
}
