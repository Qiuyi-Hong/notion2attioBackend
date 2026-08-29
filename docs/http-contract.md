# The HTTP contract between the browser and the graph

Settled on [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16). This is the wire format between `notion2attioFrontend` (React/Vite) and `notion2attioBackend` (Express + an embedded LangGraph graph).

It is a specification first, and it stays authoritative where the code disagrees. The Connection ([#49](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/49)), batches ([#50](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/50)) and the starting, listing, watching, continuing and cancelling of runs ([#51](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/51)), the candidates and repair log the snapshot carries ([#52](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/52)), and the deterministic flags on those candidates ([#53](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/53)), are built. The two pauses and the file download are not: `/review`, `/confirm` and `/files/:fileId` arrive with the tickets that give them something to carry.

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
4. **An edit is validated, not re-checked.** The reviewer's changes are validated where they land; `check` does not run again, and editing is never a way to remove a flag ([ADR-0004](./adr/0004-the-candidate-set-is-frozen-at-the-check-pass.md)).
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

Both `/auth` routes are browser navigations, so the callback's answer is the URL it lands on: `${FRONTEND_ORIGIN}/runs?connection=<outcome>`. The outcome is a closed list, and it is what the connect banner in [`run-surfaces.md`](./run-surfaces.md) renders — the browser is told which of these happened rather than left to infer it from a generic failure.

| `connection` | What happened |
| --- | --- |
| `connected` | The grant is stored and reaches at least one data source. |
| `no_databases` | The grant is stored, but covers no database we can read. The workspace has a name; there is nothing in it for us. |
| `cancelled` | The user backed out of consent. Nothing was exchanged and nothing was stored. |
| `expired` | The `state` was unknown, already spent or over ten minutes old — or the issued token was refused on sight. Nothing was stored. |
| `failed` | Notion refused the code exchange. |

`DELETE /api/connection` answers `{ disconnected: true, strandedRuns: runId[] }`. A stranded run is one at `awaiting_confirmation`: its bundle is in Attio and, once the grant is gone, its write-back can no longer be made.

### Batches

| Route | Purpose |
| --- | --- |
| `GET /api/batches` | `[{ batch: "2026-W34", ready: 8 }]` — the distinct `Batch` values among `CRM status = Ready for CRM` rows, with counts. |

This costs one search and one query — a second query per further hundred ready rows, since the counts are the payload and a truncated one would be wrong — and earns three things: the pre-run screen, an honest weekly-repeat story for [#13](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/13), and proof that the filter runs rather than sitting hardcoded in config.

The route reads the **status leg alone** — `CRM status = Ready for CRM` — and groups what comes back by `Batch`. `CRM status` is a status property and `Batch` is a select ([`notion-source-database.md`](./notion-source-database.md)); a filter key that does not match the property's type is a `validation_error` from Notion, which leaves here as `notion_failed`, never as zero rows.

**The data source is found by searching**, with the `data_source` object filter, on every request. No data-source identifier is read from config — `NOTION_DATA_SOURCE_ID` seeds the fixture and is not request-time configuration. That is what keeps the consent screen load-bearing: the grant decides what is readable.

**The first data source the search returns wins.** A grant reaching several is read as though it reached one, and choosing between them would mean the picker naming a database as well as a batch — which no surface asks for. Named here so it is a known ceiling rather than a surprise.

Batches come back **most recent week first**. ISO weeks are zero-padded, so this is a plain descending string sort, and it puts the week a reviewer opened the app to run at the top of a `<select>` that is often one option long.

Four situations, and only the first answers with a list:

| Situation | Answer |
| --- | --- |
| A grant reaching a data source | `200`, the list — empty when nothing is waiting |
| No Connection | `409 not_connected` |
| A Connection whose grant reaches no data source | `409 not_connected`, `details: { reason: "no_databases" }` |
| Notion refuses the search or the query | `502 notion_failed` |

Settled on [#50](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/50), which asked for an answer here and did not name one. The shared-nothing case is **not** an empty list: an empty list means *nothing is waiting this week*, which is what a healthy workspace with everything imported looks like. It carries the same `no_databases` name the connect banner already renders, under the `not_connected` code so the closed list stays closed.

A stored Connection answering `not_connected` is not a new contortion: [#49](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/49) already answers it, with `details: { reason: "expired" }`, for a grant Notion has stopped honouring. Both say the same thing — *there is a row in the file, and it will not get you a batch* — and `details.reason` is what separates the two repairs. The workspace name for the banner comes from `GET /api/connection`, as it always has; this error is not asked to carry it.

### Runs

| Route | Purpose |
| --- | --- |
| `POST /api/runs` | Body `{ batch }`. Returns **`202`** with `{ runId }` immediately; the graph runs on. `409 batch_in_progress` if another run still holds the batch. |
| `GET /api/runs` | Recent runs — `{ runId, batch, createdAt, status }[]`. |
| `GET /api/runs/:runId` | The snapshot. The one thing the browser polls. |
| `POST /api/runs/:runId/review` | The reviewer's decision document. |
| `POST /api/runs/:runId/confirm` | The human attestation that the batch landed in Attio — and, on a retry, the attestation that the write-back is being abandoned. |
| `POST /api/runs/:runId/continue` | Restarts a stopped run — `stalled`, or `failed` in the process that saw it throw — from its last checkpoint. |
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

`status` is a closed list of seven.

| State | Meaning |
| --- | --- |
| `running` | Work is in flight in this process. |
| `awaiting_review` | The first interrupt. The ledger is on screen. |
| `awaiting_confirmation` | The files exist. Waiting for the human to confirm the Attio import. |
| `done` | The write-back to Notion completed. Every handed-off row reads `Imported`. |
| `abandoned` | The reviewer gave up on a write-back that could not finish. Some handed-off rows still read `Ready for CRM`. |
| `failed` | A node threw. |
| `stalled` | The checkpoint has pending tasks but nothing is running — the process restarted mid-run. |

`stalled` is recoverable: `POST /api/runs/:runId/continue` resumes from the last checkpoint, which [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) verified works from the file alone in a fresh process. It cannot be a `GET`, by principle 2.

We persist no failure record of our own, so **after a restart a `failed` run reads as `stalled`**. Continuing it re-runs the node that threw. This is a deliberate omission, not an oversight.

The run reaches `awaiting_confirmation` **as soon as the files exist**, not when they are downloaded. A download is a repeatable `GET`.

`abandoned` is terminal but is **not** `done`. The distinction is load-bearing against [#13](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/13)'s one-live-run-per-batch guard ([PR #39](https://github.com/Qiuyi-Hong/notion2attioBackend/pull/39)), under which only a `done` run releases its batch: an abandoned run leaves rows reading `Ready for CRM` whose deals are **already in Attio**, so releasing the batch would let the next run emit those deals a second time. The batch stays reserved until a person sets those rows to `Imported` in Notion by hand and deletes the run — `DELETE /api/runs/:runId` is the explicit release. See [ADR-0007](./adr/0007-the-write-back-completes-or-is-abandoned.md).

Two exits from `awaiting_confirmation` assert opposite things and must not be conflated: **cancelling** (#13's meaning — *these files did not reach Attio*) and **abandoning** (*they did, and I am giving up on marking Notion*).

## Payloads

### Snapshot — `GET /api/runs/:runId`

```
{
  runId, batch, status, createdAt,
  candidates: { companies: [...], people: [...], deals: [...] },  // per #10
  batchFlags: [{ id, rule, level, kind, stage }],
  repairs:    [...],      // the repair log, shown in place
  files:      [{ fileId, filename, bytes }] | null,
  writeBack:  { written: sourceId[], failed: [{ sourceId, cause }] } | null,
  blocked:    { reason: "wrong_workspace", readWorkspace, liveWorkspace } | null
}
```

`candidates` is grouped by the Attio object each candidate becomes, because the ledger is read that way and Attio imports one file per object. A Person carries a reference to its Company rather than a copy of it, and a Deal carries no name — reach-through and derived values resolve when the files are written ([ADR-0004](./adr/0004-the-candidate-set-is-frozen-at-the-check-pass.md)).

Every candidate carries its own **`flags`** array — `{ id, rule, level, kind, override, sibling }` — because a flag attaches to a candidate and never to a source row ([ADR-0001](./adr/0001-flags-attach-to-candidate-records.md)). There is no top-level `flags` key: a flag has nowhere a source row could go.

- `rule` names the rule that raised it, and is what the surface renders a fixed sentence for. No prose travels on the wire, which is also what keeps the screener's model unable to narrate ([ADR-0002](./adr/0002-a-model-may-only-raise-a-flag.md)).
- `level` is `stop` or `warn`; `kind` is `decision` or `notice` on a Warn and `null` on a Stop.
- `override` says whether the reviewer may force past it. `D1` — the Stop a Deal carries while its account is not whole — is the one flag that never can ([ADR-0005](./adr/0005-a-deal-is-emitted-only-when-its-account-is-clear.md)).
- `sibling` names the candidate that _caused_ the flag, by id rather than by name, where that is not the candidate carrying it. A person's name lives on their own candidate and is never copied.

The candidate set and the flag set are fixed the moment `check` completes, so a poll never returns a different set of either ([ADR-0004](./adr/0004-the-candidate-set-is-frozen-at-the-check-pass.md)). What _is_ answered changes; which flags exist does not.

`batchFlags` is asked once, in one place, before the files are made. Today it holds exactly one: `P1`, the decision Warn confirming `Deal owner` and `Deal stage` ([#18](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/18)). It carries `stage` because no Notion column holds one and we never read Attio, so the proposal comes from configuration. It carries **no owner and no count**: Notion's `Owner` is already on every Deal candidate, and any count the surface shows beside the flag — _six deals to `Maya`_ — is derived from the candidates as they stand, so storing it beside the flag would let the two disagree.

Each entry in `repairs` names the **candidate field** the repaired value sits on — `domain`, not the source property `Website` it came from — alongside the original and the source row it arrived on, so the ledger marks it in place rather than in an audit screen elsewhere. A value that was already correct produces no entry.

There is one entry per source row repaired, so a candidate several rows collapsed onto carries one for each: Brightyard's `domain` has two, because two spellings were repaired into it. That is what makes the collapse legible, and it is why the W34 log is seven entries rather than six.

`blocked` is `null` unless something stops the run being confirmed that is not a stage or a missing Connection. Today it has exactly one reason: the live Connection names a different Notion workspace from the one this run read the batch from ([ADR-0008](./adr/0008-a-run-is-confirmed-only-through-the-connection-that-read-it.md)). `readWorkspace` and `liveWorkspace` are **names, for display** — the comparison happens on `workspace_id`, server-side, and the ids never reach the browser. The server decides and the browser renders; putting the rule in both places would let the two disagree, and the route holds the copy that enforces.

`writeBack` is `null` until a write-back has been attempted. A non-empty `failed` is what turns the confirmation panel into a retry panel — and it is why [#17](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/17) needed **no** extra state for the retry pause: a run with failures is paused at the confirmation interrupt, which is the definition of `awaiting_confirmation`. The difference the UI needs is derived from this field, not stored beside it.

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

```
{ confirmed: true } | { abandoned: true }
```

`{ confirmed: true }` is the human's statement that they performed the Attio import. It is accepted on the first pass and on every retry pass.

`{ abandoned: true }` is accepted when `writeBack.failed` is non-empty, **or** when `blocked.reason` is `wrong_workspace` — that is, when a write-back has failed, or when one can never begin. It ends the run `abandoned`. It is refused otherwise: there is nothing to abandon while the write-back can still be attempted.

The second case is [ADR-0008](./adr/0008-a-run-is-confirmed-only-through-the-connection-that-read-it.md)'s. A Reviewer whose original workspace is gone for good has imported the bundle and can never mark Notion; without this, their only exits are cancelling — which asserts the files never reached Attio, and is false — or leaving the batch reserved for ever.

**The confirm route refuses `wrong_workspace` (`409`) before either payload is considered**, so `{ confirmed: true }` cannot start a write-back the run has no standing to make. `{ abandoned: true }` is the one payload the block does not refuse; it is the exit from it.

**One route serves both passes**, because the stage guard below already does the work: after a partial failure the run is genuinely back at the confirmation pause, so a retry is accepted for exactly the reason a first confirm is. The Retry button is this route with this payload.

**The write node re-queries Notion before writing** — `Batch = <batch> AND CRM status = Ready for CRM`, intersected with the rows this run handed off — and writes only what is still `Ready for CRM`. That makes the node idempotent against Notion rather than against a record of ours, which is what lets it survive a double-submit, a retry, and a process death mid-write alike. Writes are sequential (~3/s, [#4](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/4)); a `429` is retried honouring `Retry-After` and a `5xx` twice, after which the node stops and routes back to the pause with `writeBack.failed` populated.

A `401` stops the node immediately rather than failing the remaining rows one at a time, and reports one cause for the batch.

**The run records the `workspace_id` and workspace name it read the batch from**, written into graph state by the node that queries Notion — not stamped at run creation, since `POST /api/runs` is a `202` and the Connection can change before the query runs. The write node refuses if the live Connection names a different workspace. That check is kept **in addition to** the route's `wrong_workspace`, because a run left `stalled` at the write-back is re-entered through `POST /api/runs/:runId/continue`, which never passes the confirm route. `continue` itself gains no check — a run can stall at any node, and most of them never touch Notion.

Full reasoning: [ADR-0007](./adr/0007-the-write-back-completes-or-is-abandoned.md) and [ADR-0008](./adr/0008-a-run-is-confirmed-only-through-the-connection-that-read-it.md).

### File download — `GET /api/runs/:runId/files/:fileId`

Serves the **stored bytes from the checkpoint**. It never regenerates the file, so the bytes downloaded are provably the bytes the reviewer approved.

`Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment`. The bytes themselves are [#12](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/12)'s: UTF-8, no BOM, **CRLF**, comma, RFC-4180 quoting, no trailing newline.

## Validating untrusted input

The resume value arrives straight from a browser. Two kinds of bad input get two different answers.

**Structural — rejected at the edge, never reaches the graph.** Malformed JSON, an unknown `candidateId`, an unknown `flagId`, a field that is not editable. A Zod schema at the route boundary returns `400`.

**Semantic — goes back into the graph as a flag.** The reviewer types an email address that still does not parse. The review node re-interrupts and the problem appears on the candidate in the ledger, where the reviewer is already working. A `400` here would be the API correcting the reviewer somewhere other than the surface they are looking at.

The load-bearing half is that **an edit is validated, not re-checked**. [ADR-0004](./adr/0004-the-candidate-set-is-frozen-at-the-check-pass.md) settled [#31](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/31) and amends what this contract first said here: validation runs on the edited value, where it lands, and `check` never runs a second pass. Laundering is then structurally impossible rather than defended against — the candidate set and the flag set are frozen the moment `check` completes, so a flag is cleared only by answering it through its own control, never by editing a cell near it.

## Concurrency

[#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) found LangGraph has **no** concurrency control: two simultaneous resumes on one thread both succeed. With a poll loop running, a double-click on Confirm could fire the Notion write-back twice.

Two mechanisms cover it together:

1. **An in-process lock per run.** The first request takes it.
2. **The stage guard.** `/review` and `/confirm` each return `409` if the run is not at that pause. Once the first request has moved the run past the pause, the second is refused by definition.

3. **The write node's re-query.** Even if both mechanisms were bypassed, a second write-back finds every row already `Imported` and writes nothing.

No client cooperation is required — no checkpoint token to echo back. Multi-process safety is a deliberate gap; see below — and (3) is the one guard that would still hold across two processes.

## Errors

One shape, one closed list of codes.

```
{ "error": { "code": "...", "message": "...", "details": {...} } }
```

| Code | Status |
| --- | --- |
| `not_connected` | `409` |
| `wrong_workspace` | `409` |
| `no_such_run` | `404` |
| `wrong_stage` | `409` |
| `batch_in_progress` | `409` |
| `invalid_payload` | `400` |
| `notion_failed` | `502` |

`wrong_workspace` sits next to `not_connected` on purpose: both are **preconditions on the Connection**, not write-back outcomes, so neither breaches the rule below — the write-back never starts. `not_connected` wins when there is no Connection at all. It is returned by `POST /api/runs/:runId/confirm` only. `/review` is deliberately unguarded: nothing between `review` and `emit` touches Notion, and since the block clears the moment the original workspace is connected again, stopping the Reviewer mid-triage would save no work ([ADR-0008](./adr/0008-a-run-is-confirmed-only-through-the-connection-that-read-it.md)).

`notion_failed` is **read-side only** — the batch query and the data-source search. No write-back outcome is ever an HTTP error: a failed write, `401` included, is run state on `GET /api/runs/:runId`, for the same reason semantic validation failures re-interrupt rather than return `400`. The reviewer is looking at the ledger, not at the response to a POST they will never see again.

The list is closed for failures the contract *knows about*. A failure it does not — an unhandled throw — leaves in the same shape with code `internal_error` and a `500`. That code is deliberately outside the list: a browser that finds it has hit a bug, not a state.

`problem+json` (RFC 9457) was considered and declined: nothing here consumes it.

## Repo split

The graph lives entirely in `notion2attioBackend`. `notion2attioFrontend` is a pure HTTP client and holds no pipeline logic.

**No code is shared between the repositories.** The backend owns one module of Zod schemas as the source of truth; the frontend hand-writes the handful of types it renders. The two repos have no workspace between them, so a shared package would need publishing or a git dependency — more plumbing than the duplication costs. The shared *vocabulary* stays where it already lives, in `CONTEXT.md`.

## Deliberately not covered here

| Question | Ticket |
| --- | --- |
| What files exist and what is in them | [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8) |
| The `CRM status` of a half-handed-off row | [#29](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/29) |
| What is re-derived when a reviewer edits a derived-from value | [#31](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/31) |

## Productionise gaps, built on purpose

These join the four [#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15) already named.

- **The in-process lock is single-process.** Two Express processes would both accept a resume. A real deployment needs the lock in the database.
- **Run URLs are unguessable, not authorised.** A v4 UUID in a shareable link is the whole access-control story. There is no authentication in front of it.
- **`failed` does not survive a restart.** It degrades to `stalled`, and continuing re-runs the node that threw.
- **Nothing sweeps old runs.** `DELETE` is the only deletion; the SQLite file grows.
- **A confirmation is taken at face value.** Nothing detects a reviewer who clicks Confirm before the Attio import actually finished; the recovery is the same manual edit in Notion. This is the residue of choosing a human attestation over a signal we cannot obtain ([#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7)), not an oversight.
