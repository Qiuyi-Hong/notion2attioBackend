---
question: "Notion OAuth login end-to-end for a demo Node/Express + React app: how to register a public integration, run the authorization-code flow, understand token expiry/refresh, and understand consent/page-access grants."
date: 2026-08-29
api_version_documented_against: "2026-03-11"
github_issue: https://github.com/Qiuyi-Hong/notion2attioBackend/issues/4
---

# Notion OAuth login, end to end

**Notion-Version documented against: `2026-03-11`** (current latest per changelog, released 2026-03-11). Send this exact string in the `Notion-Version` header on every REST call, including the OAuth token endpoints. Source: [Create a token reference](https://developers.notion.com/reference/create-a-token) (`Notion-Version` parameter, enum `["2026-03-11"]`), [Changelog — March 11, 2026](https://developers.notion.com/page/changelog#march-11-2026).

Notion now calls what used to be "integrations" **connections** (Internal connections, Public connections, Personal access tokens). The docs use "connection" and "integration" interchangeably in places; this note uses "connection" to match current terminology. Source: [Overview](https://developers.notion.com/guides/get-started/overview).

**Recent changes relevant to this build (check before you start):**
- **2026-06-08** — "Unique access tokens per OAuth authorization": new public connections now mint a fresh `access_token` **and `refresh_token`** on every successful OAuth authorization, instead of returning the existing active token. Existing (older) connections keep prior behavior. This is when `refresh_token` support became standard for newly-created public connections. Source: [Changelog — June 8, 2026](https://developers.notion.com/page/changelog#june-8-2026).
- **2026-07-15** — OAuth token responses (the `owner.user` object) gained an `email_verified` boolean next to `person.email`. Source: [Changelog — July 15, 2026](https://developers.notion.com/page/changelog#july-15-2026).
- **2026-07-14** — "Longer-lived Notion MCP access tokens": Notion **MCP** access tokens now last ~8 hours (up from 1 hour). **This entry is specific to the Notion MCP remote server's OAuth, not the general public-integration REST API OAuth** — do not apply it to this build. Source: [Changelog — July 14, 2026](https://developers.notion.com/page/changelog#july-14-2026).
- **2026-07-02** — Personal access tokens (PATs, not OAuth) gained configurable expiration: 7/30/90/180 days or 1 year (default 1 year, was fixed at 1 year before). Not applicable to public-integration OAuth tokens. Source: [Changelog — July 2, 2026](https://developers.notion.com/page/changelog#july-2-2026); [Personal access tokens guide](https://developers.notion.com/guides/get-started/personal-access-tokens).
- API version `2026-03-11` itself (released same day) is unrelated to OAuth — it's `after`→`position`, `archived`→`in_trash`, `transcription`→`meeting_notes` breaking changes. Source: [Changelog — March 11, 2026](https://developers.notion.com/page/changelog#march-11-2026).
- Separately, since API version **2025-09-03**, databases were split into a database + one-or-more **data sources**; querying rows now goes through `/v1/data_sources/{id}/query`, not `/v1/databases/{id}/query`. See §4 gotchas — this directly affects "read a Notion database of qualified accounts."

**Companion note:** database discovery, schema reading, filter syntax per property type, pagination and rate limits live in [`notion-query-api.md`](./notion-query-api.md).

---

## 1. Registering a public integration

### Steps (Developer portal → Public connections)

Source: [Public connections guide](https://developers.notion.com/guides/get-started/public-connections#creating-a-public-connection)

1. Go to the [Developer portal](https://app.notion.com/developers/connections).
2. In the **Build** sidebar section, select **Public connections**.
3. Click **Create new connection** and fill in the required fields:
   - Connection name and development workspace
   - **Redirect URI(s)** for the OAuth flow
   - **Installation scope** — `Any workspace` (Marketplace-eligible) or `Selected workspaces only` (not Marketplace-eligible). **This choice is permanent — can't be changed after creation.**
   - **Capabilities** — read content / update content / insert content / read comments / insert comments / user-info level (see §3).
4. After creation, open the **Configuration** tab to retrieve the **OAuth client ID** and **OAuth client secret**.

Marketplace listing (public/logo/description/category) is a **separate, optional** step handled under **Listings**, not required to use the connection. Source: [Public connections guide](https://developers.notion.com/guides/get-started/public-connections).

**Fields the primary docs do NOT enumerate:** company name, website, support email, privacy-policy URL, terms-of-use URL, icon. The current "Public connections" and "Preparing for users" guides do not list these as creation-time fields — the docs only describe them at the **Marketplace listing** step (name, description, category/tags, images/logo — see [Marketplace listing guide](https://developers.notion.com/guides/get-started/marketplace-listing#start-a-new-listing)), not at connection-creation time. If Notion's live Developer portal UI shows extra optional fields (e.g., a privacy-policy link) at connection-creation time that aren't in the docs, treat that as UI-only and not independently confirmed here — see "Open / unverified" below.

### Does it work immediately, or is there a review step?

**No review is required to create and use a public connection's OAuth flow.** Review is only required to get **listed on the Notion Marketplace** (a discoverability feature), which is optional:

> "Public connections must undergo a Notion security review before being listed on the Marketplace. You can create and use a public connection without listing it." — [Overview](https://developers.notion.com/guides/get-started/overview)

> "Do I need to list my public connection on the Marketplace? No. Public connections work independently of Marketplace listings... your connection can be used via its OAuth flow without being listed." — [Marketplace listing guide FAQ](https://developers.notion.com/guides/get-started/marketplace-listing#frequently-asked-questions)

Marketplace review timeline (only relevant if you choose to list): "expect to hear back... within 5-10 business days via email." Same source.

**Minor doc inconsistency to note:** the Authorization guide has a screenshot captioned "The Authorization URL field populates after a public connection is submitted for review" ([Authorization guide, Step 1](https://developers.notion.com/guides/get-started/authorization#step-1-navigate-the-user-to-the-connection%E2%80%99s-authorization-url)) — this reads as if the Authorization URL itself needs a review before it's usable, which contradicts the explicit Overview/FAQ statements above that OAuth works without any review. This looks like a stale image caption from an older UI. Treat the explicit Overview/FAQ text as authoritative; flagged under Open/unverified.

### Redirect URI: is `http://localhost:PORT/...` allowed?

**Not stated explicitly in the primary docs.** Neither [Public connections](https://developers.notion.com/guides/get-started/public-connections) nor [Authorization](https://developers.notion.com/guides/get-started/authorization) nor [Create a token](https://developers.notion.com/reference/create-a-token) states a scheme restriction (HTTPS-only) or explicitly allows `http://localhost`. The docs only say the redirect URI field is required, must be configured under "OAuth Domain & URIs" in the connection's settings, must match what you send in the authorize URL/token exchange, and link out to a generic third-party explainer of redirect URIs (https://www.oauth.com/oauth2-servers/redirect-uris/) rather than Notion-specific rules.

This is genuinely unverified against primary sources — see "Open / unverified" below for the practical recommendation.

### Internal integration, for contrast (two lines)

An **internal connection** is scoped to one workspace, authenticates with a single static "installation access token" you copy from the Configuration tab (no OAuth, no page picker), and only works once a workspace member manually shares each page/database with it via the page's "Add connections" menu. Source: [Internal connections](https://developers.notion.com/guides/get-started/internal-connections) / [Authorization guide, Internal connection auth flow set-up](https://developers.notion.com/guides/get-started/authorization#internal-connection-auth-flow-set-up).

---

## 2. The authorization code flow, end to end

Primary source for this whole section: [Authorization guide — Public connection auth flow set-up](https://developers.notion.com/guides/get-started/authorization#public-connection-auth-flow-set-up) and [Create a token reference](https://developers.notion.com/reference/create-a-token).

### 2.1 Authorize URL

```
https://api.notion.com/v1/oauth/authorize
```

| Parameter | Required | Allowed values |
|---|---|---|
| `client_id` | ✅ | Your connection's client ID (Configuration tab) |
| `redirect_uri` | ✅ | URL the user returns to after granting access; must match a URI configured in the connection's OAuth settings |
| `response_type` | ✅ | Always `code` |
| `owner` | ✅ | Always `user` |
| `state` | optional | Opaque string for CSRF protection / restoring client state |

No `scope` parameter — access breadth is controlled by capabilities (configured in the portal, not the URL) plus the page picker (see §3), not by an OAuth `scope` query param.

Documented example:
```
https://api.notion.com/v1/oauth/authorize?owner=user&client_id=463558a3-725e-4f37-b6d3-0889894f68de&redirect_uri=https%3A%2F%2Fexample.com%2Fauth%2Fnotion%2Fcallback&response_type=code
```

On approval, redirect includes `code` (required) and `state` (echoed back). On denial: `?error=access_denied&state=...`. Notion uses the standard OAuth error codes from [RFC 6749 §4.1.2.1](https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.2.1).

### 2.2 Token exchange

- **Method / URL:** `POST https://api.notion.com/v1/oauth/token`
- **Auth:** HTTP Basic — `Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)`
- **Headers:** `Content-Type: application/json`, `Notion-Version: 2026-03-11` (required — it's a required OpenAPI parameter on this endpoint, not optional). Source: [Create a token OpenAPI spec](https://developers.notion.com/reference/create-a-token) (`notionVersion` parameter, `required: true`).
- **Body (authorization_code grant):**

```json
{
  "grant_type": "authorization_code",
  "code": "e202e8c9-0990-40af-855f-ff8f872b1ec6",
  "redirect_uri": "https://example.com/auth/notion/callback"
}
```

`redirect_uri` in the body: **required** if you passed `redirect_uri` as a query param on the authorize URL, or if the connection has more than one configured redirect URI; **not allowed** in the body only if the connection has exactly one configured redirect URI and you omitted it from the authorize URL. Source: [Create a token reference, Warning block](https://developers.notion.com/reference/create-a-token) and [Authorization guide, Step 3 table](https://developers.notion.com/guides/get-started/authorization#step-3-send-the-code-in-a-post-request-to-the-notion-api). Given the ambiguity, simplest safe approach for a demo: always send `redirect_uri` in both the authorize URL and the token-exchange body.

curl, exactly as documented:

```http
POST /v1/oauth/token HTTP/1.1
Authorization: Basic "$CLIENT_ID:$CLIENT_SECRET"
Content-Type: application/json

{"grant_type":"authorization_code","code":"e202e8c9-0990-40af-855f-ff8f872b1ec6", "redirect_uri":"https://example.com/auth/notion/callback"}
```

(Note the `Authorization` header line as printed in the docs literally includes quote marks around `$CLIENT_ID:$CLIENT_SECRET` — in real code, base64-encode `CLIENT_ID:CLIENT_SECRET` yourself and put the base64 string after `Basic `, do not send the literal placeholder text.)

Node/fetch, from the docs' own example:

```javascript
const clientId = process.env.OAUTH_CLIENT_ID;
const clientSecret = process.env.OAUTH_CLIENT_SECRET;
const redirectUri = process.env.OAUTH_REDIRECT_URI;

const encoded = btoa(`${clientId}:${clientSecret}`); // Node 18+: Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

const response = await fetch("https://api.notion.com/v1/oauth/token", {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Basic ${encoded}`,
    "Notion-Version": "2026-03-11",
  },
  body: JSON.stringify({
    grant_type: "authorization_code",
    code: "your-temporary-code",
    redirect_uri: redirectUri,
  }),
});
```

Or with the official SDK:

```javascript
import { Client } from "@notionhq/client";
const notion = new Client();
const response = await notion.oauth.token({
  client_id: process.env.OAUTH_CLIENT_ID,
  client_secret: process.env.OAUTH_CLIENT_SECRET,
  grant_type: "authorization_code",
  code: "abc123-authorization-code",
  redirect_uri: "https://example.com/callback",
});
```
Source: [Create a token reference, x-codeSamples](https://developers.notion.com/reference/create-a-token).

### 2.3 Token response — exact JSON shape

Source: [Create a token reference OpenAPI schema](https://developers.notion.com/reference/create-a-token) and [Authorization guide, Step 4 table](https://developers.notion.com/guides/get-started/authorization#step-4-notion-responds-with-an-access_token--refresh_token-and-additional-information).

| Field | Type | Meaning | Nullable / always present |
|---|---|---|---|
| `access_token` | string | Bearer token to authorize Notion API requests | Always present |
| `token_type` | string | Always `"bearer"` | Always present |
| `refresh_token` | string \| null | Token used to mint a new `access_token` via the `refresh_token` grant | Present as a key; value can be `null` per schema, though the Authorization guide's prose table marks it "not null" — treat as present-but-verify-not-null in code |
| `bot_id` | string (uuid) | Identifier for this specific authorization (the "bot" representing this connection+user pairing) | Always present |
| `workspace_id` | string (uuid) | Workspace the authorization took place in | Always present |
| `workspace_name` | string \| null | Human-readable workspace name for UI display | Present as key; can be null |
| `workspace_icon` | string \| null | URL to workspace icon image | Present as key; can be null |
| `owner` | object | Either `{ "type": "user", "user": <User object> }` (a Person or partial user) or `{ "type": "workspace", "workspace": true }` (legacy workspace-level tokens — see historical note below) | Always present |
| `duplicated_template_id` | string (uuid) \| null | ID of the new page created by duplicating your optional template; `null` if no template was configured/used | Present as key; null if n/a |
| `request_id` | string (uuid) | Notion's internal request id, useful for support | Always present (OpenAPI schema) |

Example request/response pattern quoted directly from the Authorization guide narrative (field list, not a single literal JSON blob in the docs, but this is the exact assembled shape per the reference OpenAPI schema):

```json
{
  "access_token": "9bdb2200-c204-4674-8c03-98111ba6f2ba",
  "token_type": "bearer",
  "refresh_token": "nrt_4991090011501Ejc6Xn4sHguI7jZIN449mKe9PRhpMfNK",
  "bot_id": "1f4a4e4a-8a4a-4a4a-8a4a-4a4a4a4a4a4a",
  "workspace_name": "Ada's Workspace",
  "workspace_icon": "https://website.domain/images/image.png",
  "workspace_id": "a5cd917a-a3d7-4a41-b9c5-c9d1b0c5c7e5",
  "owner": {
    "type": "user",
    "user": {
      "object": "user",
      "id": "d40e767c-d7af-4b18-a86d-55c61f1e39a4",
      "name": "Ada Lovelace",
      "avatar_url": "https://secure.notion-static.com/e6a352a8-8381-44d0-a1dc-9ed80e62b53d.jpg",
      "type": "person",
      "person": {
        "email": "ada@example.org",
        "email_verified": true
      }
    }
  },
  "duplicated_template_id": null,
  "request_id": "b6a9e5b0-4f1e-4c2a-9a1a-4a4a4a4a4a4a"
}
```
(Assembled from the documented field table + `owner`/User object schema; the token values are illustrative examples that appear individually in the docs' code samples — e.g. `refresh_token` value taken verbatim from [Authorization guide, Step 6 example](https://developers.notion.com/guides/get-started/authorization#step-6-refreshing-an-access-token) — not a single copy-pasted response block from one page.)

Historical note on `owner`: prior to a 2021-era migration, Notion issued **workspace-level** tokens (`owner: { workspace: true }`), one token shared per workspace. Public integrations now default to **user-level** tokens (`owner: { type: "user", user: {...} }`), one token per user who authorizes. Source: [Historical changelog — "Workspace-level tokens for public integrations will be deprecated soon"](https://developers.notion.com/guides/resources/historical-changelog). For a new integration built today you'll get user-level tokens by default.

### 2.4 Do access tokens expire? Is there a refresh token?

**Yes, there is a `refresh_token`, but the primary docs do not state that the general public-API `access_token` has a fixed expiration/TTL.** Specifically:

- The [Authorization guide](https://developers.notion.com/guides/get-started/authorization#step-4-notion-responds-with-an-access_token--refresh_token-and-additional-information) and [Create a token reference](https://developers.notion.com/reference/create-a-token) both document `refresh_token` as a normal field on the token response and describe a dedicated [Refresh a token](https://developers.notion.com/reference/refresh-a-token) endpoint (`grant_type: refresh_token`), but neither page states an `access_token` lifetime, an `expires_in` field, or any expiry timestamp for the general public-integration OAuth flow.
- The [Introspect a token](https://developers.notion.com/reference/introspect-token) endpoint's response schema is `{ active: boolean, scope: string, iat: integer, request_id: uuid }` — it returns `iat` (issued-at) but **no `exp` (expiration) field**, which is consistent with there being no fixed expiry to report.
- `refresh_token` support (a fresh token pair minted per authorization) is a **recently-introduced** behavior as of 2026-06-08 (see top of this doc), and the docs frame it as being about getting a **new token pair on each re-authorization**, not about a short-lived access token that must be refreshed periodically on a timer.
- The only tokens in the docs with a stated, fixed expiration are: **Personal access tokens** (7/30/90/180 days or 1 year, configurable, default 1 year — [Personal access tokens](https://developers.notion.com/guides/get-started/personal-access-tokens#creating-a-personal-access-token)) and **Notion MCP** OAuth access tokens (~8 hours as of 2026-07-14 — MCP-specific, not the general public-integration REST API — [Changelog, July 14 2026](https://developers.notion.com/page/changelog#july-14-2026)).

**Bottom line for this build:** treat the public-connection `access_token` as long-lived / not expiring on a fixed schedule per the current primary docs. Store `refresh_token` anyway (the docs explicitly instruct you to — "Store all of the information that your connection receives with the access_token and refresh_token... It's really hard (or impossible) to send users to repeat the authorization flow to generate the information again" — [Authorization guide, Step 5](https://developers.notion.com/guides/get-started/authorization#step-5-the-connection-stores-the-access_token-and-refresh_token-for-future-requests)), and be ready to call the refresh endpoint if you ever get an `invalid_grant`/`unauthorized_client`-type 401/400 from a REST call using an old token, but don't build a proactive timed-refresh loop — the docs give no TTL to schedule against. Revalidate this if you hit unexpected 401s in testing (see Open/unverified).

### 2.5 Refresh flow

- Same endpoint/method/auth as the token exchange: `POST https://api.notion.com/v1/oauth/token`, HTTP Basic with `CLIENT_ID:CLIENT_SECRET`, `Notion-Version: 2026-03-11`.
- Body:
```json
{"grant_type":"refresh_token","refresh_token":"nrt_4991090011501Ejc6Xn4sHguI7jZIN449mKe9PRhpMfNK"}
```
- "Refreshing an access token will generate a new access token **and a new refresh token**." Store both again — the old refresh token is implicitly rotated out. Source: [Authorization guide, Step 6](https://developers.notion.com/guides/get-started/authorization#step-6-refreshing-an-access-token).

Node/fetch:
```javascript
const encoded = btoa(`${clientId}:${clientSecret}`);
const response = await fetch("https://api.notion.com/v1/oauth/token", {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Basic ${encoded}`,
    "Notion-Version": "2026-03-11",
  },
  body: JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: storedRefreshToken,
  }),
});
```

### 2.6 Other OAuth token-lifecycle endpoints

- **Revoke a token** — `POST https://api.notion.com/v1/oauth/revoke`, Basic auth, body `{ "token": "<access_token>" }`, `Notion-Version` required, returns `{ request_id }` on 200. Source: [Revoke a token reference](https://developers.notion.com/reference/revoke-token).
- **Introspect a token** — `POST https://api.notion.com/v1/oauth/introspect`, Basic auth, body `{ "token": "<token>" }`, `Notion-Version` required, returns `{ active: boolean, scope?: string, iat?: integer, request_id: uuid }`. Source: [Introspect a token reference](https://developers.notion.com/reference/introspect-token).

### 2.7 Documented error responses (token exchange, refresh, revoke, introspect — same schema family)

Source: [Create a token OpenAPI error schemas](https://developers.notion.com/reference/create-a-token).

| HTTP status | `code` value(s) |
|---|---|
| 400 | `invalid_request`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope` |
| 401 | `invalid_client` |
| 403 | `test_env_error` |
| 500 | `internal_server_error` |

Common error body shape: `{ "object": "error", "message": "...", "additional_data"?: {...} }`. Authorization-URL-level denial/errors instead use the standard [OAuth spec error codes, RFC 6749 §4.1.2.1](https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.2.1) as a redirect query param (`?error=access_denied`, etc.) — [Authorization guide](https://developers.notion.com/guides/get-started/authorization#step-1-navigate-the-user-to-the-connection%E2%80%99s-authorization-url).

---

## 3. Consent and access grants

Source: [Authorization guide — Step 1](https://developers.notion.com/guides/get-started/authorization#step-1-navigate-the-user-to-the-connection%E2%80%99s-authorization-url), [Public connections guide](https://developers.notion.com/guides/get-started/public-connections#how-users-authorize-a-public-connection), [Capabilities reference](https://developers.notion.com/reference/capabilities).

### What the user sees

1. **Capabilities prompt** — a screen describing what the connection would be able to do in the workspace (read/update/insert content, read/insert comments, and what level of user info it can see), derived from the capabilities you configured for the connection in the Developer portal. The user can only **Select pages** (proceed) or **Cancel**.
2. **Page picker** — if the user proceeds, a search/browse UI where they choose which pages and/or databases to share with the connection. "The page picker only displays pages or databases to which a user has full access, because a user needs full access to a resource in order to be able to share it with a connection." Selecting a parent page grants access to all its child pages automatically. Users can select both private and public pages they have full access to.
3. **Optional template step** — if the developer configured a "Notion URL for optional template," the user is first shown the capabilities prompt with a "Next" button, then chooses between (a) duplicating the developer-provided template into their workspace (auto-shares the new page) or (b) going to the standard page picker instead.
4. On `Allow access`, redirect to `redirect_uri?code=...`. On `Cancel`, redirect to `redirect_uri?error=access_denied&state=...`.

There is **no "select whole workspace" option** in the standard flow described in the docs — access is granted per selected page/database (with children inherited), not as a workspace-wide grant, for the standard (non-template) prompt.

### Does page selection constrain subsequent API access?

**Yes.** The connection can only read/write pages, databases, and their children that were explicitly shared during the page picker (or later via the page's "Add connections" menu, or via template duplication). This is a hard access boundary enforced server-side, not merely a UI convenience — Notion API calls against unshared content return errors, matching the internal-connection behavior described for "Never share your installation access token" style page-scoping. Source: [Authorization guide — page picker note](https://developers.notion.com/guides/get-started/authorization#prompt-for-a-standard-connection-with-no-template-option-default); [Overview comparison table, "Content access" row](https://developers.notion.com/guides/get-started/overview#comparison): "Users choose which pages to share during the OAuth flow or via the Add connections menu." Also: "If a connection is added to a page, then the connection can access the page's children" — [Capabilities reference](https://developers.notion.com/reference/capabilities).

So for this build: after OAuth, you can only see the specific database(s)/page(s) the user ticked in the page picker (or their parents' shares), **not** everything in the workspace, regardless of what capabilities you requested.

### Can the user change the selection later? What happens to already-issued tokens?

- "Users can return to this view at a later time to update access settings if circumstances change." Source: [Authorization guide, Step 1](https://developers.notion.com/guides/get-started/authorization#prompt-for-a-standard-connection-with-no-template-option-default).
- Re-running the authorize URL re-triggers the page picker, remembering prior shares and letting the user add/remove pages: "the user who initially authorized an integration can reauthorize by going through OAuth a second time. The page picker step will remember which pages have already been shared with the integration... and let users share or un-share additional pages. Other OAuth behavior has not changed: only... the original person originally added an integration via OAuth can go through the flow again." Historically (pre current docs) reauthorization returned the **same** access token; current docs (post 2026-06-08 change) say new public connections **mint a fresh token pair on every successful authorization, including re-authorizations** — so for connections created after that date, expect a **new** `access_token`/`refresh_token` each time the user re-runs OAuth, and you must overwrite your stored pair. Sources: [Historical changelog — "OAuth improvements"](https://developers.notion.com/guides/resources/historical-changelog); [Changelog — June 8, 2026](https://developers.notion.com/page/changelog#june-8-2026); [Authorization guide, Step 5](https://developers.notion.com/guides/get-started/authorization#step-5-the-connection-stores-the-access_token-and-refresh_token-for-future-requests).
- Also relevant: capability changes force re-auth. "For public connections, users will need to re-authenticate with a connection if the capabilities are changed in the time since the user last authenticated with the connection." Source: [Capabilities reference](https://developers.notion.com/reference/capabilities#capability-behaviors-and-best-practices).

### Capabilities: what they are, where configured, and consent-screen visibility

Source: [Capabilities reference](https://developers.notion.com/reference/capabilities).

- **Content capabilities:** Read content / Update content / Insert content (any combination). "Insert content... does not give the connection access to read full objects."
- **Comment capabilities:** Read comments / Insert comments.
- **User capabilities (one of):** No user information / User information without email addresses / User information with email addresses.
- Configured in the **Developer portal** at connection-creation/edit time (for PATs, chosen at token-creation time). They directly gate which API endpoints succeed (e.g., read-only capability can call Retrieve a database but not Update a database) and what fields appear in API responses (e.g., user objects omit email unless the email-info capability is granted).
- They **do** surface to the end user: the capabilities prompt at the start of the OAuth flow is explicitly "presented to the user as what the connection would like to be able to do in the workspace" — this is the primary place capabilities are shown in consent UI. Source: [Authorization guide](https://developers.notion.com/guides/get-started/authorization#prompt-for-a-standard-connection-with-no-template-option-default).
- Best practice per the docs: request the minimum needed — "If your connection is reading data to export it out of Notion, your connection will only need **Read content** capabilities." (Matches this build's CSV-export use case exactly — request Read content, and User information without/with email only if you actually need the account owner's email in the export.)

---

## 4. Gotchas for a developer building this

1. **Send `Notion-Version: 2026-03-11` on every request**, including `/v1/oauth/token`, `/v1/oauth/revoke`, `/v1/oauth/introspect` — it's a required parameter on the OAuth endpoints, not just REST resource endpoints. Source: [Create a token reference](https://developers.notion.com/reference/create-a-token).
2. **Basic-auth encoding**: `Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)` — don't confuse with the `Bearer` scheme used for subsequent resource API calls with the `access_token`.
3. **`redirect_uri` in the token-exchange body** is conditionally required (see §2.2) — safest to always include it and always include it in the authorize URL too, to sidestep the "not allowed if you have exactly one URI and omitted it from the authorize URL" edge case.
4. **Databases → data sources split (API version ≥ 2025-09-03, in force under 2026-03-11):** a "database" object no longer directly holds rows; each database has one or more **data sources**, and querying/reading rows requires `data_source_id`, via `POST /v1/data_sources/{data_source_id}/query` (not `/v1/databases/{id}/query`, which is deprecated as of 2025-09-03). Retrieve the data source id first (e.g. from `database.data_sources[0].id` after retrieving/creating the database, or from Search results). This is highly relevant to "reads a Notion database of qualified accounts" — plan the CSV-export code around `data_sources`, not the legacy database-query endpoint. Sources: [Upgrade guide 2025-09-03](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03), [Query a data source reference](https://developers.notion.com/reference/query-a-data-source), [Retrieve a database reference — deprecation note](https://developers.notion.com/reference/retrieve-a-database).
5. **Query pagination cap:** a single data-source query returns at most **10,000 results**; beyond that, `has_more` is `false` but `request_status.type === "incomplete"` signals a capped result — check for this if the "qualified accounts" database could be large. Source: [Query a data source reference](https://developers.notion.com/reference/query-a-data-source#pagination).
6. **Store the full token response, not just `access_token`** — `bot_id`, `workspace_id`, `owner`, `refresh_token` are all needed for later token lifecycle management and cannot be re-derived without repeating the OAuth flow. Source: [Authorization guide, Step 5](https://developers.notion.com/guides/get-started/authorization#step-5-the-connection-stores-the-access_token-and-refresh_token-for-future-requests).
7. **Re-authorization may issue a brand-new token pair** (post 2026-06-08 behavior for newly-created connections) — don't assume idempotent tokens across repeated OAuth runs; always overwrite stored tokens on every successful exchange.
8. **Installation scope is permanent** — picking "Selected workspaces only" for local dev testing means you cannot later flip to "Any workspace" / Marketplace-eligible on the same connection; you'd need a new connection. Source: [Public connections guide](https://developers.notion.com/guides/get-started/public-connections#installation-scope).
9. **Capability changes force re-auth** for already-authorized users — if you tweak capabilities after users have connected, they'll need to redo the OAuth flow. Source: [Capabilities reference](https://developers.notion.com/reference/capabilities#capability-behaviors-and-best-practices).
10. **One access token per user, not per workspace** — if multiple people in the same workspace need the export tool, each must individually complete OAuth; there's no single workspace-wide token for a public connection. Source: [Public connections guide](https://developers.notion.com/guides/get-started/public-connections#how-users-authorize-a-public-connection).
11. Prefer **connection webhooks** over polling if you ever need to keep the exported CSV in sync — not essential for a one-shot demo export, but documented as the recommended pattern for anything beyond a single read. Source: [Query a data source reference](https://developers.notion.com/reference/query-a-data-source#pagination).

---

## Open / unverified

- **`http://localhost:PORT/...` as a redirect URI for a public connection**: the primary Notion docs consulted (Public connections, Authorization guide, Create a token reference) do not state a scheme/host restriction one way or the other. No HTTPS-only requirement is documented, but none is ruled out either. **Recommendation for this demo:** just try registering `http://localhost:3000/oauth/callback` (or your actual port) directly in the Developer portal's "OAuth Domain & URIs" field first — third-party integration guides (Better Auth, Supabase — not Notion primary sources, so not cited as authoritative here) describe using exactly this pattern for local development, suggesting it's commonly accepted in practice, but this could not be confirmed against developers.notion.com or notion.com/help. If the portal rejects a bare `http://localhost` URI, the fallback is a local HTTPS tunnel (e.g., ngrok, Cloudflare Tunnel) pointed at your local server, registered as the redirect URI — a standard OAuth workaround, not something Notion's docs mention specifically. Verify directly in the Developer portal UI before building around either assumption.
- **Exact required fields at public-connection creation time** beyond name/redirect URI(s)/installation scope/capabilities (e.g., whether the live Developer portal UI asks for a privacy-policy URL, terms-of-use URL, icon, or support contact at creation time rather than only at Marketplace-listing time) — not enumerated in the docs pages fetched. Confirm directly in the Developer portal when creating the connection.
- **Whether `access_token` truly never expires**, or whether there's an undocumented soft expiry/rotation policy Notion enforces server-side without publishing a TTL — the docs are silent rather than explicit ("does not expire") on this point for the general public-integration OAuth flow (contrast with PATs and MCP tokens, which do have documented, explicit expirations). Treated here as "no fixed expiry per current docs," but this is an absence-of-statement inference, not a documented guarantee. If the demo app runs long enough to matter, implement the refresh-on-401 fallback described in §2.4 regardless.
- **The "submitted for review" screenshot caption** in the Authorization guide (§1) appears to conflict with the explicit no-review-needed statements elsewhere in the same docs; treated as a stale caption, not verified further.
- **`refresh_token`'s `null` possibility**: the OpenAPI schema on [Create a token](https://developers.notion.com/reference/create-a-token) types `refresh_token` as `string | null`, while the Authorization guide's prose table marks it "not null" (always present) — inconsistency not resolved against a live API call; code should defensively check for null/undefined before relying on it.
