#!/usr/bin/env node
/**
 * Byte-inspects Attio's own downloadable CSV import templates (issue #12).
 *
 * Attio's signup rejects personal email domains, so we cannot stand up a
 * workspace to probe the importer directly. These templates are the next best
 * primary source, and for the encoding question they are arguably better than a
 * probe: they are the files Attio itself hands users to fill in and upload, so
 * whatever bytes they carry are bytes the importer is guaranteed to accept.
 *
 * That settles by observation what the docs never state (silences 1-4 in
 * docs/research/attio-csv-importer.md): encoding, BOM, line endings, delimiter
 * and quoting style.
 *
 * Usage: node scripts/inspect-attio-templates.mjs
 * Writes docs/attio-template-bytes.json. Requires Node 20+ (global fetch).
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "attio-template-bytes.json");

// Linked from Attio's own import guide and formatting guide.
const TEMPLATES = {
  people:
    "https://a.storyblok.com/f/234930/x/175fdf6914/attio-csv-import-template-people.csv",
  companies:
    "https://a.storyblok.com/f/234930/x/e998c0de2c/attio-csv-import-template-companies.csv",
  deals:
    "https://a.storyblok.com/f/234930/x/23c0505bf7/attio-csv-import-template-deals.csv",
  "people-and-companies":
    "https://a.storyblok.com/f/234930/x/f7f2c5ee36/attio-csv-import-template-people-and-companies.csv",
  "deals-and-companies":
    "https://a.storyblok.com/f/234930/x/8792194a4b/attio-csv-import-template-deals-and-companies.csv",
  "deals-domains-and-emails":
    "https://a.storyblok.com/f/234930/x/61601e3176/attio-csv-import-template-deals-domains-and-emails.csv",
};

function heading(s) {
  console.log(`\n${"─".repeat(74)}\n${s}\n${"─".repeat(74)}`);
}

/** Non-ASCII characters rendered as codepoints — the dash question is invisible otherwise. */
function escapeNonAscii(s) {
  return [...s]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      return cp >= 0x20 && cp < 0x7f
        ? ch
        : `\\u{${cp.toString(16).toUpperCase()}}`;
    })
    .join("");
}

function analyse(buf) {
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const cr = [...buf].filter((b) => b === 0x0d).length;
  const lf = [...buf].filter((b) => b === 0x0a).length;

  const text = buf.toString("utf8");
  // A lone U+FFFD means the bytes were not valid UTF-8.
  const validUtf8 = !text.includes("�");

  const body = hasBom ? text.slice(1) : text;
  const firstLine = body.split(/\r?\n/)[0] ?? "";

  // Count delimiter candidates outside quoted regions on the header line.
  const outsideQuotes = (line, ch) => {
    let inQ = false,
      n = 0;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === ch && !inQ) n++;
    }
    return n;
  };

  return {
    bytes: buf.length,
    firstFourBytes: [...buf.slice(0, 4)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" "),
    hasUtf8Bom: hasBom,
    validUtf8,
    crCount: cr,
    lfCount: lf,
    lineEndings: cr === 0 ? "LF" : cr === lf ? "CRLF" : "mixed",
    trailingNewline: /[\r\n]$/.test(text),
    headerCommas: outsideQuotes(firstLine, ","),
    headerSemicolons: outsideQuotes(firstLine, ";"),
    headerTabs: outsideQuotes(firstLine, "\t"),
    usesQuoting: body.includes('"'),
    usesDoubledQuotes: body.includes('""'),
    nonAscii: [
      ...new Set([...body].filter((c) => c.codePointAt(0) > 0x7f)),
    ].map((c) => ({
      char: c,
      codepoint: `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
    })),
    header: firstLine,
    lines: body.split(/\r?\n/).filter(Boolean).length,
  };
}

const results = {};
let failures = 0;

heading("Attio's own CSV import templates — byte inspection");

for (const [name, url] of Object.entries(TEMPLATES)) {
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  ${name}: HTTP ${res.status} — skipped`);
    failures++;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const a = analyse(buf);
  results[name] = { url, contentType: res.headers.get("content-type"), ...a };

  console.log(`\n  ${name}`);
  console.log(
    `    bytes          ${a.bytes}   first four: ${a.firstFourBytes}`,
  );
  console.log(`    UTF-8 BOM      ${a.hasUtf8Bom}`);
  console.log(`    valid UTF-8    ${a.validUtf8}`);
  console.log(
    `    line endings   ${a.lineEndings}  (CR ${a.crCount}, LF ${a.lfCount})`,
  );
  console.log(`    trailing \\n    ${a.trailingNewline}`);
  console.log(
    `    header delims  , ${a.headerCommas}   ; ${a.headerSemicolons}   tab ${a.headerTabs}`,
  );
  console.log(
    `    quoting        uses " ${a.usesQuoting}, doubled "" ${a.usesDoubledQuotes}`,
  );
  console.log(
    `    non-ASCII      ${
      a.nonAscii.length
        ? a.nonAscii.map((c) => `${c.char} ${c.codepoint}`).join(", ")
        : "none"
    }`,
  );
  console.log(`    header         ${escapeNonAscii(a.header)}`);
}

// ------------------------------------------------------------------ verdict

const all = Object.values(results);
heading("Verdict");

if (!all.length) {
  console.log("  Nothing downloaded — cannot conclude anything.");
  process.exit(1);
}

const agree = (key) => {
  const vals = [...new Set(all.map((r) => JSON.stringify(r[key])))];
  return vals.length === 1 ? JSON.parse(vals[0]) : null;
};

const bom = agree("hasUtf8Bom");
const eol = agree("lineEndings");

console.log(`  ${all.length} templates inspected.`);
console.log(
  `  BOM            ${
    bom === null
      ? "DISAGREE between templates"
      : bom
        ? "all have one"
        : "none has one"
  }`,
);
console.log(
  `  line endings   ${eol === null ? "DISAGREE between templates" : `all ${eol}`}`,
);
console.log(
  `  delimiter      ${
    all.every((r) => r.headerCommas > 0 && r.headerSemicolons === 0)
      ? "all comma"
      : "not uniform"
  }`,
);
console.log(
  `  valid UTF-8    ${all.every((r) => r.validUtf8) ? "all" : "NOT ALL — investigate"}`,
);

console.log(
  "\n  These are the files Attio hands users to fill in and upload, so this is\n" +
    "  the byte shape its importer is guaranteed to accept. Emitting the same\n" +
    "  shape needs no experiment and carries no risk.",
);

if (!existsSync(path.dirname(OUT)))
  mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ fetchedAt: new Date().toISOString(), results }, null, 2) +
    "\n",
);
console.log(`\n✓ wrote ${path.relative(ROOT, OUT)}`);

if (failures) process.exit(1);
