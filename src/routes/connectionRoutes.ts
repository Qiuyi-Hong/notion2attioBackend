/**
 * `/api/connection` — what the app knows about the Connection, and how to end
 * it. The read names the workspace and nothing else: no token, no id. The ids
 * stay server-side, where ADR-0008's comparison happens.
 */

import { Router } from "express";
import { ApiError } from "../errors.ts";
import { revokeToken } from "../notion.ts";
import { runsAwaitingConfirmation } from "../runs.ts";
import { deleteConnection, readConnection } from "../store.ts";

const router = Router();

router.get("/", (_req, res) => {
  const connection = readConnection();
  res.json(
    connection
      ? {
          connected: true,
          workspace: {
            name: connection.workspace_name,
            icon: connection.workspace_icon,
          },
        }
      : { connected: false, workspace: null },
  );
});

router.delete("/", async (_req, res) => {
  const connection = readConnection();
  if (!connection) {
    throw new ApiError(
      "not_connected",
      409,
      "No Notion workspace is connected.",
    );
  }
  // Named before the row goes: after the grant is gone these runs can never
  // write their outcome back to Notion.
  const strandedRuns = await runsAwaitingConfirmation();
  await revokeToken(connection.access_token);
  deleteConnection();
  res.json({ disconnected: true, strandedRuns });
});

export default router;
