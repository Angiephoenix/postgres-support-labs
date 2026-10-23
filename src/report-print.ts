// Print revision 1, used by 0.1.0-bundle5, 0.1.0-pooling-bundle3, 0.1.0-index-bundle2, 0.1.0-connectivity-bundle4,
// 0.1.0-permissions-bundle2 and 0.1.0-pool-exhaustion-bundle2. Earlier versions never include it, so their bytes don't change.
// Verification regenerates these bytes, so any change needs new bundle versions.
//
// Safari PDFs of earlier reports showed headings at page ends, short blocks split across pages and closed evidence cards
// printed as titles only. The cause isn't confirmed; these rules don't rely on break-after:avoid or on printing a closed
// <details>. In print:
// - a panel that fits on one page is kept whole, and its rule is drawn on its heading so the two stay together;
// - other headings reserve room below themselves and can't be split, so they move to the next page with what follows;
// - table rows, code blocks and list items are kept whole where they fit on a page, so a long table breaks only between rows;
// - a draft's rule is drawn on its title, and the title reserves room for the draft's own heading and the text after it;
// - each evidence card is replaced by a copy laid out without <details>. By default the copy leaves out the record's JSON.
//   With #full-evidence in the address, the JSON is included as well.
// Each evidence item's id is on a wrapper around its card and its print copy, so links reach whichever one is shown.
// The wrapper is kept whole, so a link's destination is where the record starts. A record whose JSON is too long for one
// page (class long) starts on a new page instead and flows across pages when the full JSON is printed.
export const FULL_EVIDENCE_ID = 'full-evidence';
export const printStyles = `
/* Print revision 1 */
.print-note,.print-record{display:none}
#full-evidence:target{display:block}
.evidence-item{scroll-margin-top:24px}
.evidence-item:target>details{border-color:var(--yellow)}
@media print{
.panel{border-top:0;padding-top:0;break-inside:avoid;page-break-inside:avoid}
.panel>h2{border-top:1px solid var(--line);padding-top:20px}
#report h2,#report h3,#report h4{break-inside:avoid;page-break-inside:avoid;padding-bottom:160px;margin-bottom:-160px}
#report h2+*,#report h3+*,#report h4+*{margin-top:1em}
.table-wrap{overflow:visible}
tr,.context div,.stats,blockquote,li,pre,.status{break-inside:avoid;page-break-inside:avoid}
#evidence details{display:none}
.compact-note,.print-record{display:block}
.draft{border-top:0}
.draft>summary{border-top:1px solid var(--line);break-inside:avoid;page-break-inside:avoid;padding-bottom:294px;margin-bottom:-280px}
.evidence-item{break-inside:avoid;page-break-inside:avoid}
.print-record{border-top:1px solid var(--line);margin-top:14px;padding-top:4px}
.print-record h3 small{display:block;font-weight:400;color:var(--muted)}
.print-record pre{display:none}
#full-evidence:target~.compact-note{display:none}
#full-evidence:target~.evidence-item .print-record pre{display:block;white-space:pre-wrap;font-size:8pt;line-height:1.45}
#full-evidence:target~.evidence-item.long{break-inside:auto;page-break-inside:auto;break-before:page;page-break-before:always}
#full-evidence:target~.evidence-item.long .print-record pre{break-inside:auto;page-break-inside:auto}
}`;

export type EvidenceCard = { id: string; summary: string; detail: string };

// About as many printed lines of record JSON as fit on an A4 page under the record's heading, at 8pt, wrapping at 100 characters.
export const LONG_RECORD_LINES = 50;
export const printedLines = (detail: string) =>
  (detail.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 100)), 0);

// The evidence cards for print revision 1. Ids must already be escaped.
export function evidenceItems(cards: EvidenceCard[]) {
  return `<p class="print-note" id="${FULL_EVIDENCE_ID}"><strong>Full evidence selected for printing.</strong> A printout of this report now includes every evidence record in full, which can run to many pages. Remove #${FULL_EVIDENCE_ID} from the address to print the shorter version.</p>`
    + `<p class="print-note compact-note">This printout lists each evidence record without its JSON. To print every record in full, open this report with #${FULL_EVIDENCE_ID} at the end of its address, then print again. The records are also in evidence.jsonl.</p>`
    + cards.map(c => `<div class="evidence-item${printedLines(c.detail) > LONG_RECORD_LINES ? ' long' : ''}" id="${c.id}"><details><summary>${c.summary}</summary><div class="detail">${c.detail}</div></details>`
      + `<section class="print-record"><h3>${c.summary}</h3><div class="detail">${c.detail}</div></section></div>`).join('');
}
