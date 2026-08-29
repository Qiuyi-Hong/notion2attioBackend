/**
 * The reviewer answering the ledger, over the HTTP contract (#54).
 *
 * Same discipline as `flags.test.mjs`: every assertion is made on the snapshot
 * `GET /api/runs/:runId` answers, and the candidates and flags a test acts on
 * are **found in that snapshot** rather than named by id here — a test that
 * hardcoded `person:QL-260819-003` would pass while the ledger keyed people on
 * something else entirely.
 *
 * One batch is synthetic: `docs/examples/handoff-2026-W34` is owned end to end
 * by `Maya`, so the batch flag's one re-open condition — a Deal becoming
 * sendable under an owner the answer never named — cannot be reached with it.
 * That batch is built here, from the same rows, with one owner changed.
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
const DEMO_SPACE = {
  access_token: "ntn_other_token",
  workspace_id: "ws-2",
  workspace_name: "Demo Space",
  workspace_icon: null,
};

const DATA_SOURCE_ID = "ds-shared-by-the-grant";
const QUERY_PATH = `/v1/data_sources/${DATA_SOURCE_ID}/query`;

// ── The batches ────────────────────────────────────────────────────────────

const seedRows = parseCsv(readFileSync(CSV_PATH, "utf8"));

/**
 * A second batch, two accounts wide: one whole and owned by `Maya`, one whose
 * Person has no work email — and whose Deal is therefore Held — owned by
 * `Sam`. Clearing the second is what puts a name the batch flag's answer never
 * covered onto a record Attio always creates.
 */
const UNSEEN_OWNER_BATCH = "2026-W90";
const HELD_OWNER = "Sam";

const rowFrom = (source, changes) => ({
  ...seedRows.find((row) => row["Source ID"] === source),
  ...changes,
  Batch: UNSEEN_OWNER_BATCH,
  "CRM status": TARGET_STATUS,
});

const unseenOwnerRows = [
  rowFrom("QL-260818-001", { "Source ID": "QL-W90-001" }),
  rowFrom("QL-260819-003", { "Source ID": "QL-W90-002", Owner: HELD_OWNER }),
];

const asPage = (row) => {
  const properties = buildProperties(row);
  for (const value of Object.values(properties)) {
    for (const piece of value.title ?? value.rich_text ?? []) {
      piece.plain_text = piece.text.content;
    }
  }
  return { object: "page", id: row["Source ID"], properties };
};

const pages = [...seedRows, ...unseenOwnerRows].map(asPage);

// ── The Notion fake ────────────────────────────────────────────────────────

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
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const snapshot = async (runId) =>
  (await fetch(`${base}/api/runs/${runId}`)).json();

/** A run taken to its first pause, with the ledger it paused on. */
async function paused(batch = TARGET_BATCH) {
  const { runId } = await (await post("/api/runs", { batch })).json();
  for (let tries = 0; tries < 200; tries += 1) {
    const body = await snapshot(runId);
    if (body.status === "awaiting_review") return { runId, ...body };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`run ${runId} never reached awaiting_review`);
}

const review = (runId, decision) => post(`/api/runs/${runId}/review`, decision);

const reviewed = async (runId, decision) => {
  const res = await review(runId, decision);
  const body = await res.text();
  assert.equal(res.status, 200, body);
  return JSON.parse(body);
};

// ── Finding the candidates a test acts on, in the ledger itself ────────────

/** The Person the batch leaves without a work email, and their B1 Stop. */
const stopped = (ledger) => {
  const person = ledger.candidates.people.find((one) =>
    one.flags.some((flag) => flag.rule === "B1"),
  );
  return { person, flag: person.flags.find((one) => one.rule === "B1") };
};

/** The Company two source rows collapsed onto, and its Deal's decision Warn. */
const shared = (ledger) => {
  const company = ledger.candidates.companies.find(
    (one) =>
      ledger.candidates.people.filter((person) => person.companyId === one.id)
        .length > 1,
  );
  const deal = ledger.candidates.deals.find(
    (one) => one.companyId === company.id,
  );
  return { company, deal, warn: deal.flags.find((one) => one.rule === "W1") };
};

/** What would be exported now — the number the batch flag's summary shows. */
const sendableDeals = (ledger) =>
  ledger.candidates.deals.filter((deal) => !deal.held);

const batchFlag = (ledger) => ledger.batchFlags[0];

// ── One route, three acts ──────────────────────────────────────────────────

test("answers, holds and sparse edits all take effect through one route", async () => {
  const run = await paused();
  const { company, deal, warn } = shared(run);
  const [heldPerson] = run.candidates.people.filter(
    (person) => person.companyId === company.id,
  );

  const after = await reviewed(run.runId, {
    edits: { [company.id]: { name: "Brightyard Group" } },
    held: [heldPerson.id],
    answers: { [warn.id]: true },
  });

  const edited = after.candidates.companies.find(
    (one) => one.id === company.id,
  );
  assert.equal(edited.name, "Brightyard Group", "the edit landed");
  assert.deepEqual(edited.overrides, ["name"], "and pinned the field");
  assert.equal(
    after.candidates.people.find((one) => one.id === heldPerson.id).held,
    true,
    "the hold landed",
  );
  assert.equal(
    after.candidates.deals
      .find((one) => one.id === deal.id)
      .flags.find((one) => one.rule === "W1").cleared,
    true,
    "the answer landed",
  );
});

test("holding a Company holds its People and its Deal", async () => {
  const run = await paused();
  const { company } = shared(run);
  const people = run.candidates.people.filter(
    (person) => person.companyId === company.id,
  );
  assert.ok(people.length > 1, "the account is more than one person");

  const after = await reviewed(run.runId, { held: [company.id] });

  const held = (id) =>
    [
      ...after.candidates.companies,
      ...after.candidates.people,
      ...after.candidates.deals,
    ].find((one) => one.id === id).held;

  assert.equal(held(company.id), true, "the Company the reviewer held");
  for (const person of people) {
    assert.equal(held(person.id), true, `${person.name} went with it`);
  }
  assert.equal(
    held(after.candidates.deals.find((one) => one.companyId === company.id).id),
    true,
    "and so did its Deal — a person line would create the company anyway",
  );

  // A hold on one account reaches no other.
  const elsewhere = after.candidates.people.filter(
    (person) => person.companyId !== company.id && !person.flags.length,
  );
  assert.ok(elsewhere.length > 0);
  for (const person of elsewhere) {
    assert.equal(person.held, false, `${person.name} is untouched`);
  }
});

// ── What the freeze will not let the reviewer type ─────────────────────────

test("an identity-keyed value is not editable", async () => {
  const run = await paused();
  const [company] = run.candidates.companies;
  const [person] = run.candidates.people;

  for (const edit of [
    { [company.id]: { domain: "elsewhere.example.com" } },
    { [person.id]: { email: "someone.else@example.com" } },
  ]) {
    const res = await review(run.runId, { edits: edit });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_payload");
  }

  // Nothing reached the graph: the run is still at the pause it was at.
  assert.equal((await snapshot(run.runId)).status, "awaiting_review");
});

test("the one permitted identity change is refused when it duplicates", async () => {
  const run = await paused();
  const { person, flag } = stopped(run);
  const taken = run.candidates.people.find((one) => one.id !== person.id).email;

  const after = await reviewed(run.runId, {
    answers: { [flag.id]: { email: taken.toUpperCase() } },
  });

  const still = after.candidates.people.find((one) => one.id === person.id);
  assert.equal(still.email, "", "the address Attio would collapse never lands");
  assert.deepEqual(
    still.flags.map((one) => [one.cleared, one.refused]),
    [[false, "duplicate_email"]],
    "the Stop stands, and says why",
  );
  assert.equal(after.status, "awaiting_review", "back at the same pause");
});

test("an unparseable email re-interrupts into the ledger", async () => {
  const run = await paused();
  const { person, flag } = stopped(run);

  const after = await reviewed(run.runId, {
    answers: { [flag.id]: { email: "amina at tern" } },
  });

  const still = after.candidates.people.find((one) => one.id === person.id);
  assert.equal(still.flags[0].refused, "invalid_email");
  assert.equal(still.flags[0].cleared, false);
  // Where the reviewer is already working, not a 400 on a response they will
  // never see again.
  assert.equal(after.status, "awaiting_review");

  // And the same control, answered again, is taken.
  const fixed = await reviewed(run.runId, {
    answers: { [flag.id]: { email: "amina.yusuf@tern.example.com" } },
  });
  const cleared = fixed.candidates.people.find((one) => one.id === person.id);
  assert.equal(cleared.email, "amina.yusuf@tern.example.com");
  assert.deepEqual(
    cleared.flags.map((one) => one.cleared),
    [true],
  );
  assert.equal(cleared.held, false, "no longer Held");
});

test("an edit is taken as typed, pins, and clears no flag on the same value", async () => {
  const run = await paused();
  const { deal, warn } = shared(run);

  const after = await reviewed(run.runId, {
    edits: { [deal.id]: { owner: "  Maya  " } },
  });

  const edited = after.candidates.deals.find((one) => one.id === deal.id);
  assert.equal(edited.owner, "  Maya  ", "exactly as typed, never repaired");
  assert.deepEqual(edited.overrides, ["owner"], "and pinned");
  assert.equal(
    edited.flags.find((one) => one.rule === warn.rule).cleared,
    false,
    "editing the Deal is not a way to answer the Deal's Warn",
  );
});

test("re-typing what the pipeline proposed pins nothing", async () => {
  const run = await paused();
  const { deal } = shared(run);

  const after = await reviewed(run.runId, {
    edits: { [deal.id]: { owner: deal.owner } },
  });

  assert.deepEqual(
    after.candidates.deals.find((one) => one.id === deal.id).overrides,
    [],
    "touched is a fact; overridden is a difference",
  );
});

// ── Bad input, at the edge ─────────────────────────────────────────────────

test("an unknown candidate or flag id is invalid_payload", async () => {
  const run = await paused();

  for (const decision of [
    { edits: { "company:nobody.example.com": { name: "x" } } },
    { held: ["person:nobody@example.com"] },
    { answers: { "B1:person:nobody@example.com": true } },
    { nonsense: true },
  ]) {
    const res = await review(run.runId, decision);

    assert.equal(res.status, 400, JSON.stringify(decision));
    assert.equal((await res.json()).error.code, "invalid_payload");
  }
});

test("malformed JSON is invalid_payload, not a 500", async () => {
  const run = await paused();

  const res = await fetch(`${base}/api/runs/${run.runId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ not json",
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_payload");
});

test("a Stop with no control of its own takes no answer", async () => {
  const run = await paused();
  const held = run.candidates.deals.find((deal) =>
    deal.flags.some((flag) => flag.rule === "D1"),
  );
  const d1 = held.flags.find((flag) => flag.rule === "D1");

  const res = await review(run.runId, { answers: { [d1.id]: true } });

  assert.equal(res.status, 400);
  // It is cleared by completing the account, and by nothing the reviewer sends.
  assert.equal((await res.json()).error.code, "invalid_payload");
});

// ── One pause, one decision ────────────────────────────────────────────────

test("a review posted when the run is not at that pause is refused", async () => {
  const run = await paused();
  await reviewed(run.runId, {});

  const res = await review(run.runId, {});

  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "wrong_stage");
});

test("a double-submitted review applies once", async () => {
  const run = await paused();
  const { company } = shared(run);
  const decision = { edits: { [company.id]: { name: "Brightyard Group" } } };

  const [first, second] = await Promise.all([
    review(run.runId, decision),
    review(run.runId, decision),
  ]);

  const codes = [first.status, second.status].sort();
  assert.deepEqual(codes, [200, 409], "one applied, one was refused");
  const refused = first.status === 409 ? first : second;
  assert.equal((await refused.json()).error.code, "wrong_stage");
});

test("an unknown run cannot be reviewed", async () => {
  const res = await review(randomUUID(), {});

  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "no_such_run");
});

// ── The batch flag's moving count ──────────────────────────────────────────

test("the count moves as candidates are cleared, and does not re-open", async () => {
  const run = await paused();
  const { person, flag } = stopped(run);
  const before = sendableDeals(run).length;

  const after = await reviewed(run.runId, {
    answers: {
      [flag.id]: { email: "amina.yusuf@tern.example.com" },
      [batchFlag(run).id]: true,
    },
  });

  assert.equal(
    sendableDeals(after).length,
    before + 1,
    `the Deal ${person.name}'s account was holding is sendable now`,
  );
  // A count that moves is not a reason to ask again — the answer covers the
  // batch, not the deals that happened to be sendable when it was given.
  assert.equal(batchFlag(after).cleared, true);
  assert.equal(batchFlag(after).refused, null);
});

test("the count moves as candidates are held", async () => {
  const run = await paused();
  const before = sendableDeals(run).length;
  const [sendable] = sendableDeals(run);

  const after = await reviewed(run.runId, { held: [sendable.id] });

  assert.equal(sendableDeals(after).length, before - 1);
});

test("the batch flag re-opens for an owner nobody has seen", async () => {
  const run = await paused(UNSEEN_OWNER_BATCH);
  const { flag } = stopped(run);
  assert.deepEqual(
    [...new Set(sendableDeals(run).map((deal) => deal.owner))],
    ["Maya"],
    "one owner is on screen when the flag is answered",
  );

  const after = await reviewed(run.runId, {
    answers: {
      [flag.id]: { email: "amina.yusuf@tern.example.com" },
      [batchFlag(run).id]: true,
    },
  });

  assert.ok(
    sendableDeals(after).some((deal) => deal.owner === HELD_OWNER),
    "a Deal became sendable under an owner the answer did not name",
  );
  assert.equal(batchFlag(after).cleared, false, "so the flag re-opened");
  assert.equal(batchFlag(after).refused, "new_owner");
  assert.equal(after.status, "awaiting_review");

  // Asked once per distinct thing to decide: the same answer, now that the
  // name is in front of them, stands.
  const again = await reviewed(run.runId, {
    answers: { [batchFlag(run).id]: true },
  });
  assert.equal(batchFlag(again).cleared, true);
  assert.equal(batchFlag(again).refused, null);
});

// ── What this route is deliberately not guarded on ─────────────────────────

test("the review route is not guarded on the Connection's workspace", async () => {
  const run = await paused();
  // The grant is replaced, mid-triage, by one naming somewhere else entirely.
  connect(DEMO_SPACE);

  const after = await reviewed(run.runId, {
    held: [run.candidates.deals[0].id],
  });

  // Nothing between `review` and `emit` touches Notion, and the block would
  // clear the moment the original workspace came back (ADR-0008).
  assert.equal(after.candidates.deals[0].held, true);
  assert.equal(
    notion.calls.filter((call) => call.path === QUERY_PATH).length,
    1,
    "the review asked Notion nothing",
  );
});
