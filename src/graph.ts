/**
 * The pipeline, compiled and `.invoke()`d **inside** this Express process (#3).
 * No LangGraph Platform, no `@langchain/langgraph-sdk`: the run identifier is
 * the `thread_id` and the checkpoint file is the whole read model.
 *
 * Seven nodes — read the batch, propose candidates from it, check them, pause
 * for the Reviewer, make the files, pause again for the confirmation, and write
 * `Imported` back to Notion. `check` holds the deterministic rules and the one
 * model call the pipeline makes, which may only raise a flag (ADR-0002);
 * `writeback` holds the only side effect the system has (ADR-0007).
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
import { bundleFiles, HandoffFile, unansweredWarn } from "./emit.ts";
import { BatchFlag, checkFlags } from "./flags.ts";
import { findSharedDataSource, queryBatchRows } from "./notion.ts";
import { applyDecision, type Decision, wasRefused } from "./review.ts";
import { noticesOf, Screening, screenNotes } from "./screener.ts";
import { readConnection } from "./store.ts";
import { type Confirmation, WriteBack, writeBackOf } from "./writeback.ts";

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
  /**
   * The screening log, beside the repair log. `null` until `check` has run,
   * and still `null` afterwards when there was no key — which is what the
   * `N0` batch flag says out loud.
   */
  screening: Screening.nullable().default(() => null),
  /**
   * The handoff bundle once `emit` has made it — the bytes themselves, not a
   * path to them. `null` until then.
   *
   * They live in the checkpoint because that is where a run's own work lives
   * (ADR-0009), and because the download must serve what was reviewed rather
   * than what a second run of the emitter would produce today.
   */
  files: z
    .array(HandoffFile)
    .nullable()
    .default(() => null),
  /**
   * What the write-back left behind, and `null` until one has been attempted
   * (#57). A non-empty `failed` is the whole of the retry panel's input: a run
   * with failures is paused at the confirmation interrupt, which is the
   * definition of `awaiting_confirmation`, so the retry needs no state of its
   * own beside this.
   */
  writeBack: WriteBack.nullable().default(() => null),
  /**
   * The reviewer gave up on marking Notion for a bundle that did reach Attio.
   * Terminal, and deliberately **not** `done`: a `done` run releases its batch,
   * and these rows still read `Ready for CRM` with their deals already in Attio
   * (ADR-0007).
   */
  abandoned: z.boolean().default(() => false),
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
 * The deterministic rules, over the candidates the transform proposed, and the
 * screener's notices beside them. The candidate set and the flag set are frozen
 * the moment this returns (ADR-0004).
 *
 * The model call lives **here**, before the interrupt, rather than in `review`:
 * an interrupted node re-runs from the top, so a call there would be charged
 * again on every resume and could return different notices under the Reviewer
 * mid-decision (ADR-0002). Screened here, the same run shows the same notices
 * every time it is looked at.
 */
const check: GraphNode<typeof State> = async (state) => {
  const screening = await screenNotes(state.sourceRows);
  return {
    ...checkFlags(
      state,
      config.dealStage,
      screening && noticesOf(state.sourceRows, screening),
    ),
    screening,
  };
};

/**
 * The first pause, and the reviewer's decision landing on it (#54).
 *
 * An interrupted node re-runs from the top on resume, so this one holds the
 * `interrupt()` and one pure function — no read, no write, no log. The
 * document arrives already validated structurally, at the route: this side of
 * the resume is where the ledger is, and nothing here re-enters `check`.
 *
 * The `interrupt()` is called **once** per invocation and never conditionally.
 * A refused answer routes the run back to this node rather than looping inside
 * it, which is the pattern `docs/research/langgraph-hitl.md` verified: each
 * resume replays every earlier iteration of an in-node loop.
 */
const review: GraphNode<typeof State> = (state) =>
  applyDecision(state, interrupt({ kind: "review" }) as Decision);

/**
 * The files, made once (#56). Pure, and the whole of it lives in `emit.ts`.
 *
 * It runs here, after the review, rather than at the download: a `GET` free to
 * regenerate them would be free to disagree with the ledger that was on
 * screen.
 */
const emit: GraphNode<typeof State> = (state) => ({
  files: bundleFiles(state),
});

/**
 * The second pause. The files exist, and the run waits for the human to say
 * the batch landed in Attio — which may be hours later, at a different
 * machine.
 *
 * The run reaches `awaiting_confirmation` as soon as the files **exist**, not
 * when they are downloaded: a download is a repeatable `GET` that moves the run
 * nowhere.
 *
 * It is reached a second time after a partial write-back, carrying the failure
 * list — which is what turns the confirmation panel into a retry panel, with
 * no second pause and no second route. Like `review`, it holds the
 * `interrupt()` and nothing else: an interrupted node re-runs from the top, so
 * a side effect here would be charged again on every resume.
 */
const confirm: GraphNode<typeof State> = (state) => {
  const answer = interrupt({
    kind: "confirm",
    writeBack: state.writeBack,
  }) as Confirmation;
  return "abandoned" in answer ? { abandoned: true } : {};
};

/**
 * The write-back, and the only side effect in the system (#57). The whole of it
 * lives in `writeback.ts`; the node is the seam it runs at.
 */
const writeback: GraphNode<typeof State> = async (state) => ({
  writeBack: await writeBackOf(state),
});

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
  .addNode("emit", emit)
  .addNode("confirm", confirm)
  .addNode("writeback", writeback)
  .addEdge(START, "read")
  .addEdge("read", "transform")
  .addEdge("transform", "check")
  .addEdge("check", "review")
  /**
   * Back to the pause when an answer was refused, so the problem appears on
   * the candidate in the ledger where the reviewer is already working — never
   * as a `400` on a response they will never see again. The ledger this leaves
   * behind is the reviewer's own work, so nothing they got right is lost.
   *
   * And back to it while any **Warn** is unanswered — the export gate, whose
   * reading lives on `unansweredWarn`. The refusal is the run staying where it
   * is, not an error: the unanswered flag is already on screen in the ledger,
   * which is the only place its answer can be given.
   */
  .addConditionalEdges(
    "review",
    (state) => (wasRefused(state) || unansweredWarn(state) ? "review" : "emit"),
    ["review", "emit"],
  )
  .addEdge("emit", "confirm")
  /**
   * Abandoning ends the run without writing anything: the bundle reached
   * Attio and the reviewer is giving up on marking Notion. Confirming is the
   * only way into the one node that writes.
   */
  .addConditionalEdges(
    "confirm",
    (state) => (state.abandoned ? END : "writeback"),
    [END, "writeback"],
  )
  /**
   * Back to the pause while any handed-off row is still unwritten — the whole
   * of the retry mechanism, and the reason there is no second pause and no
   * second route. **Retry is this same edge**, re-entered by the same payload
   * on the same route, and re-entering costs nothing because the node
   * re-queries Notion before it writes (ADR-0007).
   */
  .addConditionalEdges(
    "writeback",
    (state) => (state.writeBack?.failed.length ? "confirm" : END),
    ["confirm", END],
  )
  .compile({ checkpointer });
