---
question: >
  How do we (1) discover Notion databases visible to an OAuth integration,
  (2) read a database's schema to build a real filter UI, (3) query rows
  filtered by CRM status = "Ready for CRM" AND Batch = "2026-W34" when the
  property types of those two columns are unknown, and (4) paginate all
  matching rows — against the current Notion API, including the
  databases-vs-data-sources breaking change?
date: 2026-08-29
api_version_documented_against: "2026-03-11 (current); 2025-09-03 is the version that introduced the data-source model and is still the default in Notion's official SDKs"
github_issue: https://github.com/Qiuyi-Hong/notion2attioBackend/issues/4
---

# Notion Query API Research: Databases, Data Sources, Schema, Filters, Pagination

## API version documented against

- **Current `Notion-Version` header value: `2026-03-11`.** Source: [Versioning](https://developers.notion.com/reference/versioning).
- The **data-source split** (databases vs. data sources) was introduced in version **`2025-09-03`** and is unchanged by `2026-03-11`. Notion's own SDKs still default to `2025-09-03` and additionally support `2026-03-11`. Source: web search of Notion SDK release notes referencing `developers.notion.com/reference/versioning`; primary confirmation of the `2025-09-03` split from [Upgrade guide: 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03) and the [Changelog](https://developers.notion.com/page/changelog).
- **`2026-03-11` breaking changes** (unrelated to the data-source model, but worth knowing): `archived` replaced by `in_trash`, `transcription` renamed to `meeting_notes`, and [Append block children](https://developers.notion.com/reference/patch-block-children) now takes a `position` object instead of a flat `after` parameter. Source: [Changelog](https://developers.notion.com/page/changelog).
- **Recommendation for this project:** pin `Notion-Version: 2025-09-03` (the SDK default, and the version this whole document assumes for the data-source model) unless you specifically need a `2026-03-11`-only feature (e.g. `in_trash`, block `position`). Everything about data sources, search, and filters below is identical between `2025-09-03` and `2026-03-11`.

> **Version reconciliation with the companion OAuth note.** The companion note [`notion-oauth.md`](./notion-oauth.md) documents against `2026-03-11`; this note recommends `2025-09-03`. Both are correct and the difference is not load-bearing: the data-source model, search, schema, filter and pagination contracts described here are **identical** across the two versions, and the OAuth endpoints accept either. Pick one and send it on every request — `2025-09-03` if you use the official `@notionhq/client` SDK unmodified (its default), `2026-03-11` if you hand-roll `fetch`. If you go with `2026-03-11`, remember page objects use `in_trash`, not `archived`.

**Companion note:** OAuth registration, the authorization-code flow, tokens and consent live in [`notion-oauth.md`](./notion-oauth.md).

---

## 1. Current data model and the breaking change

### Database vs. data source

- Starting in `2025-09-03`, "a single database [can] contain multiple linked data sources." A **database** is now a *container* (holds title, icon, cover, permissions, and a list of data sources); a **data source** is the thing that actually has a **schema** (`properties`) and **rows** (pages). Before this version, database and data source were 1:1 and the distinction didn't exist in the API. Source: [Upgrade guide: 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03).
- Practical effect for anyone who called `POST /v1/databases/{id}/query`: that endpoint's *behavior* changed with the version header. On `2025-09-03`+, database-scoped query/schema operations move to a `data_source_id`-scoped set of endpoints (below). The docs are explicit that **using `Notion-Version: 2022-06-28` (or earlier) against a database that has been split into multiple data sources will fail** for page creation, database read/write/query, and relation-property updates. Source: [Upgrade guide: 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03).
- `GET /v1/databases/{database_id}` still exists but was **repurposed**: it now returns database-level metadata plus a `data_sources: [{id, name}, ...]` array, and **no longer returns the `properties` schema**. Source: [Retrieve a database](https://developers.notion.com/reference/retrieve-a-database).

### Endpoint map: old → current

| Purpose | Deprecated / pre-2025-09-03 endpoint | Current endpoint (2025-09-03+) |
|---|---|---|
| Query rows with filters | `PATCH /v1/databases/{database_id}/query` | `POST /v1/data_sources/{data_source_id}/query` — [Query a data source](https://developers.notion.com/reference/query-a-data-source) |
| Get schema (property definitions) | `GET /v1/databases/{database_id}` (used to return `properties`) | `GET /v1/data_sources/{data_source_id}` — [Retrieve a data source](https://developers.notion.com/reference/retrieve-a-data-source) |
| Get database container metadata | `GET /v1/databases/{database_id}` | `GET /v1/databases/{database_id}` — same path, **repurposed** response shape (now returns `data_sources` list, not `properties`) — [Retrieve a database](https://developers.notion.com/reference/retrieve-a-database) |
| Create a database | `POST /v1/databases` (created schema inline) | `POST /v1/databases` with an `initial_data_source` object; add more sources later via `POST /v1/data_sources` |
| Update schema | `PATCH /v1/databases/{database_id}` | `PATCH /v1/data_sources/{data_source_id}` — [Update a data source](https://developers.notion.com/reference/update-a-data-source) |
| List/search databases | `POST /v1/search` (`filter.value = "database"`) | `POST /v1/search` (`filter.value = "data_source"` or `"page"` — see §2, `"database"` is no longer a valid search filter value) |

Source for the table: [Upgrade guide: 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03), [Query a data source](https://developers.notion.com/reference/query-a-data-source), [Retrieve a data source](https://developers.notion.com/reference/retrieve-a-data-source), [Retrieve a database](https://developers.notion.com/reference/retrieve-a-database), [Changelog](https://developers.notion.com/page/changelog).

Also changed in `2025-09-03`: page-creation `parent` objects now use `{"type": "data_source_id", "data_source_id": "..."}` instead of `{"type": "database_id", ...}`; relation properties must specify `data_source_id` in write requests (though read responses include both `data_source_id` and `database_id` for convenience). Webhook events were renamed (`database.content_updated` → `data_source.content_updated`, `database.schema_updated` → `data_source.schema_updated`; new events `data_source.created` / `data_source.moved` / `data_source.deleted` / `data_source.undeleted`). Source: [Upgrade guide: 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03).

### Pinning an older `Notion-Version` — is it viable?

- Notion's stated policy: **"We don't currently have any plans to stop supporting older API versions. If this changes in the future, we'll communicate this with all affected users and provide a time window and migration guidance."** Source: [Versioning](https://developers.notion.com/reference/versioning).
- However, pinning `2022-06-28` is **not a viable strategy for this project**: the upgrade guide explicitly warns it breaks as soon as a database has more than one data source (increasingly the default going forward, and not something the integration controls — the Notion user could add a second data source at any time), and it also cannot address any database that started as multi-source. Source: [Upgrade guide: 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03).
- **Recommendation:** do not pin old. Build against `2025-09-03`/`2026-03-11` and the `data_sources` endpoints from the start.

---

## 2. Enumerating databases the integration can see

### `POST /v1/search`

Request body (source: [Search](https://developers.notion.com/reference/post-search)):

```json
{
  "query": "optional text to match against titles",
  "filter": {
    "property": "object",
    "value": "page",
    "in_trash": false
  },
  "sort": {
    "timestamp": "last_edited_time",
    "direction": "descending"
  },
  "page_size": 100,
  "start_cursor": "cursor-from-previous-page"
}
```

- `filter.value` accepts **`"page"` or `"data_source"`** — **`"database"` is not a valid value under the current model.** Source: [Search](https://developers.notion.com/reference/post-search).
- Response shape:

```json
{
  "object": "list",
  "type": "page_or_data_source",
  "page_or_data_source": {},
  "results": [ /* page or data_source objects */ ],
  "next_cursor": null,
  "has_more": false,
  "request_status": {
    "type": "complete",
    "incomplete_reason": "query_result_limit_reached"
  }
}
```

Source: [Search](https://developers.notion.com/reference/post-search).

### What this means for "discover the databases the integration can see"

- To enumerate the underlying **databases**, filter search to `"value": "data_source"`, then for each `data_source` result read its `parent` object (`{"type": "database_id", "database_id": "...", ...}`) to find which database it belongs to, and/or call `GET /v1/databases/{database_id}` to get the database's title/icon and its full `data_sources` list. There is no documented way to search directly for `"database"` objects anymore.
- Only `page` and `data_source` are searchable object types in `2025-09-03`+. Source: [Search](https://developers.notion.com/reference/post-search).
- The query text is matched against the **database title, not the data source title** — confirmed directly on the upgrade guide: *"the search behavior remains the same. The provided query is matched against the database title, not the data source title."* Source: [Upgrade guide: 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03).
- Search only returns objects the **integration has been explicitly shared with** in Notion (this is standard Notion API behavior, not something re-verified against this specific page in this pass — flagged below as it wasn't re-confirmed against a fresh fetch of the search page's "what it does not return" caveats).
- `request_status.incomplete_reason: "query_result_limit_reached"` indicates the search results were truncated — treat `has_more`/pagination and this field together as the completeness signal. Source: [Search](https://developers.notion.com/reference/post-search).

---

## 3. Reading a database's schema

### `GET /v1/data_sources/{data_source_id}`

Source: [Retrieve a data source](https://developers.notion.com/reference/retrieve-a-data-source).

Top-level shape:

```json
{
  "object": "data_source",
  "id": "d9824bdc-8445-4327-be8b-5b47500af6ce",
  "title": [{ "type": "text", "text": { "content": "..." } }],
  "description": [{ "type": "text", "text": { "content": "..." } }],
  "parent": { "type": "database_id", "database_id": "..." },
  "is_inline": false,
  "in_trash": false,
  "created_time": "2024-01-01T00:00:00.000Z",
  "last_edited_time": "2024-01-01T00:00:00.000Z",
  "created_by": { "id": "...", "object": "user" },
  "last_edited_by": { "id": "...", "object": "user" },
  "properties": { "PropertyName": { /* one of the shapes below */ } },
  "icon": { "type": "emoji", "emoji": "📊" },
  "cover": null,
  "url": "https://www.notion.com/...",
  "public_url": "https://www.notion.so/..."
}
```

To go from a database to its data source(s), call `GET /v1/databases/{database_id}` first (§1) and use the `id` from its `data_sources` array as `{data_source_id}` here.

### Property schema shapes (`properties.<Name>`)

| Type | Schema JSON |
|---|---|
| `select` | `{"type":"select","id":"...","name":"CRM status","description":null,"select":{"options":[{"id":"opt1","name":"Ready for CRM","color":"green","description":null}]}}` — options live at `select.options[]`, each with `id`, `name`, `color`. |
| `multi_select` | `{"type":"multi_select","id":"...","name":"Tags","description":null,"multi_select":{"options":[{"id":"opt1","name":"Important","color":"red","description":null}]}}` — options live at `multi_select.options[]`, same shape as select. |
| `status` | `{"type":"status","id":"...","name":"Workflow","description":null,"status":{"options":[{"id":"stat1","name":"Todo","color":"gray","description":null}],"groups":[{"id":"grp1","name":"To-do","color":"gray","option_ids":["stat1"]}]}}` — individual option values live in `status.options[]`; the UI's grouping ("To-do" / "In progress" / "Complete"-style buckets) lives separately in `status.groups[]`, where each group references its member options by `option_ids`. |
| `title` | `{"type":"title","id":"title","name":"Name","description":null,"title":{}}` — no options; `properties.title.id` is always `"title"`. |
| `rich_text` | `{"type":"rich_text","id":"...","name":"Notes","description":null,"rich_text":{}}` |
| `formula` | `{"type":"formula","id":"...","name":"Calculated","description":null,"formula":{"expression":"prop(\"Count\") * 2"}}` — as of the 2026-08-12 changelog entry, [Retrieve a data source](https://developers.notion.com/reference/retrieve-a-data-source) returns the expression using `prop("Property Name")` syntax; the schema does **not** state the formula's result type here — you must inspect an actual row's `formula` value (§5) or the formula expression itself to know whether it resolves to string/number/boolean/date. |
| `date` | `{"type":"date","id":"...","name":"Due Date","description":null,"date":{}}` |
| `number` | `{"type":"number","id":"...","name":"Quantity","description":null,"number":{"format":"number"}}` |
| `email` | `{"type":"email","id":"...","name":"Contact","description":null,"email":{}}` |
| `url` | `{"type":"url","id":"...","name":"Website","description":null,"url":{}}` |
| `people` | `{"type":"people","id":"...","name":"Assigned To","description":null,"people":{}}` |
| `checkbox` | `{"type":"checkbox","id":"...","name":"Done","description":null,"checkbox":{}}` |
| `relation` | `{"type":"relation","id":"...","name":"Related Items","description":null,"relation":{"database_id":"...","data_source_id":"...","type":"single_property","single_property":{}}}` |
| `rollup` | `{"type":"rollup","id":"...","name":"Total","description":null,"rollup":{"function":"sum","rollup_property_name":"Amount","relation_property_name":"Items","rollup_property_id":"...","relation_property_id":"..."}}` |
| `unique_id` | `{"type":"unique_id","id":"...","name":"ID","description":null,"unique_id":{"prefix":"ITEM"}}` |

Source for all rows: [Retrieve a data source](https://developers.notion.com/reference/retrieve-a-data-source).

### Practical recipe for building the filter UI

To populate a "CRM status" dropdown with real options: `GET /v1/data_sources/{id}`, find `properties["CRM status"]`, branch on `.type`:
- `select` → options at `.select.options[].name`
- `multi_select` → options at `.multi_select.options[].name`
- `status` → options at `.status.options[].name` (optionally grouped via `.status.groups[]`)
- `rich_text` / `title` / `formula` (string) → no fixed option list; render a free-text input instead of a dropdown.

---

## 4. Filter syntax (core deliverable)

### Endpoint and request body

`POST /v1/data_sources/{data_source_id}/query` — source: [Query a data source](https://developers.notion.com/reference/query-a-data-source).

```json
{
  "filter": { "...": "see below" },
  "sorts": [ { "property": "Created", "direction": "descending" } ],
  "start_cursor": "cursor-from-previous-page",
  "page_size": 100
}
```

- "The order of the sorts in the request matters, with earlier sorts taking precedence." Source: [Query a data source](https://developers.notion.com/reference/query-a-data-source).
- The docs also mention a `filter_properties` **query-string** parameter (not body) to restrict which properties are returned, for performance. Source: [Query a data source](https://developers.notion.com/reference/query-a-data-source).
- **Maximum pagination depth: 10,000 results per query** (added April 20, 2026). Beyond that, `has_more` becomes `false` and the response carries `request_status: {"type": "incomplete", "incomplete_reason": "query_result_limit_reached"}` even though not all matching rows were returned — check `request_status`, not just `has_more`, if you need to know whether you truly saw everything. Source: [Changelog](https://developers.notion.com/page/changelog), [Query a data source](https://developers.notion.com/reference/query-a-data-source).

### `CRM status = "Ready for CRM"` by property type

Full operator reference: [Filter a data source (filter object)](https://developers.notion.com/reference/post-database-query-filter).

| Property type | Filter JSON |
|---|---|
| `select` | `{"filter":{"property":"CRM status","select":{"equals":"Ready for CRM"}}}` |
| `multi_select` | `{"filter":{"property":"CRM status","multi_select":{"contains":"Ready for CRM"}}}` — **there is no `equals` for multi_select**; use `contains` for "has this tag" (see traps below). |
| `status` | `{"filter":{"property":"CRM status","status":{"equals":"Ready for CRM"}}}` — `equals` also accepts a **status group name** (e.g. `"In progress"`), not just an individual status option name. |
| `rich_text` | `{"filter":{"property":"CRM status","rich_text":{"equals":"Ready for CRM"}}}` |
| `title` | **Not documented.** See "Open / unverified" below — do not assume a `title` filter key exists without testing. |
| `formula` (string result) | `{"filter":{"property":"CRM status","formula":{"string":{"equals":"Ready for CRM"}}}}` |
| `formula` (number result) | `{"filter":{"property":"CRM status","formula":{"number":{"equals":1}}}}` — only relevant if the formula resolves to a number, not a string. |
| `formula` (boolean result) | `{"filter":{"property":"CRM status","formula":{"checkbox":{"equals":true}}}}` — note the sub-key is `checkbox`, not `boolean`. |
| `formula` (date result) | `{"filter":{"property":"CRM status","formula":{"date":{"equals":"2026-01-01"}}}}` |

Source for all rows: [Filter a data source (filter object)](https://developers.notion.com/reference/post-database-query-filter).

### `Batch = "2026-W34"` — same shapes, plus notes if it's a different type

Structurally identical to the above — substitute `"property": "Batch"` and `"2026-W34"` as the value, for `select` / `multi_select` (`contains`) / `status` / `rich_text` / `formula.string`.

If `Batch` turns out to be:
- **`date`**: `"2026-W34"` is not a valid ISO 8601 date on its own — you'd need the app to resolve the week string to a concrete date range and filter with `{"filter":{"property":"Batch","date":{"on_or_after":"2026-08-17","on_or_before":"2026-08-23"}}}` (`equals` also exists for an exact single date). Source: [Filter a data source (filter object)](https://developers.notion.com/reference/post-database-query-filter) (`date` operator table).
- **`number`**: a literal string like `"2026-W34"` cannot be represented; this combination is inapplicable — flag as a data-modeling mismatch rather than trying to filter it, e.g. `{"filter":{"property":"Batch","number":{"equals":34}}}` would only work if Batch were stored as a bare week-number integer.

### Compound `and` / `or`

```json
{
  "filter": {
    "and": [
      { "property": "CRM status", "select": { "equals": "Ready for CRM" } },
      { "property": "Batch", "select": { "equals": "2026-W34" } }
    ]
  }
}
```

Nested example straight from the docs:

```json
{
  "filter": {
    "and": [
      { "property": "Done", "checkbox": { "equals": true } },
      {
        "or": [
          { "property": "Tags", "contains": "A" },
          { "property": "Tags", "contains": "B" }
        ]
      }
    ]
  }
}
```

**Nesting limit: "Nesting is supported up to two levels deep."** — i.e. an `and`/`or` may contain another `and`/`or`, but not a third level. For this project's two-condition `and`, that's well within the limit. Source: [Filter a data source (filter object)](https://developers.notion.com/reference/post-database-query-filter).

### Documented traps

- **`equals` does not exist for `multi_select`.** Only `contains`, `does_not_contain`, `is_empty`, `is_not_empty`. To require an exact single tag with nothing else, you cannot express that in one filter condition — `contains` will match if `"Ready for CRM"` is one of several tags. Source: [Filter a data source (filter object)](https://developers.notion.com/reference/post-database-query-filter).
- `select` and `status` `equals`/`does_not_equal` accept **either a single string or an array of strings**, e.g. `"equals": ["Low", "Medium"]` — this is an OR-match against the listed values, per the field description "matches any of the provided values." Source: [Filter a data source (filter object)](https://developers.notion.com/reference/post-database-query-filter) (Select and Status sections).
- `status.equals` additionally accepts a **status group name** (e.g. `"To-do"`, `"In progress"`, `"Complete"`), not only individual option names. Source: same.
- **Case sensitivity is not documented anywhere on the filter reference page** — the docs never state whether `rich_text`/`select`/`status` string comparisons are case-sensitive. Treat as unverified; do not assume case-insensitivity.
- `is_empty` / `is_not_empty` exist on every value-type filter (checkbox has no empty variant since it's a boolean) and take the literal value `true`.
- **There is no documented `title` filter section** on the filter reference page at all (confirmed by a full verbatim dump of the page's sections: Checkbox, Date, Files, Formula, Multi-select, Number, People, Relation, Rich text, Select, Status, Timestamp, Verification, ID — no "Title" section exists). See "Open / unverified."

---

## 5. Reading values back out of the response

Rows come back as `page` objects in `results[]`; each property value lives at `properties["Property Name"]`. Source: [Page property values](https://developers.notion.com/reference/page-property-values).

| Type | Value shape | Plain-value extraction |
|---|---|---|
| `title` | `{"id":"title","type":"title","title":[{"type":"text","text":{"content":"..."},"plain_text":"...",...}]}` | Concatenate `.title[].plain_text` |
| `rich_text` | `{"id":"...","type":"rich_text","rich_text":[{"type":"text","text":{"content":"..."},"plain_text":"...",...}]}` | Concatenate `.rich_text[].plain_text` |
| `select` | `{"id":"...","type":"select","select":{"id":"...","name":"jQuery","color":"purple"}}` | `.select.name` (nullable if unset) |
| `multi_select` | `{"id":"...","type":"multi_select","multi_select":[{"id":"...","name":"TypeScript","color":"purple"}, ...]}` | `.multi_select.map(o => o.name)` |
| `status` | `{"id":"...","type":"status","status":{"id":"...","name":"In progress","color":"blue"}}` | `.status.name` |
| `formula` | `{"id":"...","type":"formula","formula":{"type":"number","number":56}}` (or `"type":"string","string":"..."` / `"type":"boolean","boolean":true` / `"type":"date","date":{"start":"2023-02-07","end":null}}`) | Branch on `.formula.type`, then read `.formula[type]` |
| `date` | `{"id":"...","type":"date","date":{"start":"2023-02-07","end":null,"time_zone":null}}` | `.date.start` (and `.date.end` if a range) |
| `email` | `{"id":"...","type":"email","email":"ada@makenotion.com"}` | `.email` |
| `url` | `{"id":"...","type":"url","url":"https://..."}` | `.url` |
| `number` | `{"id":"...","type":"number","number":42}` | `.number` |

Source for all rows: [Page property values](https://developers.notion.com/reference/page-property-values).

### Getting from a row back to its database/data source

A page's `parent` object, when the parent is a data source, includes **both** IDs for convenience:

```json
{ "type": "data_source_id", "data_source_id": "1a44be12-...", "database_id": "d9824bdc-..." }
```

Source: [Parent object](https://developers.notion.com/reference/parent-object).

---

## 6. Pagination and rate limits

### Pagination contract

Source: [Pagination](https://developers.notion.com/reference/pagination).

- Request: `start_cursor` (optional string) — cursor from a previous response's `next_cursor`. `page_size` (optional number) — **default 100, maximum 100**.
- Response: `has_more` (boolean) — `false` once you've reached the end of the list, otherwise `true`. `next_cursor` (string) — only present/meaningful when `has_more` is `true`; pass it back as `start_cursor` for the next page. `results` (array), `object: "list"`.
- For POST endpoints (including data-source query), these go in the request **body**; for GET endpoints, in the query string.
- Combine with §4's `request_status.incomplete_reason: "query_result_limit_reached"` (10,000-row cap) — a query can report `has_more: false` while still having stopped short, so surface `request_status` to the caller/log it rather than trusting `has_more` alone as "definitely got everything."

### Rate limits

Source: [Request limits](https://developers.notion.com/reference/request-limits).

- **Per-integration average: 3 requests/second**, with some bursting allowed above that average.
- Also a **per-workspace** limit shared across all connections, scaled to the workspace's plan.
- Exceeding a limit returns **HTTP 429** with error code `rate_limited` and `additional_data.rate_limit_reason` indicating which limit was hit. A separate **HTTP 529** indicates service overload.
- **`Retry-After` response header**: an integer number of seconds to wait before retrying.
- Recommended retry policy: always retry 429/529; retry 500/502/503/504 only for idempotent requests (GET/DELETE); use exponential backoff with jitter, capped at 30s, max 6 attempts.

### Size limits (general, not query-specific — relevant if the app ever writes back)

- Payload: max 1,000 block elements and 500KB overall.
- Rich text content/URL length: 2,000 characters.
- Generic block-type arrays: 100 elements.
- Relation and people property arrays: 100 related pages / 100 users.
- Multi-select: max 100 options.

---

## Open / unverified

- **No documented `title` filter.** The current [filter reference](https://developers.notion.com/reference/post-database-query-filter) has sections for checkbox, date, files, formula, multi-select, number, people, relation, rich_text, select, status, timestamp, verification, and ID — **no "Title" section exists**, confirmed via a full verbatim dump of the page. If `CRM status` or `Batch` turns out to be the database's `title` property, do not assume `{"property": "...", "title": {"equals": "..."}}` works — it is not documented anywhere we could find on developers.notion.com. Test empirically against a real database before relying on it, or treat title-typed filter columns as unsupported and surface an error/warning in the UI instead. **Independently re-verified 2026-08-29** during ticket resolution: a second fetch of the filter reference returned the same 15 sections (Checkbox, Date, Files, Formula, Multi-select, Number, People, Relation, Rich text, Rollup, Select, Status, Timestamp, Verification, ID) with no Title section and no statement that title properties use rich-text conditions. For this project the practical consequence is small — the two filter columns (`CRM status`, `Batch`) are not the title column (`Company` is) — but do not plan to filter on `Company`.
- **Case sensitivity of string filter operators** (`equals`, `contains`, etc. on `rich_text`/`select`/`status`/`formula.string`) is not stated anywhere in the filter reference. Do not assume case-insensitive matching; treat "Ready for CRM" vs "ready for crm" as potentially non-matching until verified against a live workspace.
- **Search completeness/consistency caveats**: we could not find explicit language on the `POST /v1/search` reference page about eventual consistency or index lag (e.g., a just-created database not immediately appearing in search results). This is commonly true of Notion's search in practice, but we did not find a primary-source statement to cite — flagging rather than asserting.
- **Full historical list of all `Notion-Version` values** (e.g. everything between `2021-05-13` and `2025-09-03`) is not published as a single table on the [Versioning](https://developers.notion.com/reference/versioning) page; only select versions are called out in changelog entries and inline examples. We did not attempt to reconstruct a complete list since only `2025-09-03` and `2026-03-11` are relevant to this project.
- **Formula result type is not declared in the schema.** `GET /v1/data_sources/{id}` returns the formula's `expression` string but not a `result_type` field, so the app cannot know in advance whether a formula filter needs `string`/`number`/`checkbox`/`date` — this must be inferred by reading a sample row's `formula.type` (§5) before constructing a filter, or by parsing the expression.
