/**
 * The one SQLite file (#15, #49).
 *
 * It holds the **Connection** — the whole token response, one row, overwritten
 * on every authorisation — and pending authorisations, the only rows here with
 * a lifetime. Nothing else: no session, no env config, no graph state.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import config from "./config/config.ts";

/** Long enough to read a consent screen, short enough that a stray link dies. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * The token response as Notion returns it, verified live on #14. There is no
 * `expires_in` and no expiry field of any kind, so nothing here is scheduled
 * against: recovery from a `401` is re-authorisation, which is ordinary.
 */
export interface Connection {
  access_token: string;
  workspace_id: string;
  workspace_name: string | null;
  workspace_icon: string | null;
  [key: string]: unknown;
}

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(config.databasePath), { recursive: true });
  db = new DatabaseSync(config.databasePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS connection (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      token_response TEXT    NOT NULL,
      connected_at   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_authorisation (
      state      TEXT    PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

/** Records a pending authorisation against the OAuth `state` that carries it. */
export function openAuthorisation(state: string): void {
  open()
    .prepare(
      "INSERT INTO pending_authorisation (state, expires_at) VALUES (?, ?)",
    )
    .run(state, Date.now() + PENDING_TTL_MS);
}

/**
 * Spends a pending authorisation. `false` means the `state` was never issued,
 * has already been spent, or is more than ten minutes old — the callback
 * cannot tell those apart and does not need to.
 */
export function claimAuthorisation(state: string): boolean {
  const handle = open();
  handle
    .prepare("DELETE FROM pending_authorisation WHERE expires_at <= ?")
    .run(Date.now());
  return (
    handle
      .prepare("DELETE FROM pending_authorisation WHERE state = ?")
      .run(state).changes === 1
  );
}

export function saveConnection(connection: Connection): void {
  open()
    .prepare(
      `INSERT INTO connection (id, token_response, connected_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET token_response = excluded.token_response,
                                     connected_at   = excluded.connected_at`,
    )
    .run(JSON.stringify(connection), new Date().toISOString());
}

export function readConnection(): Connection | undefined {
  const row = open()
    .prepare("SELECT token_response FROM connection WHERE id = 1")
    .get() as { token_response: string } | undefined;
  return row ? (JSON.parse(row.token_response) as Connection) : undefined;
}

export function deleteConnection(): void {
  open().prepare("DELETE FROM connection").run();
}

/**
 * The runs a disconnect would strand: their bundle is in Attio and their
 * write-back can no longer be made. #50 brings the `runs` table; until it does
 * there is nothing to strand.
 */
export function runsAwaitingConfirmation(): string[] {
  const handle = open();
  const runsTable = handle
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
    )
    .get();
  if (!runsTable) return [];
  return (
    handle
      .prepare("SELECT run_id FROM runs WHERE status = 'awaiting_confirmation'")
      .all() as { run_id: string }[]
  ).map((row) => row.run_id);
}
