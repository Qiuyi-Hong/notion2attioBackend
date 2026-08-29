#!/usr/bin/env node
/**
 * Offline check of the Notion seed fixture. No token, no network.
 *
 * Asserts the things the seeder depends on:
 *   - the CSV parses to 12 rows x 18 columns
 *   - exactly 8 rows match the W34 filter, and strictly fewer than the total
 *   - each filter leg (CRM status, Batch) is independently provable
 *   - every select value the rows use exists as an option in the schema
 *   - both dash variants of Employees survive as distinct values
 *
 * Usage: node scripts/check-notion-fixture.mjs
 */

import { readFileSync } from 'node:fs';
import {
  parseCsv,
  buildSchema,
  CSV_PATH,
  TARGET_BATCH,
  TARGET_STATUS,
  EXPECTED_MATCHES,
} from './seed-notion-source-db.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
const schema = buildSchema();
const columns = Object.keys(schema);

check('12 rows parsed', rows.length === 12, `got ${rows.length}`);
check('18 columns in schema', columns.length === 18, `got ${columns.length}`);
check(
  'every CSV column has a schema property',
  Object.keys(rows[0]).every((c) => columns.includes(c)),
  Object.keys(rows[0])
    .filter((c) => !columns.includes(c))
    .join(', ') || 'all mapped',
);

const matches = rows.filter((r) => r.Batch === TARGET_BATCH && r['CRM status'] === TARGET_STATUS);
check(`${EXPECTED_MATCHES} rows match the W34 filter`, matches.length === EXPECTED_MATCHES, `got ${matches.length}`);
check('the filter excludes something', matches.length < rows.length, `${rows.length - matches.length} excluded`);

// Each leg must bite on its own, otherwise one of them is untested.
const statusOnly = rows.filter((r) => r.Batch === TARGET_BATCH && r['CRM status'] !== TARGET_STATUS);
const batchOnly = rows.filter((r) => r.Batch !== TARGET_BATCH && r['CRM status'] === TARGET_STATUS);
check('CRM status leg is provable', statusOnly.length > 0, `${statusOnly.length} row(s) right batch, wrong status`);
check('Batch leg is provable', batchOnly.length > 0, `${batchOnly.length} row(s) right status, wrong batch`);

// Every select/status value used by a row must exist as an option.
for (const [name, def] of Object.entries(schema)) {
  const config = def.select ?? def.status;
  if (!config) continue;
  const allowed = new Set(config.options.map((o) => o.name));
  const used = [...new Set(rows.map((r) => r[name]).filter(Boolean))];
  const unknown = used.filter((v) => !allowed.has(v));
  check(`${name}: all used values are options`, unknown.length === 0, unknown.join(' | ') || `${used.length} used`);
}

// The trap: en-dash and hyphen must both survive as distinct values.
const employees = new Set(rows.map((r) => r.Employees));
check('en-dash 11–50 present', employees.has('11–50'));
check('hyphen 11-50 present', employees.has('11-50'));
check('en-dash 51–200 present', employees.has('51–200'));
check('hyphen 51-200 present', employees.has('51-200'));

// The missing-email row must survive as empty, not as a literal.
const tern = rows.find((r) => r.Account === 'Tern Mobility');
check('Tern Mobility has no work email', tern !== undefined && tern['Work email'] === '');

// The duplicate-account trap must still be in the fixture.
const brightyard = rows.filter((r) => r.Account === 'Brightyard');
check('Brightyard appears twice', brightyard.length === 2);
check(
  'Brightyard rows carry two different website spellings',
  new Set(brightyard.map((r) => r.Website)).size === 2,
);

console.log(failures === 0 ? '\nAll fixture checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
