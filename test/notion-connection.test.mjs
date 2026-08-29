/**
 * The Notion connection, end to end through the real Express app (#49).
 *
 * Notion is faked at the network — `globalThis.fetch` is swapped for one that
 * answers `api.notion.com` from a script and delegates everything else to the
 * real one, so the app under test is the app that ships. No seam exists in
 * `src/` because a test wanted it.
 *
 * `docs/notion-oauth-connection.md` and `docs/http-contract.md` are the
 * authorities for the URLs, the payload shapes and the error shape.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const DB_PATH = join(tmpdir(), `notion2attio-${randomUUID()}.sqlite`);
const FRONTEND_ORIGIN = "http://localhost:5173";
const REDIRECT_URI = "http://localhost:3000/auth/notion/callback";

process.env.DATABASE_PATH = DB_PATH;
process.env.FRONTEND_ORIGIN = FRONTEND_ORIGIN;
process.env.NOTION_OAUTH_CLIENT_ID = "test-client-id";
process.env.NOTION_OAUTH_CLIENT_SECRET = "test-client-secret";
process.env.NOTION_OAUTH_REDIRECT_URI = REDIRECT_URI;

const { default: app } = await import("../src/app.ts");

/** The live token response, minus nothing: this is the shape #14 observed. */
const TOKEN_RESPONSE = {
  access_token: "ntn_live_token",
  token_type: "bearer",
  refresh_token: "ntn_refresh",
  bot_id: "bot-1",
  workspace_name: "Carpe Lab",
  workspace_icon: "https://example.com/icon.png",
  workspace_id: "ws-1",
  owner: {
    type: "user",
    user: { type: "person", name: "Qiuyi Hong", person: {} },
  },
  duplicated_template_id: null,
  request_id: "req-1",
};

// ── The Notion fake ────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
/** Calls Notion saw, oldest first: `{ path, method, auth, body }`. */
let notionCalls = [];
/** `{ [path]: (body) => [status, json] }`, replaced per test. */
let notionScript = {};

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== "https://api.notion.com") return realFetch(input, init);
  const body = init?.body ? JSON.parse(init.body) : undefined;
  notionCalls.push({
    path: url.pathname,
    method: init?.method,
    auth: init?.headers?.Authorization,
    version: init?.headers?.["Notion-Version"],
    body,
  });
  const reply = notionScript[url.pathname];
  assert.ok(
    reply,
    `the app called ${url.pathname}, which this test did not script`,
  );
  const [status, json] = reply(body);
  return new Response(JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

/** Consent granted, one data source shared. The ordinary case. */
function scriptHappyPath() {
  notionScript = {
    "/v1/oauth/token": () => [200, TOKEN_RESPONSE],
    "/v1/search": () => [
      200,
      { results: [{ object: "data_source", id: "ds-1" }] },
    ],
    "/v1/oauth/revoke": () => [200, { request_id: "req-2" }],
  };
}

// ── The app under test ─────────────────────────────────────────────────────

let base;
let server;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await get("/api/connection"); // one read, so the SQLite file and its tables exist
});

after(() => {
  server?.close();
  globalThis.fetch = realFetch;
  rmSync(DB_PATH, { force: true });
});

beforeEach(() => {
  notionCalls = [];
  scriptHappyPath();
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    "DELETE FROM connection; DELETE FROM pending_authorisation; DROP TABLE IF EXISTS runs;",
  );
  db.close();
});

/** Never follows the 302 — the redirect target is what is under test. */
const get = (path) => fetch(`${base}${path}`, { redirect: "manual" });

/** Starts an authorisation and returns the `state` the app minted. */
async function startAuthorisation() {
  const res = await get("/auth/notion/start");
  return new URL(res.headers.get("location")).searchParams.get("state");
}

/** The `connection` outcome on the URL the callback redirected the browser to. */
function outcomeOf(res) {
  const location = new URL(res.headers.get("location"));
  assert.equal(location.origin, FRONTEND_ORIGIN);
  return location.searchParams.get("connection");
}

function storedConnection() {
  const db = new DatabaseSync(DB_PATH);
  const row = db.prepare("SELECT token_response FROM connection").get();
  db.close();
  return row ? JSON.parse(row.token_response) : undefined;
}

// ── Starting authorisation ─────────────────────────────────────────────────

test("start writes a pending row and redirects to Notion's authorize URL", async () => {
  const res = await get("/auth/notion/start");

  assert.equal(res.status, 302);
  const url = new URL(res.headers.get("location"));
  assert.equal(
    url.origin + url.pathname,
    "https://api.notion.com/v1/oauth/authorize",
  );
  assert.equal(url.searchParams.get("client_id"), "test-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("owner"), "user");

  const db = new DatabaseSync(DB_PATH);
  const row = db
    .prepare("SELECT state, expires_at FROM pending_authorisation")
    .get();
  db.close();
  assert.equal(row.state, url.searchParams.get("state"));
  const minutesAway = (row.expires_at - Date.now()) / 60_000;
  assert.ok(
    minutesAway > 9 && minutesAway <= 10,
    `expires in ${minutesAway} minutes`,
  );
});

// ── The callback ───────────────────────────────────────────────────────────

test("the callback exchanges the code, stores the Connection and returns to the app", async () => {
  const state = await startAuthorisation();

  const res = await get(`/auth/notion/callback?code=the-code&state=${state}`);

  assert.equal(res.status, 302);
  assert.equal(outcomeOf(res), "connected");
  assert.deepEqual(storedConnection(), TOKEN_RESPONSE);

  const exchange = notionCalls.find((c) => c.path === "/v1/oauth/token");
  assert.equal(exchange.method, "POST");
  assert.equal(
    exchange.auth,
    "Basic " +
      Buffer.from("test-client-id:test-client-secret").toString("base64"),
  );
  assert.equal(exchange.version, "2026-03-11");
  assert.deepEqual(exchange.body, {
    grant_type: "authorization_code",
    code: "the-code",
    redirect_uri: REDIRECT_URI,
  });
});

test("the pending row expires on use: the same state is refused twice", async () => {
  const state = await startAuthorisation();
  await get(`/auth/notion/callback?code=the-code&state=${state}`);
  notionCalls = [];

  const res = await get(`/auth/notion/callback?code=the-code&state=${state}`);

  assert.equal(outcomeOf(res), "expired");
  assert.deepEqual(notionCalls, [], "a refused callback exchanges nothing");
});

test("a pending row older than ten minutes is refused", async () => {
  const state = await startAuthorisation();
  const db = new DatabaseSync(DB_PATH);
  db.prepare("UPDATE pending_authorisation SET expires_at = ?").run(
    Date.now() - 1,
  );
  db.close();

  const res = await get(`/auth/notion/callback?code=the-code&state=${state}`);

  assert.equal(outcomeOf(res), "expired");
  assert.equal(storedConnection(), undefined);
});

test("a callback carrying an unknown state is refused", async () => {
  const res = await get(
    "/auth/notion/callback?code=the-code&state=never-issued",
  );

  assert.equal(outcomeOf(res), "expired");
  assert.equal(storedConnection(), undefined);
});

test("cancelling out of consent stores nothing and says so", async () => {
  const state = await startAuthorisation();

  const res = await get(
    `/auth/notion/callback?error=access_denied&state=${state}`,
  );

  assert.equal(outcomeOf(res), "cancelled");
  assert.equal(storedConnection(), undefined);
  assert.deepEqual(notionCalls, []);
});

test("granting access while ticking no databases connects, and says so", async () => {
  notionScript["/v1/search"] = () => [200, { results: [] }];
  const state = await startAuthorisation();

  const res = await get(`/auth/notion/callback?code=the-code&state=${state}`);

  assert.equal(outcomeOf(res), "no_databases");
  // The grant is real — the workspace has a name to put in the banner.
  assert.equal(storedConnection().workspace_name, "Carpe Lab");
});

test("a token Notion rejects on sight is reported as expired, not as a failure", async () => {
  notionScript["/v1/search"] = () => [401, { code: "unauthorized" }];
  const state = await startAuthorisation();

  const res = await get(`/auth/notion/callback?code=the-code&state=${state}`);

  assert.equal(outcomeOf(res), "expired");
  assert.equal(
    storedConnection(),
    undefined,
    "expired means nothing was stored",
  );
});

test("a grant we cannot look into is stored nowhere", async () => {
  // The look happens before the row is written, so an unreadable answer
  // leaves the file exactly as `failed` promises: untouched.
  notionScript["/v1/search"] = () => [500, { code: "internal_server_error" }];
  const state = await startAuthorisation();

  const res = await get(`/auth/notion/callback?code=the-code&state=${state}`);

  assert.equal(outcomeOf(res), "failed");
  assert.equal(
    storedConnection(),
    undefined,
    "failed means nothing was stored",
  );
});

test("a token exchange Notion refuses reports a failure", async () => {
  notionScript["/v1/oauth/token"] = () => [400, { error: "invalid_grant" }];
  const state = await startAuthorisation();

  const res = await get(`/auth/notion/callback?code=stale&state=${state}`);

  assert.equal(outcomeOf(res), "failed");
  assert.equal(storedConnection(), undefined);
});

// ── Reading the connection ─────────────────────────────────────────────────

test("reading the connection with none reports not connected", async () => {
  const res = await get("/api/connection");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connected: false, workspace: null });
});

test("reading the connection names the workspace, and leaks no token and no id", async () => {
  const state = await startAuthorisation();
  await get(`/auth/notion/callback?code=the-code&state=${state}`);

  const res = await get("/api/connection");
  const body = await res.json();

  assert.deepEqual(body, {
    connected: true,
    workspace: { name: "Carpe Lab", icon: "https://example.com/icon.png" },
  });
  const wire = JSON.stringify(body);
  for (const secret of ["ntn_live_token", "ntn_refresh", "ws-1", "bot-1"]) {
    assert.ok(!wire.includes(secret), `the wire carries ${secret}`);
  }
});

test("the Connection survives a process restart", async () => {
  const state = await startAuthorisation();
  await get(`/auth/notion/callback?code=the-code&state=${state}`);

  const readInAFreshProcess = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import("./src/store.ts").then((s) => console.log(JSON.stringify(s.readConnection())))',
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env },
      encoding: "utf8",
    },
  );

  assert.deepEqual(JSON.parse(readInAFreshProcess), TOKEN_RESPONSE);
});

// ── Disconnecting ──────────────────────────────────────────────────────────

test("deleting the connection revokes the grant and reports nothing stranded", async () => {
  const state = await startAuthorisation();
  await get(`/auth/notion/callback?code=the-code&state=${state}`);
  notionCalls = [];

  const res = await fetch(`${base}/api/connection`, { method: "DELETE" });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { disconnected: true, strandedRuns: [] });
  const revoke = notionCalls.find((c) => c.path === "/v1/oauth/revoke");
  assert.deepEqual(revoke.body, { token: "ntn_live_token" });
  assert.equal(storedConnection(), undefined);
});

test("deleting the connection names the runs a disconnect would strand", async () => {
  const state = await startAuthorisation();
  await get(`/auth/notion/callback?code=the-code&state=${state}`);
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    "CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL)",
  );
  db.exec(
    "INSERT INTO runs (run_id, status) VALUES ('run-a', 'awaiting_confirmation'), ('run-b', 'done')",
  );
  db.close();

  const res = await fetch(`${base}/api/connection`, { method: "DELETE" });

  assert.deepEqual(await res.json(), {
    disconnected: true,
    strandedRuns: ["run-a"],
  });
});

test("deleting a connection that is not there answers not_connected", async () => {
  const res = await fetch(`${base}/api/connection`, { method: "DELETE" });

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "not_connected");
  assert.equal(typeof body.error.message, "string");
  assert.deepEqual(
    Object.keys(body),
    ["error"],
    "one error shape, nothing beside it",
  );
});

test("a grant Notion has already forgotten still disconnects", async () => {
  notionScript["/v1/oauth/revoke"] = () => [401, { code: "unauthorized" }];
  const state = await startAuthorisation();
  await get(`/auth/notion/callback?code=the-code&state=${state}`);

  const res = await fetch(`${base}/api/connection`, { method: "DELETE" });

  assert.equal(res.status, 200);
  assert.equal(storedConnection(), undefined);
});

// ── The refresh loop that must not exist ───────────────────────────────────

test("no refresh loop exists anywhere in the codebase", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  for (const path of walk(root)) {
    const source = readFileSync(path, "utf8");
    assert.ok(!/refresh_token/.test(source), `${path} reads the refresh token`);
    assert.ok(!/setInterval|setTimeout/.test(source), `${path} schedules work`);
  }
});
