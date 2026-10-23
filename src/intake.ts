import schema from '../schemas/intake.v1.json' with { type: 'json' };
export type Intake = { schemaVersion: 1; report: string; expectedBehavior: string; [key: string]: string | number };
const patterns: [string, RegExp][] = [
  ['connection URI', /\bpostgres(?:ql)?:\/\/\S+/i],
  ['credential assignment', /["']?\b(?:password|passwd|pwd|token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*\S+/i],
  ['bearer credential', /\bbearer\s+\S+/i],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['cloud access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['email address', /\b[^\s@]+@[^\s@]+\.[^\s@]+/],
  ['SQL literal', /'(?:[^']|'')*'/],
];
export function privacyFindings(value: unknown): string[] {
  const findings = new Set<string>();
  function visit(v: unknown) {
    if (typeof v === 'string') for (const [label, rx] of patterns) { if(rx.test(v)) findings.add(label); }
    else if (Array.isArray(v)) v.forEach(visit);
    else if(v && typeof v === 'object') for(const [key, item] of Object.entries(v)) { visit(key); visit(item); }
  }
  visit(value); return [...findings];
}
export function parseIntake(value: unknown): Intake {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Intake must be an object.');
  const findings = privacyFindings(value);
  if(findings.length) throw Error('Privacy gate blocked input. Remove sensitive material before retrying.');
  const v = value as Record<string, unknown>;
  const properties = schema.properties as Record<string, {const?: unknown; type?: string; minLength?: number; maxLength?: number; pattern?: string; enum?: string[]}>;
  if(Object.keys(v).some(k => !Object.hasOwn(properties,k))) throw Error('Intake contains unsupported fields.');
  for(const k of schema.required) if(!Object.hasOwn(v,k)) throw Error(`Required intake field: ${k}.`);
  for(const [k, item] of Object.entries(v)) {
    const rule = properties[k];
    if(k === 'schemaVersion') { if(item !== 1) throw Error('Unsupported schema version.'); continue; }
    if(typeof item !== 'string' || !item.trim() || item.length > 8000) throw Error(`Invalid intake field: ${k}.`);
    if(rule.pattern && !new RegExp(rule.pattern).test(item)) throw Error(`Invalid intake field: ${k}.`);
    if(rule.enum && !rule.enum.includes(item)) throw Error(`Invalid intake field: ${k}.`);
  }
  if(v.report === 'unknown' || v.expectedBehavior === 'unknown') throw Error('Describe the report and expected behavior.');
  return Object.freeze({...v}) as Intake;
}
