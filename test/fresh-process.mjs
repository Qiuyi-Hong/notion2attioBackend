/**
 * A run, read and continued from a process that has never seen it.
 *
 * This is how `test/runs.test.mjs` restarts the server: a real second Node
 * process against the same SQLite file, with nothing in memory. There is no
 * other honest way to prove that a run reads `stalled` after a restart and
 * that continuing resumes it from the last checkpoint — the whole point is
 * that the first process's memory is gone.
 *
 *   node test/fresh-process.mjs <databasePath> <runId>
 *
 * Prints one JSON line: the status it found, the status after continuing, and
 * what the resumed read node put into graph state.
 */

import { fakeNotion } from "./notion-fake.mjs";

const [databasePath, runId] = process.argv.slice(2);
process.env.DATABASE_PATH = databasePath;

const DATA_SOURCE_ID = "ds-a-fresh-process-found";

/** One ready row, so a resumed read has something to come back with. */
const notion = fakeNotion();
notion.script = {
  "/v1/search": () => [
    200,
    { results: [{ object: "data_source", id: DATA_SOURCE_ID }] },
  ],
  [`/v1/data_sources/${DATA_SOURCE_ID}/query`]: () => [
    200,
    {
      results: [
        {
          object: "page",
          id: "QL-260818-001",
          properties: {
            "Source ID": { rich_text: [{ plain_text: "QL-260818-001" }] },
            Batch: { select: { name: "2026-W34" } },
            "CRM status": { status: { name: "Ready for CRM" } },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    },
  ],
};

const { graph } = await import("../src/graph.ts");
const { continueRun, statusOf } = await import("../src/runs.ts");
const { readRun } = await import("../src/store.ts");

const before = await statusOf(runId);

await continueRun(readRun(runId));
let after = await statusOf(runId);
for (let tries = 0; after === "running" && tries < 200; tries += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  after = await statusOf(runId);
}

const { values } = await graph.getState({ configurable: { thread_id: runId } });

console.log(
  JSON.stringify({
    before,
    after,
    workspaceId: values.workspaceId,
    workspaceName: values.workspaceName,
    sourceRows: values.sourceRows,
  }),
);
