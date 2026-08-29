/**
 * The deterministic flags, over the HTTP contract (#53).
 *
 * Same discipline as `candidates.test.mjs`: every assertion is made on the
 * snapshot `GET /api/runs/:runId` answers, and every count is **re-derived
 * from the batch data** rather than quoted from the ticket. The Stop count is
 * derived from the rows with no `Work email` and the accounts they sit in; the
 * decision Warn count from the accounts appearing on more than one row. Both
 * routes are independent of the rule code they check.
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

// ── The batch, and what the rules imply for it ─────────────────────────────

const rows = parseCsv(readFileSync(CSV_PATH, "utf8")).filter(
  (row) => row.Batch === TARGET_BATCH && row["CRM status"] === TARGET_STATUS,
);

const rowsFor = (account) => rows.filter((row) => row.Account === account);

/** B1: a Person with no work email can never be matched in Attio again. */
const missingEmail = rows.filter((row) => !row["Work email"].trim());

/** The accounts B1 leaves incomplete — one D1 Stop on each account's Deal,
 *  however many of its siblings are the reason. */
const incompleteAccounts = new Set(missingEmail.map((row) => row.Account));

/** W1: an account on more than one row is one opportunity, not several. */
const sharedAccounts = [...new Set(rows.map((row) => row.Account))].filter(
  (account) => rowsFor(account).length > 1,
);

const EXPECTED_STOPS = missingEmail.length + incompleteAccounts.size;
const EXPECTED_DECISION_WARNS = sharedAccounts.length;

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
    if (body.status === "awaiting_review") return { runId, ...body };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`run ${runId} never reached awaiting_review`);
}

/** Every candidate on the wire, whichever object it became. */
const everyCandidate = (candidates) => Object.values(candidates).flat();

const everyFlag = (candidates) =>
  everyCandidate(candidates).flatMap((candidate) =>
    candidate.flags.map((flag) => ({ ...flag, on: candidate.id })),
  );

// ── What the batch raises ──────────────────────────────────────────────────

test("the deterministic rules raise the Stops and the decision Warn the batch implies", async () => {
  assert.ok(EXPECTED_STOPS > 0, "the batch has something to stop on");
  const { candidates } = await reviewSnapshot();

  const flags = everyFlag(candidates);
  const stops = flags.filter((flag) => flag.level === "stop");
  const decisions = flags.filter(
    (flag) => flag.level === "warn" && flag.kind === "decision",
  );

  assert.equal(stops.length, EXPECTED_STOPS);
  assert.equal(decisions.length, EXPECTED_DECISION_WARNS);
  // Nothing else: the two notice Warns are the screener's, not a rule's.
  assert.equal(flags.length, stops.length + decisions.length);
});

test("the Stop for a missing work email lands on that person's candidate", async () => {
  const { candidates } = await reviewSnapshot();

  for (const row of missingEmail) {
    const person = candidates.people.find(
      (candidate) => candidate.sourceId === row["Source ID"],
    );
    assert.deepEqual(
      person.flags.map((flag) => flag.rule),
      ["B1"],
      `${row.Contact} is stopped, once`,
    );
    // The reviewer supplies an address, or forces past it knowing Attio can
    // never match this person again.
    assert.equal(person.flags[0].override, true);
  }

  // And on nobody else.
  const stopped = candidates.people.filter((person) =>
    person.flags.some((flag) => flag.rule === "B1"),
  );
  assert.equal(stopped.length, missingEmail.length);
});

test("an account on two rows asks once whether it is one opportunity", async () => {
  const { candidates } = await reviewSnapshot();

  for (const account of sharedAccounts) {
    const rowsOfAccount = rowsFor(account);
    const people = candidates.people.filter((person) =>
      rowsOfAccount.some((row) => row["Source ID"] === person.sourceId),
    );
    const [companyId] = new Set(people.map((person) => person.companyId));
    const deals = candidates.deals.filter(
      (deal) => deal.companyId === companyId,
    );

    assert.equal(deals.length, 1, "one Deal candidate for the account");
    assert.deepEqual(
      deals[0].flags.filter((flag) => flag.level === "warn"),
      [
        {
          id: `W1:${deals[0].id}`,
          rule: "W1",
          level: "warn",
          kind: "decision",
          override: false,
          siblings: [],
          // Unanswered, and refused nothing: the review has not run (#54).
          cleared: false,
          refused: null,
        },
      ],
      "one decision Warn, not one per source row",
    );
  }
});

// ── The Deal waits for its account ─────────────────────────────────────────

test("a Deal whose sibling is unanswered is Stopped, and names the sibling", async () => {
  const { candidates } = await reviewSnapshot();

  for (const account of incompleteAccounts) {
    const unanswered = candidates.people.filter(
      (person) =>
        rowsFor(account).some((row) => row["Source ID"] === person.sourceId) &&
        person.flags.length > 0,
    );
    const deal = candidates.deals.find(
      (candidate) => candidate.companyId === unanswered[0].companyId,
    );
    const stops = deal.flags.filter((flag) => flag.level === "stop");

    // One flag is one problem — *this account is not whole* — however many
    // siblings are the reason for it.
    assert.equal(stops.length, 1, `${account}'s Deal waits, once`);
    assert.equal(stops[0].rule, "D1");
    // By id, not by name: a person's name lives on their own candidate.
    assert.deepEqual(
      stops[0].siblings.sort(),
      unanswered.map((person) => person.id).sort(),
      "it names every sibling that caused it",
    );
    // Only the irreversible object waits, and it cannot be forced past.
    assert.equal(stops[0].override, false);
  }

  // The Company is not held with them — it upserts safely and loses nothing by
  // going early (ADR-0003).
  for (const company of candidates.companies) {
    assert.deepEqual(company.flags, [], `${company.name} is not held`);
  }
});

test("a Deal whose account is whole carries no Stop", async () => {
  const { candidates } = await reviewSnapshot();

  const wholeAccounts = candidates.companies.filter(
    (company) =>
      !candidates.people.some(
        (person) => person.companyId === company.id && person.flags.length > 0,
      ),
  );
  assert.ok(wholeAccounts.length > 0, "the batch has a whole account");

  for (const company of wholeAccounts) {
    const deal = candidates.deals.find((one) => one.companyId === company.id);
    assert.equal(
      deal.flags.filter((flag) => flag.level === "stop").length,
      0,
      `${company.name}'s Deal is not held by a sibling`,
    );
  }
});

// ── Where a flag can and cannot sit ────────────────────────────────────────

test("a flag attaches to a candidate, and has nowhere to name a source row", async () => {
  const { candidates, ...snapshot } = await reviewSnapshot();

  const flags = everyFlag(candidates);
  assert.ok(flags.length > 0, "there are flags to misplace");
  const sourceIds = new Set(rows.map((row) => row["Source ID"]));

  for (const flag of flags) {
    assert.ok(
      everyCandidate(candidates).some((candidate) => candidate.id === flag.on),
      "every flag sits on a candidate that exists",
    );
    assert.equal(flag.sourceId, undefined, "and names no source row");
    for (const value of Object.values(flag).flat()) {
      assert.ok(
        !sourceIds.has(value),
        `${flag.id} carries the source row ${value}`,
      );
    }
    // A Stop is neither a decision nor a notice; a Warn is one of the two.
    // And a Warn excludes nothing, so it has nothing to force past.
    if (flag.level === "stop") assert.equal(flag.kind, null);
    else {
      assert.ok(["decision", "notice"].includes(flag.kind));
      assert.equal(flag.override, false, `${flag.id} is a Warn`);
    }
  }

  // The snapshot has no candidate flags of its own: `batchFlags` is the only
  // other place a flag lives, and it sits on the batch by definition.
  assert.equal(snapshot.flags, undefined);
});

// ── The batch flag ─────────────────────────────────────────────────────────

test("deal owner and stage are asked once for the batch, not once per deal", async () => {
  const { batchFlags, candidates } = await reviewSnapshot();

  assert.equal(batchFlags.length, 1, "one flag, however many deals");
  assert.ok(candidates.deals.length > 1, "there are deals it covers");
  const [flag] = batchFlags;
  // #6's two batch rules, merged by #18 into one question asked once.
  assert.equal(flag.rule, "P1+P2");
  assert.equal(flag.level, "warn");
  assert.equal(flag.kind, "decision", "the answer changes the files");

  // Stage has no Notion column, so the flag proposes one from configuration.
  assert.equal(flag.stage, process.env.DEAL_STAGE || "Lead");
  // Owner does have one, so it stays on the Deal candidates and is not copied
  // here — nor is any count, which the surface derives as the batch stands.
  assert.equal(flag.owner, undefined);
  assert.equal(flag.deals, undefined);
  for (const deal of candidates.deals) {
    const company = candidates.companies.find(
      (one) => one.id === deal.companyId,
    );
    const owners = new Set(rowsFor(company.name).map((row) => row.Owner));
    assert.ok(
      owners.has(deal.owner),
      `${deal.id} proposes an owner its account's rows gave`,
    );
  }
});

// ── The freeze ─────────────────────────────────────────────────────────────

test("the candidate set and the flag set do not move once checking has completed", async () => {
  const first = await reviewSnapshot();
  assert.ok(everyFlag(first.candidates).length > 0, "there is a flag to move");

  for (let poll = 0; poll < 3; poll += 1) {
    const again = await (await fetch(`${base}/api/runs/${first.runId}`)).json();
    assert.equal(again.status, "awaiting_review");
    assert.deepEqual(again.candidates, first.candidates);
    assert.deepEqual(again.batchFlags, first.batchFlags);
  }
});
