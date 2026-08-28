#!/usr/bin/env node
/**
 * Stands up the Notion source database for the weekly Notion -> Attio handoff.
 *
 * Creates a "Qualified accounts" database from data/notion-source-seed.csv with
 * deliberately chosen property types (see docs/notion-source-database.md), then
 * self-checks by running the real W34 extraction filter and asserting it returns
 * exactly the 8 rows the handoff is supposed to pick up.
 *
 * Usage:
 *   NOTION_TOKEN=ntn_... NOTION_PARENT_PAGE_ID=<page-id> node scripts/seed-notion-source-db.mjs
 *
 * Both values are also read from .env if present.
 * Requires Node 20+ (global fetch). No dependencies.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = path.join(ROOT, 'data', 'notion-source-seed.csv');
const ENV_PATH = path.join(ROOT, '.env');

const NOTION_VERSION = '2026-03-11';
const DB_TITLE = 'Qualified accounts';

// The extraction filter this whole exercise exists to run.
const TARGET_BATCH = '2026-W34';
const TARGET_STATUS = 'Ready for CRM';
const EXPECTED_MATCHES = 8;

// ---------------------------------------------------------------- env + csv

function loadEnvFile() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** Minimal RFC4180 parser: handles quoted fields, embedded commas and "" escapes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((v) => v !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ------------------------------------------------------------ notion client

const token = process.env.NOTION_TOKEN;
const parentPageId = process.env.NOTION_PARENT_PAGE_ID;

async function notion(method, endpoint, body) {
  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${method} ${endpoint} -> ${res.status} ${json.code ?? ''}: ${json.message ?? JSON.stringify(json)}`,
    );
  }
  return json;
}

// --------------------------------------------------------------- the schema
//
// Every choice here is deliberate and recorded in docs/notion-source-database.md.
// The two that change the app's query syntax:
//   Batch      -> select  => {"property":"Batch","select":{"equals":"2026-W34"}}
//   CRM status -> status  => {"property":"CRM status","status":{"equals":"Ready for CRM"}}

/** Both dash variants are kept as SEPARATE options on purpose - that is the trap. */
const EMPLOYEE_OPTIONS = ['11–50', '11-50', '51–200', '51-200', '201-500'];

function buildSchema() {
  return {
    // Account is the title: it is the row's display name, and two rows titled
    // "Brightyard" make the duplicate-account trap visible in Notion itself.
    Account: { title: {} },
    'Source ID': { rich_text: {} },
    // url does not enforce a scheme, so the messy variants survive verbatim.
    Website: { url: {} },
    Contact: { rich_text: {} },
    // email gives the extraction node a typed null for the missing address.
    'Work email': { email: {} },
    'Job title': { rich_text: {} },
    LinkedIn: { url: {} },
    'Lead source': {
      select: {
        options: [
          'Inbound demo',
          'Partner referral',
          'Mobility Summit',
          'Outbound research',
          'Agency partner list',
          'Webinar',
          'Founder referral',
        ].map((name) => ({ name })),
      },
    },
    Segment: { select: { options: ['SMB', 'Mid-market', 'Enterprise'].map((name) => ({ name })) } },
    Employees: { select: { options: EMPLOYEE_OPTIONS.map((name) => ({ name })) } },
    HQ: { rich_text: {} },
    'Research notes': { rich_text: {} },
    // select, not people: a people property would bind the fixture to real
    // workspace member ids and stop it reproducing in another workspace.
    Owner: { select: { options: [{ name: 'Maya' }] } },
    'Qualified on': { date: {} },
    Batch: {
      select: { options: ['2026-W33', '2026-W34', '2026-W35'].map((name) => ({ name })) },
    },
    'CRM status': {
      status: {
        options: [
          { name: 'Not ready', color: 'default' },
          { name: TARGET_STATUS, color: 'blue' },
          { name: 'Imported', color: 'green' },
        ],
        groups: [
          { name: 'To-do', color: 'gray', option_names: ['Not ready'] },
          { name: 'In progress', color: 'blue', option_names: [TARGET_STATUS] },
          { name: 'Complete', color: 'green', option_names: ['Imported'] },
        ],
      },
    },
    'CRM company ID': { rich_text: {} },
    'CRM person ID': { rich_text: {} },
  };
}

const text = (v) => (v ? { rich_text: [{ text: { content: v } }] } : { rich_text: [] });

function buildProperties(row) {
  return {
    Account: { title: [{ text: { content: row.Account } }] },
    'Source ID': text(row['Source ID']),
    Website: { url: row.Website || null },
    Contact: text(row.Contact),
    'Work email': { email: row['Work email'] || null },
    'Job title': text(row['Job title']),
    LinkedIn: { url: row.LinkedIn || null },
    'Lead source': { select: row['Lead source'] ? { name: row['Lead source'] } : null },
    Segment: { select: row.Segment ? { name: row.Segment } : null },
    Employees: { select: row.Employees ? { name: row.Employees } : null },
    HQ: text(row.HQ),
    'Research notes': text(row['Research notes']),
    Owner: { select: row.Owner ? { name: row.Owner } : null },
    'Qualified on': { date: row['Qualified on'] ? { start: row['Qualified on'] } : null },
    Batch: { select: row.Batch ? { name: row.Batch } : null },
    'CRM status': { status: row['CRM status'] ? { name: row['CRM status'] } : null },
    'CRM company ID': text(row['CRM company ID']),
    'CRM person ID': text(row['CRM person ID']),
  };
}

// -------------------------------------------------------------------- main

async function main() {
  loadEnvFile();
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_PARENT_PAGE_ID) {
    console.error(
      'Missing NOTION_TOKEN and/or NOTION_PARENT_PAGE_ID.\n' +
        'Run scripts/notion-setup-wizard.sh, or see docs/notion-source-database.md.',
    );
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  console.log(`Read ${rows.length} rows from ${path.relative(ROOT, CSV_PATH)}`);

  // Fail loudly if the fixture stops containing a provable negative case.
  const shouldMatch = rows.filter(
    (r) => r.Batch === TARGET_BATCH && r['CRM status'] === TARGET_STATUS,
  );
  if (shouldMatch.length !== EXPECTED_MATCHES || shouldMatch.length === rows.length) {
    throw new Error(
      `Fixture is wrong: ${shouldMatch.length}/${rows.length} rows match the W34 filter ` +
        `(expected ${EXPECTED_MATCHES}, and strictly fewer than the total).`,
    );
  }

  const db = await notion('POST', 'databases', {
    parent: { type: 'page_id', page_id: process.env.NOTION_PARENT_PAGE_ID },
    title: [{ text: { content: DB_TITLE } }],
    properties: buildSchema(),
  });

  // Since API version 2025-09-03 a database owns data sources, and rows are
  // created in / queried from the data source, not the database.
  let dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) {
    const full = await notion('GET', `databases/${db.id}`);
    dataSourceId = full.data_sources?.[0]?.id;
  }
  if (!dataSourceId) throw new Error(`Could not resolve a data source id for database ${db.id}`);

  console.log(`Created database ${db.id}`);
  console.log(`   data source ${dataSourceId}`);

  for (const row of rows) {
    await notion('POST', 'pages', {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: buildProperties(row),
    });
    console.log(`  + ${row['Source ID']}  ${row.Account}`);
  }

  // Self-check: run the real extraction filter against the live data source.
  const query = await notion('POST', `data_sources/${dataSourceId}/query`, {
    filter: {
      and: [
        { property: 'CRM status', status: { equals: TARGET_STATUS } },
        { property: 'Batch', select: { equals: TARGET_BATCH } },
      ],
    },
    page_size: 100,
  });
  const got = query.results.length;
  console.log(`\nW34 filter returned ${got} of ${rows.length} rows (expected ${EXPECTED_MATCHES})`);
  if (got !== EXPECTED_MATCHES) {
    throw new Error(`Filter self-check FAILED: expected ${EXPECTED_MATCHES}, got ${got}`);
  }

  appendFileSync(ENV_PATH, `\nNOTION_DATABASE_ID=${db.id}\nNOTION_DATA_SOURCE_ID=${dataSourceId}\n`);
  console.log('Filter self-check passed. Ids appended to .env:');
  console.log(`NOTION_DATABASE_ID=${db.id}`);
  console.log(`NOTION_DATA_SOURCE_ID=${dataSourceId}`);
  console.log(`\nURL: https://www.notion.so/${db.id.replace(/-/g, '')}`);
}

// Exported so the fixture can be checked without touching the Notion API.
export { parseCsv, buildSchema, buildProperties, CSV_PATH, TARGET_BATCH, TARGET_STATUS, EXPECTED_MATCHES };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
