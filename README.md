# Notion → Attio: the weekly handoff

Maya qualifies accounts in Notion and moves them into Attio once a week, by hand,
through a working spreadsheet. This is the argument for replacing the part of that
job the spreadsheet cannot reach, and the evidence for it.

The write-up and the source are the same link. Every claim below is checkable
against files in this repo: the real workbook is
[`data/crm-handoff-working.xlsx`](data/crm-handoff-working.xlsx), the real batch is
[`data/notion-qualified-accounts-w34.csv`](data/notion-qualified-accounts-w34.csv),
and every count here is printed by `node scripts/derive-w34.mjs`. Nothing is quoted
from a ticket.

Detail lives behind links — eight [ADRs](docs/adr/), four
[research notes](docs/research/), and a committed
[worked example](docs/examples/handoff-2026-W34/) — so this stays short and the
evidence stays reachable.

---

## The job as it stands

The workbook's `Start here` tab lists six steps:

> 1. Filter the Notion database to `CRM status = Ready for CRM` and the current batch.
> 2. Export the filtered view as CSV.
> 3. Paste the exported rows into `Paste Notion Export`, beginning at A2.
> 4. Review the generated rows in `Attio Upload`. Correct anything that looks wrong.
> 5. Search Attio, then create or update the company and person and add the company to Qualified accounts.
> 6. Once the batch is done, mark the source rows `Imported` in Notion.

The sheet automates 1–4 — the steps that were never hard. It stops dead at 5, where a
person searches Attio and creates records one at a time, and at 6, where she goes back
to Notion and marks each row by hand. It cannot help with either, and the reason is
structural: **a spreadsheet has nowhere to record the outcome of a human importing rows
into another system.**

The `Attio Upload` tab carries **700 formulas across 50 rows and 14 columns, with zero
drift** — every column is one shape, filled down. It is a well-kept sheet. That is the
problem: consistency across 50 rows is not correctness on 8.

## The transform is deterministic, and still wrong

`Attio Upload!C2`, the `Domain` column, verbatim:

```excel
=IF(B2="","",LOWER(SUBSTITUTE(SUBSTITUTE('Paste Notion Export'!C2,"https://",""),"www.","")))
```

It strips `https://` and `www.` and nothing else. Run it over the 8 real rows of batch
`2026-W34`, beside `S1`, the repair this pipeline makes instead — *lowercase; strip
scheme, `www.`, path, trailing `/`*:

| Source ID | Website | sheet `Domain` | `S1` repair | |
| --- | --- | --- | --- | --- |
| `QL-260818-001` | `https://www.northbeam.example.com/` | `northbeam.example.com/` | `northbeam.example.com` | **not a domain** |
| `QL-260818-002` | `https://oriel.example.com/uk` | `oriel.example.com/uk` | `oriel.example.com` | **not a domain** |
| `QL-260819-003` | `https://tern.example.com` | `tern.example.com` | `tern.example.com` | |
| `QL-260819-004` | `https://brightyard.example.com` | `brightyard.example.com` | `brightyard.example.com` | |
| `QL-260819-005` | `https://www.brightyard.example.com/` | `brightyard.example.com/` | `brightyard.example.com` | **not a domain** |
| `QL-260820-006` | `heliograph.example.com` | `heliograph.example.com` | `heliograph.example.com` | |
| `QL-260820-007` | `www.alderfinch.example.com` | `alderfinch.example.com` | `alderfinch.example.com` | |
| `QL-260820-008` | `https://lattice.example.com/` | `lattice.example.com/` | `lattice.example.com` | **not a domain** |

**Four of the eight outputs are not domains.** Three keep a trailing slash the formula
has no case for; one, Oriel, puts a URL path into a domain field.

One of the four costs a record. `QL-260819-004` and `QL-260819-005` are the same
account — Brightyard, two contacts, one opportunity, and the second row's own notes say
so: *"Treat this as a second contact at the existing account, not a second
opportunity."* The two websites differ only in `www.` and a trailing slash, and the
formula removes exactly one of the two. They land **one character apart**:
`brightyard.example.com` and `brightyard.example.com/`.

Attio matches Companies on `Domains`. So the sheet's output creates **8 companies from 8
source rows, where the batch contains 7.** Maya's current process creates two Brightyard
companies, and nothing in the sheet can tell her.

Two further gaps in the same formula are real but untriggered by this batch, so they are
stated as latent rather than shown: it handles `https://` and not `http://`, and
`SUBSTITUTE` replaces *every* occurrence of `www.`, anywhere in the string.

## The check catches one problem of four

`Attio Upload!O2`, the `Row check` column, verbatim:

```excel
=IF(B2="","",IF(F2="","CHECK","READY"))
```

`F` is the work email. That is the whole rule. On W34 it returns **7 `READY` and 1
`CHECK`** — Tern Mobility, whose contact has no work email. It is right, and it is the
only thing it can be right about.

It does not see that Brightyard is one account across two rows. It does not see that
Heliograph's notes say the contact *"previously spoke to the team under another email
address"*, or that Lattice Forge's say the contact *"replied from a newer email alias"* —
duplicate-person traps stated in prose and nowhere else. And it **cannot** see them,
because it marks a *source row*, and a row cannot say *one company, two people, one
opportunity*.

The column named `Import state` sits beside it. It is worth reading the workbook rather
than the description of it: **`Import state` has no formula at all, in any of the 50
rows. The column is empty.** That is not an oversight — it is the same structural fact
as step 5. A spreadsheet has nowhere to record the outcome of an import that happens in
another system, so the column that would have recorded it was never written. Any
readiness the sheet *can* compute — `Row check` — is computed from data that exists
before Attio is opened, and is stale the moment the import runs.

So the same batch can be handed off twice. In Attio a Deal has **no unique attribute and
always creates**, with no undo ([research](docs/research/attio-csv-importer.md)). A
second handoff is a duplicate opportunity nobody can remove.

## What changes

**Candidates, not rows.** The pipeline splits a batch into Company, Person and Deal
**candidates** before any checking happens, keyed on the normalised domain and the work
email. Several rows can feed one candidate; one row feeds several. That is the unit that
can carry *one company, two people, one opportunity* — and the unit review happens on
([ADR-0001](docs/adr/0001-flags-attach-to-candidate-records.md)).

**A repair is not a judgement.** A change is a *silent repair* only when it is
deterministic, reversible, and asserts nothing new — it reformats a value already given.
Everything else is a **flag** the reviewer answers. Every repair is logged, and *silent*
means it does not need attention, not that it is hidden ([`CONTEXT.md`](CONTEXT.md)).

**Prove, or relay — never assert.** The pipeline never reads Attio. Brightyard is a
*proven* duplicate: both rows repair to one domain, and the evidence is in hand.
Heliograph and Lattice Forge are *suspicions* about records the pipeline has never seen,
so they reach the reviewer as notices to read, and change nothing.

**The confirmation closes step 6.** The reviewer downloads the bundle, imports it into
Attio by hand, and comes back — minutes or hours later, possibly at a different machine —
to confirm it landed. Only then does the pipeline write `CRM status = Imported` back to
Notion, and only on the source rows whose **every** candidate reached the CRM. Partial is
not finished, so `Imported` never overstates
([ADR-0005](docs/adr/0005-a-deal-is-emitted-only-when-its-account-is-clear.md),
[ADR-0007](docs/adr/0007-the-write-back-completes-or-is-abandoned.md)). That click is the
whole point: it is what stops a batch being handed off twice.

## Where the model does not earn its place

The brief comes from a company that sells AI for sales, and the obvious move is to put a
model in the transform. **The transform does not want one, and the honest result is
mostly negative.** Full reasoning in
[ADR-0002](docs/adr/0002-a-model-may-only-raise-a-flag.md).

Four plausible jobs for a model, three of them closed by evidence:

- **Normalising the domain** — deterministic. Four characters of regex beat a model that
  cannot be replayed.
- **Splitting the person name** — Attio takes a single full-name column, so the split is
  never performed at all.
- **Summarising the notes into a CRM field** — Attio's importer *cannot import notes by
  CSV*, and the Attio API leg is out of scope. There is no field to write into.
- **Reading the notes to route Brightyard** — the note *corroborates* a fact the pipeline
  already proves from the shared domain. It supplies nothing.

**One job survives**, and it is the one deterministic rules cannot reach: reading free
prose for the two suspicions — an earlier contact under a different email address, and a
match with an earlier campaign. No honest regular expression generalises those.

So the pipeline ships **exactly one model call**, and its contract is narrow by
construction: a closed list of two kinds; a verbatim quote checked programmatically as an
exact substring of the source notes, with any suspicion whose quote does not match
discarded; no confidence score; a fixed reviewer-facing sentence, so the model selects
and never narrates; and the full `Research notes` always on screen whether or not a
notice was raised. A model can add attention. It cannot remove it.

**A model output is never a silent repair.** It is neither deterministic nor reversible,
and it asserts something the pipeline was not given. It can only raise a flag, and it
never writes a value the reviewer will send.

With no API key the run still completes, carrying a notice that the notes were not read.
A missing key never produces a batch that looks clean.

## What W34 actually produces

Re-derived by `node scripts/derive-w34.mjs` from the batch data:

| | candidates | exported | held |
| --- | --- | --- | --- |
| Company | 7 | 7 | 0 |
| Person | 8 | 7 | 1 |
| Deal | 7 | 6 | 1 |

The bundle is `1-companies.csv` (1 row), `2-people.csv` (7 rows), `3-deals.csv` (6 rows)
and an inert `handoff-notes.md`. On confirmation, **7 of the 8 source rows** are marked
`Imported`.

The held pair is the interesting case. Tern Mobility's contact has no work email, so the
Person candidate is Held. The Deal is held with it — not because a Stop leaks to
siblings, but because **only the irreversible object waits**: a Company or a Person sent
early upserts safely and sending it twice is a no-op, while a Deal with an empty
participants cell is a record attached to nobody, permanently. The *Company* still ships,
in `1-companies.csv`, so the account is in Attio the week it was qualified. The source row
keeps `Ready for CRM` and returns when W34 is re-run
([ADR-0003](docs/adr/0003-a-company-candidate-is-never-dropped-with-its-people.md),
[ADR-0005](docs/adr/0005-a-deal-is-emitted-only-when-its-account-is-clear.md)).

The full bundle for this batch is committed:
[`docs/examples/handoff-2026-W34/`](docs/examples/handoff-2026-W34/), including the
repair log and every flag with its answer.

One finding that changes nothing downstream but is worth Maya's time: `Employees` holds
**5 distinct values for 3 ranges** at source — `51–200` and `51-200`, `11–50` and
`11-50`, `201-500` — an en dash and a hyphen kept as separate Notion select options. The
pipeline does not emit `Employee range` at all ([why](docs/attio-workspace.md)), so
nothing breaks. The Notion database is still worth tidying.

## Stated as untested, because it is untestable

**There is no Attio workspace, and one cannot be created.** Attio's signup rejects
personal email domains and requires a work email, and the restriction is documented
nowhere in their help centre. Three questions were re-settled from primary sources
instead of by experiment ([full account](docs/attio-workspace.md)):

- **The byte format is settled by observation, firmly.** Attio publishes six downloadable
  CSV import templates; `npm run attio:templates` downloads and inspects all six, and they
  agree unanimously — UTF-8, no BOM, CRLF, comma-delimited, RFC-4180 quoting, no trailing
  newline. Raw evidence in [`docs/attio-template-bytes.json`](docs/attio-template-bytes.json).
- **`Primary location` from a bare city is untested.** Attio's template shows
  `"City, State, Country"` (`San Francisco, CA, USA`); Notion holds `London`, `Bristol`.
  Whether Attio resolves a bare city is unknown and unknowable without a workspace. If it
  does not, the cell is dropped and nothing else breaks.
- **The real `Deal stage` labels are untested.** `Lead` is taken from Attio's published
  template, not from a live workspace. The labels must be confirmed before the first real
  import.

The probe harness for all of this is written and parked, not deleted
([`data/attio-probes/`](data/attio-probes/)). Anyone with a work email address settles
the open questions empirically in about five minutes with `npm run attio:setup`.

## Decisions, taken as decisions

Each of these is a gap made on purpose, with a reason. None is an oversight.

**The Attio write leg is out of scope.** The pipeline never reads or writes Attio; the
reviewer imports by hand and attests that it landed. That is what makes confirmation an
*attestation* rather than an observation, and it is why `CRM company ID` and
`CRM person ID` in Notion stay empty for ever. Adding the API leg is the single change
that would close the most gaps below.

**`Research notes` reach nobody.** Attio cannot import notes by CSV, so the prose is read
for flags and then dropped — where Maya pastes it into Attio by hand today. This is a
genuine **regression against the manual process**, not a neutral trade, and it is stated
as one. The stopgap is `handoff-notes.md`, which carries every note for the reviewer to
paste; the fix is the Attio API leg.

**A unique Deal `Source ID` is the right production answer, and is not shipped.** Deals
have no natural unique attribute, so Attio always creates them; a `Source ID` marked
unique in Attio would be a real key and would defuse the duplicate-deal problem outright.
It requires a schema change to a workspace that does not exist and cannot be tested.
Shipping an untestable schema dependency, to solve a problem the confirmation step already
defends against, trades a real risk for a theoretical one.

**The OAuth token is plaintext at rest.** One row in the SQLite file, single tenant, no
encryption. In production it is encrypted under a managed key or held in a secrets
manager. It is stored rather than kept in memory because a Run survives a restart, and a
Connection that did not would fail at the last step of the flow — the write-back, hours
later.

**Concurrency is single-process.** The in-process lock and the stage guard both assume one
Express process; two would each accept a resume. Only the write node's re-query of Notion
survives that. A real deployment puts the lock in the database.

**There is no authorisation.** A run identifier is a v4 UUID in a URL, and possession of it
is the entire access-control story. In production a Connection belongs to a user and every
Run is authorised against its owner, so the identifier stops being a bearer capability.
This is precisely why the app stays on localhost.

Two smaller ones, for completeness: rate limiting and retry against Notion are out of
scope, and a confirmation is taken at face value — nothing detects a reviewer who clicks
Confirm before the import finished. That last one is the residue of choosing a human
attestation over a signal that cannot be obtained, not an oversight.

## The decision record

| Where | What it settles |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | The vocabulary — batch, run, candidate, flag, silent repair, confirmation, write-back |
| [ADR-0001](docs/adr/0001-flags-attach-to-candidate-records.md) | Flags attach to candidates, not source rows |
| [ADR-0002](docs/adr/0002-a-model-may-only-raise-a-flag.md) | A model may only raise a flag — the negative result above |
| [ADR-0003 (companies)](docs/adr/0003-a-company-candidate-is-never-dropped-with-its-people.md) | A Company candidate is never dropped with its people |
| [ADR-0003 (runs)](docs/adr/0003-the-server-keeps-its-own-record-of-runs.md) | The server keeps its own record of runs, so a lost link is recoverable |
| [ADR-0004](docs/adr/0004-the-candidate-set-is-frozen-at-the-check-pass.md) | The candidate set is frozen at the check pass |
| [ADR-0005](docs/adr/0005-a-deal-is-emitted-only-when-its-account-is-clear.md) | A Deal is emitted only when its whole account is Clear |
| [ADR-0006](docs/adr/0006-a-repeat-deal-for-a-known-account-is-not-a-duplicate.md) | A repeat deal for a known account is not a duplicate |
| [ADR-0007](docs/adr/0007-the-write-back-completes-or-is-abandoned.md) | The write-back completes or is abandoned |
| [ADR-0008](docs/adr/0008-a-run-is-confirmed-only-through-the-connection-that-read-it.md) | A run is confirmed only through the connection that read it |

**Specifications** — [the handoff bundle](docs/handoff-files.md),
[the HTTP contract](docs/http-contract.md), [the run surfaces](docs/run-surfaces.md),
[the Notion source database](docs/notion-source-database.md),
[the Notion connection](docs/notion-oauth-connection.md),
[what the Attio docs don't say](docs/attio-workspace.md).

**Research** — [Attio's CSV importer](docs/research/attio-csv-importer.md),
[human-in-the-loop in LangGraph.js](docs/research/langgraph-hitl.md),
[Notion OAuth](docs/research/notion-oauth.md),
[the Notion query API](docs/research/notion-query-api.md).

## Re-deriving every number

```
node scripts/derive-w34.mjs     # every count above, from the batch data
node scripts/check-notion-fixture.mjs
```

The first runs both workbook formulas over the batch, derives the candidate counts, and
self-checks the eight headline numbers this write-up states. No token, no network. If a
number here disagrees with that output, the output is right.

## State of the build

The argument above stands on the workbook, the batch, the decision record and the
committed worked example. All four are in this repo now.

`src/` is still an Express scaffold: the graph — **transform → check → review → emit**,
with two interrupts and a write-back node — is specified in
[`docs/http-contract.md`](docs/http-contract.md) and not yet built. The frontend lives in
a separate repository and holds no pipeline logic. Where a running demo exists, it is
supporting evidence for this write-up rather than the other way round.
