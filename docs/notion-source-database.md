# The Notion source database

The weekly handoff starts at a Notion database of qualified accounts. `data/notion-qualified-accounts-w34.csv` is an *export* of one; this document defines the real thing behind it, so the extraction node has something true to query.

Resolves [#5](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/5).

## Standing it up

```bash
npm run notion:setup
```

A six-stage wizard. It only asks you for the things a human has to do in a browser; everything else it does itself, and it stops before writing anything to your workspace until it has proved the token works.

| Stage | You do | Produces |
| --- | --- | --- |
| 1 · Preflight | nothing — checks Node 20+ and runs the offline fixture check | — |
| 2 · Access token | create a personal access token, copy it (hidden entry) | `NOTION_TOKEN` |
| 3 · Parent page | create an empty page, paste its URL | `NOTION_PARENT_PAGE_ID` |
| 4 · Verify access | nothing — probes the API and says *which* of stage 2 or 3 went wrong | — |
| 5 · Create + seed | confirm; this is the first write to your workspace | `NOTION_DATABASE_ID`, `NOTION_DATA_SOURCE_ID` |
| 6 · Record | confirm posting the ids to [#5](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/5) | — |

Ctrl-C at any point is safe; values already captured are in `.env` and a re-run offers them as defaults. Stage 6 deliberately does **not** close #5 — closing a wayfinder ticket also means writing its resolution into the map, which the agent does.

Everything after stage 4 is scripted and repeatable:

| Script | What it does |
| --- | --- |
| `scripts/check-notion-fixture.mjs` | Offline. Asserts the fixture is still correct — no token, no network. |
| `scripts/seed-notion-source-db.mjs` | Creates the database, inserts 12 rows, then runs the real W34 filter against the live data source and fails unless it returns exactly 8. |

Re-running the seeder creates a **second** database — it is not idempotent by design. Delete the old one in Notion first.

## Two API facts that shape the app

1. **`status` properties are creatable via the API.** With custom options *and* groups, on the current version (`2026-03-11`). This used not to be true, and a lot of surviving advice online says to build status properties by hand in the UI. It removes the only real argument for modelling `CRM status` as a `select`.
2. **Rows live in a *data source*, not the database.** Since API version `2025-09-03` a database owns one or more data sources. Creating a row is `POST /v1/pages` with parent `{"type":"data_source_id","data_source_id":…}`, and querying is `POST /v1/data_sources/{id}/query`. **The app needs `NOTION_DATA_SOURCE_ID`, not just `NOTION_DATABASE_ID`** — a database id alone will not run the extraction filter. `POST /v1/databases` returns `data_sources[]` on the create response.

## The extraction filter

```json
{
  "and": [
    { "property": "CRM status", "status": { "equals": "Ready for CRM" } },
    { "property": "Batch",      "select": { "equals": "2026-W34" } }
  ]
}
```

Note the asymmetry: `status` for one leg, `select` for the other. Getting either key wrong is a `validation_error`, not an empty result — Notion rejects a filter whose key does not match the property's type, which is a small mercy.

## Property types

18 properties. Every choice below is deliberate; the ones marked **⚑** change how the app must query.

| Property | Type | Why |
| --- | --- | --- |
| `Account` | **title** | Notion requires exactly one title. `Account` is the row's display name — and because two rows are titled `Brightyard`, the duplicate-account trap is visible in Notion itself, not just downstream. A plain CSV import would instead make `Source ID` the title, since Notion takes the first column; the seeder does not have that constraint. |
| `Source ID` | rich_text | The stable per-row key used for dedupe and idempotency. Not the title: it is not human-readable. Filter with `rich_text.equals`. |
| `Website` | url | Notion's `url` type does **not** enforce a scheme, so the messy variants survive verbatim — `heliograph.example.com`, `www.alderfinch.example.com`, `https://oriel.example.com/uk`, and Northbeam's trailing slash. Preserving that mess is the point: it is what the domain transform has to survive. |
| `Contact` | rich_text | |
| `Work email` | email | Gives the extraction node a typed `null` for Tern Mobility rather than an empty string, and makes `email.is_empty` a usable filter. |
| `Job title` | rich_text | Unbounded free text. |
| `LinkedIn` | url | |
| `Lead source` | select | Seven enumerable values. |
| `Segment` | select | `SMB`, `Mid-market` (+ `Enterprise`, unused, for realism). |
| `Employees` | **select, both dash variants as separate options** ⚑ | Five options: `11–50`, `11-50`, `51–200`, `51-200`, `201-500`. The en-dash and hyphen forms are kept as **distinct** options on purpose. This proves the normalisation problem exists *at source* — a real dropdown a real person picked from — rather than being an artefact of CSV export. Notion compares option names exactly, so `51–200` ≠ `51-200`. |
| `HQ` | rich_text | Unbounded city list, and unmapped to Attio. No structure worth inventing. |
| `Research notes` | rich_text | Carries the "previously spoke to the team under another email address" and "replied from a newer email alias" hints — the only place the duplicate-person traps are stated. |
| `Owner` | select | `Maya`. Deliberately **not** `people`: a `people` property binds the fixture to real workspace member ids and stops it reproducing in anyone else's workspace. |
| `Qualified on` | date | |
| `Batch` | **select** ⚑ | A controlled weekly vocabulary (`2026-W33`/`W34`/`W35`), so a dropdown prevents the typo-at-source that plain text permits. Filter key is `select`. |
| `CRM status` | **status** ⚑ | It is a lifecycle, and `status` is the type Notion built for lifecycles. Options and groups: `Not ready` (To-do) → `Ready for CRM` (In progress) → `Imported` (Complete). The `Imported` end is what a future weekly-repeat run would set, so the type is chosen for where this is going, not just for W34. Filter key is `status`, **not** `select`. |
| `CRM company ID` | rich_text | Empty in W34; the write-back target if an Attio API leg is ever added (currently out of scope). |
| `CRM person ID` | rich_text | Empty in W34. |

## The rows

`data/notion-source-seed.csv` — 12 rows. The original 8 are byte-identical to `data/notion-qualified-accounts-w34.csv`; four more exist so the filter is **provably** doing something rather than trivially matching everything.

| Source ID | Account | Batch | CRM status | Proves |
| --- | --- | --- | --- | --- |
| `QL-260818-001` … `QL-260820-008` | the original 8 | `2026-W34` | `Ready for CRM` | the rows that must come through |
| `QL-260821-009` | Vantle Freight | `2026-W34` | `Not ready` | the **status** leg bites |
| `QL-260811-010` | Kepler Rowe | `2026-W33` | `Ready for CRM` | the **batch** leg bites backwards |
| `QL-260826-011` | Summerlin Optics | `2026-W35` | `Ready for CRM` | the **batch** leg bites forwards — a future week must not leak in |
| `QL-260812-012` | Halden & Roe | `2026-W33` | `Imported` | the `Imported` end of the lifecycle is real, with CRM ids filled |

A filter returning 12 — or 9, or 11 — is a filter that is not working. Only 8 is correct, and `check-notion-fixture.mjs` plus the seeder's own self-check both assert it.

## Traps preserved in the fixture

These survive the seeding intact, because the transform has to deal with them:

- **Brightyard twice** — one account, two contacts, and two website spellings that produce two *different* domains under the sheet's formula.
- **Tern Mobility has no work email** — the one row the sheet's `Row check` actually catches.
- **`51–200` vs `51-200`** and **`11–50` vs `11-50`** — en-dash and hyphen, as separate select options.
- **`oriel.example.com/uk`** keeps its path, and **Northbeam** keeps its trailing slash, under a domain formula that only strips the scheme and `www.`.
- **Heliograph** ("previously spoke to the team under another email address") and **Lattice Forge** ("replied from a newer email alias") — duplicate people that only the notes disclose.

## Credentials

`.env` (gitignored) after the wizard runs:

```
NOTION_TOKEN=ntn_…            # personal access token
NOTION_PARENT_PAGE_ID=…       # page the database is created under
NOTION_DATABASE_ID=…          # written by the seeder
NOTION_DATA_SOURCE_ID=…       # written by the seeder — this is what queries need
```

The demo's real login is full Notion **OAuth**, not this token (see [#4](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/4)). The token exists only to stand the fixture up and to let the pipeline be developed without a browser round-trip on every run.

### Getting a token

https://www.notion.so/developers/tokens → **New token** → name it → tick the **Notion API** capability → **Create token**. It starts `ntn_` and is shown **once**.

Notion has renamed *integrations* to **connections**, so older guides — including much of what search turns up — point at `notion.so/profile/integrations`, which no longer exists. That is the likely source of confusion if you go looking.

A **personal access token** acts as you and carries your own permissions, so the parent page needs no sharing step. An **internal connection's** secret works too, but then the page must be shared with it explicitly (page → **•••** → **Connections**) — otherwise the API returns `404`, not a permission error, because Notion hides pages a token cannot reach. Stage 4 of the wizard distinguishes these before anything is written.

On Business and Enterprise plans, token creation is disabled by default; a workspace owner enables it under **Settings → Connections**.
