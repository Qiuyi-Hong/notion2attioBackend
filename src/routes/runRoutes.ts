/**
 * `/api/runs` — starting a run, watching it move, answering its first pause,
 * downloading what that produced, and ending it.
 *
 * `/confirm` is not here yet: the run reaches the second pause as soon as the
 * files exist (#56), but what answering it *does* — the write-back, its retry
 * and its abandonment — arrives with #57.
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
  fileFrom,
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
 * Read off the filename rather than stored beside it. `handoff-notes.md` is
 * Markdown precisely so that neither an auto-mapper nor a tired human offers
 * it to Attio's import screen, and serving it as `text/csv` would undo that in
 * one header.
 */
const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  zip: "application/zip",
};

/**
 * One file of the handoff bundle (#56).
 *
 * Serves the stored bytes from the checkpoint and never regenerates them, so
 * the bytes downloaded are provably the bytes the reviewer approved. It is a
 * repeatable `GET`: downloading twice returns the same bytes and moves the run
 * nowhere, which is why the run reaches `awaiting_confirmation` when the files
 * *exist* rather than when they are fetched.
 *
 * The file set is the emitter's — the ZIP the reviewer carries, and each of
 * its members, so a reviewer who wants one file can take one. `fileId` is
 * opaque, so that set can change without touching the contract.
 */
router.get("/:runId/files/:fileId", async (req, res) => {
  const run = requireRun(req.params.runId);
  const file = await fileFrom(run.runId, req.params.fileId);
  if (!file) throw new ApiError("no_such_file", 404, "No such file.");

  const extension = file.filename.split(".").pop() ?? "";
  res.type(CONTENT_TYPES[extension] ?? "application/octet-stream");
  // Attachment, always: a bundle read in a browser tab is a bundle that never
  // reached the folder the reviewer imports from.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${file.filename}"`,
  );
  res.send(Buffer.from(file.content, "base64"));
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
