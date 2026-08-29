/**
 * The consent round trip. Both routes are browser navigations, not `fetch`,
 * so every outcome ends as a redirect back to the app carrying its own name —
 * the connect banner in `docs/run-surfaces.md` is built from it.
 *
 * The callback path is pinned in the Notion portal (#14) and cannot move.
 */

import { Router } from "express";
import { randomUUID } from "node:crypto";
import config from "../config/config.ts";
import { ApiError } from "../errors.ts";
import { authorizeUrl, exchangeCode, findSharedDataSource } from "../notion.ts";
import {
  claimAuthorisation,
  openAuthorisation,
  saveConnection,
} from "../store.ts";

type Outcome =
  "connected" | "no_databases" | "cancelled" | "expired" | "failed";

const backToApp = (outcome: Outcome) =>
  `${config.frontendOrigin}/runs?connection=${outcome}`;

const router = Router();

router.get("/notion/start", (_req, res) => {
  const state = randomUUID();
  openAuthorisation(state);
  res.redirect(authorizeUrl(state));
});

router.get("/notion/callback", async (req, res) => {
  const { code, state, error } = req.query;

  // One pending row, one callback — spent whichever way the consent went.
  const claimed = typeof state === "string" && claimAuthorisation(state);

  if (error) return res.redirect(backToApp("cancelled"));
  if (!claimed) return res.redirect(backToApp("expired"));
  if (typeof code !== "string") return res.redirect(backToApp("failed"));

  try {
    // Asked before the row is written, so `expired` and `failed` can both
    // mean what the contract says they mean: nothing was stored.
    const connection = await exchangeCode(code);
    const shared = await findSharedDataSource(connection.access_token);
    saveConnection(connection);
    return res.redirect(backToApp(shared ? "connected" : "no_databases"));
  } catch (thrown) {
    const expired =
      thrown instanceof ApiError && thrown.code === "not_connected";
    return res.redirect(backToApp(expired ? "expired" : "failed"));
  }
});

export default router;
