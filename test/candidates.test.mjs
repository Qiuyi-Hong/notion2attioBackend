/**
 * The ledger, over the HTTP contract (#52).
 *
 * Every assertion here is made on the snapshot `GET /api/runs/:runId` answers
 * — the thing the Reviewer would see — never on an in-process candidate
 * object, because a candidate that is correct in memory and absent from the
 * wire is not a candidate the Reviewer has.
 *
 * Every count is **re-derived from the batch data**, by a route independent of
 * the code under test: the number of companies is the number of distinct
 * `Account` names, not the number of distinct repaired domains. The two agree
 * on W34 for different reasons, which is the point — a normaliser that merged
 * the wrong rows would break the agreement rather than move both numbers.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { fakeNotion } from "./notion-fake.mjs";
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

const { default: app } = await import("../src/app.ts");

const CARPE_LAB = {
  access_token: "ntn_live_token",
  workspace_id: "ws-1",
  workspace_name: "Carpe Lab",
  workspace_icon: null,
};

const DATA_SOURCE_ID = "ds-shared-by-the-grant";
const QUERY_PATH = `/v1/data_sources/${DATA_SOURCE_ID}/query`;

// ── The batch, and what it implies ─────────────────────────────────────────

const rows = parseCsv(readFileSync(CSV_PATH, "utf8")).filter(
  (row) => row.Batch === TARGET_BATCH && row["CRM status"] === TARGET_STATUS,
);

/** One Company per account, one Person per source row, one Deal per Company. */
const accounts = new Set(rows.map((row) => row.Account));

/** A website needing no repair: no scheme, no `www.`, no path, already lower. */
const alreadyNormalised = (website) => /^(?!www\.)[a-z0-9.-]+$/.test(website);

const rowsFor = (account) => rows.filter((row) => row.Account === account);

// ── The Notion fake ────────────────────────────────────────────────────────

const pages = parseCsv(readFileSync(CSV_PATH, "utf8")).map((row) => {
  const properties = buildProperties(row);
  for (const value of Object.values(properties)) {
    for (const piece of value.title ?? value.rich_text ?? []) {
      piece.plain_text = piece.text.content;
    }
  }
  return { object: "page", id: row["Source ID"], properties };
});

const notion = fakeNotion();

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
  notion.restore();
  rmSync(DB_PATH, { force: true });
});

beforeEach(() => {
  notion.calls = [];
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
  const db = new DatabaseSync(DB_PATH);
  db.exec("DELETE FROM connection");
  db.exec("DELETE FROM runs");
  db.close();
  connect(CARPE_LAB);
});

/** A stored Connection, without walking the consent round trip again. */
function connect(workspace) {
  const db = new DatabaseSync(DB_PATH);
  db.prepare(
    `INSERT INTO connection (id, token_response, connected_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token_response = excluded.token_response`,
  ).run(JSON.stringify(workspace), new Date().toISOString());
  db.close();
}

/** Runs the batch and returns the snapshot the Reviewer would be looking at. */
async function reviewSnapshot() {
  const started = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batch: TARGET_BATCH }),
  });
  assert.equal(started.status, 202);
  const { runId } = await started.json();

  for (let tries = 0; tries < 200; tries += 1) {
    const body = await (await fetch(`${base}/api/runs/${runId}`)).json();
    if (body.status === "awaiting_review") return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`run ${runId} never reached awaiting_review`);
}

// ── The candidates ─────────────────────────────────────────────────────────

test("the run proposes one company per account, one person per row, one deal per company", async () => {
  const { candidates } = await reviewSnapshot();

  assert.equal(candidates.companies.length, accounts.size);
  assert.equal(candidates.people.length, rows.length);
  assert.equal(candidates.deals.length, candidates.companies.length);

  // A candidate is its key, so a repeated id would mean two candidates the
  // ledger cannot tell apart and Attio would upsert onto one record.
  for (const group of Object.values(candidates)) {
    const ids = group.map((candidate) => candidate.id);
    assert.equal(new Set(ids).size, ids.length, "every candidate is distinct");
  }
});

test("both Brightyard rows make one company carrying two people and one deal", async () => {
  const brightyard = rowsFor("Brightyard");
  assert.equal(brightyard.length, 2, "the batch has the two rows to collapse");
  const { candidates } = await reviewSnapshot();

  const people = candidates.people.filter((person) =>
    brightyard.some((row) => row["Source ID"] === person.sourceId),
  );
  assert.equal(people.length, 2, "two contacts");
  const [companyId] = new Set(people.map((person) => person.companyId));
  assert.equal(
    new Set(people.map((person) => person.companyId)).size,
    1,
    "on one company candidate",
  );
  assert.equal(
    candidates.companies.filter((company) => company.id === companyId).length,
    1,
  );
  assert.equal(
    candidates.deals.filter((deal) => deal.companyId === companyId).length,
    1,
    "one opportunity, not one per row",
  );
});

test("a path and a `www.` both normalise to a bare domain", async () => {
  const withPath = rows.find((row) => /\/\/[^/]+\/.+/.test(row.Website));
  const withWww = rows.find((row) => /\/\/www\./.test(row.Website));
  const { candidates } = await reviewSnapshot();

  for (const row of [withPath, withWww]) {
    const person = candidates.people.find(
      (candidate) => candidate.sourceId === row["Source ID"],
    );
    const company = candidates.companies.find(
      (candidate) => candidate.id === person.companyId,
    );
    assert.ok(
      alreadyNormalised(company.domain),
      `${row.Website} became ${company.domain}`,
    );
  }
});

test("a person references its company rather than copying it", async () => {
  const { candidates } = await reviewSnapshot();

  for (const person of candidates.people) {
    assert.ok(person.companyId, "every person names its company");
    assert.ok(
      candidates.companies.some((company) => company.id === person.companyId),
      "and the company it names exists",
    );
    for (const copied of ["companyName", "companyDomain", "companySegment"]) {
      assert.equal(person[copied], undefined, `${copied} is not copied`);
    }
  }
  // A deal's name derives from its company at emit, so it is not held here.
  for (const deal of candidates.deals) {
    assert.equal(deal.name, undefined);
    assert.ok(
      candidates.companies.some((company) => company.id === deal.companyId),
    );
  }
});

// ── The repair log ─────────────────────────────────────────────────────────

test("the repair log carries every website that needed repairing, and no other", async () => {
  const repaired = rows.filter((row) => !alreadyNormalised(row.Website));
  const correct = rows.filter((row) => alreadyNormalised(row.Website));
  assert.ok(correct.length > 0, "the batch has an already-correct website");
  const { repairs, candidates } = await reviewSnapshot();

  assert.equal(repairs.length, repaired.length, "one entry of substance each");
  for (const row of repaired) {
    const entry = repairs.find(
      (repair) => repair.sourceId === row["Source ID"],
    );
    assert.ok(entry, `${row["Source ID"]} was repaired`);
    // The candidate field the value sits on, not the source property it came
    // from — the ledger has to be able to find it.
    assert.equal(entry.field, "domain");
    assert.equal(entry.from, row.Website, "the original value is kept");
    const company = candidates.companies.find(
      (candidate) => candidate.id === entry.candidateId,
    );
    assert.equal(entry.to, company.domain, "marked where the value sits");
  }
  for (const row of correct) {
    assert.equal(
      repairs.find((repair) => repair.sourceId === row["Source ID"]),
      undefined,
      "a value already correct is not a repair",
    );
  }
});

// ── Where the candidates live ──────────────────────────────────────────────

test("no candidate data is persisted outside the checkpoint", async () => {
  const { candidates } = await reviewSnapshot();
  assert.ok(
    candidates.companies.length > 0,
    "there are candidates to misplace",
  );

  const db = new DatabaseSync(DB_PATH);
  const ours = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((table) => table.name)
    .filter(
      (name) => !name.startsWith("checkpoint") && !name.startsWith("writes"),
    );
  // No new table took any of it — and no new *column* did either, which is the
  // half a list of table names alone would miss (ADR-0009).
  const columns = ours.flatMap((table) =>
    db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map((column) => `${table}.${column.name}`),
  );
  db.close();

  assert.deepEqual(ours.sort(), [
    "connection",
    "pending_authorisation",
    "runs",
  ]);
  assert.deepEqual(
    columns.filter((name) => name.startsWith("runs.")),
    ["runs.run_id", "runs.batch", "runs.created_at"],
  );
});
