/**
 * What a run *is*, between the `runs` table and the checkpoint.
 *
 * The table holds a run's identifier, batch and created time. Everything else
 * is derived here from the checkpoint on every request (ADR-0009), which is
 * why a process that dies mid-run leaves a run reading `stalled` rather than
 * one whose stored status lies about what is happening.
 *
 * Two things live only in this process's memory, on purpose: which runs are
 * working right now, and which threw. Both are gone after a restart, and both
 * degrade to `stalled` — the contract keeps no failure record.
 */

import { randomUUID } from "node:crypto";
import { checkpointer, graph } from "./graph.ts";
import {
  deleteRun,
  insertRun,
  readRun,
  readRuns,
  type RunRecord,
} from "./store.ts";

/** `docs/http-contract.md`'s closed list. */
export type RunStatus =
  | "running"
  | "awaiting_review"
  | "awaiting_confirmation"
  | "done"
  | "abandoned"
  | "failed"
  | "stalled";

/** Work in flight in this process — also the per-run lock (#3 found none). */
const working = new Set<string>();

/** Nodes that threw since this process started. */
const threw = new Set<string>();

/** Batches whose guard is being decided right now, against the run deciding it. */
const claiming = new Map<string, string>();

const configFor = (runId: string) => ({ configurable: { thread_id: runId } });

/**
 * Read off the checkpoint's pending tasks, in this order:
 *
 * - something is running here, or threw here — only this process knows either
 * - a task is paused on an `interrupt()` — the Reviewer is what it waits for
 * - tasks are pending and nothing is running — the process restarted mid-run
 * - nothing is pending — the graph ran to the end
 *
 * A checkpoint that does not exist yet is the same picture as pending work:
 * the run was created and never got anywhere, so it is `stalled` too.
 */
export async function statusOf(runId: string): Promise<RunStatus> {
  return statusFrom(runId, await graph.getState(configFor(runId)));
}

/** The same reading, for a caller that has already read the checkpoint. */
function statusFrom(
  runId: string,
  snapshot: Awaited<ReturnType<typeof graph.getState>>,
): RunStatus {
  if (working.has(runId)) return "running";
  if (threw.has(runId)) return "failed";
  if (snapshot.tasks.some((task) => task.interrupts.length > 0)) {
    // `review` is the only node that interrupts so far. The confirmation
    // pause joins it with #57, and is told apart by the task's name.
    return "awaiting_review";
  }
  if (!snapshot.createdAt || snapshot.next.length > 0) return "stalled";
  return "done";
}

/**
 * The snapshot `GET /api/runs/:runId` answers with.
 *
 * The candidates, their flags and the repair log are read from the checkpoint,
 * which is the only place they exist (ADR-0009), and are empty until
 * `transform` and `check` have run.
 * One read serves the status and the ledger, so the two cannot come from two
 * different moments of a live thread.
 */
export async function snapshotOf(run: RunRecord) {
  const state = await graph.getState(configFor(run.runId));
  const { values } = state;
  return {
    runId: run.runId,
    batch: run.batch,
    createdAt: run.createdAt,
    status: statusFrom(run.runId, state),
    /**
     * The checkpoint's pending node — `snap.next`, which #3 verified names the
     * node about to run. It is what the run's page derives its step indicator
     * from, so progress is *read* rather than stored and ADR-0009's rule that
     * the runs table holds nothing derivable survives untouched.
     *
     * Empty once the graph has run to the end.
     */
    next: [...state.next],
    candidates: {
      companies: values.companies ?? [],
      people: values.people ?? [],
      deals: values.deals ?? [],
    },
    batchFlags: values.batchFlags ?? [],
    repairs: values.repairs ?? [],
    // The screening log is deliberately **not** here. It is an audit record,
    // not a reviewer surface: nothing downstream reads it (#56's notes file
    // carries the repair log and the flags; #60's ledger renders neither), and
    // a discarded quote is the one piece of model-authored text in the run.
    // Keeping it in the checkpoint is what makes #60's *the quote span is never
    // rendered* structural rather than a promise the browser has to keep.
    // The three below stay null until they mean something.
    files: null,
    writeBack: null,
    blocked: null,
  };
}

/** Every run the file holds, each against the status its checkpoint gives it. */
async function statuses(): Promise<{ run: RunRecord; status: RunStatus }[]> {
  return Promise.all(
    readRuns().map(async (run) => ({
      run,
      status: await statusOf(run.runId),
    })),
  );
}

export async function listRuns() {
  return (await statuses()).map(({ run, status }) => ({
    runId: run.runId,
    batch: run.batch,
    createdAt: run.createdAt,
    status,
  }));
}

/**
 * The run still holding this batch, if one does. Only a `done` run releases
 * its batch: it has written `Imported` to Notion, so its rows leave the filter
 * anyway. Every other state holds it, `failed` and `abandoned` included —
 * a second run would read the same rows and make the same Deals, and #2 found
 * Deals always create, with no undo.
 */
async function runHolding(batch: string): Promise<RunRecord | undefined> {
  return (await statuses()).find(
    ({ run, status }) => run.batch === batch && status !== "done",
  )?.run;
}

/**
 * Drives the graph to its next stop. Nothing awaits this: the route has
 * already answered `202`, and the first pause is 20–40 seconds away.
 *
 * `durability: "sync"` puts the input checkpoint down before the first node
 * runs, so a process killed inside that node still leaves a run something can
 * be continued from.
 */
async function work(runId: string, input: { batch: string } | null) {
  working.add(runId);
  threw.delete(runId);
  try {
    await graph.invoke(input, { ...configFor(runId), durability: "sync" });
  } catch (error) {
    threw.add(runId);
    console.error(`Run ${runId} failed:`, error);
  } finally {
    working.delete(runId);
    // Cancelled while it was still working: the run is gone, so the checkpoint
    // this just wrote has nothing left to belong to.
    if (!readRun(runId)) await checkpointer.deleteThread(runId);
  }
}

/**
 * Starts a run over a batch, or names the run that already holds it.
 *
 * The claim is taken **before the first `await`**, so a double-clicked Start
 * cannot put two runs on one batch: reading each run's status is asynchronous,
 * and without the claim both requests would pass the guard and both insert.
 * The row itself exists before the caller is answered, so a reload during
 * startup cannot orphan the run either.
 *
 * ponytail: the claim is this process's. Two Express processes would still
 * both pass — the same single-process ceiling the resume lock has.
 */
export async function startRun(
  batch: string,
): Promise<{ run: RunRecord } | { heldBy: string }> {
  const claimed = claiming.get(batch);
  if (claimed) return { heldBy: claimed };
  const runId = randomUUID();
  claiming.set(batch, runId);
  try {
    const holder = await runHolding(batch);
    if (holder) return { heldBy: holder.runId };
    const run = insertRun(runId, batch);
    void work(runId, { batch });
    return { run };
  } finally {
    claiming.delete(batch);
  }
}

/**
 * Resumes a stopped run from its last checkpoint, in a fresh process or this
 * one. It carries no workspace check of its own: a run can stall at any node,
 * and most of them never touch Notion.
 */
export async function continueRun(run: RunRecord): Promise<void> {
  const snapshot = await graph.getState(configFor(run.runId));
  // Nothing was checkpointed before the process died, so there is no last
  // checkpoint to resume from — the run starts from its input instead.
  void work(run.runId, snapshot.createdAt ? null : { batch: run.batch });
}

/**
 * Deletes the run and releases its batch.
 *
 * ponytail: a run cancelled while a node is still executing is not stopped —
 * `work()` deletes the checkpoint it leaves behind, and every node this far is
 * read-only, so nothing outside is touched. From #52 a released batch could be
 * started again while the old run is still dying; that wants a cancellation
 * the graph can see.
 */
export async function cancelRun(runId: string): Promise<void> {
  deleteRun(runId);
  await checkpointer.deleteThread(runId);
}

/**
 * The runs a disconnect would strand: their bundle is in Attio and their
 * write-back can no longer be made. Nothing is stranded until #57 brings the
 * confirmation pause, and this says so by deriving it rather than by knowing.
 */
export async function runsAwaitingConfirmation(): Promise<string[]> {
  return (await statuses())
    .filter(({ status }) => status === "awaiting_confirmation")
    .map(({ run }) => run.runId);
}
