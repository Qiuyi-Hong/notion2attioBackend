# The HTTP contract between the browser and the graph

Settled on [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16). This is the wire format between `notion2attioFrontend` (React/Vite) and `notion2attioBackend` (Express + an embedded LangGraph graph).

It is a specification, not an implementation. Nothing here is built yet — `src/` is still the Express scaffold.

## What was already fixed before this ticket

- **[#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3)** — the graph is compiled and `.invoke()`d inside our own Express process. No LangGraph Platform, no `@langchain/langgraph-sdk`. `thread_id` is the only handle. An interrupted node re-runs from the top. There is **no concurrency control**, an unknown `thread_id` **returns empty state silently**, and `updateState` on an interrupted thread **wipes the interrupt** — so edits travel by `Command({ resume })` only.
- **[#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7)** — the run pauses a **second** time, after the download, and writes `CRM status` = `Imported` back to Notion once a human confirms.
- **[#14](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/14)** — the OAuth redirect URI is pinned to `http://localhost:3000/auth/notion/callback`. It cannot move.
- **[#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15)** — there is **no session**. No cookie, no session middleware. A **Connection** is application-wide; a **Run** is addressed by its own identifier; neither belongs to a browser.
- **[#10](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/10)** — the reviewer works a candidate ledger: every candidate on screen, every field editable inline, any candidate holdable, the repair log shown in place.

## Principles

1. **The browser holds one value: the run identifier.** Everything else is fetched.
2. **`GET` never advances a run.** Downloading a file, polling status and reading the connection are all repeatable and side-effect-free.
3. **The two pauses are two routes, not one.** They carry different payloads and have different consequences.
4. **An edit re-enters the checks.** The reviewer's changes go back through `check`; editing is never a way to remove a flag.
5. **The vocabulary survives the wire format.** A Connection is not part of a Run's payload, because a Connection does not belong to a Run.

## Origin and transport

The Vite dev server proxies to Express, so the browser only ever talks to **one origin**. There is no CORS configuration and nothing to send credentials for, because [#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15) removed cookies entirely.

The proxy must forward **two** prefixes:

| Prefix | Why |
| --- | --- |
| `/api` | Everything the React app calls with `fetch`. |
| `/auth` | [#14](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/14) pinned the Notion callback outside any namespace of ours, and the Notion portal will not accept a change. |

`FRONTEND_ORIGIN` stays in config, defaulted to the proxy's origin, so a build served by Express also works.

All request and response bodies are JSON, except the file download.

## Routes

### Connection

| Route | Purpose |
| --- | --- |
| `GET /auth/notion/start` | Writes a pending-authorisation row holding the OAuth `state`, then `302`s to Notion's authorize URL. A browser navigation, not a `fetch`. |
| `GET /auth/notion/callback` | Exchanges the code, stores the Connection, `302`s back to the app. The exact string is [#14](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/14)'s and is not ours to change. |
| `GET /api/connection` | `{ connected: boolean, workspace: { name, icon } \| null }` |
| `DELETE /api/connection` | Revokes the Notion grant. Warns when a run is awaiting confirmation. |

The pending-authorisation row is the one thing in the SQLite file with a lifetime: it expires on use, or after ten minutes.

### Batches

| Route | Purpose |
| --- | --- |
| `GET /api/batches` | `[{ batch: "2026-W34", ready: 8 }]` — the distinct `Batch` values among `CRM status = Ready for CRM` rows, with counts. |

This costs one Notion query and earns three things: the pre-run screen, an honest weekly-repeat story for [#13](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/13), and proof that the filter runs rather than sitting hardcoded in config.

### Runs

| Route | Purpose |
| --- | --- |
| `POST /api/runs` | Body `{ batch }`. Returns **`202`** with `{ runId }` immediately; the graph runs on. `409 batch_in_progress` if another run still holds the batch. |
| `GET /api/runs` | Recent runs — `{ runId, batch, createdAt, status }[]`. |
| `GET /api/runs/:runId` | The snapshot. The one thing the browser polls. |
| `POST /api/runs/:runId/review` | The reviewer's decision document. |
| `POST /api/runs/:runId/confirm` | The human attestation that the batch landed in Attio. |
| `POST /api/runs/:runId/continue` | Restarts a `stalled` run from its last checkpoint. |
| `GET /api/runs/:runId/files/:fileId` | The CSV bytes, from the checkpoint. |
| `DELETE /api/runs/:runId` | Cancels the run and releases its batch. After the files exist, this is an attestation — see below. |

`POST /api/runs` returns `202` rather than blocking, because the run reads Notion and then makes up to eight model calls ([#9](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/9)) before it first pauses — plausibly 20–40 seconds. Returning the identifier immediately means the run's URL is shareable before the work finishes, and a reload during startup cannot orphan a run.

### One live run per batch

`POST /api/runs` first asks the `runs` table whether another run still holds this batch, and returns `409 batch_in_progress` with `details: { runId }` if one does ([ADR-0006](./adr/0006-a-repeat-deal-for-a-known-account-is-not-a-duplicate.md)).

Without the guard, a reviewer who leaves a run at `awaiting_confirmation` and forgets it can start the batch again. Nothing has flipped to `Imported` yet, so the second run reads the same rows and emits the same deals — and [#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2) found deals always create, with no undo.

**Only `done` releases a batch.** A `done` run has written `Imported` to Notion, so its rows leave the filter anyway and a new run over the same batch returns exactly the rows still waiting — [#29](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/29)'s batch-as-unit-of-retry, untouched. Every other state holds the batch, `failed` included: the contract keeps no failure record, so a `failed` run reads as `stalled` after a restart, and a node can throw *after* the export, leaving files a reviewer may already have downloaded.

The code is new rather than a reuse of `wrong_stage`, which is about one run at the wrong pause. This is about a batch another run holds, and the browser must tell them apart to offer *"open the run that already exists"* — which is what `GET /api/runs` is for.

### Cancelling — `DELETE /api/runs/:runId`

Deletes the run and releases its batch. Before the files exist it is unremarkable. At `awaiting_confirmation` it is an **attestation**, the mirror of `/confirm`: it states that these files did **not** reach Attio.

That distinction is load-bearing because [ADR-0004](./adr/0004-the-candidate-set-is-frozen-at-the-check-pass.md) makes cancelling the only escape once export locks the values, and describes it as *"abandoning the run and starting a new one"*. Followed literally by a reviewer who has already imported, that escape **is** the duplicate-deal error. So the reviewer chooses on a fact only they hold:

- **The files never reached Attio** — cancel. The batch is released, and the next run creates each deal once.
- **The files reached Attio and something is wrong** — **confirm**, then correct the records in Attio by hand. Confirming is what flips `CRM status` and stops the batch being handed off a second time; nothing can undo an import, and cancelling does not pretend to.

## Run states

`status` is a closed list of six.

| State | Meaning |
| --- | --- |
| `running` | Work is in flight in this process. |
| `awaiting_review` | The first interrupt. The ledger is on screen. |
| `awaiting_confirmation` | The files exist. Waiting for the human to confirm the Attio import. |
| `done` | The write-back to Notion completed. |
| `failed` | A node threw. |
| `stalled` | The checkpoint has pending tasks but nothing is running — the process restarted mid-run. |

`stalled` is recoverable: `POST /api/runs/:runId/continue` resumes from the last checkpoint, which [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) verified works from the file alone in a fresh process. It cannot be a `GET`, by principle 2.

We persist no failure record of our own, so **after a restart a `failed` run reads as `stalled`**. Continuing it re-runs the node that threw. This is a deliberate omission, not an oversight.

The run reaches `awaiting_confirmation` **as soon as the files exist**, not when they are downloaded. A download is a repeatable `GET`.

## Payloads

### Snapshot — `GET /api/runs/:runId`

```
{
  runId, batch, status, createdAt,
  candidates: [...],      // grouped by Company / Person / Deal, per #10
  batchFlags: [...],
  repairs:    [...],      // the repair log, shown in place
  files:      [{ fileId, filename, bytes }] | null
}
```

`files` is `null` until the emit node has run. `fileId` is opaque, so [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8) can change the file set without touching this contract.

### The decision document — `POST /api/runs/:runId/review`

```
{
  edits:   { [candidateId]: { [field]: value } },   // sparse: changed fields only
  held:    candidateId[],
  answers: { [flagId]: <answer> }                   // candidate Warns and batch flags alike
}
```

`edits` is **sparse** for a reason that is not about size. [#10](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/10) shows every silent repair in place with the original value on hover. If the browser posted whole candidates, the server could not tell *"the reviewer retyped the same value"* from *"the reviewer never touched it"* — so a repair would either lose its marking or keep it falsely. Sparse edits make **touched** a fact rather than an inference.

This is also why the payload is not a patch of *rows*: [#6](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6) attaches flags to candidates, and the reviewer edits candidates.

### The attestation — `POST /api/runs/:runId/confirm`

The human's statement that they performed the Attio import. The failure and double-submit semantics of the node behind it are [#17](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/17).

### File download — `GET /api/runs/:runId/files/:fileId`

Serves the **stored bytes from the checkpoint**. It never regenerates the file, so the bytes downloaded are provably the bytes the reviewer approved.

`Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment`. The bytes themselves are [#12](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/12)'s: UTF-8, no BOM, **CRLF**, comma, RFC-4180 quoting, no trailing newline.

## Validating untrusted input

The resume value arrives straight from a browser. Two kinds of bad input get two different answers.

**Structural — rejected at the edge, never reaches the graph.** Malformed JSON, an unknown `candidateId`, an unknown `flagId`, a field that is not editable. A Zod schema at the route boundary returns `400`.

**Semantic — goes back into the graph as a flag.** The reviewer types an email address that still does not parse. The review node re-interrupts and the problem appears on the candidate in the ledger, where the reviewer is already working. A `400` here would be the API correcting the reviewer somewhere other than the surface they are looking at.

The load-bearing half is that **the reviewer's edits re-enter `check`**. If they did not, editing a flagged value would be a way to launder the flag away. What the pipeline *re-derives* on that pass is [#31](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/31)'s question, not this contract's.

## Concurrency

[#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) found LangGraph has **no** concurrency control: two simultaneous resumes on one thread both succeed. With a poll loop running, a double-click on Confirm could fire the Notion write-back twice.

Two mechanisms cover it together:

1. **An in-process lock per run.** The first request takes it.
2. **The stage guard.** `/review` and `/confirm` each return `409` if the run is not at that pause. Once the first request has moved the run past the pause, the second is refused by definition.

No client cooperation is required — no checkpoint token to echo back. Multi-process safety is a deliberate gap; see below.

## Errors

One shape, one closed list of codes.

```
{ "error": { "code": "...", "message": "...", "details": {...} } }
```

| Code | Status |
| --- | --- |
| `not_connected` | `409` |
| `no_such_run` | `404` |
| `wrong_stage` | `409` |
| `batch_in_progress` | `409` |
| `invalid_payload` | `400` |
| `notion_failed` | `502` |

`problem+json` (RFC 9457) was considered and declined: nothing here consumes it.

## Repo split

The graph lives entirely in `notion2attioBackend`. `notion2attioFrontend` is a pure HTTP client and holds no pipeline logic.

**No code is shared between the repositories.** The backend owns one module of Zod schemas as the source of truth; the frontend hand-writes the handful of types it renders. The two repos have no workspace between them, so a shared package would need publishing or a git dependency — more plumbing than the duplication costs. The shared *vocabulary* stays where it already lives, in `CONTEXT.md`.

## Deliberately not covered here

| Question | Ticket |
| --- | --- |
| What files exist and what is in them | [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8) |
| What the write-back does when it half-fails | [#17](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/17) |
| The `CRM status` of a half-handed-off row | [#29](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/29) |
| What is re-derived when a reviewer edits a derived-from value | [#31](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/31) |

## Productionise gaps, built on purpose

These join the four [#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15) already named.

- **The in-process lock is single-process.** Two Express processes would both accept a resume. A real deployment needs the lock in the database.
- **Run URLs are unguessable, not authorised.** A v4 UUID in a shareable link is the whole access-control story. There is no authentication in front of it.
- **`failed` does not survive a restart.** It degrades to `stalled`, and continuing re-runs the node that threw.
- **Nothing sweeps old runs.** `DELETE` is the only deletion; the SQLite file grows.
