# What the Attio docs don't say, settled without a workspace

Issue [#12](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/12). Companion
to [`docs/research/attio-csv-importer.md`](research/attio-csv-importer.md), which
established the importer contract from Attio's own documentation and ended with
fifteen things that documentation never states. Three of them change what our
emitter writes.

## The workspace is unobtainable

**Attio's signup rejects personal email domains.** It requires a work email, which
we do not have, and Attio's help centre never documents the restriction — which is
why #12 was written assuming a Free workspace was a formality. It is not.

That kills the planned experiment. It does not kill the questions, because for
each one there turned out to be primary-source evidence that does not need an
account. Two of the three are now settled more firmly than a single probe would
have settled them; the third is settled by a decision rather than a measurement.

A second fact makes the loss smaller than it looks: **`Employee range` enrichment
is not available on the Free plan** ([enriched data](https://attio.com/help/reference/data-and-syncing/enriched-data)).
A free workspace would have been the wrong instrument for the headline question
anyway.

## 1. Encoding, BOM, line endings, delimiter — settled by observation

Attio publishes six downloadable CSV import templates and tells users to fill
them in and upload them. Whatever bytes they carry are bytes the importer is
guaranteed to accept. `npm run attio:templates` downloads all six and inspects
them; raw data in [`attio-template-bytes.json`](attio-template-bytes.json).

All six agree, unanimously:

| property         | finding                                                             |
| ---------------- | ------------------------------------------------------------------- |
| encoding         | valid UTF-8                                                         |
| BOM              | **none** — first bytes are the header text, never `ef bb bf`        |
| line endings     | **CRLF**                                                            |
| delimiter        | **comma**; zero semicolons or tabs outside quotes                   |
| quoting          | RFC-4180 double quotes, applied only where a value contains a comma |
| trailing newline | none                                                                |

**So our emitter writes UTF-8 without a BOM, CRLF line endings, comma-delimited,
RFC-4180 quoting.** Note the CRLF: the intuitive choice is LF, and it is probably
fine, but CRLF is what Attio itself ships and it costs nothing to match.

Multi-value cells are one quoted field with comma-space separation, exactly as
`docs/research/attio-csv-importer.md` predicted:
`"jane.doe@pulsehq.co, john.smith@pulsehq.co"`.

### Incidental findings the templates hand us

- **`Deal owner` is a workspace member's email address** (`emily.smith@basecamp.io`),
  not a name. That is a direct input to [#18](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/18).
- **`Deal stage` ships with `Lead`** as an example value.
- **`Deal value` is a bare number** — `5000`, no currency symbol or separators.
- **Phone numbers are bare digits** — `14155550123`, no `+` and no punctuation.
- **`Primary location` is `"City, State, Country"`** — so it needs quoting.
- Attio's own deal-name convention is `Pulse - 6 seats`. The sheet's
  `Company & " — New business"` uses an em dash; cosmetic, but ours to choose.

## 2. Can an imported value be written to an enriched select?

**Yes — and this reverses the assumption #12 was written on.** The ticket asked
whether "Attio's enrichment simply owns the value and overwrites whatever we
import". It does not:

> You can manually update most enriched attributes with your own data as desired,
> and any values you add manually **will not be overwritten** by Attio's enrichment.

— [Enriched data](https://attio.com/help/reference/data-and-syncing/enriched-data)

The research doc conflated two different immutabilities. Pulling them apart:

- **The schema is frozen.** "System attributes on Companies are not editable:
  their names, configuration, and options (for select and multi-select attributes)
  cannot be changed." — [Manage standard objects](https://attio.com/help/reference/managing-your-data/objects/manage-standard-objects).
  That sentence is about _names, configuration and options_, not values.
- **The values are writable**, per the enriched-data page above.

So the constraint on `Employee range` is neither "read-only" nor "overwritten".
It is narrower and more awkward: **our value must match one of Attio's fixed,
unpublished option labels, case-insensitively, or the cell is silently dropped.**

## 3. The `Employee range` option labels — genuinely unobtainable

This is the one question no substitute answers. The labels are not in the help
centre, not in the API reference, and not in the OpenAPI spec (checked: no
`employee_range` examples, no range-shaped example strings anywhere in the 1 MB
document). Only `GET /v2/objects/companies/attributes/employee_range/options`
against a live workspace returns them.

Our Notion source holds five distinct `Employees` values —
`51–200`, `51-200`, `11–50`, `11-50`, `201-500` — where the dash split is real at
source ([#5](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/5)). We
cannot tell which, if any, match.

### Why that stops mattering

Three pieces of evidence converge:

1. **Attio's own Companies import template omits it.** The template header is
   `Name,Domains,Description,Primary location,LinkedIn` — no `Employee range`, no
   `Categories`, no `Estimated ARR`. Precisely the enriched attributes are absent.
   Attio does not present these as fields you import.
2. **Attio fills it itself**, from the domain, on any paid plan.
3. **A manual value permanently suppresses enrichment for that field** — that is
   what "will not be overwritten" means, read from the other side.

Point 3 turns the sheet's `Employees → Employee range` mapping from wasted effort
into an actively harmful one: it freezes a stale, hand-maintained Notion value
into a field Attio would otherwise keep current, and it does so silently. The
best case is that our value matches a label and blocks better data; the worst is
that it does not match, the cell is dropped, and the mapping did nothing at all.

**Recommendation: do not emit `Employee range`.** If the source value is worth
keeping, it belongs in a custom attribute (options are freely creatable there),
not in Attio's enriched one.

Consequence for the transform: the `51–200` / `51-200` dash split stops being an
Attio problem. It remains a _Notion_ data-quality observation worth surfacing in
the write-up, and worth a notice-level flag under
[#6](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6)'s vocabulary, but
nothing downstream depends on normalising it.

## The probe harness is parked, not deleted

`scripts/probe-attio.mjs` and `npm run attio:setup` still work and still do the
right thing — they are simply unrunnable until somebody with a work email address
creates a workspace. If that ever happens, `npm run attio:setup` enumerates the
option labels and settles question 3 empirically in about five minutes. See
[`data/attio-probes/README.md`](../data/attio-probes/README.md).

One correction to make if it is ever run: the harness was written before the
template inspection, so it labels UTF-8/LF/comma as "what we intend to emit". It
is CRLF, per the templates.
