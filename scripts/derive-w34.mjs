#!/usr/bin/env node
/**
 * Re-derives every count the README quotes, from the batch data. No token, no
 * network. The README states no number this script does not print.
 *
 * It runs the two `Attio Upload` formulas over the 8 real W34 rows, alongside
 * the pipeline's S1 domain repair, and then counts candidates the way the
 * pipeline does — one Company per normalised domain, one Person per source
 * row, one Deal per Company.
 *
 * Usage: node scripts/derive-w34.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseCsv, CSV_PATH, TARGET_BATCH, TARGET_STATUS } from './seed-notion-source-db.mjs';
import { normalisedDomain } from '../src/candidates.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKBOOK_PATH = path.join(ROOT, 'data', 'crm-handoff-working.xlsx');

// ------------------------------------------------------------ the workbook

// An .xlsx is a zip. Read one member out of it via the central directory —
// enough to quote the sheet's own formulas rather than retyping them here.
function readZipEntry(buf, name) {
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocd < 0) throw new Error(`${name}: no end-of-central-directory record`);
  let at = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);

  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(at + 28);
    const entry = buf.toString('utf8', at + 46, at + 46 + nameLen);
    if (entry === name) {
      const method = buf.readUInt16LE(at + 10);
      const size = buf.readUInt32LE(at + 20);
      const local = buf.readUInt32LE(at + 42);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const bytes = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(bytes) : bytes).toString('utf8');
    }
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  throw new Error(`${name}: not found in the archive`);
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

// Every cell as { col, row, formula, text }. No XML dependency: the sheet parts
// are flat, and we only ever ask for <f>, <v> and <is><t>. The element names
// carry a namespace prefix in this workbook (`<x:c>`), so every tag is optional-
// prefix matched.
const TAG = (name) => `<(?:\\w+:)?${name}`;
function readCells(xml) {
  const cells = [];
  const cell = new RegExp(
    `${TAG('c')}\\b[^>]*?r="([A-Z]+)(\\d+)"[^>]*?(?:/>|>([\\s\\S]*?)</(?:\\w+:)?c>)`,
    'g',
  );
  const formulaTag = new RegExp(`${TAG('f')}[^>]*>([\\s\\S]*?)</(?:\\w+:)?f>`);
  const valueTag = new RegExp(`${TAG('v')}[^>]*>([\\s\\S]*?)</(?:\\w+:)?v>`);
  const textTag = new RegExp(`${TAG('t')}[^>]*>([\\s\\S]*?)</(?:\\w+:)?t>`, 'g');

  for (const m of xml.matchAll(cell)) {
    const body = m[3] ?? '';
    const formula = body.match(formulaTag);
    const value = body.match(valueTag);
    // A string cell is written either inline (`t="inlineStr"`, an <is><t>) or as
    // a bare <v> (`t="str"`). This sheet uses both, so read either.
    const inline = [...body.matchAll(textTag)].map((t) => t[1]).join('');
    cells.push({
      col: m[1],
      row: Number(m[2]),
      formula: formula ? unescapeXml(formula[1]) : null,
      value: value ? unescapeXml(value[1]) : null,
      text: inline ? unescapeXml(inline) : value ? unescapeXml(value[1]) : null,
    });
  }
  return cells;
}

const workbook = readFileSync(WORKBOOK_PATH);
// Only one sheet carries formulas — `Attio Upload`. Found by that property and
// then confirmed against its own header row, so a renamed sheet cannot slip past.
const sheets = [...Array(8).keys()]
  .map((i) => {
    try {
      return readZipEntry(workbook, `xl/worksheets/sheet${i + 1}.xml`);
    } catch {
      return null;
    }
  })
  .filter((xml) => xml && new RegExp(`${TAG('f')}[ >]`).test(xml));
if (sheets.length !== 1) throw new Error(`expected 1 sheet with formulas, found ${sheets.length}`);

const cells = readCells(sheets[0]);
const headers = Object.fromEntries(
  cells.filter((c) => c.row === 1 && c.text).map((c) => [c.col, c.text]),
);
const formulas = cells.filter((c) => c.formula);
const formulaCols = [...new Set(formulas.map((c) => c.col))];
const formulaRows = [...new Set(formulas.map((c) => c.row))];
// One shape per column, with the row numbers blanked out, is what "zero drift" means.
const shapes = new Map();
for (const c of formulas) {
  const shape = c.formula.replace(/(?<=[A-Z!])\d+/g, 'N');
  shapes.set(c.col, (shapes.get(c.col) ?? new Set()).add(shape));
}
const drifting = [...shapes].filter(([, s]) => s.size > 1).map(([col]) => col);

const at = (ref) => {
  const [, col, row] = ref.match(/^([A-Z]+)(\d+)$/);
  return cells.find((c) => c.col === col && c.row === Number(row));
};
const domainFormula = at('C2').formula;
const rowCheckFormula = at('O2').formula;
const importStateCells = cells.filter((c) => c.col === 'N' && c.row > 1);

console.log(`\n## The \`Attio Upload\` sheet, read from the workbook\n`);
console.log(`- formulas: ${formulas.length}`);
console.log(
  `- rows: ${formulaRows.length} (${Math.min(...formulaRows)}–${Math.max(...formulaRows)}),` +
    ` formula columns: ${formulaCols.length} (${formulaCols.join(', ')})`,
);
console.log(`- columns whose formula drifts between rows: ${drifting.length || 'none'}`);
console.log(`- \`${headers.C}\` is column C:  ${domainFormula}`);
console.log(`- \`${headers.O}\` is column O:  ${rowCheckFormula}`);
console.log(
  `- \`${headers.N}\` is column N:  ${importStateCells.filter((c) => c.formula).length} formulas,` +
    ` ${importStateCells.filter((c) => c.formula || c.text || c.value).length} non-empty cells` +
    ` in ${importStateCells.length} rows`,
);

// ------------------------------------------------------------ the two transforms

// 'Attio Upload'!C2, verbatim:
//   =IF(B2="","",LOWER(SUBSTITUTE(SUBSTITUTE('Paste Notion Export'!C2,"https://",""),"www.","")))
// SUBSTITUTE replaces every occurrence, and there is no third one.
const sheetDomain = (website) =>
  website.replaceAll('https://', '').replaceAll('www.', '').toLowerCase();

// 'Attio Upload'!O2, verbatim:
//   =IF(B2="","",IF(F2="","CHECK","READY"))   — F is the work email.
const sheetRowCheck = (row) => (row['Work email'] === '' ? 'CHECK' : 'READY');

// S1, the pipeline's silent repair: lowercase; strip scheme, `www.`, path,
// trailing `/`. Restated here rather than imported, on purpose — this script is
// the independent re-derivation of every count the README quotes, and a script
// that called the shipped function would confirm the pipeline against itself.
// The last check below is what keeps the two copies honest.
const s1Domain = (website) =>
  website
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');

// ------------------------------------------------------------ the batch

const rows = parseCsv(readFileSync(CSV_PATH, 'utf8')).filter(
  (r) => r.Batch === TARGET_BATCH && r['CRM status'] === TARGET_STATUS,
);

const derived = rows.map((r) => ({
  id: r['Source ID'],
  account: r.Account,
  website: r.Website,
  email: r['Work email'],
  sheet: sheetDomain(r.Website),
  s1: s1Domain(r.Website),
  check: sheetRowCheck(r),
}));

console.log(
  `\nRead ${rows.length} rows from ${CSV_PATH.replace(/.*\/(?=data\/)/, '')},` +
    ` filtered to Batch = ${TARGET_BATCH} and CRM status = ${TARGET_STATUS}.`,
);

const table = (header, body) =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

console.log(`\n## The \`Domain\` formula on the ${rows.length} rows of ${TARGET_BATCH}\n`);
console.log(
  table(
    ['Source ID', 'Website', 'sheet `Domain`', 'S1 repair', ''],
    derived.map((d) => [
      `\`${d.id}\``,
      `\`${d.website}\``,
      `\`${d.sheet}\``,
      `\`${d.s1}\``,
      d.sheet === d.s1 ? '' : '**not a domain**',
    ]),
  ),
);

const sheetDomains = new Set(derived.map((d) => d.sheet));
const s1Domains = new Set(derived.map((d) => d.s1));
const wrong = derived.filter((d) => d.sheet !== d.s1);
const unchanged = derived.filter((d) => d.website === d.s1);

console.log(
  `\n- outputs that are not a bare domain: ${wrong.length} of ${derived.length}` +
    ` (${wrong.map((d) => d.id).join(', ')})`,
);
console.log(`- distinct companies the sheet creates: ${sheetDomains.size}`);
console.log(`- distinct companies in the batch:      ${s1Domains.size}`);
console.log(
  `- websites S1 leaves untouched:         ${unchanged.length}` +
    ` (${unchanged.map((d) => d.id).join(', ') || 'none'})`,
);

// The one divergence that collapses, or fails to collapse, two rows into one company.
const byAccount = new Map();
for (const d of derived) byAccount.set(d.account, (byAccount.get(d.account) ?? []).concat(d));
for (const [account, ds] of byAccount) {
  if (ds.length < 2) continue;
  const split = new Set(ds.map((d) => d.sheet)).size > 1;
  console.log(
    `- ${account}: ${ds.length} rows, ${new Set(ds.map((d) => d.s1)).size} company after S1, ` +
      `${new Set(ds.map((d) => d.sheet)).size} in the sheet` +
      `${split ? ' — a duplicate the sheet cannot see' : ''}`,
  );
}

// ------------------------------------------------------------ Row check

console.log(`\n## \`Row check\` on the same rows\n`);
const check = derived.filter((d) => d.check === 'CHECK');
console.log(`- READY: ${derived.length - check.length}`);
console.log(`- CHECK: ${check.length} (${check.map((d) => `${d.id} — ${d.account}`).join(', ')})`);

// ------------------------------------------------------------ candidates

const companies = [...s1Domains];
const people = derived; // one Person candidate per source row
// Held on the B1 Stop: a Person candidate is keyed on the work email, so a row
// without one cannot become a Person. Derived from the source value, not from
// the sheet's `Row check` — the two agree on this batch and agree for different
// reasons.
const heldPeople = people.filter((d) => d.email === '');
const heldAccounts = new Set(heldPeople.map((d) => d.s1));
// ADR-0005: a Deal is emitted only when every candidate in its account is Clear.
const deals = companies;
const heldDeals = deals.filter((c) => heldAccounts.has(c));
// ADR-0003 (companies): the companies file carries companies with no exported person.
const companiesWithNoExportedPerson = companies.filter((c) =>
  people.filter((p) => p.s1 === c).every((p) => heldPeople.includes(p)),
);
const markedImported = derived.filter((d) => !heldAccounts.has(d.s1));

console.log(`\n## Candidates\n`);
console.log(
  table(
    ['', 'candidates', 'exported', 'held'],
    [
      ['Company', companies.length, companies.length, 0],
      ['Person', people.length, people.length - heldPeople.length, heldPeople.length],
      ['Deal', deals.length, deals.length - heldDeals.length, heldDeals.length],
    ],
  ),
);
console.log(
  `\n- \`1-companies.csv\`: ${companiesWithNoExportedPerson.length} row(s) —` +
    ` ${companiesWithNoExportedPerson.join(', ')}`,
);
console.log(
  `- the other ${companies.length - companiesWithNoExportedPerson.length} companies reach Attio` +
    ` through the relationship columns of \`2-people.csv\``,
);
console.log(`- \`2-people.csv\`:    ${people.length - heldPeople.length} rows`);
console.log(`- \`3-deals.csv\`:     ${deals.length - heldDeals.length} rows`);
console.log(
  `- source rows marked \`Imported\` on confirmation: ${markedImported.length} of ${derived.length}`,
);

const employees = new Set(rows.map((r) => r.Employees));
const ranges = new Set([...employees].map((e) => e.replace(/[–—]/g, '-')));
console.log(
  `- distinct \`Employees\` values at source: ${employees.size} for ${ranges.size} ranges —` +
    ` ${[...employees].map((e) => `\`${e}\``).join(', ')}`,
);

// ------------------------------------------------------------ self-check

console.log(`\n## Checks\n`);
let failures = 0;
const assert = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

// The workbook claims. These are the two the README departs from the ticket on,
// so they are checked against the file rather than asserted in prose.
assert('700 formulas over 50 rows and 14 columns', formulas.length === 700 && formulaRows.length === 50 && formulaCols.length === 14, `${formulas.length} / ${formulaRows.length} / ${formulaCols.length}`);
assert('zero formula drift', drifting.length === 0, drifting.join(', '));
assert(
  'the `Domain` formula is quoted verbatim in the README',
  domainFormula ===
    `IF(B2="","",LOWER(SUBSTITUTE(SUBSTITUTE('Paste Notion Export'!C2,"https://",""),"www.","")))`,
  domainFormula,
);
assert(
  'the `Row check` formula is quoted verbatim in the README',
  rowCheckFormula === `IF(B2="","",IF(F2="","CHECK","READY"))`,
  rowCheckFormula,
);
assert(
  '`Import state` has no formula and no value in any of the 50 rows',
  headers.N === 'Import state' &&
    importStateCells.length === 50 &&
    importStateCells.every((c) => !c.formula && !c.text && !c.value),
  `${importStateCells.filter((c) => c.formula).length} formulas in ${importStateCells.length} rows`,
);

assert('8 source rows in the batch', derived.length === 8, `got ${derived.length}`);
assert('the sheet creates 8 companies from 8 rows', sheetDomains.size === 8, `got ${sheetDomains.size}`);
assert('the batch contains 7 companies', s1Domains.size === 7, `got ${s1Domains.size}`);
assert(
  'the two Brightyard rows differ in the sheet and agree after S1',
  new Set(byAccount.get('Brightyard').map((d) => d.sheet)).size === 2 &&
    new Set(byAccount.get('Brightyard').map((d) => d.s1)).size === 1,
);
assert('Row check catches exactly one row', check.length === 1, check.map((d) => d.account).join(', '));
assert('one Person and one Deal are held', heldPeople.length === 1 && heldDeals.length === 1);
assert(
  'the bundle is 1 + 7 + 6 rows',
  companiesWithNoExportedPerson.length === 1 &&
    people.length - heldPeople.length === 7 &&
    deals.length - heldDeals.length === 6,
);
assert('7 of 8 source rows are marked Imported', markedImported.length === 7, `got ${markedImported.length}`);
assert('5 distinct `Employees` values for 3 ranges', employees.size === 5 && ranges.size === 3, `${employees.size} / ${ranges.size}`);

// The counts above are this script's own. This one check is where the shipped
// repair meets them: it may not disagree with S1 on any website in the batch.
assert(
  'the pipeline repairs every website exactly as S1 does',
  derived.every((d) => normalisedDomain(d.website) === d.s1),
  derived.filter((d) => normalisedDomain(d.website) !== d.s1).map((d) => d.id).join(', '),
);

console.log(failures ? `\n${failures} check(s) FAILED\n` : `\nall checks passed\n`);
process.exit(failures ? 1 : 0);
