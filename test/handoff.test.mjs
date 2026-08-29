/**
 * The handoff bundle, over the HTTP contract (#56).
 *
 * Same discipline as `review.test.mjs`: the run is driven through the real
 * routes, and the flags a test answers are **found in the ledger** rather than
 * named by id here — a test that hardcoded `W1:deal:brightyard.example.com`
 * would pass while the pipeline keyed candidates on something else entirely.
 *
 * The model is faked at the network with #30's recorded reading of this batch,
 * so the run under test is the one the reviewer would see: two notices, one
 * decision Warn, one batch flag, and one Stop nobody can answer.
 *
 * Two things are asserted **separately** and must stay that way:
 *
 * - the emitted CSVs equal the committed example byte for byte, and
 * - the emitted CSVs obey the byte rules — valid UTF-8, no BOM, CRLF only, no
 *   trailing newline.
 *
 * A golden match alone would let a future fixture regression pass by agreeing
 * with a wrong file.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { fakeNotion } from "./notion-fake.mjs";
import { fakeModel } from "./model-fake.mjs";
import {
  parseCsv,
  buildProperties,
  CSV_PATH,
  TARGET_BATCH,
  TARGET_STATUS,
} from "../scripts/seed-notion-source-db.mjs";

const DB_PATH = join(tmpdir(), `notion2attio-${randomUUID()}.sqlite`);

process.env.DATABASE_PATH = DB_PATH;
process.env.NOTION_OAUTH_CLIENT_ID = "test-client-id";
process.env.NOTION_OAUTH_CLIENT_SECRET = "test-client-secret";
// A key, so the notes are read and the batch carries its two notices rather
// than the `N0` that stands in for them when nothing read the notes.
process.env.OPENAI_API_KEY = "test-model-key";

const { default: app } = await import("../src/app.ts");

const CARPE_LAB = {
  access_token: "ntn_live_token",
  workspace_id: "ws-1",
  workspace_name: "Carpe Lab",
  workspace_icon: null,
};

const DATA_SOURCE_ID = "ds-shared-by-the-grant";
const QUERY_PATH = `/v1/data_sources/${DATA_SOURCE_ID}/query`;

/** The committed exhibit the emitted bytes are compared against. */
const EXAMPLE_DIR = fileURLToPath(
  new URL("../docs/examples/handoff-2026-W34/", import.meta.url),
);
const committed = (name) => readFileSync(join(EXAMPLE_DIR, name));

// ── The batch, and what the model says about it ────────────────────────────

const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
const batchRows = rows.filter(
  (row) => row.Batch === TARGET_BATCH && row["CRM status"] === TARGET_STATUS,
);

/** #30's result on this batch, replayed. Identical to `screening.test.mjs`. */
const SUSPICIONS = {
  "Heliograph Systems": [
    {
      kind: "N1",
      quote: "She previously spoke to the team under another email address.",
    },
  ],
  "Lattice Forge": [
    { kind: "N1", quote: "Noor replied from a newer email alias." },
    {
      kind: "N2",
      quote:
        "Their LinkedIn profile and role match a person already researched in the spring campaign.",
    },
  ],
};

const scripted = (notes) =>
  SUSPICIONS[
    batchRows.find((row) => row["Research notes"] === notes)?.Account
  ] ?? [];

const pages = rows.map((row) => {
  const properties = buildProperties(row);
  for (const value of Object.values(properties)) {
    for (const piece of value.title ?? value.rich_text ?? []) {
      piece.plain_text = piece.text.content;
    }
  }
  return { object: "page", id: row["Source ID"], properties };
});

const notion = fakeNotion();
// Installed second, so it answers the model and hands everything else down.
const model = fakeModel();

// ── The app under test ─────────────────────────────────────────────────────

let base;
let server;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/connection`); // one read, so the tables exist
});

after(() => {
  server?.close();
  model.restore();
  notion.restore();
  rmSync(DB_PATH, { force: true });
});

beforeEach(() => {
  notion.script = {
    "/v1/search": () => [
      200,
      { results: [{ object: "data_source", id: DATA_SOURCE_ID }] },
    ],
    [QUERY_PATH]: (body) => [
      200,
      {
        results: pages.filter(
          (page) =>
            page.properties.Batch.select?.name ===
              body.filter.and[1].select.equals &&
            page.properties["CRM status"].status?.name === TARGET_STATUS,
        ),
        has_more: false,
        next_cursor: null,
      },
    ],
  };
  model.reply = (notes) => scripted(notes);

  const db = new DatabaseSync(DB_PATH);
  db.exec("DELETE FROM connection");
  db.exec("DELETE FROM runs");
  db.prepare(
    `INSERT INTO connection (id, token_response, connected_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token_response = excluded.token_response`,
  ).run(JSON.stringify(CARPE_LAB), new Date().toISOString());
  db.close();
});

// ── Driving one run ────────────────────────────────────────────────────────

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

const snapshot = async (runId) =>
  (await fetch(`${base}/api/runs/${runId}`)).json();

/** A run taken to its first pause, with the ledger it paused on. */
async function paused() {
  const { runId } = await (
    await post("/api/runs", { batch: TARGET_BATCH })
  ).json();
  for (let tries = 0; tries < 400; tries += 1) {
    const body = await snapshot(runId);
    if (body.status === "awaiting_review") return { runId, ...body };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`run ${runId} never reached awaiting_review`);
}

const everyCandidate = (ledger) => [
  ...ledger.candidates.companies,
  ...ledger.candidates.people,
  ...ledger.candidates.deals,
];

/**
 * Every Warn in the ledger, answered with `true`: the batch flag, both
 * notices and the Brightyard decision. Found in the ledger rather than named,
 * and holding nothing.
 */
const answerEveryWarn = (ledger) =>
  Object.fromEntries(
    [
      ...everyCandidate(ledger).flatMap((candidate) => candidate.flags),
      ...ledger.batchFlags,
    ]
      .filter((flag) => flag.level === "warn")
      .map((flag) => [flag.id, true]),
  );

const review = async (runId, decision) => {
  const res = await post(`/api/runs/${runId}/review`, decision);
  const body = await res.text();
  assert.equal(res.status, 200, body);
  return JSON.parse(body);
};

/** The W34 run the acceptance criteria describe, exported. */
async function exported(extra = {}) {
  const ledger = await paused();
  const answers = { ...answerEveryWarn(ledger), ...(extra.answers ?? {}) };
  const after = await review(ledger.runId, { answers, held: extra.held ?? [] });
  assert.equal(after.status, "awaiting_confirmation", JSON.stringify(after));
  return { runId: ledger.runId, ledger, ...after };
}

const named = (files, filename) =>
  files.find((file) => file.filename === filename);

const download = async (runId, fileId) => {
  const res = await fetch(`${base}/api/runs/${runId}/files/${fileId}`);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
};

const bytesOf = async (run, filename) => {
  const file = named(run.files, filename);
  assert.ok(file, `${filename} is not in the bundle`);
  return (await download(run.runId, file.fileId)).bytes;
};

/** Rows, not lines: the header is not a row and there is no trailing newline. */
const rowCount = (bytes) => bytes.toString("utf8").split("\r\n").length - 1;

// ── The bundle is the committed example ────────────────────────────────────

const IMPORT_FILES = ["1-companies.csv", "2-people.csv", "3-deals.csv"];

test("the W34 bundle is the committed example, byte for byte", async () => {
  const run = await exported();
  for (const name of IMPORT_FILES) {
    assert.deepEqual(
      await bytesOf(run, name),
      committed(name),
      `${name} differs from the committed example`,
    );
  }
});

test("the emitted CSVs obey the byte rules, golden match or not", async () => {
  const run = await exported();
  for (const name of IMPORT_FILES) {
    const bytes = await bytesOf(run, name);

    assert.doesNotThrow(
      () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      `${name} is not valid UTF-8`,
    );
    assert.notDeepEqual(
      bytes.subarray(0, 3),
      Buffer.from([0xef, 0xbb, 0xbf]),
      `${name} carries a BOM`,
    );

    const bare = { LF: 0, CR: 0 };
    for (const [i, byte] of bytes.entries()) {
      if (byte === 0x0a && bytes[i - 1] !== 0x0d) bare.LF += 1;
      if (byte === 0x0d && bytes[i + 1] !== 0x0a) bare.CR += 1;
    }
    assert.deepEqual(bare, { LF: 0, CR: 0 }, `${name} has a bare line ending`);

    const last = bytes.at(-1);
    assert.ok(
      last !== 0x0a && last !== 0x0d,
      `${name} ends with a trailing newline`,
    );
  }
});

// ── What is in the bundle, and what is not ─────────────────────────────────

test("a Company with no exported Person is still sent", async () => {
  const run = await exported();
  const companies = (await bytesOf(run, "1-companies.csv")).toString("utf8");

  // The account whose only contact the batch holds — found in the ledger.
  const held = run.ledger.candidates.people.find((person) =>
    person.flags.some((flag) => flag.rule === "B1"),
  );
  const company = run.ledger.candidates.companies.find(
    (one) => one.id === held.companyId,
  );

  assert.equal(rowCount(companies), 1);
  assert.match(companies, new RegExp(company.name));
  assert.match(companies, new RegExp(company.domain));
  // Attio enriches it, and a manual value permanently suppresses that (#12).
  assert.doesNotMatch(companies, /Employee range/);
});

test("1-companies.csv is absent when every company has an exported person", async () => {
  const ledger = await paused();
  const held = ledger.candidates.people.find((person) =>
    person.flags.some((flag) => flag.rule === "B1"),
  );
  const stop = held.flags.find((flag) => flag.rule === "B1");

  // The one identity change the freeze permits: the Stop's own control,
  // answered, which puts the last account's contact back into the files.
  const run = {
    runId: ledger.runId,
    ...(await review(ledger.runId, {
      answers: {
        ...answerEveryWarn(ledger),
        [stop.id]: { email: "amina.yusuf@tern.example.com" },
      },
    })),
  };

  assert.equal(run.status, "awaiting_confirmation");
  assert.equal(named(run.files, "1-companies.csv"), undefined);
  assert.equal(rowCount(await bytesOf(run, "2-people.csv")), 8);
  // The account is whole, so its Deal is no longer withheld.
  assert.equal(rowCount(await bytesOf(run, "3-deals.csv")), 7);
});

test("a Deal whose account has an unanswered candidate is withheld", async () => {
  const run = await exported();
  assert.equal(run.ledger.candidates.deals.length, 7);
  assert.equal(rowCount(await bytesOf(run, "3-deals.csv")), 6);

  // Withheld by the account it waits on, never by a hold nobody made.
  const withheld = run.candidates.deals.filter((deal) => deal.held);
  assert.equal(withheld.length, 1);
  assert.ok(withheld[0].flags.some((flag) => flag.rule === "D1"));
});

test("export is refused while any Warn is unanswered", async () => {
  const ledger = await paused();
  const answers = answerEveryWarn(ledger);
  const [first] = Object.keys(answers);
  delete answers[first];

  const after = await review(ledger.runId, { answers });

  assert.equal(after.status, "awaiting_review");
  assert.equal(after.files, null);
});

// ── The download ───────────────────────────────────────────────────────────

test("the run reaches awaiting_confirmation when the files exist, served with the CSV content type and an attachment disposition", async () => {
  const run = await exported();
  assert.equal(run.status, "awaiting_confirmation");
  assert.ok(run.files.length > 0);

  const people = named(run.files, "2-people.csv");
  const { res, bytes } = await download(run.runId, people.fileId);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    res.headers.get("content-disposition"),
    'attachment; filename="2-people.csv"',
  );
  // `bytes` on the wire is the size; the bytes themselves are this response.
  assert.equal(people.bytes, bytes.length);
});

test("downloading twice returns identical bytes and does not advance the run", async () => {
  const run = await exported();
  const file = named(run.files, `handoff-${TARGET_BATCH}.zip`);

  const first = await download(run.runId, file.fileId);
  const second = await download(run.runId, file.fileId);

  assert.deepEqual(first.bytes, second.bytes);
  const after = await snapshot(run.runId);
  assert.equal(after.status, "awaiting_confirmation");
  assert.deepEqual(after.files, run.files);
});

test("an unknown fileId is a lookup miss, not an empty download", async () => {
  const run = await exported();
  const res = await fetch(`${base}/api/runs/${run.runId}/files/deadbeef`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "no_such_file");
});

// ── The ZIP, read back independently of the writer ─────────────────────────

/**
 * A minimal reader for the archive `emit.ts` writes: walk the central
 * directory, and take each member's bytes from the offset it names. It checks
 * the writer's own arithmetic — sizes, offsets and CRCs — rather than trusting
 * the same code that produced them.
 */
function unzip(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, "no end-of-central-directory record");

  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const members = {};

  for (let i = 0; i < count; i += 1) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const sum = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive
      .subarray(at + 46, at + 46 + nameLength)
      .toString("utf8");

    assert.equal(archive.readUInt32LE(offset), 0x04034b50);
    const localName = archive.readUInt16LE(offset + 26);
    const extra = archive.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + extra;
    const bytes = archive.subarray(start, start + size);

    assert.equal(crc32(bytes), sum, `${name} fails its CRC`);
    members[name] = bytes;
    at +=
      46 +
      nameLength +
      archive.readUInt16LE(at + 30) +
      archive.readUInt16LE(at + 32);
  }

  return members;
}

test("the bundle is one ZIP named for the batch, holding the numbered files and the notes", async () => {
  const run = await exported();

  const archive = await bytesOf(run, `handoff-${TARGET_BATCH}.zip`);
  const members = unzip(archive);

  assert.deepEqual(Object.keys(members).sort(), [
    ...IMPORT_FILES,
    "handoff-notes.md",
  ]);
  for (const name of IMPORT_FILES) {
    assert.deepEqual(members[name], committed(name));
  }

  const res = await fetch(
    `${base}/api/runs/${run.runId}/files/${named(run.files, `handoff-${TARGET_BATCH}.zip`).fileId}`,
  );
  assert.equal(res.headers.get("content-type"), "application/zip");
});

// ── The notes file ─────────────────────────────────────────────────────────

test("the notes file is Markdown carrying the prose, the repair log and every flag with its answer", async () => {
  const run = await exported();

  const file = named(run.files, "handoff-notes.md");
  const notes = (await bytesOf(run, "handoff-notes.md")).toString("utf8");

  // Never a CSV, so no auto-mapper and no tired human offers it to Attio.
  assert.match(file.filename, /\.md$/);
  assert.equal(
    (await download(run.runId, file.fileId)).res.headers.get("content-type"),
    "text/markdown; charset=utf-8",
  );

  // The prose Attio's importer cannot take — every row's, held or not.
  for (const row of batchRows) {
    assert.ok(
      notes.includes(row["Research notes"]),
      `the notes for ${row["Source ID"]} are missing`,
    );
  }

  // The repair log, in place against the values it changed.
  for (const repair of run.repairs) {
    assert.ok(
      notes.includes(repair.from),
      `repair from ${repair.from} missing`,
    );
    assert.ok(notes.includes(repair.to), `repair to ${repair.to} missing`);
  }
  assert.ok(run.repairs.length > 0);

  // Every flag, with its answer — including the Stop that held a row out.
  const flags = [
    ...everyCandidate(run).flatMap((candidate) => candidate.flags),
    ...run.batchFlags,
  ];
  assert.ok(flags.some((flag) => flag.rule === "B1"));
  for (const flag of flags) {
    assert.ok(notes.includes(flag.rule), `flag ${flag.rule} missing`);
  }
  assert.match(notes, /answered/);
  assert.match(notes, /not answered/);
});
