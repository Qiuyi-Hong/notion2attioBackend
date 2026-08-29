/**
 * The confirmation, the write-back, its retry and its abandonment (#57).
 *
 * Same discipline as `handoff.test.mjs`: the run is driven through the real
 * routes, and what a test needs from the ledger is **found in it** rather than
 * named here — a test that hardcoded `person:amina@...` would pass while the
 * pipeline keyed candidates on something else entirely.
 *
 * The load-bearing difference is that **Notion is stateful here**. The fake
 * holds a `CRM status` per row, the query filters on it, and the `PATCH` sets
 * it. Nothing else can prove the rule the whole ticket rests on: that the write
 * node is idempotent *against Notion*, not against a record of ours. A fake
 * that answered a fixed row set would let a node with no re-query at all pass
 * every test below.
 *
 * No model key is set, so the notes are not read and the batch carries `N0`
 * instead of its two notices. The notices hold nothing, so the handed-off set
 * is the same one the reviewer would see — and the run is a network call
 * lighter.
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
// No key: the notes are not read, and the batch says so with `N0`.
//
// **Assigned, never deleted.** `config.ts` runs `dotenv.config()`, which fills
// in any variable that is *absent* from `process.env` — so a `delete` here
// hands the screener whatever key the developer's own `.env` holds, and the
// suite quietly starts billing a real model. An empty string is still present,
// so dotenv leaves it alone.
process.env.OPENAI_API_KEY = "";

const { default: app } = await import("../src/app.ts");
// The write node, entered directly for the one guard no route can reach.
const { graph } = await import("../src/graph.ts");
const { writeBackOf } = await import("../src/writeback.ts");

const CARPE_LAB = {
  access_token: "ntn_live_token",
  workspace_id: "ws-carpe-lab",
  workspace_name: "Carpe Lab",
  workspace_icon: null,
};

const DEMO_SPACE = {
  access_token: "ntn_other_token",
  workspace_id: "ws-demo-space",
  workspace_name: "Demo Space",
  workspace_icon: null,
};

const DATA_SOURCE_ID = "ds-shared-by-the-grant";
const QUERY_PATH = `/v1/data_sources/${DATA_SOURCE_ID}/query`;
const PAGES_PREFIX = "/v1/pages/";

// ── The source database, as a thing that changes ───────────────────────────

const seedRows = parseCsv(readFileSync(CSV_PATH, "utf8"));

/**
 * ADR-0006's case, added to the fixture: Halden & Roe was handed off in W33 and
 * reads `Imported`, and a person has now qualified the same account again into
 * a later batch. That is a second opportunity, not a duplicate.
 */
const REPEAT_BATCH = "2026-W36";
const requalified = {
  ...seedRows.find((row) => row.Account === "Halden & Roe"),
  "Source ID": "QL-260901-013",
  Contact: "Owen Marsh",
  "Work email": "owen.marsh@haldenroe.example.com",
  "Research notes": "",
  Batch: REPEAT_BATCH,
  "CRM status": TARGET_STATUS,
  "CRM company ID": "",
  "CRM person ID": "",
};

const rows = [...seedRows, requalified];
const idOf = (row) => row["Source ID"];

/** `Source ID` against the `CRM status` Notion currently holds for it. */
let crmStatus;
/** `Source ID` against a reply that stands in for Notion's, once or for ever. */
let faults;

/** One row as a Notion page, carrying the status Notion holds *now*. */
function pageFor(row) {
  const properties = buildProperties(row);
  for (const value of Object.values(properties)) {
    for (const piece of value.title ?? value.rich_text ?? []) {
      piece.plain_text = piece.text.content;
    }
  }
  properties["CRM status"] = { status: { name: crmStatus.get(idOf(row)) } };
  return { object: "page", id: idOf(row), properties };
}

const notion = fakeNotion();

/** Every `PATCH` the app has made, oldest first, by the row it addressed. */
const patched = () =>
  notion.calls
    .filter((call) => call.method === "PATCH")
    .map((call) => call.path.slice(PAGES_PREFIX.length));

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

/** Whichever workspace the Connection currently names. */
function connect(connection) {
  const db = new DatabaseSync(DB_PATH);
  db.prepare(
    `INSERT INTO connection (id, token_response, connected_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token_response = excluded.token_response`,
  ).run(JSON.stringify(connection), new Date().toISOString());
  db.close();
}

beforeEach(() => {
  crmStatus = new Map(rows.map((row) => [idOf(row), row["CRM status"]]));
  faults = new Map();
  notion.calls.length = 0;
  notion.script = {
    "/v1/search": () => [
      200,
      { results: [{ object: "data_source", id: DATA_SOURCE_ID }] },
    ],
    [QUERY_PATH]: (body) => [
      200,
      {
        results: rows
          .filter(
            (row) =>
              crmStatus.get(idOf(row)) === body.filter.and[0].status.equals &&
              row.Batch === body.filter.and[1].select.equals,
          )
          .map(pageFor),
        has_more: false,
        next_cursor: null,
      },
    ],
    // One page per request, so the family is scripted rather than each path.
    [PAGES_PREFIX]: (_body, call) => {
      const sourceId = call.path.slice(PAGES_PREFIX.length);
      const answer = faults.get(sourceId)?.();
      if (answer) return answer;
      crmStatus.set(sourceId, "Imported");
      return [200, { object: "page", id: sourceId }];
    },
  };

  const db = new DatabaseSync(DB_PATH);
  db.exec("DELETE FROM connection");
  db.exec("DELETE FROM runs");
  db.close();
  connect(CARPE_LAB);
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

/**
 * The budget is longer than the other suites' because this one is the slow
 * neighbour: its write-backs pace themselves at ~3/s, and `node --test` runs
 * the files side by side. Ten seconds is enough for the run and not always
 * enough for the machine.
 */
async function paused(batch = TARGET_BATCH) {
  const { runId } = await (await post("/api/runs", { batch })).json();
  for (let tries = 0; tries < 1600; tries += 1) {
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

/** Every Warn in the ledger, answered with `true`. Found, never named. */
const answerEveryWarn = (ledger) =>
  Object.fromEntries(
    [
      ...everyCandidate(ledger).flatMap((candidate) => candidate.flags),
      ...ledger.batchFlags,
    ]
      .filter((flag) => flag.level === "warn")
      .map((flag) => [flag.id, true]),
  );

/** A run taken to the confirmation pause, with its files made. */
async function exported(batch = TARGET_BATCH, held = []) {
  const ledger = await paused(batch);
  const answered = await (
    await post(`/api/runs/${ledger.runId}/review`, {
      answers: answerEveryWarn(ledger),
      held,
    })
  ).json();
  assert.equal(
    answered.status,
    "awaiting_confirmation",
    JSON.stringify(answered),
  );
  return { runId: ledger.runId, ledger, ...answered };
}

const confirm = async (runId, payload = { confirmed: true }) => {
  const res = await post(`/api/runs/${runId}/confirm`, payload);
  return { res, body: await res.json() };
};

/**
 * The rows the W34 batch hands off: every row but Tern Mobility's, whose only
 * contact carries the `B1` Stop and whose Deal is therefore held with it.
 * Derived from the ledger rather than listed, so it stays true if the fixture
 * moves.
 */
function handedOffIds(ledger) {
  const held = new Set(
    everyCandidate(ledger)
      .filter((candidate) => candidate.held)
      .map((candidate) => candidate.id),
  );
  const people = ledger.candidates.people;
  return rows
    .filter(
      (row) =>
        row.Batch === TARGET_BATCH && row["CRM status"] === TARGET_STATUS,
    )
    .filter((row) => {
      const person = people.find((one) => one.sourceId === idOf(row));
      return person && !held.has(person.id) && !held.has(person.companyId);
    })
    .map(idOf);
}

const statusesOf = (ids) => ids.map((id) => crmStatus.get(id));

// ── `Imported` never overstates ────────────────────────────────────────────

test("confirming writes Imported only to the rows whose every candidate was exported", async () => {
  const run = await exported();
  const handed = handedOffIds(run.ledger);
  assert.ok(handed.length > 0, "the batch handed nothing off");

  const { res, body } = await confirm(run.runId);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, "done");
  assert.deepEqual(body.writeBack.failed, []);
  assert.deepEqual([...body.writeBack.written].sort(), [...handed].sort());

  assert.deepEqual(patched().sort(), [...handed].sort());
  assert.deepEqual(
    statusesOf(handed),
    handed.map(() => "Imported"),
  );
});

test("a held row keeps Ready for CRM, and is never written to", async () => {
  const run = await exported();
  const handed = new Set(handedOffIds(run.ledger));
  const held = rows
    .filter(
      (row) =>
        row.Batch === TARGET_BATCH && row["CRM status"] === TARGET_STATUS,
    )
    .map(idOf)
    .filter((id) => !handed.has(id));
  assert.ok(held.length > 0, "the W34 batch holds nothing");

  await confirm(run.runId);

  for (const id of held) {
    assert.equal(crmStatus.get(id), TARGET_STATUS, `${id} was marked Imported`);
    assert.ok(!patched().includes(id), `${id} was written to`);
  }
});

test("a row the reviewer holds by hand keeps Ready for CRM too", async () => {
  const first = await paused();
  // An account with one contact, so holding the person holds the whole row.
  const person = first.candidates.people.find(
    (one) =>
      one.flags.length === 0 &&
      first.candidates.people.filter(
        (other) => other.companyId === one.companyId,
      ).length === 1,
  );
  assert.ok(person, "no single-contact account to hold");

  const answered = await (
    await post(`/api/runs/${first.runId}/review`, {
      answers: answerEveryWarn(first),
      held: [person.id],
    })
  ).json();
  assert.equal(answered.status, "awaiting_confirmation");

  await confirm(first.runId);
  assert.equal(crmStatus.get(person.sourceId), TARGET_STATUS);
  assert.ok(!patched().includes(person.sourceId));
});

// ── Idempotent against Notion, not against a record of ours ────────────────

test("the write node re-queries Notion before it writes anything", async () => {
  const run = await exported();
  const mark = notion.calls.length;

  await confirm(run.runId);

  const since = notion.calls.slice(mark);
  const query = since.findIndex((call) => call.path === QUERY_PATH);
  const write = since.findIndex((call) => call.method === "PATCH");
  assert.ok(query !== -1, "the write node did not re-query Notion");
  assert.ok(write !== -1, "the write node wrote nothing");
  assert.ok(query < write, "the first write came before the re-query");
  assert.deepEqual(since[query].body.filter.and, [
    { property: "CRM status", status: { equals: TARGET_STATUS } },
    { property: "Batch", select: { equals: TARGET_BATCH } },
  ]);
});

test("a double-submitted confirmation writes once", async () => {
  const run = await exported();
  const handed = handedOffIds(run.ledger);

  const [one, two] = await Promise.all([
    confirm(run.runId),
    confirm(run.runId),
  ]);

  assert.deepEqual(patched().sort(), [...handed].sort());
  // One of the two moved the run; the other met a guard rather than a write.
  const accepted = [one, two].filter((answer) => answer.res.status === 200);
  assert.equal(accepted.length >= 1, true);
  assert.equal((await snapshot(run.runId)).status, "done");
});

test("a second confirmation after the run is done is refused, and writes nothing", async () => {
  const run = await exported();
  await confirm(run.runId);
  const written = patched().length;

  const { res, body } = await confirm(run.runId);
  assert.equal(res.status, 409);
  assert.equal(body.error.code, "wrong_stage");
  assert.equal(patched().length, written);
});

// ── A partial failure, and the retry that is the same route ────────────────

test("a partial failure leaves the run at the pause with the failure list populated, and Retry completes it", async () => {
  const run = await exported();
  const handed = handedOffIds(run.ledger);
  const stubborn = handed[1];
  faults.set(stubborn, () => [503, { object: "error" }]);

  const first = await confirm(run.runId);
  assert.equal(first.res.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, "awaiting_confirmation");
  assert.deepEqual(first.body.writeBack.failed, [
    { sourceId: stubborn, cause: "notion_unavailable" },
  ]);
  assert.deepEqual(
    [...first.body.writeBack.written].sort(),
    handed.filter((id) => id !== stubborn).sort(),
  );

  // Retry is the same route with the same payload — and the re-query means the
  // rows that already landed are not written a second time.
  faults.delete(stubborn);
  const mark = notion.calls.length;
  const second = await confirm(run.runId);

  assert.equal(second.res.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.status, "done");
  assert.deepEqual(second.body.writeBack.failed, []);
  assert.deepEqual(
    [...second.body.writeBack.written].sort(),
    [...handed].sort(),
  );
  assert.deepEqual(
    notion.calls
      .slice(mark)
      .filter((call) => call.method === "PATCH")
      .map((call) => call.path.slice(PAGES_PREFIX.length)),
    [stubborn],
  );
});

// ── The retry budget ───────────────────────────────────────────────────────

test("a 5xx is retried twice, and no further", async () => {
  const run = await exported();
  const stubborn = handedOffIds(run.ledger)[0];
  faults.set(stubborn, () => [500, { object: "error" }]);

  const { body } = await confirm(run.runId);

  assert.deepEqual(body.writeBack.failed, [
    { sourceId: stubborn, cause: "notion_unavailable" },
  ]);
  assert.equal(
    patched().filter((id) => id === stubborn).length,
    3,
    "a 5xx did not get exactly one attempt and two retries",
  );
});

test("a 429 honours Retry-After", async () => {
  const run = await exported();
  const limited = handedOffIds(run.ledger)[0];
  let first = true;
  faults.set(limited, () => {
    if (!first) return undefined;
    first = false;
    return [429, { object: "error" }, { "Retry-After": "1" }];
  });

  const started = Date.now();
  const { body } = await confirm(run.runId);
  const elapsed = Date.now() - started;

  assert.deepEqual(body.writeBack.failed, []);
  assert.equal(crmStatus.get(limited), "Imported");
  assert.ok(
    elapsed >= 1000,
    `the write-back waited ${elapsed}ms, not the second it was asked for`,
  );
});

test("a Retry-After longer than the foreground has is not waited out", async () => {
  const run = await exported();
  const limited = handedOffIds(run.ledger)[0];
  faults.set(limited, () => [
    429,
    { object: "error" },
    { "Retry-After": "3600" },
  ]);

  const started = Date.now();
  const { body } = await confirm(run.runId);
  const elapsed = Date.now() - started;

  // Past a short budget the Retry button is the backoff (ADR-0007), so the
  // row fails at once rather than holding the reviewer's request open.
  assert.deepEqual(body.writeBack.failed, [
    { sourceId: limited, cause: "rate_limited" },
  ]);
  assert.equal(patched().filter((id) => id === limited).length, 1);
  assert.ok(elapsed < 10_000, `the write-back waited ${elapsed}ms`);
});

test("a 429 past its budget fails the row, and says why", async () => {
  const run = await exported();
  const limited = handedOffIds(run.ledger)[0];
  faults.set(limited, () => [429, { object: "error" }, { "Retry-After": "0" }]);

  const { body } = await confirm(run.runId);

  assert.deepEqual(body.writeBack.failed, [
    { sourceId: limited, cause: "rate_limited" },
  ]);
});

test("a 401 stops the node at once, with one cause for the batch", async () => {
  const run = await exported();
  const handed = handedOffIds(run.ledger);
  faults.set(handed[0], () => [401, { object: "error" }]);

  const { res, body } = await confirm(run.runId);

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, "awaiting_confirmation");
  assert.equal(
    patched().length,
    1,
    "the node collected identical errors instead of stopping",
  );
  assert.deepEqual(
    body.writeBack.failed,
    handed.map((sourceId) => ({ sourceId, cause: "unauthorised" })),
  );
  assert.deepEqual(body.writeBack.written, []);
});

test("no write-back outcome is returned as an HTTP error", async () => {
  for (const fault of [
    [401, { object: "error" }],
    [500, { object: "error" }],
    [429, { object: "error" }, { "Retry-After": "0" }],
    [400, { object: "error" }],
  ]) {
    const run = await exported();
    faults.set(handedOffIds(run.ledger)[0], () => fault);

    const { res, body } = await confirm(run.runId);
    assert.equal(
      res.status,
      200,
      `Notion's ${fault[0]} left as HTTP ${res.status}`,
    );
    assert.ok(body.writeBack.failed.length > 0, `${fault[0]} failed nothing`);
    assert.equal(body.status, "awaiting_confirmation");

    // Each pass is a fresh run over the same batch, and the last one still
    // holds it — cancelling asserts nothing here, it just releases the guard.
    await fetch(`${base}/api/runs/${run.runId}`, { method: "DELETE" });
    crmStatus = new Map(rows.map((row) => [idOf(row), row["CRM status"]]));
    faults.clear();
  }
});

// ── Only the Connection that read the batch may confirm it ─────────────────

test("a confirm through a Connection naming a different workspace is refused, before the payload is considered", async () => {
  const run = await exported();
  connect(DEMO_SPACE);
  const mark = notion.calls.length;

  const { res, body } = await confirm(run.runId);

  assert.equal(res.status, 409);
  assert.equal(body.error.code, "wrong_workspace");
  assert.deepEqual(body.error.details, {
    readWorkspace: CARPE_LAB.workspace_name,
    liveWorkspace: DEMO_SPACE.workspace_name,
  });
  assert.deepEqual(
    notion.calls.slice(mark),
    [],
    "the write-back started despite the refusal",
  );
  assert.equal((await snapshot(run.runId)).status, "awaiting_confirmation");
});

test("the snapshot's blocked names both workspaces, before the click", async () => {
  const run = await exported();
  assert.equal((await snapshot(run.runId)).blocked, null);

  connect(DEMO_SPACE);
  assert.deepEqual((await snapshot(run.runId)).blocked, {
    reason: "wrong_workspace",
    readWorkspace: CARPE_LAB.workspace_name,
    liveWorkspace: DEMO_SPACE.workspace_name,
  });

  // Only names cross the wire. The ids stay on this side of it.
  const wire = JSON.stringify(await snapshot(run.runId));
  assert.ok(!wire.includes(CARPE_LAB.workspace_id));
  assert.ok(!wire.includes(DEMO_SPACE.workspace_id));
});

/**
 * The node's own check, which the confirm route can never exercise: a run left
 * `stalled` at the write-back is re-entered through `continue`, and `continue`
 * has no workspace guard of its own (ADR-0008 rule 5). So the node is entered
 * directly, with the state a stalled run would carry.
 *
 * Going through `{ abandoned: true }` instead would prove nothing — that
 * payload routes `confirm → END`, so the node never runs and no write could
 * have happened either way.
 */
test("the write node refuses the wrong workspace itself, which is what continue meets", async () => {
  const run = await exported();
  const handed = handedOffIds(run.ledger);
  const { values } = await graph.getState({
    configurable: { thread_id: run.runId },
  });
  connect(DEMO_SPACE);

  const result = await writeBackOf(values);

  assert.deepEqual(
    result.failed,
    handed.map((sourceId) => ({ sourceId, cause: "wrong_workspace" })),
  );
  assert.deepEqual(result.written, []);
  assert.deepEqual(patched(), [], "the node wrote despite the wrong workspace");
});

test("the node's refusal does not re-fail what an earlier pass already wrote", async () => {
  const run = await exported();
  const handed = handedOffIds(run.ledger);
  const stubborn = handed.at(-1);
  faults.set(stubborn, () => [503, { object: "error" }]);
  const first = await confirm(run.runId);
  assert.deepEqual(first.body.writeBack.failed, [
    { sourceId: stubborn, cause: "notion_unavailable" },
  ]);

  // The original workspace is gone before the retry. Notion cannot be asked
  // what already landed, so the run's own record of the first pass is what
  // keeps six written rows out of the failure list the reviewer would take to
  // Notion to repair by hand.
  connect(DEMO_SPACE);
  const { values } = await graph.getState({
    configurable: { thread_id: run.runId },
  });
  const result = await writeBackOf(values);

  assert.deepEqual(result.failed, [
    { sourceId: stubborn, cause: "wrong_workspace" },
  ]);
  assert.deepEqual(
    [...result.written].sort(),
    handed.filter((id) => id !== stubborn).sort(),
  );
});

test("connecting the same workspace again is not a different workspace", async () => {
  const run = await exported();
  // A `401` and an ordinary re-authorisation: a new grant, the same workspace.
  connect({ ...CARPE_LAB, access_token: "ntn_reissued", bot_id: "bot-2" });

  const { res, body } = await confirm(run.runId);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, "done");
});

test("confirming with no Connection at all is not_connected", async () => {
  const run = await exported();
  const db = new DatabaseSync(DB_PATH);
  db.exec("DELETE FROM connection");
  db.close();

  const { res, body } = await confirm(run.runId);
  assert.equal(res.status, 409);
  assert.equal(body.error.code, "not_connected");
  assert.deepEqual(patched(), []);
});

// ── Abandoning ────────────────────────────────────────────────────────────

test("abandoning is refused while the write-back can still be attempted", async () => {
  const run = await exported();

  const { res, body } = await confirm(run.runId, { abandoned: true });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "invalid_payload");
  assert.equal((await snapshot(run.runId)).status, "awaiting_confirmation");
});

test("abandoning is accepted once the write-back has failed", async () => {
  const run = await exported();
  faults.set(handedOffIds(run.ledger)[0], () => [401, { object: "error" }]);
  await confirm(run.runId);

  const { res, body } = await confirm(run.runId, { abandoned: true });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, "abandoned");
  // The record of which rows went unflipped survives, because it is what the
  // reviewer takes to Notion.
  assert.ok(body.writeBack.failed.length > 0);
});

test("an abandoned run does not release its batch", async () => {
  const run = await exported();
  faults.set(handedOffIds(run.ledger)[0], () => [401, { object: "error" }]);
  await confirm(run.runId);
  await confirm(run.runId, { abandoned: true });

  const res = await post("/api/runs", { batch: TARGET_BATCH });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error.code, "batch_in_progress");
  assert.equal(body.error.details.runId, run.runId);

  // Deleting the run is the explicit release, once a person has fixed Notion.
  await fetch(`${base}/api/runs/${run.runId}`, { method: "DELETE" });
  assert.equal((await post("/api/runs", { batch: TARGET_BATCH })).status, 202);
});

test("an abandoned run is terminal but is not done", async () => {
  const run = await exported();
  connect(DEMO_SPACE);
  await confirm(run.runId, { abandoned: true });

  const body = await snapshot(run.runId);
  assert.equal(body.status, "abandoned");
  assert.deepEqual(body.next, []);
  assert.equal((await confirm(run.runId)).res.status, 409);
});

test("a payload that is neither attestation is refused at the edge", async () => {
  const run = await exported();
  for (const payload of [
    {},
    { confirmed: false },
    { imported: true },
    {
      confirmed: true,
      abandoned: true,
    },
  ]) {
    const { res, body } = await confirm(run.runId, payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, "invalid_payload");
  }
  assert.deepEqual(patched(), []);
});

// ── What the next run sees ────────────────────────────────────────────────

test("a done run releases its batch, and the re-run returns exactly the rows still waiting", async () => {
  const run = await exported();
  const handed = new Set(handedOffIds(run.ledger));
  await confirm(run.runId);
  assert.equal((await snapshot(run.runId)).status, "done");

  const waiting = rows
    .filter(
      (row) =>
        row.Batch === TARGET_BATCH && row["CRM status"] === TARGET_STATUS,
    )
    .map(idOf)
    .filter((id) => !handed.has(id));

  const second = await paused();
  assert.deepEqual(
    second.candidates.people.map((person) => person.sourceId).sort(),
    [...waiting].sort(),
  );
});

// ── ADR-0006 ───────────────────────────────────────────────────────────────

test("a re-qualified row produces a second deal with no flag", async () => {
  // The account is already `Imported` from W33, and a person has qualified it
  // again into a later batch. That asserts a new opportunity, so the Deal is
  // proposed like any other and carries nothing.
  const run = await exported(REPEAT_BATCH);

  assert.equal(run.candidates.deals.length, 1);
  const [deal] = run.candidates.deals;
  assert.deepEqual(deal.flags, []);
  assert.equal(deal.held, false);

  const { body } = await confirm(run.runId);
  assert.equal(body.status, "done");
  assert.deepEqual(body.writeBack.written, [idOf(requalified)]);
  assert.equal(crmStatus.get(idOf(requalified)), "Imported");
  // And the earlier row it repeats is untouched.
  assert.ok(!patched().includes("QL-260812-012"));
});
