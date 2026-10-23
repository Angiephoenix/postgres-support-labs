import { createHash } from 'node:crypto';
import caseSchema from '../schemas/case.v1.json' with { type: 'json' };
import observationSchema from '../schemas/observation.v1.json' with { type: 'json' };
import { privacyFindings, parseIntake } from './intake.ts';
import type { Intake } from './intake.ts';
import caseSchemaV2 from '../schemas/case.v2.json' with { type: 'json' };
import observationSchemaV2 from '../schemas/observation.v2.json' with { type: 'json' };
import caseSchemaV3 from '../schemas/case.v3.json' with { type: 'json' };
import observationSchemaV3 from '../schemas/observation.v3.json' with { type: 'json' };
export class LedgerError extends Error {}
export function fail(message: string): never { throw new LedgerError(message); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return fail('Unsupported JSON value.');
  return encoded;
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
type Rule = { const?: unknown; enum?: unknown[]; type?: string | string[]; properties?: Record<string,Rule>; required?: string[]; additionalProperties?: boolean; items?: Rule; maxItems?: number; minItems?: number; oneOf?: Rule[]; uniqueItems?: boolean; minLength?: number; maxLength?: number; pattern?: string; format?: string };
// Implements the keywords used by the bundled case and observation schemas.
function validate(value: unknown, rule: Rule): void {
  if (rule.oneOf) {
    let matches=0;
    for (const branch of rule.oneOf) {
      try { validate(value,branch); matches++; } catch(error) { if(!(error instanceof LedgerError)) throw error; }
    }
    if(matches!==1) fail('Artifact must match exactly one typed observation contract.');
  }
  if (Object.hasOwn(rule,'const') && value !== rule.const) fail('Artifact constant mismatch.');
  if (rule.enum && !rule.enum.includes(value)) fail('Artifact enum mismatch.');
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (rule.type && !(Array.isArray(rule.type) ? rule.type : [rule.type]).includes(kind)) fail('Artifact field type mismatch.');
  if (kind === 'object') {
    const v = value as Record<string, unknown>;
    if (Object.getPrototypeOf(v) !== Object.prototype) fail('Artifact must contain plain objects.');
    const props = rule.properties ?? {};
    if (rule.additionalProperties === false && Object.keys(v).some(k=>!Object.hasOwn(props,k))) fail('Unsupported artifact field.');
    if (rule.required?.some(k=>!Object.hasOwn(v,k))) fail('Missing artifact field.');
    for (const [k,item] of Object.entries(v)) if (Object.hasOwn(props,k)) validate(item,props[k]);
  }
  if (kind === 'array') {
    const v = value as unknown[];
    if (rule.minItems !== undefined && v.length < rule.minItems) fail('Too few artifact items.');
    if (rule.maxItems !== undefined && v.length > rule.maxItems) fail('Too many artifact items.');
    if (rule.uniqueItems && new Set(v.map(canonical)).size !== v.length) fail('Duplicate artifact items.');
    if (rule.items) v.forEach(x=>validate(x,rule.items!));
  }
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && (!value.trim() || value.length < rule.minLength)) fail('Empty artifact text.');
    if (rule.maxLength !== undefined && value.length > rule.maxLength) fail('Artifact text too long.');
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail('Artifact field format mismatch.');
    if (rule.format === 'date-time') {
      const d = new Date(value);
      if (!Number.isFinite(d.getTime()) || d.toISOString() !== value) fail('Use a valid UTC timestamp with milliseconds.');
    }
  }
}
function screen(value: unknown) {
  if (privacyFindings(value).length) fail('Privacy gate blocked artifact. Remove sensitive material before retrying.');
}
export type Scope = { environment:string; branchFingerprint:string; roleFingerprint:string; connectionMode:'direct'|'pooled'|'unknown'; identityMethod:'fixture-definition'|'lab-marker' };
export type LegacyCase = { schemaVersion:1; caseId:string; profile:'fixture'; scope:Scope };
export type InvestigationCase = { schemaVersion:2|3; caseId:string; profile:'fixture'|'local-lab'; scope:Scope; intake:Intake; subject:{relation:string;schema:string;migrationId:string;queryShapeHash:string;expectedBranchFingerprint:string} };
export type Case = LegacyCase | InvestigationCase;
export type Kind = 'target_identity'|'effective_context'|'relation_inventory'|'permissions'|'migration_state'|'failure_observation';
type CommonObservation = { artifactId:string; caseId:string; classification:'REPRODUCED_BEHAVIOR'; source:{type:'fixture'|'local-lab';id:string;version:string;runId?:string}; scope:Scope; probeId:string; queryHash:string; collectionScope:string; collectedAt:string; expiresAt:string; collectorVersion:string; redactionStatus:'synthetic-reviewed'; parents:string[]; supersedes:string|null; correctionReason:string|null };
export type LegacyObservation = CommonObservation & {schemaVersion:1;result:{relation:string;schema:string;visible:boolean;sqlstate:string|null;limitations:string}};
export type Results = {
  target_identity:{expectedBranchFingerprint:string;observedBranchFingerprint:string;method:'fixture-definition'|'lab-marker';serverVersion?:string;clusterFingerprint?:string;limitations:string};
  effective_context:{database:string;roleFingerprint:string;searchPath:string[];currentSchema:string|null;limitations:string};
  relation_inventory:{relation:string;schema:string;visible:boolean;present?:boolean;coverage:'visible-to-role'|'fixture-complete';limitations:string};
  permissions:{relation:string;schema:string;schemaUsage:boolean;relationSelect:boolean|null;limitations:string};
  migration_state:{migrationId:string;targetBranchFingerprint:string;applied:boolean;limitations:string};
  failure_observation:{relation:string;schema:string;sqlstate:string|null;queryShapeHash:string;outcome:'error'|'success';matchingRows?:string|null;limitations:string};
};
export type TypedObservation = { [K in Kind]:CommonObservation & {schemaVersion:2|3;kind:K;result:Results[K]} }[Kind];
export type Observation = LegacyObservation | TypedObservation;
export function parseCase(value: unknown): Case {
  const version=(value as {schemaVersion?:unknown} | null)?.schemaVersion;
  validate(value,(version===3?caseSchemaV3:version===2?caseSchemaV2:caseSchema) as Rule); screen(value);
  if(version===2 || version===3) {
    const c=value as InvestigationCase;
    parseIntake(c.intake);
    if(c.intake.environment && c.intake.environment!=='unknown' && c.intake.environment!==c.scope.environment) fail('Intake environment differs from the case scope.');
    if(c.intake.relation && c.intake.relation!=='unknown' && c.intake.relation!==c.subject.relation) fail('Intake relation differs from the case subject.');
    if(c.intake.connectionMode && c.intake.connectionMode!=='unknown' && c.intake.connectionMode!==c.scope.connectionMode) fail('Intake connection mode differs from the case scope.');
    if(c.intake.dataSensitivity!=='synthetic') fail('Lab and fixture investigations require explicitly synthetic intake.');
  }
  return JSON.parse(canonical(value));
}
export function parseObservation(value: unknown): Observation {
  const version=(value as {schemaVersion?:unknown} | null)?.schemaVersion;
  validate(value,(version===3?observationSchemaV3:version===2?observationSchemaV2:observationSchema) as Rule); screen(value);
  const o = value as Observation;
  if (Date.parse(o.expiresAt) <= Date.parse(o.collectedAt)) fail('Expiry must follow collection time.');
  if ((o.supersedes === null) !== (o.correctionReason === null)) fail('Corrections require a target and reason.');
  if(o.schemaVersion!==1) {
    if(o.schemaVersion===3 && o.kind==='failure_observation' && ((o.result.outcome==='error') !== (o.result.matchingRows===null))) fail('Failure outcome and row count disagree.');
    if(o.schemaVersion===3 && o.kind==='relation_inventory' && o.result.visible && !o.result.present) fail('An absent relation cannot be visible.');
    if(o.kind==='failure_observation' && ((o.result.outcome==='error') !== (o.result.sqlstate!==null))) fail('Failure outcome and SQLSTATE disagree.');
    if(o.kind==='target_identity' && o.result.observedBranchFingerprint!==o.scope.branchFingerprint) fail('Observed identity differs from provenance scope.');
    if(o.kind==='effective_context' && o.result.roleFingerprint!==o.scope.roleFingerprint) fail('Observed role differs from provenance scope.');
    if(o.kind==='migration_state' && o.result.targetBranchFingerprint!==o.scope.branchFingerprint) fail('Migration target differs from provenance scope.');
  }
  return JSON.parse(canonical(value));
}
// A correction may update facts but must retain the subject of the original probe.
export function observationSubject(o:Observation): unknown {
  if(o.schemaVersion===1) return {schemaVersion:1,relation:o.result.relation,schema:o.result.schema};
  switch(o.kind) {
    case 'relation_inventory':case 'permissions':return {kind:o.kind,relation:o.result.relation,schema:o.result.schema};
    case 'failure_observation':return {kind:o.kind,relation:o.result.relation,schema:o.result.schema,queryShapeHash:o.result.queryShapeHash};
    case 'migration_state':return {kind:o.kind,migrationId:o.result.migrationId};
    case 'target_identity':return {kind:o.kind,expectedBranchFingerprint:o.result.expectedBranchFingerprint};
    case 'effective_context':return {kind:o.kind,database:o.result.database};
  }
}

export function validateArtifact(value: unknown, schema: unknown): void {
  validate(value, schema as Rule); screen(value);
}
