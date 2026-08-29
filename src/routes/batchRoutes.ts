/**
 * `/api/batches` — the batches that actually have rows waiting, each with its
 * ready count. One search and one query against the live workspace, so the
 * pre-run screen's picker is proof the filter runs rather than a list sitting
 * in config.
 *
 * `docs/notion-source-database.md` owns the filter; `docs/http-contract.md`
 * owns the payload and the error shape.
 */

import { Router } from "express";
import { ApiError } from "../errors.ts";
import { findSharedDataSource, queryReadyRows } from "../notion.ts";
import { readConnection } from "../store.ts";

const router = Router();

router.get("/", async (_req, res) => {
  const connection = readConnection();
  if (!connection) {
    throw new ApiError(
      "not_connected",
      409,
      "No Notion workspace is connected.",
    );
  }

  const dataSourceId = await findSharedDataSource(connection.access_token);
  if (!dataSourceId) {
    // A grant that covers nothing we can read is its own answer. An empty
    // list here would read as "no work this week" — the same picture a
    // working workspace with everything imported shows.
    throw new ApiError(
      "not_connected",
      409,
      "The connected workspace shares no database we can read.",
      { reason: "no_databases" },
    );
  }

  const ready = new Map<string, number>();
  for (const row of await queryReadyRows(
    connection.access_token,
    dataSourceId,
  )) {
    // `Batch` is a select, and an unset one belongs to no run.
    const batch = row.properties?.Batch?.select?.name;
    if (batch) ready.set(batch, (ready.get(batch) ?? 0) + 1);
  }

  // Most recent week first: it is the one a reviewer opens the app to run.
  res.json(
    [...ready]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([batch, count]) => ({ batch, ready: count })),
  );
});

export default router;
