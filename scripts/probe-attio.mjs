#!/usr/bin/env node
/**
 * Probes a live Attio workspace for the three things the docs never say
 * (issue #12; silences 1-4, 6, 7 and 8 in docs/research/attio-csv-importer.md).
 *
 * The docs research (#2) established the contract on paper. This closes the
 * gaps that only a real workspace can:
 *
 *   1. The real option labels of the standard Companies `Employee range` —
 *      unpublished, and unchangeable because it is a system enriched attribute.
 *   2. Whether anything can write to an enriched system select at all.
 *   3. Whether the CSV importer cares about encoding, BOM, line endings or
 *      delimiter, and whether select matching normalises anything past case.
 *
 * Attio has no CSV import endpoint (#2), so (3) needs a human clicking through
 * the import UI. Everything either side of that click is automated here:
 * `schema` and `csv` prepare the experiment, `readback` and `write` judge it.
 *
 * Usage:
 *   node scripts/probe-attio.mjs schema     # enumerate objects, attributes, options
 *   node scripts/probe-attio.mjs csv        # generate probe CSVs from the real labels
 *   node scripts/probe-attio.mjs readback   # what actually landed after the UI imports
 *   node scripts/probe-attio.mjs write      # can the API write an enriched select?
 *   node scripts/probe-attio.mjs cleanup    # delete the probe companies
 *
 * ATTIO_API_KEY is read from the environment or .env. The key needs
 * `object_configuration:read` and `record_permission:read-write`.
 * Requires Node 20+ (global fetch). No dependencies.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const OUT_DIR = path.join(ROOT, "data", "attio-probes");
const SCHEMA_PATH = path.join(OUT_DIR, "attio-schema.json");

const API = "https://api.attio.com/v2";
const OBJECTS = ["companies", "people", "deals"];

// Probe rows are found again by domain. `example.com` is reserved by RFC 2606,
// so Attio's enrichment has nothing to look up — those rows isolate the
// importer's own behaviour. ENRICHED_DOMAIN is a real company, so enrichment
// does have an opinion, which is the point: it tells us who owns the value.
const PROBE_TLD = "attio-probe.example.com";
const ENRICHED_DOMAIN = "stripe.com";

// ------------------------------------------------------------------- env

function loadEnvFile() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]])
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function apiKey() {
  loadEnvFile();
  const key = process.env.ATTIO_API_KEY;
  if (!key) {
    fail(
      "ATTIO_API_KEY is not set.\n" +
        "  Run `npm run attio:setup` — it walks you through creating the workspace\n" +
        "  and the key, and writes it to .env.",
    );
  }
  return key;
}

// ------------------------------------------------------------------- http

async function attio(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function attioOrFail(method, endpoint, body) {
  const r = await attio(method, endpoint, body);
  if (!r.ok) {
    fail(
      `${method} ${endpoint} → ${r.status}\n  ${(r.text || "").slice(0, 400)}\n` +
        (r.status === 403
          ? "  A 403 usually means the API key is missing a scope. It needs\n" +
            "  `object_configuration:read` and `record_permission:read-write`."
          : ""),
    );
  }
  return r.json;
}

// -------------------------------------------------------------- rendering

/**
 * Renders a string with every non-ASCII character replaced by its codepoint.
 * The whole `51-200` vs `51–200` question is invisible in a terminal — this is
 * the only honest way to report a label, and the reason this helper exists.
 */
function escapeNonAscii(s) {
  return [...s]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp >= 0x20 && cp < 0x7f) return ch;
      return `\\u{${cp.toString(16).toUpperCase()}}`;
    })
    .join("");
}

function label(s) {
  const esc = escapeNonAscii(s);
  return esc === s ? `"${s}"` : `"${s}"  →  "${esc}"`;
}

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

function heading(s) {
  console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);
}

function ensureOutDir() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
}

// ------------------------------------------------------------ 1. schema

async function cmdSchema() {
  ensureOutDir();

  const objectsRes = await attioOrFail("GET", "/objects");
  const objects = objectsRes.data;

  heading("Objects in this workspace");
  for (const o of objects) {
    console.log(
      `  ${o.api_slug.padEnd(20)} ${String(o.singular_noun).padEnd(16)} ` +
        `${o.id.object_id}`,
    );
  }
  const present = new Set(objects.map((o) => o.api_slug));
  for (const slug of OBJECTS) {
    if (!present.has(slug)) {
      console.log(
        `\n  ! "${slug}" is not enabled in this workspace. Enable it in Attio ` +
          `(Workspace settings → Objects) before importing.`,
      );
    }
  }

  const schema = { fetchedAt: new Date().toISOString(), objects: {} };

  for (const slug of OBJECTS) {
    if (!present.has(slug)) continue;

    const attrsRes = await attioOrFail(
      "GET",
      `/objects/${slug}/attributes?limit=100&show_archived=false`,
    );
    const attrs = attrsRes.data;

    heading(`${slug} — ${attrs.length} attributes`);
    console.log(
      "  " +
        "api_slug".padEnd(26) +
        "type".padEnd(16) +
        "writable".padEnd(10) +
        "unique".padEnd(8) +
        "required",
    );

    const out = [];
    for (const a of attrs) {
      const row = {
        api_slug: a.api_slug,
        title: a.title,
        type: a.type,
        is_system_attribute: a.is_system_attribute,
        is_writable: a.is_writable,
        is_unique: a.is_unique,
        is_required: a.is_required,
        is_multiselect: a.is_multiselect,
        options: null,
      };

      // Select and status attributes carry the option lists our emitter has to
      // hit exactly (case-insensitively) — Attio publishes neither.
      if (a.type === "select" || a.type === "status") {
        const sub = a.type === "select" ? "options" : "statuses";
        const r = await attio(
          "GET",
          `/objects/${slug}/attributes/${a.api_slug}/${sub}`,
        );
        if (r.ok) {
          row.options = r.json.data.map((o) => ({
            id: (o.id || {}).option_id || (o.id || {}).status_id || null,
            title: o.title,
            is_archived: o.is_archived,
          }));
        } else {
          row.options = { error: r.status, body: (r.text || "").slice(0, 200) };
        }
      }

      out.push(row);
      console.log(
        "  " +
          a.api_slug.padEnd(26) +
          String(a.type).padEnd(16) +
          String(a.is_writable).padEnd(10) +
          String(a.is_unique).padEnd(8) +
          String(a.is_required),
      );
    }

    schema.objects[slug] = out;

    // Print every option list verbatim, codepoint-escaped. This is the answer
    // to silence #7 and the input to the dash experiment.
    const withOptions = out.filter(
      (a) => Array.isArray(a.options) && a.options.length,
    );
    if (withOptions.length) {
      console.log(`\n  select / status option labels on ${slug}:`);
      for (const a of withOptions) {
        console.log(
          `\n    ${a.api_slug} (${a.type}${a.is_multiselect ? ", multi" : ""}) ` +
            `writable=${a.is_writable}`,
        );
        for (const o of a.options) {
          console.log(
            `      ${o.is_archived ? "[archived] " : ""}${label(o.title)}`,
          );
        }
      }
    }
  }

  writeFileSync(SCHEMA_PATH, JSON.stringify(schema, null, 2) + "\n");
  console.log(`\n✓ wrote ${path.relative(ROOT, SCHEMA_PATH)}`);

  // The headline the ticket asks for.
  const er = (schema.objects.companies || []).find(
    (a) => a.api_slug === "employee_range",
  );
  heading("Verdict — Employee range (Companies)");
  if (!er) {
    console.log(
      "  employee_range is NOT present on Companies in this workspace.",
    );
  } else {
    console.log(`  is_writable      : ${er.is_writable}`);
    console.log(`  is_system_attr   : ${er.is_system_attribute}`);
    console.log(
      `  options          : ${Array.isArray(er.options) ? er.options.length : "n/a"}`,
    );
    if (er.is_writable === false) {
      console.log(
        '\n  is_writable=false. Attio documents this as "protected system attributes,\n' +
          "  which are usually enriched by Attio\" — so the value is owned by Attio's\n" +
          "  enrichment, not by us. The UI import probe confirms whether the importer\n" +
          "  refuses it outright or accepts and then loses it.",
      );
    }
  }
}

// --------------------------------------------------------------- 2. csv

function loadSchema() {
  if (!existsSync(SCHEMA_PATH)) {
    fail(
      `${path.relative(ROOT, SCHEMA_PATH)} not found.\n` +
        "  Run `node scripts/probe-attio.mjs schema` first — the probe CSVs are built\n" +
        "  from the workspace's real option labels, not from guesses.",
    );
  }
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

/** Swaps U+002D for U+2013 and back, so a label becomes its dash-variant twin. */
function swapDash(s) {
  if (s.includes("–")) return s.replaceAll("–", "-");
  if (s.includes("-")) return s.replaceAll("-", "–");
  return s;
}

/** The normalisation we are considering owning: fold dashes, trim, casefold. */
function normalise(s) {
  return s
    .replace(/[‐-―−]/g, "-")
    .trim()
    .toLowerCase();
}

/**
 * The distinct `Employees` values our Notion source actually holds. #5 proved
 * they are distinct options at source, not a CSV-export artefact, so this is
 * the real input the emitter has to reconcile with Attio's fixed list.
 */
function sourceEmployeeValues() {
  const csv = path.join(ROOT, "data", "notion-source-seed.csv");
  if (!existsSync(csv)) return [];
  const lines = readFileSync(csv, "utf8").split("\n").filter(Boolean);
  const header = lines[0].split(",");
  const idx = header.findIndex((h) => /employee/i.test(h));
  if (idx === -1) return [];
  return [
    ...new Set(
      lines
        .slice(1)
        .map((l) => l.split(",")[idx])
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * How our source values line up against the workspace's fixed option list.
 * This is most of the answer to "is Employee range worth emitting at all".
 */
function reportCoverage(sourceValues, options) {
  const byExact = new Map(options.map((o) => [o.title, o]));
  const byCase = new Map(options.map((o) => [o.title.toLowerCase(), o]));
  const byNorm = new Map(options.map((o) => [normalise(o.title), o]));

  heading("Coverage — our Notion `Employees` values vs Attio's fixed options");
  console.log(
    "  " + "source value".padEnd(28) + "verdict".padEnd(22) + "matched option",
  );
  const rows = [];
  for (const v of sourceValues) {
    let verdict, matched;
    if (byExact.has(v)) {
      verdict = "exact";
      matched = byExact.get(v).title;
    } else if (byCase.has(v.toLowerCase())) {
      verdict = "case-insensitive";
      matched = byCase.get(v.toLowerCase()).title;
    } else if (byNorm.has(normalise(v))) {
      verdict = "needs normalising";
      matched = byNorm.get(normalise(v)).title;
    } else {
      verdict = "NO MATCH";
      matched = "—";
    }
    rows.push({ v, verdict, matched });
    console.log(
      "  " +
        escapeNonAscii(v).padEnd(28) +
        verdict.padEnd(22) +
        escapeNonAscii(matched),
    );
  }

  const needsWork = rows.filter(
    (r) => r.verdict === "needs normalising",
  ).length;
  const unmatched = rows.filter((r) => r.verdict === "NO MATCH").length;
  console.log(
    `\n  ${rows.length} distinct source values: ` +
      `${rows.length - needsWork - unmatched} match as-is, ` +
      `${needsWork} need our normalisation, ${unmatched} match nothing at all.`,
  );
  if (unmatched) {
    console.log(
      "  A value matching nothing cannot be rescued by normalising — the option\n" +
        "  list is fixed (system enriched attribute), so the cell is simply dropped.",
    );
  }
  return rows;
}

function csvCell(value, delimiter) {
  const needsQuote =
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes(delimiter);
  return needsQuote ? `"${value.replaceAll('"', '""')}"` : value;
}

function renderCsv(rows, { delimiter, eol, bom }) {
  const body =
    rows
      .map((r) => r.map((c) => csvCell(c, delimiter)).join(delimiter))
      .join(eol) + eol;
  return (bom ? "﻿" : "") + body;
}

function cmdCsv() {
  ensureOutDir();
  const schema = loadSchema();
  const companies = schema.objects.companies || [];
  const er = companies.find((a) => a.api_slug === "employee_range");

  if (!er || !Array.isArray(er.options) || !er.options.length) {
    fail(
      "No employee_range options in the schema dump — cannot build a meaningful\n" +
        "  dash experiment without the real labels. Re-run `schema` and check the output.",
    );
  }

  const sourceValues = sourceEmployeeValues();
  if (sourceValues.length) reportCoverage(sourceValues, er.options);

  heading("Probe CSVs");

  // Test the option our source data actually collides with, not an arbitrary
  // one: `51-200` and `51–200` are distinct options in Notion (#5), so that is
  // the pair the emitter has to reconcile. Fall back to any dashed option.
  const preferred = sourceValues
    .map((v) => er.options.find((o) => normalise(o.title) === normalise(v)))
    .find(Boolean);
  const dashed =
    preferred || er.options.find((o) => /[-–—]/.test(o.title)) || er.options[0];
  const exact = dashed.title;
  const twin = swapDash(exact);
  const padded = `  ${exact.toUpperCase()}  `;
  const absent = "Definitely Not An Option 9999";

  console.log(`  employee_range label under test: ${label(exact)}`);
  console.log(`  dash-swapped twin              : ${label(twin)}`);
  if (twin === exact) {
    console.log(
      "  ! the label has no dash, so the dash experiment degenerates —",
    );
    console.log("    the padded/case and unmatched-value probes still hold.");
  }

  const header = ["Domains", "Name", "Employee range", "Description"];

  // Names carry the three characters the docs never commit to: an accented
  // Latin-1 char, an en dash, and an astral-plane emoji.
  const rowsFor = (tag) => [
    header,
    [
      `${tag}1.${PROBE_TLD}`,
      `${tag.toUpperCase()}1 Café – Probe \u{1F680}`,
      exact,
      `${tag} exact label`,
    ],
    [
      `${tag}2.${PROBE_TLD}`,
      `${tag.toUpperCase()}2 Probe`,
      twin,
      `${tag} dash-swapped label`,
    ],
    // Upper-casing is a no-op on a digits-only label like `51-200`; the live
    // question this row asks is whether Attio trims surrounding whitespace,
    // which nothing in the docs promises.
    [
      `${tag}3.${PROBE_TLD}`,
      `${tag.toUpperCase()}3 Probe`,
      padded,
      `${tag} whitespace-padded`,
    ],
    [
      `${tag}4.${PROBE_TLD}`,
      `${tag.toUpperCase()}4 Probe`,
      absent,
      `${tag} value not in options`,
    ],
  ];

  // Probe A also carries the enrichment fight: a real domain Attio can look up,
  // imported with a deliberately wrong Employee range.
  const rowsA = rowsFor("a");
  rowsA.push([
    ENRICHED_DOMAIN,
    "A5 Enrichment Probe",
    twin,
    "a real domain, wrong range on purpose",
  ]);

  const files = [
    {
      name: "probe-a-utf8-lf-comma.csv",
      rows: rowsA,
      opts: { delimiter: ",", eol: "\n", bom: false },
      what: "UTF-8, no BOM, LF, comma — the LF variant of what we emit",
    },
    {
      name: "probe-b-utf8bom-crlf-comma.csv",
      rows: rowsFor("b"),
      opts: { delimiter: ",", eol: "\r\n", bom: true },
      what: "UTF-8 WITH BOM, CRLF, comma — what Excel produces",
    },
    {
      name: "probe-c-utf8-lf-semicolon.csv",
      rows: rowsFor("c"),
      opts: { delimiter: ";", eol: "\n", bom: false },
      what: "UTF-8, no BOM, LF, semicolon — European Excel export",
    },
  ];

  for (const f of files) {
    const target = path.join(OUT_DIR, f.name);
    writeFileSync(target, renderCsv(f.rows, f.opts), "utf8");
    console.log(`  ${f.name}\n    ${f.what}`);
  }
  console.log(`\n✓ wrote 3 files to ${path.relative(ROOT, OUT_DIR)}`);
  console.log(
    "\n  Next: import each one in the Attio UI (Companies), mapping Domains,",
  );
  console.log(
    '  Name, Employee range and Description by hand. Do NOT tick "Create',
  );
  console.log(
    '  missing select options" — the point is to see what matches on its own.',
  );
  console.log("  Then run: node scripts/probe-attio.mjs readback");
}

// ---------------------------------------------------------- 3. readback

function firstValue(values) {
  if (!Array.isArray(values) || !values.length) return null;
  return values[0];
}

async function findProbeCompanies() {
  const res = await attioOrFail("POST", "/objects/companies/records/query", {
    limit: 100,
    filter: {
      $or: [
        { domains: { domain: { $contains: PROBE_TLD } } },
        { domains: { domain: { $eq: ENRICHED_DOMAIN } } },
      ],
    },
  });
  return res.data;
}

async function cmdReadback() {
  const records = await findProbeCompanies();
  heading(`Readback — ${records.length} probe companies found`);

  if (!records.length) {
    console.log(
      "  Nothing found. Either the imports have not run yet, or every row",
    );
    console.log(
      "  was rejected. Check the Attio import history before concluding.",
    );
    return;
  }

  const byTag = new Map();
  for (const r of records) {
    const v = r.values || {};
    const domain = (firstValue(v.domains) || {}).domain || "(none)";
    const name = (firstValue(v.name) || {}).value ?? null;
    const rangeVal = firstValue(v.employee_range);
    const range = rangeVal
      ? ((rangeVal.option || {}).title ?? rangeVal.value ?? null)
      : null;
    const descVal = firstValue(v.description);
    const desc = descVal ? (descVal.value ?? null) : null;

    const tag = domain.startsWith("a")
      ? "A"
      : domain.startsWith("b")
        ? "B"
        : domain.startsWith("c")
          ? "C"
          : "A";
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push({ domain, name, range, desc, id: r.id.record_id });
  }

  for (const [tag, rows] of [...byTag.entries()].sort()) {
    console.log(`\n  Probe ${tag}`);
    for (const row of rows.sort((x, y) => x.domain.localeCompare(y.domain))) {
      console.log(`    ${row.domain}`);
      console.log(
        `      Name           ${row.name === null ? "(empty)" : label(row.name)}`,
      );
      console.log(
        `      Employee range ${row.range === null ? "(empty)" : label(row.range)}`,
      );
      console.log(
        `      Description    ${row.desc === null ? "(empty)" : label(row.desc)}`,
      );
    }
  }

  heading("What to read off this");
  console.log(
    "  Encoding   — if a Name comes back with \\u{E9}, \\u{2013} and \\u{1F680} intact,",
  );
  console.log(
    "               UTF-8 round-trips. Mojibake (\\u{C3}\\u{A9}) means it does not.",
  );
  console.log(
    '  BOM        — probe B\'s first column is "Domains". If the BOM leaked, the',
  );
  console.log(
    "               header reads \\u{FEFF}Domains and the auto-mapper will have",
  );
  console.log(
    "               missed that column (or the whole import failed).",
  );
  console.log(
    "  Delimiter  — if probe C imported as ONE column, semicolon files are not",
  );
  console.log(
    "               understood and our emitter must never produce one.",
  );
  console.log(
    "  Dash       — row 2 of each probe carries the dash-swapped label. A non-empty",
  );
  console.log(
    "               Employee range there means Attio folds dashes; empty means the",
  );
  console.log(
    "               `51-200`/`51\\u{2013}200` split is ours to normalise (#6).",
  );
  console.log(
    "  Padding    — row 3 is padded and upper-cased. Case is documented as ignored;",
  );
  console.log("               leading/trailing whitespace is not.");
  console.log(
    "  Enriched   — stripe.com was imported with a deliberately wrong range. If the",
  );
  console.log(
    "               value is absent or has become Attio's own, enrichment owns it.",
  );
  console.log(
    "\n  Re-run this after a few hours to catch a late enrichment overwrite.",
  );
}

// ------------------------------------------------------------- 4. write

async function cmdWrite() {
  const records = await findProbeCompanies();
  const target = records.find((r) =>
    ((firstValue((r.values || {}).domains) || {}).domain || "").includes(
      PROBE_TLD,
    ),
  );
  if (!target) {
    fail(
      "No probe company found to write to. Run the imports first, or create one by hand.",
    );
  }

  const schema = existsSync(SCHEMA_PATH) ? loadSchema() : null;
  const er =
    schema &&
    (schema.objects.companies || []).find(
      (a) => a.api_slug === "employee_range",
    );
  const optionTitle =
    er && Array.isArray(er.options) && er.options.length
      ? er.options[0].title
      : "11-50";

  heading("Direct API write to the enriched select");
  console.log(`  PATCH /objects/companies/records/${target.id.record_id}`);
  console.log(`  employee_range = ${label(optionTitle)}`);

  const r = await attio(
    "PATCH",
    `/objects/companies/records/${target.id.record_id}`,
    {
      data: { values: { employee_range: optionTitle } },
    },
  );

  console.log(`\n  → HTTP ${r.status}`);
  console.log(`  ${(r.text || "").slice(0, 600)}`);
  console.log(
    r.ok
      ? "\n  Accepted. The attribute is writable by the API despite being enriched —\n" +
          "  re-run `readback` later to see whether enrichment takes it back."
      : "\n  Rejected. The API will not write this attribute at all, which matches\n" +
          "  is_writable=false and settles who owns the value.",
  );
}

// ----------------------------------------------------------- 5. cleanup

async function cmdCleanup() {
  const records = await findProbeCompanies();
  const probes = records.filter((r) =>
    ((firstValue((r.values || {}).domains) || {}).domain || "").includes(
      PROBE_TLD,
    ),
  );
  heading(`Cleanup — deleting ${probes.length} probe companies`);
  console.log(
    `  (${ENRICHED_DOMAIN} is left alone — delete it by hand if you want it gone.)`,
  );
  for (const r of probes) {
    const res = await attio(
      "DELETE",
      `/objects/companies/records/${r.id.record_id}`,
    );
    const domain = (firstValue((r.values || {}).domains) || {}).domain;
    console.log(`  ${res.ok ? "✓" : "✗"} ${domain} (${res.status})`);
  }
}

// ---------------------------------------------------------------- main

const COMMANDS = {
  schema: cmdSchema,
  csv: cmdCsv,
  readback: cmdReadback,
  write: cmdWrite,
  cleanup: cmdCleanup,
};

const cmd = process.argv[2];
if (!cmd || !COMMANDS[cmd]) {
  console.error(
    `\nUsage: node scripts/probe-attio.mjs <${Object.keys(COMMANDS).join("|")}>\n\n` +
      "  schema    enumerate objects, attributes and every select option label\n" +
      "  csv       generate the three probe CSVs from the real option labels\n" +
      "  readback  report exactly what the UI imports landed\n" +
      "  write     attempt a direct API write to the enriched Employee range\n" +
      "  cleanup   delete the probe companies\n",
  );
  process.exit(1);
}

await COMMANDS[cmd]();
