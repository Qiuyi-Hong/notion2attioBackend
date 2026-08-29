/**
 * The Notion calls the connection itself needs. Everything the pipeline reads
 * and writes lands elsewhere; this file is the OAuth legs and one look at what
 * the grant actually covers.
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
 * Whether the grant reaches any database at all. Notion's picker insists on at
 * least one page, but the user can pick pages holding nothing we can read —
 * which is a connected workspace with no batch in it, not a failure.
 *
 * This is the first use of the issued token, so it is also where a token that
 * is already dead shows up: a `401` is `not_connected`, and the repair is
 * authorising again.
 */
export async function grantsAnyDataSource(
  accessToken: string,
): Promise<boolean> {
  const res = await notionPost(`Bearer ${accessToken}`, "/v1/search", {
    filter: { property: "object", value: "data_source" },
    page_size: 1,
  });
  if (res.status === 401) {
    throw new ApiError(
      "not_connected",
      409,
      "The Notion connection has expired.",
      { reason: "expired" },
    );
  }
  if (!res.ok) {
    throw new ApiError(
      "notion_failed",
      502,
      `Notion answered ${res.status} when asked what the grant covers.`,
    );
  }
  const body = (await res.json()) as { results?: unknown[] };
  return (body.results ?? []).length > 0;
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
