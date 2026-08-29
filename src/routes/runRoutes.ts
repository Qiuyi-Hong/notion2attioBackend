/**
 * `/api/runs` — starting a run, watching it move, answering its first pause,
 * and ending it.
 *
 * The second pause (`/confirm`) and the file download are not here yet; they
 * arrive with the tickets that give them something to carry.
 *
 * `docs/http-contract.md` owns the payloads, the states and the error shape.
 */

import { Router } from "express";
import * as z from "zod";
import { ApiError } from "../errors.ts";
import { Decision } from "../review.ts";
import {
  cancelRun,
  continueRun,
  listRuns,
  reviewRun,
  snapshotOf,
  startRun,
  statusOf,
} from "../runs.ts";
import { readRun, type RunRecord } from "../store.ts";

const router = Router();

/** An unknown run id is a real lookup miss, never an empty snapshot. */
function requireRun(runId: string | undefined): RunRecord {
  const run = runId ? readRun(runId) : undefined;
  if (!run) throw new ApiError("no_such_run", 404, "No such run.");
  return run;
}

router.post("/", async (req, res) => {
  const batch: unknown = req.body?.batch;
  if (typeof batch !== "string" || !batch) {
    throw new ApiError("invalid_payload", 400, "A batch is required.");
  }

  const started = await startRun(batch);
  if ("heldBy" in started) {
    // Naming the run points at the work rather than merely blocking: the
    // browser offers "open the run that already exists".
    throw new ApiError(
      "batch_in_progress",
      409,
      `${batch} is already being handed off.`,
      { runId: started.heldBy },
    );
  }

  // The identifier comes back before the work finishes — the run reads Notion
  // and screens its rows before it first pauses, plausibly 20–40 seconds.
  res.status(202).json({ runId: started.run.runId });
});

router.get("/", async (_req, res) => {
  res.json(await listRuns());
});

router.get("/:runId", async (req, res) => {
  res.json(await snapshotOf(requireRun(req.params.runId)));
});

/**
 * The first pause, answered. One route carries all three of the reviewer's
 * acts, because they are one decision: answers, holds and sparse edits.
 *
 * Structural bad input dies here, with `400`. Semantic bad input — a work
 * email the reviewer typed that does not parse, or that another Person
 * candidate already holds — does not: the run re-interrupts and the problem
 * appears on the candidate in the ledger, which is the surface they are
 * looking at.
 */
router.post("/:runId/review", async (req, res) => {
  const run = requireRun(req.params.runId);

  const decision = Decision.safeParse(req.body ?? {});
  if (!decision.success) {
    throw new ApiError("invalid_payload", 400, z.prettifyError(decision.error));
  }

  const outcome = await reviewRun(run, decision.data);
  if ("wrongStage" in outcome) {
    throw new ApiError(
      "wrong_stage",
      409,
      `This run is ${outcome.wrongStage}.`,
    );
  }
  if ("invalid" in outcome) {
    throw new ApiError("invalid_payload", 400, outcome.invalid);
  }

  // The ledger their decision produced, so a refusal reaches them in the same
  // answer rather than on the next poll.
  res.json(await snapshotOf(run));
});

/**
 * Stopped runs only. `stalled` and `failed` are the two the Reviewer is
 * offered **Continue** on, and after a restart they are the same picture.
 */
router.post("/:runId/continue", async (req, res) => {
  const run = requireRun(req.params.runId);
  const status = await statusOf(run.runId);
  if (status !== "stalled" && status !== "failed") {
    throw new ApiError("wrong_stage", 409, `This run is ${status}.`);
  }
  await continueRun(run);
  res.status(202).json({ runId: run.runId });
});

/**
 * Cancelling. Before the files exist this is unremarkable; once they exist it
 * is the attestation that they did **not** reach Attio, which is why it is
 * never how a Reviewer who has already imported gets out (they confirm).
 */
router.delete("/:runId", async (req, res) => {
  const run = requireRun(req.params.runId);
  await cancelRun(run.runId);
  res.json({ cancelled: true });
});

export default router;
