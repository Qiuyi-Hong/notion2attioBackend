/**
 * The one SQLite file (#15, #49, #51).
 *
 * It holds the **Connection** — the whole token response, one row, overwritten
 * on every authorisation — pending authorisations, the only rows here with a
 * lifetime, and the **runs**: identifier, batch, created time and nothing else.
 *
 * No graph state. Everything a run knows about its own work — status,
 * candidates, flags, files — is read from the checkpoint the graph writes into
 * the same file, because a column here would be a second source of truth that
 * drifts the first time a process dies mid-run (ADR-0009).
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
    CREATE TABLE IF NOT EXISTS runs (
      run_id     TEXT PRIMARY KEY,
      batch      TEXT NOT NULL,
      created_at TEXT NOT NULL
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
 * A run, as the file records it. The identifier is a v4 UUID and it is also
 * the LangGraph `thread_id` — there is no second identifier to reconcile.
 */
export interface RunRecord {
  runId: string;
  batch: string;
  createdAt: string;
}

const toRun = (row: {
  run_id: string;
  batch: string;
  created_at: string;
}): RunRecord => ({
  runId: row.run_id,
  batch: row.batch,
  createdAt: row.created_at,
});

export function insertRun(runId: string, batch: string): RunRecord {
  const createdAt = new Date().toISOString();
  open()
    .prepare("INSERT INTO runs (run_id, batch, created_at) VALUES (?, ?, ?)")
    .run(runId, batch, createdAt);
  return { runId, batch, createdAt };
}

/**
 * `undefined` is a real lookup miss, which is what makes an unknown run id a
 * `404` rather than the empty checkpoint state #3 found it silently returns.
 */
export function readRun(runId: string): RunRecord | undefined {
  const row = open()
    .prepare("SELECT run_id, batch, created_at FROM runs WHERE run_id = ?")
    .get(runId) as Parameters<typeof toRun>[0] | undefined;
  return row && toRun(row);
}

/** Newest first. What needs a human is the index's ordering, not the file's. */
export function readRuns(): RunRecord[] {
  return (
    open()
      .prepare("SELECT run_id, batch, created_at FROM runs ORDER BY rowid DESC")
      .all() as Parameters<typeof toRun>[0][]
  ).map(toRun);
}

export function deleteRun(runId: string): void {
  open().prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
}
