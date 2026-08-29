/**
 * `GET /api/batches`, end to end through the real Express app (#50).
 *
 * Notion is faked at the network for both legs — the data-source search and
 * the row query — and the rows it serves are built from the committed seed
 * fixture by the seeder's own `buildProperties`, so the eight W34 rows are the
 * fixture's, not this file's.
 *
 * `docs/notion-source-database.md` owns the filter; `docs/http-contract.md`
 * owns the payload and the error shape.
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
  EXPECTED_MATCHES,
} from "../scripts/seed-notion-source-db.mjs";

const DB_PATH = join(tmpdir(), `notion2attio-${randomUUID()}.sqlite`);

process.env.DATABASE_PATH = DB_PATH;
process.env.NOTION_OAUTH_CLIENT_ID = "test-client-id";
process.env.NOTION_OAUTH_CLIENT_SECRET = "test-client-secret";
// Present, and never read at request time: the route finds its data source by
// searching. If either of these ever reaches a request, the search assertions
// below stop passing.
process.env.NOTION_DATABASE_ID = "db-from-the-environment";
process.env.NOTION_DATA_SOURCE_ID = "ds-from-the-environment";

const { default: app } = await import("../src/app.ts");

const TOKEN_RESPONSE = {
  access_token: "ntn_live_token",
  workspace_id: "ws-1",
  workspace_name: "Carpe Lab",
  workspace_icon: null,
};

const DATA_SOURCE_ID = "ds-shared-by-the-grant";
const QUERY_PATH = `/v1/data_sources/${DATA_SOURCE_ID}/query`;

// ── The rows, from the committed fixture ───────────────────────────────────

const seedRows = parseCsv(readFileSync(CSV_PATH, "utf8"));

/** The 12 fixture rows as Notion pages, in the shape a query returns them. */
const pages = seedRows.map((row) => ({
  object: "page",
  id: row["Source ID"],
  properties: buildProperties(row),
}));

/**
 * What Notion returns for the status leg. Applied here rather than assumed, so
 * the fake answers the filter the app actually sent.
 */
function applyFilter(filter) {
  // Notion compares a filter key against the property's type and rejects a
  // mismatch outright — `CRM status` is a status property, `Batch` a select.
  const legs = filter.and ?? [filter];
  for (const leg of legs) {
    const expected = leg.property === "CRM status" ? "status" : "select";
    assert.ok(
      leg[expected],
      `Notion would answer validation_error: ${leg.property} filtered as ` +
        `${Object.keys(leg).find((key) => key !== "property")}`,
    );
  }
  return pages.filter((page) =>
    legs.every((leg) => {
      const value = page.properties[leg.property];
      const chosen = (value.status ?? value.select)?.name ?? null;
      return chosen === (leg.status ?? leg.select).equals;
    }),
  );
}

// ── The Notion fake ────────────────────────────────────────────────────────

const notion = fakeNotion();

/** One database shared, holding the twelve fixture rows. The ordinary case. */
function scriptHappyPath() {
  notion.script = {
    "/v1/search": () => [
      200,
      { results: [{ object: "data_source", id: DATA_SOURCE_ID }] },
    ],
    [QUERY_PATH]: (body) => [
      200,
      { results: applyFilter(body.filter), has_more: false, next_cursor: null },
    ],
  };
}

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
  scriptHappyPath();
  const db = new DatabaseSync(DB_PATH);
  db.exec("DELETE FROM connection");
  db.close();
});

/** A stored Connection, without walking the consent round trip again. */
function connect() {
  const db = new DatabaseSync(DB_PATH);
  db.prepare(
    "INSERT INTO connection (id, token_response, connected_at) VALUES (1, ?, ?)",
  ).run(JSON.stringify(TOKEN_RESPONSE), new Date().toISOString());
  db.close();
}

const batches = () => fetch(`${base}/api/batches`);

// ── The counts ─────────────────────────────────────────────────────────────

test("the batches are the distinct Batch values among ready rows, with counts", async () => {
  connect();

  const res = await batches();

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [
    { batch: "2026-W35", ready: 1 },
    { batch: TARGET_BATCH, ready: EXPECTED_MATCHES },
    { batch: "2026-W33", ready: 1 },
  ]);
});

test("the W34 fixture yields eight ready rows", async () => {
  connect();

  const found = (await (await batches()).json()).find(
    (entry) => entry.batch === TARGET_BATCH,
  );

  assert.equal(found.ready, 8);
  assert.equal(found.ready, EXPECTED_MATCHES);
});

test("rows that are not ready are not counted", async () => {
  connect();

  const total = (await (await batches()).json()).reduce(
    (sum, entry) => sum + entry.ready,
    0,
  );

  const ready = seedRows.filter((row) => row["CRM status"] === TARGET_STATUS);
  assert.equal(total, ready.length);
  assert.ok(total < seedRows.length, "the filter excludes something");
});

// ── Where the data source comes from ───────────────────────────────────────

test("the data source is located by search, not read from config", async () => {
  connect();

  await batches();

  const search = notion.calls.find((call) => call.path === "/v1/search");
  assert.equal(search.method, "POST");
  assert.equal(search.auth, "Bearer ntn_live_token");
  assert.equal(search.version, "2026-03-11");
  assert.deepEqual(search.body.filter, {
    property: "object",
    value: "data_source",
  });

  const query = notion.calls.find((call) => call.path === QUERY_PATH);
  assert.ok(query, "the query went to the data source the search returned");
  const wire = JSON.stringify(notion.calls);
  for (const fromEnv of [
    "db-from-the-environment",
    "ds-from-the-environment",
  ]) {
    assert.ok(!wire.includes(fromEnv), `the request carries ${fromEnv}`);
  }
});

test("the query filters on CRM status as a status property", async () => {
  connect();

  await batches();

  const query = notion.calls.find((call) => call.path === QUERY_PATH);
  assert.deepEqual(query.body.filter, {
    property: "CRM status",
    status: { equals: TARGET_STATUS },
  });
});

test("every ready row is counted, however many pages Notion answers in", async () => {
  connect();
  const ready = pages.filter(
    (page) => page.properties["CRM status"].status.name === TARGET_STATUS,
  );
  notion.script[QUERY_PATH] = (body) =>
    body.start_cursor
      ? [200, { results: ready.slice(2), has_more: false, next_cursor: null }]
      : [
          200,
          { results: ready.slice(0, 2), has_more: true, next_cursor: "c2" },
        ];

  const body = await (await batches()).json();

  assert.equal(
    body.find((entry) => entry.batch === TARGET_BATCH).ready,
    EXPECTED_MATCHES,
  );
  assert.equal(
    notion.calls.filter((call) => call.path === QUERY_PATH).length,
    2,
  );
});

// ── The answers that are not a list ────────────────────────────────────────

test("a connection that shared no databases says so, rather than answering nothing", async () => {
  connect();
  notion.script["/v1/search"] = () => [200, { results: [] }];

  const res = await batches();

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "not_connected");
  assert.equal(body.error.details.reason, "no_databases");
  assert.equal(
    notion.calls.find((call) => call.path === QUERY_PATH),
    undefined,
    "there was nothing to query",
  );
});

test("no Connection answers not_connected", async () => {
  const res = await batches();

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "not_connected");
  assert.deepEqual(Object.keys(body), ["error"], "one error shape");
  assert.deepEqual(notion.calls, [], "nothing was asked of Notion");
});

test("a read-side Notion failure answers notion_failed", async () => {
  connect();
  notion.script[QUERY_PATH] = () => [500, { code: "internal_server_error" }];

  const res = await batches();

  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "notion_failed");
});

test("a failing search answers notion_failed too", async () => {
  connect();
  notion.script["/v1/search"] = () => [503, { code: "service_unavailable" }];

  const res = await batches();

  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "notion_failed");
});

test("a wrong property key surfaces as a validation error, not zero rows", async () => {
  connect();
  // What Notion answers a filter whose key does not match the property's type.
  notion.script[QUERY_PATH] = () => [
    400,
    { object: "error", status: 400, code: "validation_error" },
  ];

  const res = await batches();

  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "notion_failed");
});

test("a token Notion rejects on sight answers not_connected", async () => {
  connect();
  notion.script[QUERY_PATH] = () => [401, { code: "unauthorized" }];

  const res = await batches();

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "not_connected");
  assert.equal(body.error.details.reason, "expired");
});
