import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printStyles, printedLines, LONG_RECORD_LINES } from '../src/report-print.ts';
import { verifyAnyBundle } from '../src/bundle-dispatch.ts';
import { exportBundle, restyleBundle } from '../src/support-bundle.ts';
import { appendLabReview, reviewTemplate } from '../src/lab-review.ts';
import { nativeProtocolFixture } from './native-protocol-fixture.ts';
import { exportPoolingBundle } from '../src/pooling-bundle.ts';
import { poolingCase, acceptCause, selectRemedy } from './pooling-case-fixture.ts';
import { exportIndexBundle } from '../src/index-bundle.ts';
import { indexCase, acceptIndexCause, selectIndexRemedy } from './index-fixture.ts';
import { exportConnectivityBundle } from '../src/connectivity-bundle.ts';
import { connectivityCase, acceptConnectivityCause, selectConnectivityRemedy } from './connectivity-fixture.ts';
import { exportPermissionsBundle } from '../src/permissions-bundle.ts';
import { permissionsCase, acceptPermissionsCause, selectPermissionsRemedy } from './permissions-fixture.ts';
import { exportLeakBundle } from '../src/pool-exhaustion-bundle.ts';
import { leakCase, acceptLeakCause, selectLeakRemedy } from './pool-exhaustion-fixture.ts';

const temp = (t: any) => { const d = mkdtempSync(join(tmpdir(), 'report-print-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');

// Each lab's version before print revision 1 and the version that adds it, with this fixture's manifest hashes
// (reviewed, then gap-only). The earlier hashes were recorded from the code before print revision 1 existed.
const LABS = [
  { lab: 'pooling', make: (t: any) => { const c = poolingCase(t); acceptCause(c.root, c.now); selectRemedy(c.root, c.now); return c; }, exp: exportPoolingBundle,
    before: ['0.1.0-pooling-bundle2', '8ba3a5e7083e9ae7f057cd30529401c786596d134bd1ebda7e554f0952e2a1fd', '439892eaf76bdb0ad360ee6fe453ffc2458481aba58ba8649afb316174260ad2'],
    after: ['0.1.0-pooling-bundle3', '52652cbb94412952f1af7217ac3ce473be0e6f208322c6765a4698d6efe0cf8f', '4eabcb9424e3e19de12f12ec1fb1a58678bf42c41806d6ffe12f494377170052'] },
  { lab: 'index', make: (t: any) => { const c = indexCase(t); acceptIndexCause(c.root, c.now); selectIndexRemedy(c.root, c.now); return c; }, exp: exportIndexBundle,
    before: ['0.1.0-index-bundle1', '33343e7b17e2f75dca2785c2f6330f1524788e7ed7c5d367bf3adf7b096ab7cb', '1dcd336872deac7e3f89d1c1bd469ae60842525b24b72732e65188b146159bb0'],
    after: ['0.1.0-index-bundle2', '2fd26be433382d57b65376f30f4ddd77ceddb8fa1ce996389af923518939c5d7', 'd5bb05a9e7c61297730289bfc3d9768a55400ef01e0b1249f4b2b930a463bffb'] },
  { lab: 'connectivity', make: (t: any) => { const c = connectivityCase(t); acceptConnectivityCause(c.root, c.now); selectConnectivityRemedy(c.root, c.now); return c; }, exp: exportConnectivityBundle,
    before: ['0.1.0-connectivity-bundle3', '212e06448bf97432b2c2240a51f8a09140732704f2a9c565bdade20bccce39c0', '21d61465b8516194f35233068a6863bff0c016fc5fe6d9da2f25b9de146cee8b'],
    after: ['0.1.0-connectivity-bundle4', '064365aa34cf9b6a9db06736a54ce624c313c767558a935c585e4432f0bc6788', '0d39f4a3bddaf79f26f7be2407535bd855761cbefe797c46c64a29d4c4434473'] },
  { lab: 'permissions', make: (t: any) => { const c = permissionsCase(t); acceptPermissionsCause(c.root, c.now); selectPermissionsRemedy(c.root, c.now); return c; }, exp: exportPermissionsBundle,
    before: ['0.1.0-permissions-bundle1', '2e4eeaaf84adaa9568b57c4ee01422f12e91a0c18a824285e4098a6dd8d03f03', '80405b59d589e1fbb26f675949a235ea481a4730b5042fce61670a070ae26fe9'],
    after: ['0.1.0-permissions-bundle2', '40a898a335674ff5c068297242c012fbf62b46d4b371119789e5467d8c6f69bb', 'c9a934a54443fca8dd38715e4dab6a2d67594eb882e7cdec49d036ed5bf67c1d'] },
  { lab: 'pool-exhaustion', make: (t: any) => { const c = leakCase(t); acceptLeakCause(c.root, c.now); selectLeakRemedy(c.root, c.now); return c; }, exp: exportLeakBundle,
    before: ['0.1.0-pool-exhaustion-bundle1', '3a976fb09f48c25b9c5995641f1ff817d61b74e6ad6896164e8f4a53f39b8eaa', 'c82f2ff88f60f6ae8643bb3b452c69554f365804033ba64ff59e367ee73c3db2'],
    after: ['0.1.0-pool-exhaustion-bundle2', 'f597c86745b143536e093e5b50a6b12115d44108bc37ccb345a7c9ba246cb39c', '1e372dac2e410859b16651b4e1976d644cae70c443169c47b2dee8ebac92d8e8'] },
];

// The evidence items of a print-revision-1 report: each wrapper's id, its screen card and its print copy.
function evidenceItemsOf(html: string) {
  const evidence = html.slice(html.indexOf('id="evidence"'), html.indexOf('id="handoff"'));
  return [...evidence.matchAll(/<div class="evidence-item( long)?" id="([^"]+)"><details><summary>(.*?)<\/summary><div class="detail">(.*?)<\/div><\/details><section class="print-record"><h3>(.*?)<\/h3><div class="detail">(.*?)<\/div><\/section><\/div>/gs)]
    .map(m => ({ long: Boolean(m[1]), id: m[2], card: [m[3], m[4]], copy: [m[5], m[6]] }));
}
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function checkPrintRevision(html: string, label: string) {
  assert.equal(html.split(printStyles).length, 2, `${label}: print styles appear once`);
  const items = evidenceItemsOf(html), evidence = html.slice(html.indexOf('id="evidence"'), html.indexOf('id="handoff"'));
  assert.ok(items.length > 0, label);
  assert.equal(items.length, evidence.split('<details').length - 1, `${label}: every evidence card is wrapped`);
  // Each card's print copy has the same summary and detail, outside <details>.
  for (const i of items) assert.deepEqual(i.copy, i.card, `${label}: print copy of ${i.id}`);
  // A record is marked long only when its JSON can't fit on one page; short records are kept whole in print.
  for (const i of items) assert.equal(i.long, printedLines(i.card[1]) > LONG_RECORD_LINES, `${label}: ${i.id} long flag`);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, `${label}: element ids are unique`);
  // The PDF link problem: links into the evidence pointed at closed cards, which print hides, so the links had no
  // destination. Every in-page link must now reach an element that print shows: a section, a wrapper or an open draft.
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
    const at = html.match(new RegExp(`<(\\w+)([^>]*) id="${escapeRegExp(target)}"`));
    assert.ok(at, `${label}: #${target} exists`);
    assert.ok(at![1] !== 'details' || / open\b/.test(at![2]), `${label}: #${target} isn't a closed card`);
  }
  assert.doesNotMatch(evidence, /<details id=/, `${label}: no evidence card carries an id`);
  // Compact by default, full records only after the explicit #full-evidence choice. The selectors need the choice
  // and the compact note to come before the items, as siblings.
  const choice = evidence.indexOf('<p class="print-note" id="full-evidence">'), note = evidence.indexOf('<p class="print-note compact-note">');
  assert.ok(choice > 0 && note > choice && evidence.indexOf('<div class="evidence-item') > note, `${label}: choice, note, items order`);
  // Every handoff draft has a title that print keeps with the start of its contents.
  assert.ok(html.includes('<details open class="draft"'), `${label}: drafts present`);
  assert.doesNotMatch(html, /<script/);
}

test('print revision 1 prints a compact report by default and the full records only after choosing #full-evidence', () => {
  for (const rule of ['.print-note,.print-record{display:none}', '#full-evidence:target{display:block}',
    '.evidence-item:target>details{border-color:var(--yellow)}',
    '.panel{border-top:0;padding-top:0;break-inside:avoid;page-break-inside:avoid}', '.panel>h2{border-top:1px solid var(--line);padding-top:20px}',
    '#report h2,#report h3,#report h4{break-inside:avoid;page-break-inside:avoid;padding-bottom:160px;margin-bottom:-160px}',
    'tr,.context div,.stats,blockquote,li,pre,.status{break-inside:avoid;page-break-inside:avoid}',
    '#evidence details{display:none}', '.compact-note,.print-record{display:block}', '.print-record pre{display:none}',
    '#full-evidence:target~.compact-note{display:none}', '#full-evidence:target~.evidence-item .print-record pre{display:block;',
    // Draft titles (Safari split them from their contents) carry the rule and reserve room for the draft's heading and text.
    '.draft{border-top:0}', '.draft>summary{border-top:1px solid var(--line);break-inside:avoid;page-break-inside:avoid;padding-bottom:294px;margin-bottom:-280px}',
    // Each record is kept whole, so its link destination is where it starts; a long one starts a new page and then flows.
    '.evidence-item{break-inside:avoid;page-break-inside:avoid}',
    '#full-evidence:target~.evidence-item.long{break-inside:auto;page-break-inside:auto;break-before:page;page-break-before:always}',
    '#full-evidence:target~.evidence-item.long .print-record pre{break-inside:auto;page-break-inside:auto}'])
    assert.ok(printStyles.includes(rule), rule);
  // On screen, the print copies and notes stay hidden and the wrapper takes over the card's link-target styling, so the
  // screen view is unchanged until someone chooses #full-evidence.
  const screen = printStyles.slice(0, printStyles.indexOf('@media print{'));
  assert.equal(screen.trim(), '/* Print revision 1 */\n.print-note,.print-record{display:none}\n#full-evidence:target{display:block}\n.evidence-item{scroll-margin-top:24px}\n.evidence-item:target>details{border-color:var(--yellow)}');
  // Only the #full-evidence rule shows a record's JSON in print.
  assert.equal(printStyles.split('pre{display:block').length, 2);
  // Short record JSON may not split: only the long-record rule lets a record's JSON break across pages.
  assert.equal(printStyles.split('pre{break-inside:auto').length, 2);
  assert.ok(printStyles.includes('.evidence-item.long .print-record pre{break-inside:auto'));
});

test('new exports of five labs add print revision 1; their previous versions still export and verify byte for byte', t => {
  for (const { lab, make, exp, before, after } of LABS) {
    const c = make(t), dir = temp(t);
    for (const [[version, reviewedHash, gapHash], key] of [[before, 'b'], [after, 'a']] as const) {
      const options = key === 'b' ? { toolVersion: version } : {};
      const r = exp(c.root, join(dir, key + 'r'), { now: c.now, ...options } as any), g = exp(c.root, join(dir, key + 'g'), { mode: 'gaps', now: c.now, ...options } as any);
      assert.deepEqual([r.manifestHash, g.manifestHash], [reviewedHash, gapHash], `${lab} ${version}`);
      for (const [d, h] of [[key + 'r', r.manifestHash], [key + 'g', g.manifestHash]]) {
        assert.equal(JSON.parse(read(join(dir, d), 'manifest.json')).toolVersion, version);
        assert.equal((verifyAnyBundle(join(dir, d), { expectedManifestHash: h, now: c.now }) as any).integrity, 'VALID', `${lab} ${d}`);
        const html = read(join(dir, d), 'support-bundle.html');
        if (key === 'a') {
          checkPrintRevision(html, `${lab} ${d}`);
          // Pool-exhaustion phases run to hundreds of JSON lines and start new pages; the short PgBouncer and permissions records don't.
          const items = evidenceItemsOf(html);
          if (lab === 'pool-exhaustion') assert.ok(items.every(i => i.long), lab);
          if (lab === 'pooling' || lab === 'permissions') assert.ok(items.every(i => !i.long), lab);
        }
        else { assert.ok(!html.includes('Print revision') && !html.includes('print-record'), `${lab} ${version} has no print revision`); }
      }
    }
  }
});

test('the reproduction note reports the macOS result only from permissions bundle2 and pool-exhaustion bundle2', t => {
  for (const { lab, make, exp, before } of LABS.filter(l => l.lab === 'permissions' || l.lab === 'pool-exhaustion')) {
    const c = make(t), dir = temp(t);
    exp(c.root, join(dir, 'old'), { now: c.now, toolVersion: before[0] } as any); exp(c.root, join(dir, 'new'), { now: c.now } as any);
    assert.match(read(join(dir, 'old'), 'reproduction.md'), /and in Linux CI on PostgreSQL 16, 17 and 18\. macOS has not been tested\./, lab);
    const note = read(join(dir, 'new'), 'reproduction.md');
    assert.match(note, /Tested locally on Linux with PostgreSQL 16\.13, in Linux CI on PostgreSQL 16, 17 and 18, and on macOS 12\.7\.6 with PostgreSQL 17\.11\./, lab);
    assert.doesNotMatch(note + read(join(dir, 'new'), 'support-bundle.html'), /macOS has not been tested/, lab);
  }
});

test('new schema exports use bundle5 with print revision 1, and restyling the bundle4 example adds it without changing the evidence', t => {
  const f = nativeProtocolFixture(t), dir = temp(t);
  appendLabReview(f.root, { ...reviewTemplate(f.root, f.now), reviewer: 'test-reviewer', decision: 'accept', rationale: 'The original failure and post-change observations support the local finding.' }, f.now);
  for (const mode of ['reviewed', 'gaps'] as const) {
    const out = join(dir, mode), result = exportBundle(f.root, out, { mode, now: f.now });
    const manifest = JSON.parse(read(out, 'manifest.json'));
    assert.equal(manifest.toolVersion, '0.1.0-bundle5'); assert.equal(manifest.draftRevision, 2);
    assert.equal(verifyAnyBundle(out, { expectedManifestHash: result.manifestHash, now: f.now }).integrity, 'VALID');
    checkPrintRevision(read(out, 'support-bundle.html'), 'schema ' + mode);
    assert.ok(evidenceItemsOf(read(out, 'support-bundle.html')).every(i => !i.long), 'schema records are short and kept whole');
    assert.equal(evidenceItemsOf(read(out, 'support-bundle.html')).length, read(out, 'evidence.jsonl').trim().split('\n').length);
  }
  const source = 'examples/schema-case/bundle-restyled', anchor = 'a88c90245332cf5c7c1cfc9fd9f9211d43e4f90898a5ddfa7ab043cbbc9dde14', out = join(dir, 'restyled');
  const original = read(source, 'support-bundle.html');
  assert.ok(!original.includes('print-record'));
  const result = restyleBundle(source, out, { expectedManifestHash: anchor });
  assert.equal(JSON.parse(read(out, 'manifest.json')).toolVersion, '0.1.0-bundle5');
  checkPrintRevision(read(out, 'support-bundle.html'), 'restyled example');
  assert.equal(read(out, 'evidence.jsonl'), read(source, 'evidence.jsonl'));
  assert.equal(verifyAnyBundle(out, { expectedManifestHash: result.manifestHash }).integrity, 'VALID');
  assert.equal(verifyAnyBundle(source, { expectedManifestHash: anchor }).integrity, 'VALID');
});
