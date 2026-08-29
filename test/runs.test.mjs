/**
 * `/api/runs`, end to end through the real Express app with the real compiled
 * graph (#51).
 *
 * Notion is faked at the network, and the rows it serves for the happy path
 * are the committed seed fixture's, so a run that reads `2026-W34` reads the
 * same eight rows `GET /api/batches` counts.
 *
 * `docs/http-contract.md` owns the payloads, the states and the error shape;
 * ADR-0009 owns what the `runs` table may and may not hold.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

const { default: app } = await import("../src/app.ts");
const { graph } = await import("../src/graph.ts");
const { startRun } = await import("../src/runs.ts");

const CARPE_LAB = {
  access_token: "ntn_live_token",
  workspace_id: "ws-1",
  workspace_name: "Carpe Lab",
  workspace_icon: null,
};
const DEMO_SPACE = {
  access_token: "ntn_other_token",
  workspace_id: "ws-2",
  workspace_name: "Demo Space",
  workspace_icon: null,
};

const DATA_SOURCE_ID = "ds-shared-by-the-grant";
const QUERY_PATH = `/v1/data_sources/${DATA_SOURCE_ID}/query`;

// ── The rows, from the committed fixture ───────────────────────────────────

const seedRows = parseCsv(readFileSync(CSV_PATH, "utf8"));

/**
 * The fixture as Notion *answers* it. `buildProperties` writes the request
 * shape, where text carries `text.content`; a query response carries
 * `plain_text` alongside it, and that is what the app reads.
 */
const pages = seedRows.map((row) => {
  const properties = buildProperties(row);
  for (const value of Object.values(properties)) {
    for (const piece of value.title ?? value.rich_text ?? []) {
      piece.plain_text = piece.text.content;
    }
  }
  return { object: "page", id: row["Source ID"], properties };
});

/** What both legs of the extraction filter return, applied to the fixture. */
const readyIn = (batch) =>
  pages.filter(
    (page) =>
      page.properties.Batch.select?.name === batch &&
      page.properties["CRM status"].status?.name === TARGET_STATUS,
  );

// ── The Notion fake ────────────────────────────────────────────────────────

const notion = fakeNotion();

function scriptHappyPath() {
  notion.script = {
    "/v1/search": () => [
      200,
      { results: [{ object: "data_source", id: DATA_SOURCE_ID }] },
    ],
    [QUERY_PATH]: (body) => [
      200,
      {
        results: readyIn(body.filter.and[1].select.equals),
        has_more: false,
        next_cursor: null,
      },
    ],
  };
}

/** A reply the test opens by hand, so it can assert what happened meanwhile. */
function gate(answer) {
  let open;
  const held = new Promise((resolve) => {
    open = () => resolve(answer);
  });
  return { held: () => held, open: () => open() };
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

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
  });

const start = (batch = TARGET_BATCH) => post("/api/runs", { batch });
const snapshot = async (runId) =>
  (await fetch(`${base}/api/runs/${runId}`)).json();

/** Polls the snapshot until the run reaches `status`, or gives up loudly. */
async function reaches(runId, status) {
  for (let tries = 0; tries < 200; tries += 1) {
    const body = await snapshot(runId);
    if (body.status === status) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`run ${runId} never reached ${status}`);
}

const stateOf = (runId) =>
  graph.getState({ configurable: { thread_id: runId } });

// ── Starting a run ─────────────────────────────────────────────────────────

test("the run id comes back before the work finishes", async () => {
  const search = gate([
    200,
    { results: [{ object: "data_source", id: DATA_SOURCE_ID }] },
  ]);
  notion.script["/v1/search"] = () => search.held();

  const res = await start();

  assert.equal(res.status, 202);
  const { runId } = await res.json();
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.equal(
    notion.calls.find((call) => call.path === QUERY_PATH),
    undefined,
    "the batch had not been read when the id came back",
  );

  // A reload during startup finds the run rather than orphaning it.
  assert.equal((await snapshot(runId)).status, "running");
  assert.deepEqual(
    (await (await fetch(`${base}/api/runs`)).json()).map((run) => run.runId),
    [runId],
  );

  search.open();
  await reaches(runId, "awaiting_review");
});

test("the run reads its batch and stops at the first interrupt", async () => {
  const { runId } = await (await start()).json();

  await reaches(runId, "awaiting_review");

  const query = notion.calls.find((call) => call.path === QUERY_PATH);
  assert.deepEqual(query.body.filter, {
    and: [
      { property: "CRM status", status: { equals: TARGET_STATUS } },
      { property: "Batch", select: { equals: TARGET_BATCH } },
    ],
  });
  const { values, next } = await stateOf(runId);
  assert.equal(values.sourceRows.length, EXPECTED_MATCHES);
  assert.equal(values.sourceRows[0]["Source ID"], "QL-260818-001");
  assert.equal(values.sourceRows[0].Account, "Northbeam Analytics");
  assert.deepEqual(next, ["review"], "paused on the review node");
});

test("a batch a live run still holds cannot be started again", async () => {
  const { runId } = await (await start()).json();
  await reaches(runId, "awaiting_review");

  const res = await start();

  assert.equal(res.status, 409);
  const { error } = await res.json();
  assert.equal(error.code, "batch_in_progress");
  assert.equal(error.details.runId, runId, "it names the run that holds it");
});

test("two simultaneous starts put one run on the batch, not two", async () => {
  // Straight at the guard rather than through two sockets: deciding whether a
  // batch is free reads each run's checkpoint, and that await is the window a
  // double-clicked Start would otherwise slip through.
  const [first, second] = await Promise.all([
    startRun(TARGET_BATCH),
    startRun(TARGET_BATCH),
  ]);

  const started = [first, second].filter((answer) => "run" in answer);
  const refused = [first, second].filter((answer) => "heldBy" in answer);
  assert.equal(started.length, 1, "one run was started");
  assert.equal(refused.length, 1, "the other was refused");
  assert.equal(refused[0].heldBy, started[0].run.runId, "it names the holder");
  assert.equal(
    (await (await fetch(`${base}/api/runs`)).json()).length,
    1,
    "one row, so the batch is held once",
  );

  await reaches(started[0].run.runId, "awaiting_review");
});

test("another batch is unaffected by the one being held", async () => {
  await reaches((await (await start()).json()).runId, "awaiting_review");

  const res = await start("2026-W33");

  assert.equal(res.status, 202);
});

test("a run needs a batch", async () => {
  const res = await post("/api/runs", {});

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_payload");
});

// ── Watching it move ───────────────────────────────────────────────────────

test("the snapshot names the run, and holds nothing that has no meaning yet", async () => {
  const before = new Date().toISOString();
  const { runId } = await (await start()).json();

  const body = await reaches(runId, "awaiting_review");

  assert.equal(body.runId, runId);
  assert.equal(body.batch, TARGET_BATCH);
  assert.ok(body.createdAt >= before, "created when it was started");
  assert.equal(body.files, null);
  assert.equal(body.writeBack, null);
  assert.equal(body.blocked, null);
  // Grouped by object; the ledger's contents are `candidates.test.mjs`'s, and
  // its flags `flags.test.mjs`'s.
  for (const object of ["companies", "people", "deals"]) {
    assert.ok(Array.isArray(body.candidates[object]), object);
  }
});

test("the snapshot carries the pending node, so progress needs no field", async () => {
  const { runId } = await (await start()).json();

  const body = await reaches(runId, "awaiting_review");

  // `snap.next`, passed straight through: the run's page reads its step from
  // this, and nothing about progress is written down.
  assert.deepEqual(body.next, ["review"]);
  assert.deepEqual(body.next, (await stateOf(runId)).next);
});

test("GET never advances a run", async () => {
  const { runId } = await (await start()).json();
  await reaches(runId, "awaiting_review");
  const calls = notion.calls.length;

  for (let poll = 0; poll < 3; poll += 1) {
    assert.equal((await snapshot(runId)).status, "awaiting_review");
    await fetch(`${base}/api/runs`);
  }

  assert.equal(notion.calls.length, calls, "nothing was asked of Notion");
  assert.deepEqual((await stateOf(runId)).next, ["review"], "still paused");
});

test("an unknown run id is a lookup miss, not empty state", async () => {
  const res = await fetch(`${base}/api/runs/${randomUUID()}`);

  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "no_such_run");
});

test("an unknown run cannot be continued or cancelled either", async () => {
  const unknown = `${base}/api/runs/${randomUUID()}`;

  for (const res of [
    await fetch(`${unknown}/continue`, { method: "POST" }),
    await fetch(unknown, { method: "DELETE" }),
  ]) {
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "no_such_run");
  }
});

// ── When a node throws ─────────────────────────────────────────────────────

test("a node that throws leaves the run failed, and it keeps its batch", async () => {
  notion.script["/v1/search"] = () => [500, { code: "internal_server_error" }];
  const { runId } = await (await start()).json();

  await reaches(runId, "failed");

  const res = await start();
  assert.equal(res.status, 409, "a failed run still holds its batch");
  assert.equal((await res.json()).error.details.runId, runId);
});

test("a run that is not stopped cannot be continued", async () => {
  const { runId } = await (await start()).json();
  await reaches(runId, "awaiting_review");

  const res = await fetch(`${base}/api/runs/${runId}/continue`, {
    method: "POST",
  });

  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "wrong_stage");
});

// ── After a restart ────────────────────────────────────────────────────────

test("a restart leaves the run stalled, and continuing resumes it there", async () => {
  // The run fails under Carpe Lab, then the reviewer connects somewhere else
  // entirely before a fresh process picks the run back up.
  notion.script["/v1/search"] = () => [500, { code: "internal_server_error" }];
  const { runId } = await (await start()).json();
  await reaches(runId, "failed");
  connect(DEMO_SPACE);

  const fresh = JSON.parse(
    execFileSync(process.execPath, ["test/fresh-process.mjs", DB_PATH, runId], {
      encoding: "utf8",
    }),
  );

  // We keep no failure record, so a process that never saw it throw reads it
  // as stalled — and continuing re-runs the node that threw.
  assert.equal(fresh.before, "stalled");
  assert.equal(fresh.after, "awaiting_review");
  assert.equal(fresh.sourceRows.length, 1, "the read node ran again");

  // The workspace is the querying node's, not one stamped at run creation:
  // this run was created under Carpe Lab and read under Demo Space. Continuing
  // carries no workspace check of its own.
  assert.equal(fresh.workspaceId, DEMO_SPACE.workspace_id);
  assert.equal(fresh.workspaceName, DEMO_SPACE.workspace_name);
});

// ── Cancelling ─────────────────────────────────────────────────────────────

test("cancelling deletes the run and releases its batch", async () => {
  const { runId } = await (await start()).json();
  await reaches(runId, "awaiting_review");

  const res = await fetch(`${base}/api/runs/${runId}`, { method: "DELETE" });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cancelled: true });
  assert.equal((await fetch(`${base}/api/runs/${runId}`)).status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/runs`)).json(), []);
  assert.equal((await start()).status, 202, "the batch is free again");
});

test("a cancelled run takes its checkpoint with it", async () => {
  const { runId } = await (await start()).json();
  await reaches(runId, "awaiting_review");

  await fetch(`${base}/api/runs/${runId}`, { method: "DELETE" });

  const { values, createdAt } = await stateOf(runId);
  assert.equal(createdAt, undefined, "no checkpoint is left behind");
  assert.equal(values.sourceRows, undefined);
});

// ── What the table is allowed to hold ──────────────────────────────────────

test("the runs table holds nothing the checkpoint already knows", async () => {
  const db = new DatabaseSync(DB_PATH);
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('runs')")
    .all()
    .map((column) => column.name);
  db.close();

  assert.deepEqual(columns, ["run_id", "batch", "created_at"]);
});
