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
import { parseCsv, CSV_PATH, TARGET_BATCH, TARGET_STATUS } from './seed-notion-source-db.mjs';

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
// trailing `/`.
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
  sheet: sheetDomain(r.Website),
  s1: s1Domain(r.Website),
  check: sheetRowCheck(r),
}));

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
console.log('- `Import state`: no formula in any row; the column is empty.');

// ------------------------------------------------------------ candidates

const companies = [...s1Domains];
const people = derived; // one Person candidate per source row
const heldPeople = people.filter((d) => d.check === 'CHECK'); // no work email -> Stop
const heldAccounts = new Set(heldPeople.map((d) => d.s1));
// ADR-0005: a Deal is emitted only when every candidate in its account is Clear.
const deals = companies;
const heldDeals = deals.filter((c) => heldAccounts.has(c));
// ADR-0003 (companies): the companies file carries companies with no exported person.
const companiesFile = companies.filter((c) =>
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
console.log(`\n- \`1-companies.csv\`: ${companiesFile.length} row(s) — ${companiesFile.join(', ')}`);
console.log(`- \`2-people.csv\`:    ${people.length - heldPeople.length} rows`);
console.log(`- \`3-deals.csv\`:     ${deals.length - heldDeals.length} rows`);
console.log(
  `- source rows marked \`Imported\` on confirmation: ${markedImported.length} of ${derived.length}`,
);

const employees = new Set(rows.map((r) => r.Employees));
console.log(
  `- distinct \`Employees\` values at source: ${employees.size} —` +
    ` ${[...employees].map((e) => `\`${e}\``).join(', ')}`,
);

// ------------------------------------------------------------ self-check

console.log(`\n## Checks\n`);
let failures = 0;
const assert = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

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
  companiesFile.length === 1 &&
    people.length - heldPeople.length === 7 &&
    deals.length - heldDeals.length === 6,
);
assert('7 of 8 source rows are marked Imported', markedImported.length === 7, `got ${markedImported.length}`);

console.log(failures ? `\n${failures} check(s) FAILED\n` : `\nall checks passed\n`);
process.exit(failures ? 1 : 0);
