/**
 * Every Notion call the app makes from a route: the OAuth legs, the search
 * that finds what the grant covers, and the read behind `GET /api/batches`.
 * The pipeline's own reads and writes belong to the graph's nodes, not here.
 *
 * Facts from `docs/notion-oauth-connection.md` and `docs/research/notion-oauth.md`:
 * Basic auth on the OAuth endpoints, `Notion-Version` required on all of them,
 * and `redirect_uri` sent on both the authorize URL and the exchange body.
 */

import config from "./config/config.ts";
import { ApiError } from "./errors.ts";
import type { Connection } from "./store.ts";

const API = "https://api.notion.com";
const VERSION = "2026-03-11";

const basicAuth = () =>
  "Basic " +
  Buffer.from(
    `${config.notion.clientId}:${config.notion.clientSecret}`,
  ).toString("base64");

/** Where the browser is sent to grant the page-by-page consent. */
export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.notion.clientId,
    redirect_uri: config.notion.redirectUri,
    response_type: "code",
    owner: "user",
    state,
  });
  return `${API}/v1/oauth/authorize?${params}`;
}

/**
 * Every Notion call below is the same POST: an Authorization header, JSON in,
 * JSON out, and the version header the OAuth endpoints require as much as the
 * resource ones. Only the auth scheme and the reading of a bad status differ,
 * so those stay with the callers.
 */
const notionPost = (authorization: string, path: string, body: unknown) =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "Notion-Version": VERSION,
    },
    body: JSON.stringify(body),
  });

export async function exchangeCode(code: string): Promise<Connection> {
  const res = await notionPost(basicAuth(), "/v1/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.notion.redirectUri,
  });
  if (!res.ok) {
    throw new ApiError(
      "notion_failed",
      502,
      `Notion refused the code (${res.status}).`,
    );
  }
  return (await res.json()) as Connection;
}

/**
 * Both read-side calls read a bad status the same way, and the contract fixes
 * both answers: a dead token is `not_connected`, because the repair is
 * authorising again; anything else Notion says is `notion_failed`.
 */
async function throwForStatus(res: Response, clause: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 401) {
    throw new ApiError(
      "not_connected",
      409,
      "The Notion connection has expired.",
      { reason: "expired" },
    );
  }
  throw new ApiError(
    "notion_failed",
    502,
    `Notion answered ${res.status} when ${clause}.`,
  );
}

/**
 * The data source the grant reaches, found by asking Notion rather than by
 * reading an id from the environment — which is what keeps the consent screen
 * load-bearing and makes *the user shared nothing* a real state. The env
 * identifiers seed the fixture; they are not request-time config.
 *
 * `undefined` is a connected workspace with nothing in it for us, not a
 * failure. This is also the first use of an issued token, so it is where a
 * token that is already dead shows up.
 *
 * ponytail: the first shared data source wins. A workspace sharing several
 * would need the picker to name the database as well as the batch.
 */
export async function findSharedDataSource(
  accessToken: string,
): Promise<string | undefined> {
  const res = await notionPost(`Bearer ${accessToken}`, "/v1/search", {
    filter: { property: "object", value: "data_source" },
    page_size: 1,
  });
  await throwForStatus(res, "asked what the grant covers");
  const body = (await res.json()) as { results?: { id?: string }[] };
  return body.results?.[0]?.id;
}

/**
 * The `Batch` of every row waiting for the CRM — the status leg of
 * `docs/notion-source-database.md`'s filter, on its own. Notion's page shape
 * stops here: the caller counts names.
 *
 * `CRM status` is a **status** property, so the filter key is `status`. Wrong
 * key, wrong type: Notion answers `validation_error`, which surfaces as
 * `notion_failed` rather than silently as zero rows.
 *
 * Notion pages the answer and the counts are the payload, so the cursor is
 * followed to the end; a truncated count would simply be wrong.
 */
export async function queryReadyBatches(
  accessToken: string,
  dataSourceId: string,
): Promise<string[]> {
  const batches: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await notionPost(
      `Bearer ${accessToken}`,
      `/v1/data_sources/${dataSourceId}/query`,
      {
        filter: { property: "CRM status", status: { equals: "Ready for CRM" } },
        page_size: 100,
        ...(cursor && { start_cursor: cursor }),
      },
    );
    await throwForStatus(res, "asked for the rows ready for the CRM");
    const body = (await res.json()) as {
      results?: { properties?: { Batch?: { select?: { name?: string } } } }[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const row of body.results ?? []) {
      // `Batch` is a select, and an unset one belongs to no run.
      const name = row.properties?.Batch?.select?.name;
      if (name) batches.push(name);
    }
    cursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return batches;
}

/**
 * Withdraws the grant at Notion. A `401` means Notion has already forgotten
 * it, which is the outcome asked for — so it is not an error here.
 */
export async function revokeToken(accessToken: string): Promise<void> {
  const res = await notionPost(basicAuth(), "/v1/oauth/revoke", {
    token: accessToken,
  });
  if (!res.ok && res.status !== 401) {
    throw new ApiError(
      "notion_failed",
      502,
      `Notion refused the revocation (${res.status}).`,
    );
  }
}
