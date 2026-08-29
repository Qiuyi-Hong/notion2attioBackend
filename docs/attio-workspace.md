# The Attio workspace, and what the docs don't say

Issue [#12](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/12). Companion
to [`docs/research/attio-csv-importer.md`](research/attio-csv-importer.md), which
established the importer contract from Attio's own documentation and ended with
fifteen things that documentation never states. Three of them change what our
emitter writes, and none can be settled by reading. This is the experiment that
settles them.

## Why this needs a human

Attio has **no CSV import endpoint** — import is UI-only ([#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2)).
The REST API can read the schema and read back records, but it cannot run an
import. So the encoding and delimiter questions require somebody clicking through
Attio's import wizard, and workspace signup requires a human besides.

Everything either side of those clicks is scripted, which keeps the manual part
to about five minutes:

| step                                         | who    | command                                |
| -------------------------------------------- | ------ | -------------------------------------- |
| sign up, enable Deals, create an API key     | human  | `npm run attio:setup` (walks it)       |
| enumerate objects, attributes, option labels | script | `npm run attio:schema`                 |
| generate the probe CSVs from the real labels | script | `npm run attio:probes`                 |
| import the three probe files                 | human  | Attio UI                               |
| read back exactly what landed                | script | `npm run attio:readback`               |
| try a direct write to the enriched select    | script | `node scripts/probe-attio.mjs write`   |
| delete the probe rows                        | script | `node scripts/probe-attio.mjs cleanup` |

`npm run attio:setup` runs the whole sequence in order and pauses at each manual
step, so in practice it is the only command you need.

## The three questions

### 1. What are the real `Employee range` option labels?

Attio's standard Companies `Employee range` is a **system enriched** attribute:
its options cannot be changed, and Attio publishes the list nowhere. Our Notion
source holds five distinct `Employees` values — `51–200`, `51-200`, `11–50`,
`11-50`, `201-500` — where the dash split is real at source, not a CSV artefact
([#5](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/5)).

`attio:schema` enumerates the options via
`GET /v2/objects/companies/attributes/employee_range/options` and prints a
coverage table: which of our five values match a real option as-is, which need
normalising, and which match nothing at all. A value in the last column cannot
be rescued — the option list is fixed — so that column decides whether
`Employee range` is worth emitting.

Every label is printed **codepoint-escaped** (`51\u{2013}200`). The whole
question is which dash it is, and a terminal will not tell you.

### 2. Can anything write to an enriched system select?

Two independent probes:

- **The schema already answers half of it.** The attributes API returns
  `is_writable`, which Attio documents as `false` for "protected system
  attributes, which are usually enriched by Attio". `attio:schema` prints it.
- **`probe-attio.mjs write`** attempts `PATCH /v2/objects/companies/records/{id}`
  setting `employee_range`. Accepted or rejected, that is a fact.

The importer is a third write path, and probe A carries a row on a **real
domain** (`stripe.com`) with a deliberately wrong range, so Attio's enrichment
has an opinion to overwrite us with. Re-running `attio:readback` hours later
catches a late overwrite that an immediate read would miss.

### 3. Does the importer care about bytes?

Three files that differ only in encoding, line endings and delimiter — see
[`data/attio-probes/README.md`](../data/attio-probes/README.md). They are
generated, never hand-written: a BOM, a CRLF and an en dash are invisible in an
editor and trivially destroyed by opening the file and saving it.

Each carries four select-matching rows (exact label, dash-swapped twin,
whitespace-padded copy, a value matching nothing) and a company name containing
`é`, an en dash and an emoji.

**Import them with "Create missing select options" switched off.** Ticking it
creates the option and erases the answer.

## Results

_Pending the run. Fill this in from the `attio:schema`, `attio:readback` and
`write` output, then post the same content as the resolution comment on
[#12](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/12)._

- **`Employee range` options (verbatim, codepoint-escaped):** —
- **Coverage of our five source values:** —
- **`is_writable` on `employee_range`:** —
- **Direct API write:** —
- **Enrichment overwrite after a delay:** —
- **UTF-8 round-trip (`é`, en dash, emoji):** —
- **BOM + CRLF:** —
- **Semicolon delimiter:** —
- **Dash folding in select matching:** —
- **Whitespace trimming in select matching:** —
- **Unmatched value:** —
