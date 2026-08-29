/**
 * The pipeline, compiled and `.invoke()`d **inside** this Express process (#3).
 * No LangGraph Platform, no `@langchain/langgraph-sdk`: the run identifier is
 * the `thread_id` and the checkpoint file is the whole read model.
 *
 * Two nodes so far — read the batch, then pause for the Reviewer. The nodes
 * between them arrive with the tickets that need them (#52 onwards), and the
 * ledger is empty until they do.
 *
 * `docs/research/langgraph-hitl.md` is where the API facts below were verified.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  END,
  interrupt,
  START,
  StateGraph,
  StateSchema,
  type GraphNode,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as z from "zod";
import config from "./config/config.ts";
import { findSharedDataSource, queryBatchRows } from "./notion.ts";
import { readConnection } from "./store.ts";

/**
 * Declared with the Zod state schema rather than the older annotation root.
 * Every value the Reviewer will see or edit lives here, and nowhere else
 * (ADR-0009) — we persist no candidate data of our own.
 */
export const State = new StateSchema({
  batch: z.string(),
  sourceRows: z
    .array(z.record(z.string(), z.string().nullable()))
    .default(() => []),
  /**
   * The workspace this run read its batch from. Written here by the node that
   * queried Notion rather than stamped at run creation, because `POST
   * /api/runs` answers `202` and the Connection can be replaced before the
   * query runs (ADR-0008).
   */
  workspaceId: z
    .string()
    .nullable()
    .default(() => null),
  workspaceName: z
    .string()
    .nullable()
    .default(() => null),
});

const read: GraphNode<typeof State> = async (state) => {
  const connection = readConnection();
  if (!connection) throw new Error("No Notion workspace is connected.");
  const dataSourceId = await findSharedDataSource(connection.access_token);
  if (!dataSourceId) {
    throw new Error("The connected workspace shares no database we can read.");
  }
  return {
    sourceRows: await queryBatchRows(
      connection.access_token,
      dataSourceId,
      state.batch,
    ),
    workspaceId: connection.workspace_id,
    workspaceName: connection.workspace_name,
  };
};

/**
 * The first pause. An interrupted node re-runs from the top on resume, so this
 * one holds the `interrupt()` and nothing else — no read, no write, no log.
 */
const review: GraphNode<typeof State> = () => {
  interrupt({ kind: "review" });
  return {};
};

// `SqliteSaver` opens the file eagerly, and `store.ts` cannot be relied on to
// have created the directory first.
mkdirSync(dirname(config.databasePath), { recursive: true });

/**
 * The same file the Connection lives in (ADR-0009). It is no longer
 * "LangGraph's checkpoint file", so any future cleanup is per-table.
 */
export const checkpointer = SqliteSaver.fromConnString(config.databasePath);

export const graph = new StateGraph(State)
  .addNode("read", read)
  .addNode("review", review)
  .addEdge(START, "read")
  .addEdge("read", "review")
  .addEdge("review", END)
  .compile({ checkpointer });
