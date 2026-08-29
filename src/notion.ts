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
 * The one status either read cares about. `docs/notion-source-database.md`'s
 * filter is asymmetric: `CRM status` is a **status** property, so its filter
 * key is `status`, while `Batch` is a **select**. Wrong key, wrong type:
 * Notion answers `validation_error`, which surfaces as `notion_failed` rather
 * than silently as zero rows.
 */
const READY_FOR_CRM = "Ready for CRM";

/** The shape Notion answers a query in. It goes no further than this module. */
interface NotionText {
  plain_text?: string;
}

interface NotionProperty {
  title?: NotionText[];
  rich_text?: NotionText[];
  url?: string | null;
  email?: string | null;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  date?: { start?: string } | null;
}

interface NotionPage {
  properties?: Record<string, NotionProperty | undefined>;
}

/**
 * A query filter, with the asymmetry spelled out: a leg names the property's
 * *type* as its key, and Notion rejects one that does not match. Saying so here
 * makes a wrong key a compile error rather than a `validation_error` at
 * runtime.
 */
type NotionFilter =
  | { property: string; status: { equals: string } }
  | { property: string; select: { equals: string } }
  | { and: NotionFilter[] };

/** One row of the Notion export: its property names against plain values. */
export type SourceRow = Record<string, string | null>;

/**
 * A `data_sources/{id}/query`, followed to the end. Notion pages the answer and
 * both callers read all of it — a count that stopped at a hundred, or a batch
 * missing its last rows, would simply be wrong.
 */
async function* queryPages(
  accessToken: string,
  dataSourceId: string,
  filter: NotionFilter,
  clause: string,
): AsyncGenerator<NotionPage> {
  let cursor: string | undefined;
  do {
    const res = await notionPost(
      `Bearer ${accessToken}`,
      `/v1/data_sources/${dataSourceId}/query`,
      { filter, page_size: 100, ...(cursor && { start_cursor: cursor }) },
    );
    await throwForStatus(res, clause);
    const body = (await res.json()) as {
      results?: NotionPage[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    yield* body.results ?? [];
    cursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
  } while (cursor);
}

/** Whatever the property holds, as the text a person reads in Notion. */
function plainValue(property: NotionProperty | undefined): string | null {
  if (!property) return null;
  const rich = property.title ?? property.rich_text;
  if (rich) return rich.map((piece) => piece.plain_text ?? "").join("") || null;
  return (
    property.url ??
    property.email ??
    property.select?.name ??
    property.status?.name ??
    property.date?.start ??
    null
  );
}

/**
 * The `Batch` of every row waiting for the CRM — the status leg of the filter,
 * on its own. Notion's page shape stops here: the caller counts names.
 */
export async function queryReadyBatches(
  accessToken: string,
  dataSourceId: string,
): Promise<string[]> {
  const batches: string[] = [];
  for await (const page of queryPages(
    accessToken,
    dataSourceId,
    { property: "CRM status", status: { equals: READY_FOR_CRM } },
    "asked for the rows ready for the CRM",
  )) {
    // `Batch` is a select, and an unset one belongs to no run.
    const name = page.properties?.Batch?.select?.name;
    if (name) batches.push(name);
  }
  return batches;
}

/**
 * The rows one run works on: both legs of the extraction filter this time.
 * A source row leaves here as its property names against plain values — the
 * pipeline's input, and the last place Notion's page shape is visible.
 */
export async function queryBatchRows(
  accessToken: string,
  dataSourceId: string,
  batch: string,
): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const page of queryPages(
    accessToken,
    dataSourceId,
    {
      and: [
        { property: "CRM status", status: { equals: READY_FOR_CRM } },
        { property: "Batch", select: { equals: batch } },
      ],
    },
    `asked for the rows in ${batch}`,
  )) {
    rows.push(
      Object.fromEntries(
        Object.entries(page.properties ?? {}).map(([name, property]) => [
          name,
          plainValue(property),
        ]),
      ),
    );
  }
  return rows;
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
