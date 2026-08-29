# The handoff bundle: what the user downloads, and what is in it

Issue [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8). Settles the
end of the pipeline — the artefact the reviewer actually carries into Attio.

Upstream constraints are not relitigated here. The import contract comes from
[`docs/research/attio-csv-importer.md`](research/attio-csv-importer.md) (#2), the
byte format from [`docs/attio-workspace.md`](attio-workspace.md) (#12), the flag
vocabulary from [`CONTEXT.md`](../CONTEXT.md) and
[ADR-0001](adr/0001-flags-attach-to-candidate-records.md) (#6), and the deal
fields from [#18](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/18).

A worked example built from the real W34 batch lives in
[`docs/examples/handoff-2026-W34/`](examples/handoff-2026-W34/). Its bytes were
generated and verified against the contract below, not written by hand.

## The bundle

One ZIP, named for the batch: **`handoff-2026-W34.zip`**.

| file              | destination     | present when                                  |
| ----------------- | --------------- | --------------------------------------------- |
| `1-companies.csv` | Attio Companies | always                                        |
| `2-people.csv`    | Attio People    | always                                        |
| `3-deals.csv`     | Attio Deals     | always                                        |
| `handoff-notes.md`| nobody          | always                                        |

The leading numbers are the import order, and they are load-bearing rather than
decorative. Attio writes relationships parent → child, and a deal row can only
attach to a company that already exists, so people must land before deals. A ZIP
that sits in a Downloads folder for a week loses every other cue about order; a
filename does not.

`handoff-notes.md` is deliberately **not** a CSV. A fourth CSV would be offered
to Attio's import screen by an auto-mapper and by a tired human. Markdown is
inert.

Byte format for all three CSVs, from #12: **UTF-8, no BOM, CRLF, comma-delimited,
RFC-4180 quoting, no trailing newline.** Multi-value cells are one quoted field
with comma-space separation.

## `2-people.csv`

The main file. Carries the Person candidates and, through relationship columns,
the Company candidates they belong to.

```
Person name,Email addresses,Job title,LinkedIn,Lead source,Source ID,Company name,Company domain,Company segment,Company primary location
```

| column                     | maps to                       | source                     |
| -------------------------- | ----------------------------- | -------------------------- |
| `Person name`              | Person `Name`                 | Notion `Contact`, unsplit  |
| `Email addresses`          | Person `Email addresses` (unique) | Notion `Work email`    |
| `Job title`                | Person `Job title`            | Notion `Job title`         |
| `LinkedIn`                 | Person `LinkedIn`             | Notion `LinkedIn`          |
| `Lead source`              | Person custom `Lead source`   | Notion `Lead source`       |
| `Source ID`                | Person custom `Source ID`     | Notion `Source ID`         |
| `Company name`             | `Company > Name`              | Notion `Account`           |
| `Company domain`           | `Company > Domains` (unique)  | Notion `Website`, repaired |
| `Company segment`          | `Company > Segment` (custom)  | Notion `Segment`           |
| `Company primary location` | `Company > Primary location`  | Notion `HQ`                |

One row per exported Person candidate. Several rows may name one company —
Brightyard produces two — and Attio merges them on the matching `Company domain`
without asking anyone.

### Why `Lead source` sits on the Person and `Segment` on the Company

The `Mappings` sheet sends `Lead source`, `Segment` and `Source ID` to custom
attributes and never says which object holds them. With no unconditional
companies file, a company attribute reaches Attio only through a person row — so
when two rows disagree, one value wins silently and nobody is told.

The batch decides it. Brightyard's two rows **agree** on `Segment` (`SMB`) and
`HQ` (`Bristol`) but **disagree** on `Lead source` (`Outbound research` versus
`Agency partner list`). A single company cannot hold both. `Lead source`
describes how one contact arrived; `Segment` describes the account. So
`Lead source` is a Person attribute and `Segment` is a Company attribute, on
evidence rather than taste.

### `Source ID` ships, but not as a unique attribute

`Source ID` is the handle back to the Notion page, and `Mappings` already sends
it to a custom attribute. It ships on `2-people.csv` only.

It is tempting to go further and mark it **unique** in Attio. Deals have no
natural unique attribute, so Attio always creates them (#2) — a unique
`Source ID` would be a real key and would defuse
[#13](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/13)'s
duplicate-deal problem outright. That is the right production answer and the
write-up should argue it.

It is not shipped, for one reason: #12 established that **no Attio workspace
exists and none can be created**, so the schema change cannot be tested. Shipping
an untestable schema dependency to solve a problem that #7's `CRM status` flip
already defends against trades a real risk for a theoretical one.

`Source ID` is therefore absent from `3-deals.csv` (which carries only unique
keys of linked records, per Attio's own instruction) and absent from
`1-companies.csv` (which has no person to carry it). A company imported through
`1-companies.csv` has no audit link back to Notion — an accepted, documented gap.

## `3-deals.csv`

```
Deal name,Deal owner,Deal stage,Associated company domain,Associated people email addresses
```

**One deal per Company candidate**, never one per source row. Brightyard's notes
are explicit — *"a second contact at the existing account, not a second
opportunity"* — and Attio's own template puts several participants in one quoted
cell. Deals always create and have no undo, so this is the file where a
granularity mistake is expensive and permanent.

`Deal name` is `<Company> — New business`, keeping the working sheet's em dash.
Attio's own convention is a hyphen (`Pulse - 6 seats`), but the byte format is
UTF-8, the character survives, and matching what Maya's sheet already produces
costs nothing.

`Deal owner` is read per deal from Notion's `Owner`; `Deal stage` is configured
for the batch, defaulting to `Lead`. Both are confirmed by the single batch flag
from #18. `Deal value` has no source in Notion and is not emitted.

A deal whose company has no exported person — Tern Mobility — is **withheld**,
not shipped with an empty `Associated people email addresses` cell. That
reverses what this document first said here, and
[ADR-0005](adr/0005-a-deal-is-emitted-only-when-its-account-is-clear.md) is
where it was reversed: a Deal always creates in Attio and has no undo, so one
attached to nobody is the single mistake in this bundle that nobody can take
back. The Company still ships, in `1-companies.csv`, because a Company upserts
on its domain and loses nothing by going early
([ADR-0003](adr/0003-a-company-candidate-is-never-dropped-with-its-people.md)).
The deal returns when the batch is re-run with the contact completed.

## `1-companies.csv`, and why it exists at all

#2 said plainly: do not emit a companies file *unless there are companies with no
people*. W34 is exactly that case, on the very first batch.

Tern Mobility has no work email, so #6 holds its Person candidate. Because a
Company reaches Attio only as a side effect of a person row, holding the person
would also delete the company and its deal — the whole account would silently
leave a batch it was qualified into. Worse, it would make `CONTEXT.md` false:
Tern's Company candidate carries no flag, so it is **Clear**, and Clear says
"goes into the files".

So the file exists. See
[ADR-0003](adr/0003-a-company-candidate-is-never-dropped-with-its-people.md).

It is **always emitted**, even when it carries no rows —
[ADR-0010](adr/0010-the-bundle-holds-the-same-file-set-every-week.md) reversed
ADR-0003's conditional half. The *rows* are still exactly the companies with no
exported person, so a week where every account has a contact produces a header
and nothing under it. The reviewer opens the same four files every week, and a
header-only companies file reads as *no company needed a row* rather than as *a
file is missing*.

```
Name,Domains,Primary location,Segment
```

Columns match Attio's published Companies template (`Name`, `Domains`,
`Primary location`) plus the custom `Segment`. `Description` and company
`LinkedIn` are in Attio's template but have no Notion source. `Employee range`
is deliberately absent (#12).

## What does not ship

| column                        | why                                                              |
| ----------------------------- | ---------------------------------------------------------------- |
| `Employee range`              | Attio enriches it; a manual value permanently suppresses that (#12) |
| `Research notes`              | Attio cannot import notes by CSV (#2); moved to `handoff-notes.md` |
| `Row check`                   | replaced by flags and candidate state (#6)                        |
| `Import state`                | the lifecycle now lives in Notion's `CRM status` (#7)             |
| `First name` / `Last name`    | Attio takes one full-name column (#2)                             |
| `Qualified on`                | needs an untestable custom attribute; a write-up recommendation   |
| `Batch`, `CRM status`         | pipeline metadata, not CRM data                                   |
| `CRM company ID` / `CRM person ID` | stay empty for ever; no Attio read leg (#7)                  |

`Import state` deserves its epitaph. It never had a formula, because a
spreadsheet has nowhere to record the outcome of step 5 — a human importing rows
into another system by hand. That is precisely the gap #7's confirmation step
closes, and it is a better argument in the write-up than a column ever was.

### Recovered from the unmapped Notion columns

`HQ` → `Company > Primary location`. It was in Notion and in no mapping, and
Attio's own Companies template has a home for it, so the sheet was simply losing
it.

⚠️ Attio's template shows `"City, State, Country"` (`San Francisco, CA, USA`) and
the Notion values are bare cities (`London`, `Bristol`). Whether Attio resolves a
bare city is **untested**, and untestable without a workspace. If it does not
resolve, the cell is dropped and nothing else breaks. The write-up should say so
rather than imply verification.

`Owner` was also unmapped and is now `Deal owner` (#18). `Qualified on` is real
data a CRM would want, but it needs a custom attribute nobody can test — so it is
argued for in the write-up, not shipped.

## W34, end to end

8 source rows → 7 company candidates, 8 person candidates, 7 deal candidates.
One person candidate held.

| file              | rows | contents                                            |
| ----------------- | ---- | --------------------------------------------------- |
| `1-companies.csv` | 1    | Tern Mobility                                       |
| `2-people.csv`    | 7    | 8 source rows minus the held Tern Mobility contact  |
| `3-deals.csv`     | 6    | one per company, less the withheld Tern Mobility deal |

Brightyard is the case worth reading in the example: two source rows, two
different website spellings, one repaired domain, one company row implied, two
person rows, and one deal row whose participants cell is
`"lewis.grant@brightyard.example.com, marta.silva@brightyard.example.com"` —
quoted and comma-space separated, exactly as Attio's template shows.

## Reproducing the example

The example files were generated from `data/notion-qualified-accounts-w34.csv`
and verified: valid UTF-8, no BOM, CRLF only with zero bare LF, and no trailing
newline, in all three CSVs. `npm test` asserts those four rules against the
committed files, so the exhibit cannot drift from the contract unnoticed.

The emitter that produces them for real is built
([#56](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/56), `src/emit.ts`),
and `test/handoff.test.mjs` runs the W34 batch end to end and compares what it
emits against the committed files **byte for byte** — then asserts the four
byte rules on the emitted bytes **separately**, so a future fixture regression
cannot pass by matching a wrong file. The exhibit is no longer illustrative: it
is the golden the emitter is held to.
