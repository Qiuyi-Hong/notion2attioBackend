/**
 * The pipeline, compiled and `.invoke()`d **inside** this Express process (#3).
 * No LangGraph Platform, no `@langchain/langgraph-sdk`: the run identifier is
 * the `thread_id` and the checkpoint file is the whole read model.
 *
 * Four nodes so far — read the batch, propose candidates from it, check them,
 * then pause for the Reviewer. `check` holds the deterministic rules today;
 * the screener's two notice Warns join it with the model call (ADR-0002).
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
import {
  candidatesFrom,
  CompanyCandidate,
  DealCandidate,
  PersonCandidate,
  Repair,
} from "./candidates.ts";
import config from "./config/config.ts";
import { BatchFlag, checkFlags } from "./flags.ts";
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
  /** The ledger, grouped by the Attio object each candidate becomes. */
  companies: z.array(CompanyCandidate).default(() => []),
  people: z.array(PersonCandidate).default(() => []),
  deals: z.array(DealCandidate).default(() => []),
  repairs: z.array(Repair).default(() => []),
  /** Asked once, in one place, before the files are made. */
  batchFlags: z.array(BatchFlag).default(() => []),
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

/** Pure, and the whole of it lives in `candidates.ts`. */
const transform: GraphNode<typeof State> = (state) =>
  candidatesFrom(state.sourceRows);

/**
 * The deterministic rules, over the candidates the transform proposed. Pure,
 * and the whole of it lives in `flags.ts`. The candidate set and the flag set
 * are frozen the moment this returns (ADR-0004).
 */
const check: GraphNode<typeof State> = (state) =>
  checkFlags(state, config.dealStage);

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
  .addNode("transform", transform)
  .addNode("check", check)
  .addNode("review", review)
  .addEdge(START, "read")
  .addEdge("read", "transform")
  .addEdge("transform", "check")
  .addEdge("check", "review")
  .addEdge("review", END)
  .compile({ checkpointer });
