# The demo narrative

Settled on [#63](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/63). Everything
else about the handoff was specified before the app existed; this was the one item
[#47](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/47) left open, because a
walk-through cannot be written before there is something to walk. This is the record of
what the walk shows, in what order, and what it refuses to show.

**The demo is supporting evidence, not the submission.** The submission is
[`README.md`](../README.md), which stands on the workbook, the batch, the decision record
and the committed worked example — all four in this repo, none of them needing the app to
be running. If the demo is unreachable, nothing in the write-up stops being checkable.

## The setup, and why it is not a self-serve link

The app runs on `localhost`, and that is a decision rather than a shortfall: a run
identifier is a v4 UUID in a URL and possession of it is the entire access-control story,
so there is no authorisation to put a public deployment behind
([`README.md`](../README.md), *Decisions, taken as decisions*). The demo therefore **runs
against our own Notion workspace, driven by us**. A reviewer connecting their own Notion
is not a supported path — the source database has a specific schema
([`notion-source-database.md`](notion-source-database.md)) that an arbitrary workspace
will not have.

| | |
| --- | --- |
| Notion | Our own workspace, seeded by `npm run notion:seed` from [`data/notion-source-seed.csv`](../data/notion-source-seed.csv) |
| Backend | `npm run dev` — Express on `:3000`, graph compiled in-process |
| Frontend | `npm run dev` in `notion2attioFrontend` — Vite on `:5173` |
| Batch | `2026-W34`, the same 8 rows the write-up derives every count from |
| Attio | **None.** Signup rejects personal email domains ([`attio-workspace.md`](attio-workspace.md)) |

## The beats

### 1. The front door says what needs a human

Open `/runs`. The header names the connected workspace, and the batch picker reads
`2026-W34 — 8 ready` — that count is a live Notion query, so the first screen is already
evidence the pipeline is reading real data rather than a fixture.

The point to make here is the ordering: the table sorts by *what needs a human*, not by
time ([`run-surfaces.md`](run-surfaces.md)). A run waiting on confirmation outranks a run
that finished an hour ago, because the cost of ignoring it is duplicate deals next week.

### 2. The wait is honest about being a wait

**Start run.** The URL does not change; a live row appears at the top.

Four steps, and the third one dominates: reading the batch (2–3s), building candidates
(<1s), **screening research notes (20–30s)**, running checks (~1s). The screening step is
one node making up to eight model calls, and the checkpoint only moves at node
boundaries, so the indicator sits still for most of the wait. It says so:

> Screening research notes — one call per row, nothing to report until all 8 are back

Do not apologise for this beat. It is the demo's cheapest illustration of a rule the whole
build follows — the app never invents movement it cannot observe.

### 3. The ledger — the beat that carries the argument

The run pauses at `awaiting_review` and `/runs/:runId` renders the candidate ledger. This
is the screen the write-up's figure comes from, and there are four things to point at,
in this order:

1. **`8 source rows → 21 candidates`.** The unit changed. This is
   [ADR-0001](adr/0001-flags-attach-to-candidate-records.md) made visible, and everything
   else follows from it.
2. **Brightyard, `2 rows merged`.** Two source rows, one Company. The sheet's `Domain`
   formula lands these one character apart and creates two companies; here they are one.
   This is the single most load-bearing claim in the write-up, and it is on screen.
3. **The two notices, each with its verbatim quote.** Heliograph — *"She previously spoke
   to the team under another email address"* — and Lattice Forge. These are the one job
   the model earns, and the panel says what it is worth: *nothing to change — this
   pipeline never reads Attio, so it can relay the note but cannot check it.* A model
   added attention and removed none.
4. **Export is refused.** `Not ready yet`, with the reason: two batch questions and three
   unanswered warnings. A guard is a screen, not an error.

Then answer the ledger: supply the deal owner and stage (asked once, for all seven),
take Brightyard as **one deal**, and **leave Tern Mobility held**. Holding Tern is the
choice that makes the demo match the numbers the write-up publishes — 7 of 8 source rows
reach Attio — and it shows the more interesting behaviour anyway: the Person is Held for
want of a work email, its Deal is Held on a Stop naming the sibling, and its **Company
still ships**, because only the irreversible object waits
([ADR-0003](adr/0003-a-company-candidate-is-never-dropped-with-its-people.md),
[ADR-0005](adr/0005-a-deal-is-emitted-only-when-its-account-is-clear.md)).

### 4. The bundle, on the same surface

The run moves to `awaiting_confirmation` and the files appear **inline beneath the ledger**
— the reviewer is not sent to a second screen to finish. `1-companies.csv` (1 row),
`2-people.csv` (7 rows), `3-deals.csv` (6 rows), and an inert `handoff-notes.md`. They
download as one ZIP named for the batch, and downloading twice changes nothing about the
run.

Open `2-people.csv`. Six of the seven companies reach Attio through its relationship
columns, which is why `1-companies.csv` carries one row rather than seven.

### 5. The step the demo cannot perform

**Here the walk stops, and says so.** The next act is a human importing three CSVs into
Attio by hand — and there is no Attio workspace to import them into. This is not skipped
quietly; it is the demo's most honest moment, and it is the same gap the write-up states
at length: the Attio write leg is out of scope, the byte format is settled from Attio's
six published templates rather than from experiment, and the real `Deal stage` labels are
unconfirmed.

What is shown instead is the guard around the gap. **Confirm import** is disabled with its
reason whenever it cannot be honestly clicked, and the wrong-workspace refusal names both
workspaces — *This run read Carpe Lab. You are connected to Demo Space.* — with reconnect
first and abandon below it, never instead of it.

### 6. The confirmation closes step 6 of the sheet

Click **Confirm import**. This is an attestation, not an observation: the app never reads
Attio, so the reviewer is asserting that the files landed. Only then does the write-back
run, and only on source rows whose **every** candidate reached the CRM — so `CRM status`
becomes `Imported` on **7 of the 8** rows, and Tern Mobility keeps `Ready for CRM` and
returns when W34 is re-run.

Then show Notion itself. That is the whole argument in one frame: the column the
spreadsheet could never write, written.

## The two figures, and why only one of them exists

The write-up gains figures from this walk, and they are **not** governed by the same rule.

| Figure | Source | Rule |
| --- | --- | --- |
| The review screen with its flags | The `prototype/review-screen` prototype, Variant B | **May** come from the prototype, as long as it is labelled as one |
| Notion `CRM status` after the write-back | A real write-back, or nothing | **Omitted rather than simulated** |

The asymmetry is deliberate. The review screen's job in the write-up is to show the
*shape* of the reviewer's surface — what the unit on screen is, what a flag looks like,
what refusing to export looks like. A prototype answers that honestly provided it says it
is a prototype, and the prototype was the primary source the real ledger was built from.

The write-back figure's job is different: it is the evidence that the pipeline closed the
loop the spreadsheet cannot. A screenshot of `Imported` that no write-back produced would
not be a weaker version of that evidence — it would be a fabricated version of it. So
until the walk in beat 6 is actually performed against our Notion workspace, the write-up
carries no such figure, and says why.

**To produce it:** perform beats 1–6 against the real workspace, then screenshot the
Notion database view showing `CRM status = Imported` on the seven rows with Tern Mobility
still `Ready for CRM` — the exception is half the point — and add it to
[`docs/figures/`](figures/).
