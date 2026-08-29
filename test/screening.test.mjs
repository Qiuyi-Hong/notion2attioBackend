/**
 * The notes screener, over the HTTP contract (#55).
 *
 * The model is faked at the network, so the app under test is the app that
 * ships, and what it returns is #30's recorded result on this batch: N1 on
 * Heliograph, N1 **and** N2 on Lattice Forge, silence on the other six. That is
 * a fixture, not a claim about the model — what these tests assert is what the
 * pipeline does with a reading, never that a reading was correct.
 *
 * The **no-key** path is asserted in `flags.test.mjs`, which runs the whole
 * pipeline without a key and so is where that world already lives.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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
// A key, so the notes are read. `dotenv` never overwrites what is already set,
// so a developer's own `.env` cannot reach the real API from here.
process.env.OPENAI_API_KEY = "test-model-key";
process.env.OPENAI_MODEL = "gpt-5.6-sol";

const { default: app } = await import("../src/app.ts");
const { graph } = await import("../src/graph.ts");

const CARPE_LAB = {
  access_token: "ntn_live_token",
  workspace_id: "ws-1",
  workspace_name: "Carpe Lab",
  workspace_icon: null,
};

const DATA_SOURCE_ID = "ds-shared-by-the-grant";
const QUERY_PATH = `/v1/data_sources/${DATA_SOURCE_ID}/query`;

// ── The batch, and what the model says about it ────────────────────────────

const rows = parseCsv(readFileSync(CSV_PATH, "utf8")).filter(
  (row) => row.Batch === TARGET_BATCH && row["CRM status"] === TARGET_STATUS,
);

const rowOf = (account) => rows.find((row) => row.Account === account);
const notesOf = (account) => rowOf(account)["Research notes"];

/**
 * #30's result on this batch, replayed. Lattice Forge carries **two** kinds:
 * the alias sentence is N1 and the campaign sentence is N2, and the model
 * returned both in all 12 runs that scored it.
 */
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

const SCREENED = Object.keys(SUSPICIONS);
const SILENT = rows
  .map((row) => row.Account)
  .filter((account) => !SCREENED.includes(account));

/** Which row's notes a call is reading, so a reply can be scripted per row. */
const accountOf = (notes) =>
  rows.find((row) => row["Research notes"] === notes)?.Account;

const scripted = (notes) => SUSPICIONS[accountOf(notes)] ?? [];

// ── The fakes ──────────────────────────────────────────────────────────────

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
// Installed second, so it answers the model and hands everything else to the
// Notion fake beneath it.
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
  model.calls = [];
  model.maxInFlight = 0;
  model.reply = (notes) => scripted(notes);
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

const everyCandidate = (candidates) => Object.values(candidates).flat();

const noticesIn = (candidates) =>
  everyCandidate(candidates).flatMap((candidate) =>
    candidate.flags
      .filter((flag) => flag.kind === "notice")
      .map((flag) => ({ ...flag, on: candidate.id })),
  );

/**
 * The screening log, read where it lives. It is an audit record rather than a
 * reviewer surface, so it sits in the run's checkpoint and not on the wire.
 */
const screeningOf = async (runId) =>
  (await graph.getState({ configurable: { thread_id: runId } })).values
    .screening;

const personFor = (candidates, account) =>
  candidates.people.find(
    (person) => person.sourceId === rowOf(account)["Source ID"],
  );

// ── The fixture itself ─────────────────────────────────────────────────────

test("every scripted quote is a span of the notes it is scripted against", () => {
  // Otherwise the fixture would be testing the discard path by accident.
  for (const [account, suspicions] of Object.entries(SUSPICIONS)) {
    for (const suspicion of suspicions) {
      assert.ok(
        notesOf(account).includes(suspicion.quote),
        `${account}'s ${suspicion.kind} quote is verbatim`,
      );
    }
  }
  assert.equal(SILENT.length + SCREENED.length, rows.length);
});

test("the prompt ships #6's kind sentences and #30's standing exclusions", async () => {
  await reviewSnapshot();
  const [{ system }] = model.calls;

  // Quoted here rather than imported, so a change to the rule set has to be
  // made in both places deliberately. #6's two sentences, verbatim.
  assert.ok(
    system.includes(
      "Research notes mention an earlier contact under a different email address.",
    ),
    "N1 as #6 wrote it",
  );
  assert.ok(
    system.includes("Research notes mention a match with an earlier campaign."),
    "N2 as #6 wrote it",
  );

  // #30 found the exclusions load-bearing on this model: without them
  // `gpt-5.6-sol` raised N2, in every run, on a note denying the match.
  const [, exclusions] = system.split("These are NOT suspicions:\n\n");
  assert.ok(exclusions, "the exclusions are in the shipped prompt");
  assert.equal(exclusions.split("\n\n")[0].split("\n").length, 4, "all four");
});

// ── What the batch raises ──────────────────────────────────────────────────

test("the batch raises one notice Warn on each screened candidate, and none elsewhere", async () => {
  const { candidates } = await reviewSnapshot();

  const notices = noticesIn(candidates);
  assert.equal(notices.length, SCREENED.length);
  assert.deepEqual(
    notices.map((notice) => notice.on).sort(),
    SCREENED.map((account) => personFor(candidates, account).id).sort(),
    "on Heliograph's and Lattice Forge's people, and nobody else's",
  );

  for (const notice of notices) {
    assert.equal(notice.level, "warn");
    // A Warn excludes nothing, so it has nothing to force past.
    assert.equal(notice.override, false);
    assert.deepEqual(notice.siblings, []);
  }

  for (const account of SILENT) {
    const person = personFor(candidates, account);
    assert.equal(
      person.flags.filter((flag) => flag.kind === "notice").length,
      0,
      `${account} raised nothing`,
    );
  }

  // One call per source row, on the settled levers. Effort is not a knob.
  assert.equal(model.calls.length, rows.length);
  for (const call of model.calls) {
    assert.equal(call.model, "gpt-5.6-sol");
    assert.equal(call.effort, "low");
  }
});

test("two kinds of evidence for one suspicion are one notice, carrying both", async () => {
  const { candidates } = await reviewSnapshot();

  const [twoKinds] = Object.entries(SUSPICIONS).filter(
    ([, suspicions]) => new Set(suspicions.map((s) => s.kind)).size > 1,
  );
  assert.ok(twoKinds, "the batch has a candidate with two kinds");
  const [account, suspicions] = twoKinds;

  const person = personFor(candidates, account);
  const notices = person.flags.filter((flag) => flag.kind === "notice");
  assert.equal(notices.length, 1, `${account} is acknowledged once, not twice`);
  // The name carries every kind, the way `P1+P2` carries both its halves.
  assert.equal(
    notices[0].rule,
    [...new Set(suspicions.map((s) => s.kind))].sort().join("+"),
  );
});

test("a notice does not hold its account's Deal", async () => {
  const { candidates } = await reviewSnapshot();

  for (const account of SCREENED) {
    const person = personFor(candidates, account);
    assert.equal(
      person.flags.length,
      1,
      `${account}'s person carries the notice and nothing else`,
    );
    const deal = candidates.deals.find(
      (candidate) => candidate.companyId === person.companyId,
    );
    // A notice says nothing about whether the account is whole, and the export
    // gate already has the Reviewer read it. Asserted on `held` as well as on
    // the flags: a Deal held with no D1 to say why would pass the first half
    // while the ledger said two things at once (#54).
    assert.deepEqual(deal.flags, [], `${account}'s Deal raises no Stop`);
    assert.equal(deal.held, false, `${account}'s Deal is not held`);
    assert.equal(person.held, false, `${account}'s Person is not held`);
  }
});

// ── What may not travel ────────────────────────────────────────────────────

test("no prose the model wrote, and no confidence score, reaches the wire", async () => {
  model.reply = (notes) =>
    scripted(notes).map((suspicion) => ({
      ...suspicion,
      // Everything a model might volunteer beyond the contract.
      confidence: 0.93,
      sentence: "I think this person may be a duplicate.",
    }));

  const snapshot = await reviewSnapshot();
  const notices = noticesIn(snapshot.candidates);
  assert.equal(notices.length, SCREENED.length, "the notices still land");

  for (const notice of notices) {
    assert.deepEqual(
      Object.keys(notice).sort(),
      // `cleared` and `refused` are the reviewer's own answer (#54), and
      // neither is a place the model could put a word.
      [
        "cleared",
        "id",
        "kind",
        "level",
        "on",
        "override",
        "refused",
        "rule",
        "siblings",
      ],
      "a notice carries a rule name and nothing to narrate with",
    );
  }

  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes("I think this person"), "no model prose");
  assert.ok(!wire.includes("confidence"), "and no confidence score");
  assert.ok(!wire.includes("quote"), "and nothing named a quote");

  /**
   * And no quote **span**.
   *
   * A kept quote is by definition a verbatim substring of the notes, and #60
   * puts the full notes on the wire for every candidate — so the characters
   * themselves are unavoidable, and asserting their absence would be asserting
   * the notes are withheld. What is checkable, and what *the quote span is
   * never rendered* actually means, is that the span is nowhere on the wire as
   * a value of its own: the Reviewer is handed their own text whole, with
   * nothing marking where the model looked.
   *
   * Blanking the notes is what makes that a test rather than a claim — every
   * occurrence left afterwards would be the model's pointer travelling
   * separately.
   */
  const withoutNotes = JSON.stringify(snapshot, (key, value) =>
    key === "notes" ? [] : value,
  );
  for (const suspicions of Object.values(SUSPICIONS)) {
    for (const suspicion of suspicions) {
      assert.ok(
        !withoutNotes.includes(suspicion.quote),
        "and no quote span outside the Reviewer's own notes",
      );
    }
  }
});

test("the screener changes no value", async () => {
  const { candidates, repairs } = await reviewSnapshot();

  // Every value on a screened candidate is still the one its source row gave.
  for (const account of SCREENED) {
    const row = rowOf(account);
    const person = personFor(candidates, account);
    assert.equal(person.name, row.Contact);
    assert.equal(person.email, row["Work email"]);
    assert.equal(person.jobTitle, row["Job title"]);
    assert.equal(person.leadSource, row["Lead source"]);

    const company = candidates.companies.find(
      (candidate) => candidate.id === person.companyId,
    );
    assert.equal(company.name, row.Account);
    assert.equal(company.primaryLocation, row.HQ);
  }

  // And the repair log gained nothing: a model's reading is never a repair.
  for (const repair of repairs) assert.equal(repair.field, "domain");
});

// ── The quote check ────────────────────────────────────────────────────────

test("a suspicion whose quote is not in the notes is discarded, and logged", async () => {
  const invented = {
    kind: "N2",
    quote: "She was in the spring campaign under a different name.",
  };
  const target = SCREENED[0];
  assert.ok(!notesOf(target).includes(invented.quote), "it is invented");
  model.reply = (notes) =>
    accountOf(notes) === target ? [invented] : scripted(notes);

  const { runId, candidates } = await reviewSnapshot();
  const screening = await screeningOf(runId);

  const person = personFor(candidates, target);
  assert.deepEqual(person.flags, [], `${target} raised nothing that survived`);
  assert.equal(
    noticesIn(candidates).length,
    SCREENED.length - 1,
    "the other notice is untouched",
  );

  const entry = screening.entries.find(
    (screened) => screened.sourceId === rowOf(target)["Source ID"],
  );
  assert.deepEqual(entry.kept, [], "nothing was kept");
  assert.deepEqual(
    entry.discarded,
    [invented],
    "and the log names what was not",
  );
});

test("an empty quote is not a quote, and is discarded too", async () => {
  // `"anything".includes("")` is true, so this is the one invention that would
  // reach the reviewer for free if the check were a bare substring test.
  const empty = { kind: "N1", quote: "" };
  const target = SCREENED[0];
  model.reply = (notes) =>
    accountOf(notes) === target ? [empty] : scripted(notes);

  const { runId, candidates } = await reviewSnapshot();

  assert.deepEqual(
    personFor(candidates, target).flags,
    [],
    `${target} raised nothing on evidence-free ground`,
  );
  const entry = (await screeningOf(runId)).entries.find(
    (screened) => screened.sourceId === rowOf(target)["Source ID"],
  );
  assert.deepEqual(entry.discarded, [empty], "and the log names it");
});

test("the screening log records the model, the effort and the prompt version", async () => {
  const { runId } = await reviewSnapshot();
  const screening = await screeningOf(runId);

  assert.equal(screening.model, "gpt-5.6-sol");
  assert.equal(screening.effort, "low");
  assert.ok(
    screening.prompt,
    "the prompt version, so a change is attributable",
  );
  assert.deepEqual(
    screening.entries.map((entry) => entry.sourceId).sort(),
    rows.map((row) => row["Source ID"]).sort(),
    "one entry per source row, read or not",
  );
});

// ── The freeze, and the node ───────────────────────────────────────────────

test("the notices are checkpointed, and re-reading the run costs nothing", async () => {
  const first = await reviewSnapshot();
  assert.ok(
    noticesIn(first.candidates).length > 0,
    "there is a notice to move",
  );
  const log = await screeningOf(first.runId);
  const calls = model.calls.length;

  for (let poll = 0; poll < 3; poll += 1) {
    const again = await (await fetch(`${base}/api/runs/${first.runId}`)).json();
    assert.equal(again.status, "awaiting_review");
    assert.deepEqual(again.candidates, first.candidates);
    assert.equal(again.screening, undefined, "the log is not a wire field");
    assert.deepEqual(await screeningOf(first.runId), log);
    // The reading is checkpointed, not re-taken: it cannot change under the
    // Reviewer mid-decision, and it is not charged again.
    assert.equal(model.calls.length, calls);
  }
});

test("the rows are screened in parallel, and the node checkpoints once", async () => {
  // Every call is held open until the last one has arrived, so a sequential
  // screener never gets past the first row.
  let arrived = 0;
  let release;
  const allArrived = new Promise((resolve) => (release = resolve));
  model.reply = async (notes) => {
    arrived += 1;
    if (arrived === rows.length) release();
    await Promise.race([
      allArrived,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    return scripted(notes);
  };

  const { runId } = await reviewSnapshot();
  assert.equal(
    model.maxInFlight,
    rows.length,
    "all eight rows were open at once",
  );

  const history = [];
  for await (const state of graph.getStateHistory({
    configurable: { thread_id: runId },
  })) {
    history.push(state);
  }
  const screened = history.filter((state) => state.values.screening);
  assert.equal(screened.length, 1, "one checkpoint carries the screening");
  assert.deepEqual(screened[0].next, ["review"], "and the interrupt is next");
  // Nothing moved until all eight were back.
  assert.equal((await screeningOf(runId)).entries.length, rows.length);
});
