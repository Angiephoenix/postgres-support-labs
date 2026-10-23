import { reportStyles, fontLicenses } from './report-theme.ts';
import { printStyles, evidenceItems } from './report-print.ts';
export function escapeHtml(value: unknown) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export function bundleHtml(model: any) {
  const { review, validation, generatedAt, mode, observations, timeline, facts } = model;
  const accepted = mode === 'reviewed';
  const e = escapeHtml, value = (v: unknown) => e(Array.isArray(v) ? v.join(', ') : v === null ? 'Not recorded' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
  const label = (field: string, v: unknown) => e(displayValue(field, v));
  const refs = (ids: string[]) => ids.map(id => `<a class="ref" href="#${e(id)}">${e(id)}</a>`).join(' ');
  const table = review.changed.map((f: any) => `<tr><th scope="row">${e(f.field)}</th><td>${label(f.field,f.before)}</td><td>${label(f.field,f.after)}</td></tr>`).join('');
  const parts = observations.map(({phase, entry}: any) => {
    const o = entry.observation;
    return { id: `${e(o.artifactId)}`, summary: `<span>${e(o.kind === 'failure_observation' ? (o.probeId === 'qualified_control' ? 'Schema-qualified control query' : 'Application query result') : o.kind.replaceAll('_',' '))}</span><small>${e(phase)}</small>`,
      detail: `<p class="mono">${e(o.artifactId)}</p><p>Collected ${e(o.collectedAt)}<br>Expires ${e(o.expiresAt)}</p><p>${e(o.result.limitations)}</p><pre>${e(JSON.stringify(o.result,null,2))}</pre><p>Parents: ${o.parents.length ? refs(o.parents) : 'Root observation'}</p><p class="mono">Entry hash: ${e(entry.hash)}</p>` };
  });
  const cards = model.print ? evidenceItems(parts) : parts.map((c: any) => `<details id="${c.id}"><summary>${c.summary}</summary><div class="detail">${c.detail}</div></details>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>Postgres Support Lab | Investigation bundle</title>
<style>${model.styles ?? reportStyles}${model.print ? printStyles : ''}</style></head><body><a class="skip" href="#report">Skip to report</a><aside><div class="brand"><span class="brand-mark" aria-hidden="true">p:</span>Postgres<br> Support Lab</div><p class="tag">Investigation bundle<br>Local PostgreSQL · Synthetic data</p><p class="nav-label">Case contents</p><nav aria-label="Report sections"><a href="#finding">Finding & scope</a><a href="#comparison">Before & after</a><a href="#control">Same-error control</a><a href="#validation">Validation</a><a href="#timeline">Timeline</a><a href="#evidence">Evidence ledger</a><a href="#handoff">Handoff drafts</a></nav><p class="side-note">Independent project.<br>Customer environment unverified.<br>No outgoing message is approved.</p></aside>
<main id="report"><div class="topline"><span>Investigation / schema resolution</span><b>Local lab · Synthetic data</b></div><header><div class="eyebrow">Schema-resolution investigation</div>${header(model.copyRevision ?? 1, accepted)}<p class="meta">Run ${e(review.runId)}<br>Exported ${e(generatedAt)}</p></header>
<div class="banner"><strong>Recorded snapshot.</strong> Statuses describe the evidence at export time. Recheck freshness with <code>lab verify-bundle</code> before relying on current support. The disposable cluster has been removed.</div>
<div class="stats"><div class="stat"><span>Human review at export</span><strong>${accepted?'Accepted for local lab':'Evidence or review pending'}</strong></div><div class="stat"><span>Recorded observations</span><strong>${observations.length} · four snapshots</strong></div><div class="stat"><span>Customer resolution</span><strong>Unverified</strong></div></div>
<section class="panel" id="finding"><h2>Finding & scope</h2><span class="status">${accepted?'SUPPORTED_CAUSE · local-lab':'UNVERIFIED_HYPOTHESIS'}</span><p>${accepted?'The reviewer accepted the missing migration as the cause of this local reproduction.':'The missing-migration explanation remains a candidate in this gap report.'}</p><p>Migration: ${label('migration applied',facts['migration applied'].before)} before; ${label('migration applied',facts['migration applied'].after)} after. Query outcome: ${value(facts['query outcome'].before)} before, ${value(facts['query outcome'].after)} after. Matching rows afterward: ${value(facts['matching rows'].after)}.</p><p class="scope">${e(validation.limitation)}</p>${accepted?`<p>Reviewer: ${e(review.reviews.at(-1).input.reviewer)}</p><blockquote>${e(review.reviews.at(-1).input.rationale)}</blockquote>`:''}<p class="mono">Comparison ${e(review.comparisonHash)}<br>Review head ${e(review.reviewHead)}</p></section>
<section class="panel" id="comparison"><h2>What changed after the migration</h2><div class="table-wrap"><table><thead><tr><th>Observation</th><th>Before</th><th>After</th></tr></thead><tbody>${table}</tbody></table></div><p>Source observations: ${refs(['before-migration_state','after-migration_state','before-relation_inventory','after-relation_inventory','before-failure_observation','after-failure_observation'])}</p><h3>Unchanged context</h3><div class="context">${review.unchanged.map((f:any)=>`<div><b>${e(f.field)}</b><code>${value(f.before)}</code></div>`).join('')}</div></section>
<section class="panel" id="control"><h2>The same-error control</h2><p>SQLSTATE <strong>${e(review.controls.searchPath.sqlstate)}</strong> was recorded. Migration: ${label('migration applied',review.controls.searchPath.migrationApplied)}. Relation: ${label('relation present',review.controls.searchPath.relationPresent)}. Visibility through the search path: ${label('relation visible',review.controls.searchPath.relationVisible)}. The schema-qualified query returned ${e(review.controls.searchPath.qualifiedRows)} matching row.</p><p>${refs(['search-path-control-effective_context','search-path-control-relation_inventory','search-path-control-failure_observation-qualified'])}</p><p class="scope">This control demonstrates an alternative explanation in its own database. It does not establish the state of a customer connection.</p></section>
<section class="panel" id="validation"><h2>Validation at export</h2><span class="status">${accepted?e(validation.status)+' · local-lab':'GAP_REPORT · no validated finding'}</span><ul>${validation.checks.map((c:any)=>`<li><strong>${c.passed?'Passed':'Pending'}:</strong> ${e(c.id.replaceAll('-',' '))}</li>`).join('')}</ul><p>${refs(['before-failure_observation','after-failure_observation'])}</p>${validation.blockers.length?`<h3>Remaining blockers</h3><ul>${validation.blockers.map((b:string)=>`<li>${e(b)}</li>`).join('')}</ul>`:''}<p class="scope">No customer fix has been validated. Customer-message approval is pending.</p></section>
<section class="panel" id="timeline"><h2>Investigation timeline</h2><ol class="timeline">${timeline.map((item:any)=>`<li><strong>${e(item.label)}</strong><small>${e(item.at)}</small>${refs(item.evidenceIds??[])}</li>`).join('')}</ol><p class="scope">Collection and review times are recorded. The bundled migration ran between the before and after snapshots; a separate action timestamp was not collected.</p></section>
<section class="panel" id="evidence"><h2>Inspect the evidence</h2><p>Expand a record to read its result, collection time, expiry, limitations and parent references.</p>${cards}</section>
<section class="panel" id="handoff"><h2>Handoff drafts</h2><p>These files share the same evidence snapshot. Customer communication and playbook publication require separate human approval.</p><div class="files">${[['case-summary.md','Case summary'],['customer-reply.md','Customer reply draft'],['engineering-escalation.md','Engineering handoff draft'],['runbook-candidate.md','Runbook candidate'],['resolution-validation.md','Validation record'],['evidence-gap-report.md','Evidence gaps'],['reproduction.md','Reproduction steps'],['manifest.json','Integrity manifest']].map(([path,label])=>`<a href="${path.endsWith('.md')?'#document-'+path.replace('.md',''):path}">${label}</a>`).join('')}</div>${Object.entries(model.documents ?? {}).map(([path,text]) => `<details open class="draft" id="document-${e(path.replace('.md',''))}"><summary>${e(path.replace('.md','').replaceAll('-',' '))}</summary><div class="detail document">${documentHtml(String(text))}<p class="download"><a href="${e(path)}">Open Markdown source</a></p></div></details>`).join('')}</section>
<footer>Postgres Support Lab · Signal design ${model.designRevision ?? 2} · Bundle schema 1 · Caller-supplied reviewer identity · Hashes support consistency checks and require a separately trusted anchor to detect a complete rewrite.${fontLicenses.map(f=>`<details class="license"><summary>${e(f.name)} font license</summary><pre>${e(f.text)}</pre></details>`).join('')}</footer></main></body></html>\n`;
}

// Heading copy is part of each bundle version's rendered bytes. Revision 1 is frozen for bundle2 and bundle3.
function header(revision: number, accepted: boolean) {
  if (revision === 1) return '<h1>One error.<br>Two different explanations.</h1><p class="lede">Follow a missing relation from its original failure through a controlled migration, with a search-path control showing why the SQLSTATE alone cannot establish the cause.</p>';
  return '<h1>Why can\u2019t the app find the table?</h1>' + (accepted
    ? '<p class="lede">In this local test, the migration had run in development but was missing from the affected database. Applying it made the query work.</p><p class="lede">We also reproduced the same error with the table present but outside the app\u2019s search path. That\u2019s the list of schemas PostgreSQL checks when a query doesn\u2019t name one. Both situations produced the same error, so we needed more than the error message to work out what happened.</p>'
    : '<p class="lede">This report records a local investigation of a \u201crelation does not exist\u201d error that isn\u2019t complete yet. It doesn\u2019t support a cause. The evidence collected so far and the remaining gaps are listed below.</p>');
}

// Human labels apply only to presentation. Original typed results remain in each evidence record.
export function displayValue(field: string, value: unknown): string {
  if (value === null) return field === 'SQLSTATE' ? 'None recorded' : field === 'relation SELECT' ? 'Unknown' : 'Not recorded';
  if (typeof value === 'boolean') {
    const labels: Record<string, [string,string]> = {
      'migration applied':['Not applied','Applied'], 'relation present':['Absent','Present'],
      'relation visible':['Not visible','Visible'], 'relation SELECT':['Not granted','Granted'], 'schema USAGE':['Not granted','Granted']
    };
    return labels[field]?.[Number(value)] ?? (value ? 'Yes' : 'No');
  }
  return Array.isArray(value) ? value.join(', ') : String(value);
}
// The generated document subset contains headings, paragraphs, lists and fenced code.
// Escape first. Raw HTML and links from evidence never become active markup.
export function documentHtml(text: string): string {
  let code=false, list='', output='';
  const closeList=()=>{ if(list) { output+='</'+list+'>'; list=''; } };
  for(const line of text.split('\n')) {
    if(line.startsWith('```')) { closeList(); output+=code?'</code></pre>':'<pre><code>'; code=!code; continue; }
    if(code) { output+=escapeHtml(line)+'\n'; continue; }
    if(!line.trim()) { closeList(); continue; }
    const heading=/^(#{1,2}) (.*)$/.exec(line), item=/^(?:- |\d+\. )(.*)$/.exec(line);
    if(heading) { closeList(); const level=heading[1].length+2; output+=`<h${level}>${escapeHtml(heading[2])}</h${level}>`; }
    else if(item) { const kind=line.startsWith('- ')?'ul':'ol'; if(list!==kind) { closeList(); list=kind; output+='<'+kind+'>'; } output+='<li>'+escapeHtml(item[1])+'</li>'; }
    else { closeList(); output+='<p>'+escapeHtml(line)+'</p>'; }
  }
  closeList(); if(code) output+='</code></pre>'; return output;
}
