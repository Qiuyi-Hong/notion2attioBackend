# Attio CSV importer: what it accepts, and what "Attio-compatible" means

Researched 2026-08-29 against Attio primary sources only (attio.com/help, docs.attio.com, attio.com/blog, attio.com/changelog, the public OpenAPI spec at `https://api.attio.com/openapi/api`, and Attio's own downloadable CSV templates hosted on `a.storyblok.com` and linked from the help centre). Anything not backed by one of those is marked **[unverified]**.

## Bottom line

Attio's CSV import is **UI-only and per-destination**: you upload one file into exactly one object (or one list), and there is no CSV import endpoint anywhere in the public REST API. One file *can* populate more than one object in a single pass, but only in a parent → child direction: importing into **People** with company columns creates/links Companies, and importing into **Deals** with company/person columns creates/links both — so a mapping table spanning Company + Person + Deal needs **two imports**, one into People and one into Deals, which is exactly what Attio's own docs prescribe. Matching is real upsert, but only on **unique attributes you explicitly map**: Domains for Companies, Email addresses for People, Record ID for anything (Deals have *no* natural unique attribute, so Deal rows always create). Column headers are not a contract — mapping is interactive in the UI, with a heuristic auto-map that reads both header text and column contents; matching Attio's own template header names (`Person name`, `Company domain`, `Associated company domain`) just makes the auto-map land. A person's company link is expressed as a **linked-record column mapped through the relationship to a unique attribute** (`Company > Domains` or `Company > Record ID`) — a company-*name* column is mappable but will always create a new company rather than match an existing one. Names accept either a single Full-name column or separate First/Last columns. Select values are matched by option label **case-insensitively only**; no punctuation normalisation is documented, so `51–200` (en dash) and `51-200` (hyphen) are two different labels — and on the standard Companies `Employee range` attribute you cannot even add options, because it is a system enriched attribute whose options cannot be changed. There is **no undo/rollback**: you cancel an in-flight import or delete records afterwards.

## Implications for our CSV output

1. **Emit two files, not one and not three.**
   - `people.csv` → imported into **People**. Carries all Person attributes *plus* the Company attributes we want to set (company columns get mapped through `Company > …`).
   - `deals.csv` → imported into **Deals**. Carries all Deal attributes plus *only* the unique keys of the linked company and people (domain, email addresses) — Attio explicitly says to strip other company/person attributes from the Deals file.
   - Do **not** emit a separate `companies.csv` unless there are companies with no people; company records are created and enriched as a side effect of the People import. ([source](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv))
2. **Every emitted row must carry the unique key of every object it touches.** Person rows: an email address *and* the company domain. Deal rows: the company domain and the participants' email addresses. Without them Attio creates duplicates rather than matching, and the importer shows an "Avoid creating duplicate records" warning.
3. **Domain is our responsibility.** Company matching is on `Domains`, so if the Notion source only has a company *name*, we must derive/carry a domain — otherwise every import run creates fresh companies. (If we have person emails but no domains, Attio will auto-create companies from the email domain and link them, excluding public providers like gmail.com — an acceptable fallback, not a matching strategy.)
4. **Normalise select values ourselves, exactly.** Match Attio's option labels character-for-character apart from case. Pick one dash character for `Employee range` and every other range-style select. Do not rely on the importer to fold `51–200` into `51-200`.
5. **Check whether `Employee range` is the standard Companies attribute or a custom one.** If standard, its options are fixed and non-editable — our values must be from Attio's list or they will be rejected at the Review-values step. Enumerate the real labels before shipping via `GET /v2/objects/companies/attributes/employee_range/options`.
6. **Use `, ` (comma + space) inside a cell for multi-value columns**, and quote the cell. That is the only documented multi-value delimiter — which also means **no select option label of ours may contain a comma**.
7. **Emit dates as ISO `YYYY-MM-DD`** and timestamps as ISO8601, use `.` as the decimal separator for numbers, strip currency symbols, and write phone numbers as E.164 (`+14155552671`). Format is chosen once per column in the UI, so the column must be internally consistent.
8. **Full name in one column** (`Person name` / `Name`) as `Nicolas Sharp` — not `"Nicolas Sharp"`, not `Sharp, Nicolas`. Splitting into First/Last is also supported if we prefer.
9. **Name our headers after Attio's templates** to get a clean auto-map: `Person name`, `Email addresses`, `Job title`, `Company name`, `Company domain`, `Company LinkedIn`, `Name`, `Domains`, `Description`, `Primary location`, `LinkedIn`, `Deal name`, `Deal owner`, `Deal stage`, `Deal value`, `Associated company domain`, `Associated people email addresses`. This is convenience, not correctness — a human still confirms every mapping.
10. **Leave a cell blank to mean "don't touch"** — blank cells are skipped and never clear an existing value. There is no documented way to emit "clear this field".
11. **Deal rows are always creates.** Deals have no unique attribute other than Record ID, so re-running the deals import duplicates deals. Design the pipeline as one-shot, or plan to export Record IDs and re-import for updates.
12. **Budget for the caps**: ≤100,000 rows, ≤100 columns, ≤100 MB per file. Split larger outputs, and run imports one at a time.
13. **No API path.** Don't design an automated "push to Attio" step around CSV. If we ever want headless, it's `PUT /v2/objects/{object}/records` (Assert a record) with a `matching_attribute` — a different contract entirely.

---

## 1. Per-object or multi-object?

**Import is per-destination — one file, one object or one list — but a single file can create records in more than one object via relationship columns.**

Attio's own decision table:

> - **One object (e.g., Companies, People, or Deals):** Import directly into that object's page under **Records**, or into a list of that object.
> - **People and their companies:** Import into **People** (or a list of people).
> - **Deals and their companies:** Import into **Deals** (or a list of deals).
> - **Companies, deals, and people together:** You'll need two imports, one into **People** (or a list of people), and one into **Deals** (or a list of deals).

— [Import data into Attio via CSV, Step 1](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

### Creating a Person AND its linked Company in one pass — exactly how

Import the file into **People**. Include, per row: the person's unique attribute (email address), any person attributes, and one or more company columns which you map *through the relationship*:

> If you're importing people and include their company's domain and description, Attio will:
> - Update the existing company if the domain matches
> - Create a new company if no match is found
>
> In both cases, the company will be linked as the person's **Company**.
>
> To import attributes from a linked object, first select the relationship (e.g., **Company** or **Team**), then choose the specific attribute from that object.

— [Import data into Attio via CSV, "Importing attributes of linked objects"](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

Attio's downloadable **People and Companies** template confirms the shape (header row verbatim):

```
Person name,Email addresses,Job title,Company name,Company domain,Company LinkedIn
Jane Doe,jane.doe@cloudsync.io,Customer Success Manager,CloudSync,cloudsync.io,https://www.linkedin.com/company/cloudsync
```

— [attio-csv-import-template-people-and-companies.csv](https://a.storyblok.com/f/234930/x/f7f2c5ee36/attio-csv-import-template-people-and-companies.csv), linked from the import guide.

The reverse direction (import into **Companies**, listing team members) is supported but crippled:

> Include a column with a comma-separated list of email addresses for linked people. **Note:** This method only links people by email. It can't update other attributes (like Name or Job title).

and

> For relationships that support multiple values, you can only map unique attributes. […] Attio won't know which job title belongs to which email, so this setup isn't supported.

— same page.

### Ordering guarantee

> The importer will always write relationship attributes from the direction of parent > child. For example, if you were importing companies and specifying Team members (people), we create those people first, then the companies are created referencing those people. Since relationships are bi-directional, only when the company is successfully created does the Company attribute on people get set properly.

— [CSV import formatting guide, "Relationship attributes"](https://attio.com/help/reference/imports-exports/csv-imports/csv-import-formatting-guide)

### Three-object case (ours)

> If your file contains attributes for all three objects, companies, deals, and people, you'll need two imports: one into **People** and one into **Deals**.
>
> For the import into **People:** … Remove all deal attributes. Include all company and people attributes. Include unique attributes (e.g., Email addresses and Domains).
>
> For the import into **Deals:** … Include all deal attributes, including required ones: Deal name, Deal owner, Deal stage. Include unique attributes for linked people and companies (e.g., Email addresses and Domains). **Remove other company and people attributes.**

— [Import data into Attio via CSV, "Importing companies, deals, and people"](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

Attio's Deals template header row:

```
Deal name,Deal owner,Deal stage,Deal value,Associated company domain,Associated people email addresses
Pulse - 6 seats,emily.smith@basecamp.io,Lead,5000,pulsehq.co,"jane.doe@pulsehq.co, john.smith@pulsehq.co"
```

— [attio-csv-import-template-deals-domains-and-emails.csv](https://a.storyblok.com/f/234930/x/61601e3176/attio-csv-import-template-deals-domains-and-emails.csv)

Note the quoted, comma-space-separated multi-value cell.

---

## 2. Matching / dedupe

**It is upsert, but only on unique attributes that you have explicitly mapped. Map nothing unique → always-create.**

> Attio uses unique attributes to check for existing records, and will update existing records if they already exist rather than creating duplicates.

> If you're importing into objects like Companies or People **without including a unique attribute** (like Email addresses or Domains), you might end up with duplicate records.

— [Troubleshooting CSV imports](https://attio.com/help/reference/imports-exports/csv-imports/troubleshooting-csv-imports)

> If a record with a matching unique attribute value is found in Attio, it will be updated with the new values from your file. If no match is found, a new record will be created using the information in your file (except when using Record ID […]).

— [Bulk update records or lists via CSV import](https://attio.com/help/reference/imports-exports/csv-imports/bulk-update-records-via-csv-import)

### Unique attributes per object (the full documented list)

| Object | Unique attributes |
| --- | --- |
| Companies | **Domains** or Record ID |
| People | **Email addresses** or Record ID |
| Deals | Record ID only |
| Users | Primary email address, User ID, or Record ID |
| Workspaces | Workspace ID or Record ID |
| Custom objects | Record ID, or admin-created custom unique attributes |

— [Bulk update records or lists via CSV import, "Unique attributes for each object"](https://attio.com/help/reference/imports-exports/csv-imports/bulk-update-records-via-csv-import)

So yes: **Companies dedupe on domain, People on email address.** Deals have no natural unique attribute — a Deals import always creates unless you supply exported Record IDs.

### Is the matching attribute user-selectable at import time?

There is no separate "choose your matching key" control documented. The matching key is implicitly whichever unique attribute(s) you map on the **Map columns** step, so it is selectable in that sense. Attio warns when you haven't:

> **What does the "Avoid creating duplicate records" warning mean?** — This warning appears if you haven't mapped at least one unique attribute for each object in your import file. […] Without at least one unique attribute, Attio won't be able to check for existing records, which means new duplicates will be created when you proceed with the import. If you're importing into Deals and all the records in your file are new, you can safely ignore this warning and click **Continue without mapping**.

— FAQ, [Import data into Attio via CSV](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

For **lists** there *is* an explicit toggle, on the Map columns step, "For records already in the list": **Add again** (duplicates) vs **Update existing**. — same page.

### Duplicates *within the same file*

Documented, and the answer is "merged":

> The **Up to [X] will be created** note is an estimate. Attio checks your rows against existing records, but not against each other, so a new record listed on several rows appears more than once in the preview. **Attio merges those rows into a single record when the import runs if they share a unique attribute value.**

— [Import data into Attio via CSV, Step 6](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv); restated under "Preview showed more records than were created" in [Troubleshooting](https://attio.com/help/reference/imports-exports/csv-imports/troubleshooting-csv-imports).

The docs do **not** state which row's value wins for a single-value attribute when two rows for the same unique key disagree. See *Where the docs are silent*.

### Record ID caveat

> Do not include Record ID in your file if you're adding any new records, as they won't import successfully.
>
> If an ID matches an existing record during import, it will be updated; if not, it will be skipped.

— [Bulk update](https://attio.com/help/reference/imports-exports/csv-imports/bulk-update-records-via-csv-import) / [Import guide](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv). Corresponding errors are "No records found" and "The linked record was not found" ([Troubleshooting](https://attio.com/help/reference/imports-exports/csv-imports/troubleshooting-csv-imports)).

---

## 3. Column headers, and whether there's a headless import

**A header row is required, but the header text is a hint, not a contract. Mapping is interactive in the UI.**

File requirements, verbatim:

> - File type: CSV only
> - Header row: required, with each column labeled by attribute name (e.g., Name, Email address, City)
> - Maximum rows: 100,000
> - Maximum columns: 100
> - Maximum file size: 100mb

— [Import data into Attio via CSV, "General formatting and file requirements"](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

Mapping step:

> In the **Map columns** step, your file's columns appear on the left under **File column**, and Attio attributes on the right under **Attributes**. Attio will **auto-map columns where possible**. To adjust or map manually, select the appropriate attribute on the right. If an attribute doesn't exist, click **+ Create new attribute**. […] To skip a column, don't select an attribute, or click the **x** to remove an auto-mapped one.

— same page.

How much the header text matters — Attio's own description of the auto-map, from the importer launch post:

> We've upgraded our automatic value mapping to speed up the process for you. **We analyze the headers and entries in every column** to instantly identify the best matching attribute for each value.

— [The new Attio importer is here](https://attio.com/blog/the-new-attio-importer-is-here)

So: it is a heuristic over header text **and** cell contents, not an exact-name lookup. Attio never documents the matching algorithm (exact vs. fuzzy vs. thresholds) — see *Where the docs are silent*. The practical guidance is to copy the header names from Attio's own templates, which are the closest thing to a canonical spelling that Attio publishes:

- People: `Name,Email addresses,Job title,Description,Phone numbers,Primary location,LinkedIn` — [template](https://a.storyblok.com/f/234930/x/175fdf6914/attio-csv-import-template-people.csv)
- Companies: `Name,Domains,Description,Primary location,LinkedIn` — [template](https://a.storyblok.com/f/234930/x/e998c0de2c/attio-csv-import-template-companies.csv)
- People + Companies: `Person name,Email addresses,Job title,Company name,Company domain,Company LinkedIn` — [template](https://a.storyblok.com/f/234930/x/f7f2c5ee36/attio-csv-import-template-people-and-companies.csv)
- Deals + linked: `Deal name,Deal owner,Deal stage,Deal value,Associated company domain,Associated people email addresses` — [template](https://a.storyblok.com/f/234930/x/61601e3176/attio-csv-import-template-deals-domains-and-emails.csv)
- Also linked from the guide: [Deals](https://a.storyblok.com/f/234930/x/23c0505bf7/attio-csv-import-template-deals.csv), [Deals and Companies](https://a.storyblok.com/f/234930/x/8792194a4b/attio-csv-import-template-deals-and-companies.csv)

Note the templates deliberately use *descriptive* headers (`Company domain`, `Associated people email addresses`) that are **not** Attio attribute names — further evidence that the header is a label for a human mapping step, not a key.

### Headless / API CSV import: **no.**

- Attio's public OpenAPI spec (`https://api.attio.com/openapi/api`, `openapi: 3.1.0`, `Attio API 2.0.0`) exposes **53 paths**, none containing `import`, `csv`, or `bulk`. There is no import resource.
- Attio's own setup playbook lists the import methods as "CSV, Import2, API, or migration expert", where the API route means scripting record creation yourself, not uploading a CSV: "Use the API or Import2 to migrate records that can't be imported via CSV […] use the Attio API to script these yourself" — [attio.com/setup](https://attio.com/setup).
- The nearest API equivalent of an upsert row is **Assert a record**: `PUT /v2/objects/{object}/records` with a `matching_attribute` query param — "A matching attribute is used to search for existing records. If a record is found with the same value for the matching attribute, that record will be updated. If no record with the same value for the matching attribute is found, a new record will be created instead. […] The attribute must be unique." — [Assert a record](https://docs.attio.com/rest-api/endpoint-reference/records/assert-a-record). Note this API *does* have an explicit user-chosen matching attribute, unlike the CSV importer.
- The importer is reached only through the UI: "Click **Import / Export** in the top right, then choose **Import CSV**" — [Import guide, Step 3](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv).

Permissions: admins, or members with Read-and-write / Full access to the target object or list. — same page.

---

## 4. Person → Company link: exact accepted format

**A relationship/record column is expressed as a column mapped through the relationship to a *unique* attribute of the target record.** Not a bare name, not a bare relationship.

> To add a record to a relationship attribute, specify a unique attribute for that record. For example, you can't do this by mapping `Person > Company`. But you can do `Person > Company > Domains` or `Person > Company > Record ID`.

— [CSV import formatting guide, "Relationship attributes"](https://attio.com/help/reference/imports-exports/csv-imports/csv-import-formatting-guide) (identical wording under "Record attributes")

So, in a People import, the accepted forms are:

| Column content | Mapped to | Result |
| --- | --- | --- |
| `cloudsync.io` | `Company > Domains` | Matches existing company on domain, else creates one; links as the person's **Company** |
| `bf071e1f-…` (Attio Record ID) | `Company > Record ID` | Links to that exact company; errors ("The linked record was not found") if the ID doesn't exist |
| `CloudSync` | `Company > Name` | **Always creates a new company** — Name is not unique |

The third row is documented explicitly:

> If you import People with just their companies' names but no domains or Record IDs for the companies, you will create all new companies rather than connecting people to any existing companies.

— [Bulk update records or lists via CSV import, "Note for importing more than one object"](https://attio.com/help/reference/imports-exports/csv-imports/bulk-update-records-via-csv-import)

You can also carry additional company attributes (e.g. `Company > Description`) in the same People file, as long as the unique key column is present.

**Multi-value separator: a comma.**

> Some attributes, such as multi-select and relationship attributes, support multiple values. **Use a comma delimiter** to import multiple values into any given attribute. […] we can use a comma and a space to separate each value within the category cell.
>
> If an attribute can hold multiple values and already has some before your import, the values in your import will be added to the existing ones rather than replacing them.

— [Import data into Attio via CSV, "Multiple value delimiters"](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

Attio's Deals template shows the encoding in practice: `"jane.doe@pulsehq.co, john.smith@pulsehq.co"` in the `Associated people email addresses` cell (standard RFC-4180 quoting).

Fallback if we have no domains at all:

> If you don't already have company domains for your people, a good approach is to import only people with their email addresses. Attio will automatically create companies from those email domains and link them to them using the Company <> Team relationship attributes. […] This excludes public email providers like gmail.com, outlook.com, or icloud.com, which won't generate companies.

— same page.

---

## 5. Person name

**Either works — one Full-name column, or separate First and Last columns.** The `Name` attribute is a composite you map into.

> When importing names for person records, you can either import a single **Full name** column, or **First name** and **Last name** as separate columns (you don't need all three). When you go to select the mapping and click **Name**, you can select **First**, **Last**, or **Full** accordingly.
>
> As an example, to import `Nicolas Sharp`, you can either have a column with `Nicolas` mapped to **First** and another column with `Sharp` mapped to **Last**, or you can have a single column with `Nicolas Sharp` mapped to **Full.**
>
> When importing the full name, your column in the CSV should contain `Nicolas Sharp`, **not** `"Nicolas Sharp"` or `Sharp, Nicolas`.

— [CSV import formatting guide, "Name"](https://attio.com/help/reference/imports-exports/csv-imports/csv-import-formatting-guide)

Separate first/last columns were added in 2024: "You can now import `People` from a CSV file with separate first name and last name columns." — [Importing improvements changelog](https://attio.com/changelog/2024/importing-improvements)

The docs do not describe how a Full-name string is split into first/last (middle names, multi-word surnames, single-token names) — see *Where the docs are silent*.

---

## 6. Select attributes and the `51–200` vs `51-200` problem

### How a select value is matched

> Select options can be matched by the select option **label (they are not case sensitive)**, or the ID value. For example:
> - `3D Printing`
> - `3d printing`
> - `eccbbd4f-0d87-4c0d-972e-92fe0d0ec33d`

> Multi-select attributes accept the same formatting as Select, but each value should be split with a `,`. […] **This means your select option cannot include `,` in the label.**

— [CSV import formatting guide](https://attio.com/help/reference/imports-exports/csv-imports/csv-import-formatting-guide)

**Case-insensitivity is the only normalisation Attio documents.** No trimming, no Unicode folding, no punctuation equivalence. So `51–200` (U+2013 en dash) and `51-200` (U+002D hyphen) are two different labels as far as anything documented goes — they will not collide, and with "Create missing select options" enabled you'd end up with two options. **[unverified]** that Attio doesn't silently normalise dashes — the docs neither promise nor deny it; treat non-collision as the safe assumption and normalise upstream.

### What happens to a value not in the option list

Not a row rejection, and not a silent auto-create either — it's surfaced at the **Review values** step, where you choose:

> If you're importing select or multi-select attributes and your file includes values not yet added in Attio, select **Create missing select options** in the upper-right to add them during import.

> If a raw value doesn't match the required format, you'll see an **Invalid format** error. You can correct it by clicking into the mapped value cell. **If you don't fix it, the import will skip that value.** If all attributes for a record are invalid or blank, the record won't be imported.

— [Import data into Attio via CSV, Step 5](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

And from the changelog when this was added:

> For files with a select option column, we now highlight any matching errors in the review page, and enable you to add any missing select options in a single click.

— [Importing improvements](https://attio.com/changelog/2024/importing-improvements)

So the ladder is: **match by label (case-insensitive) or option ID → else flagged in Review values → operator either fixes the value, enables "Create missing select options", or skips the cell → an unfixed value is dropped (cell only, not the row)**.

### Single-select vs multi-select

The formatting guide treats them as one type with one difference — the comma split — and the "Create missing select options" control is described for "select or multi-select attributes" jointly. The one documented behavioural difference is on **update**:

> **Note:** When updating existing records, multi-select values imported will be added to any existing values on those records. **Existing values will not be replaced.**

— [CSV import formatting guide, "Multi-select attributes"](https://attio.com/help/reference/imports-exports/csv-imports/csv-import-formatting-guide); repeated with a worked example ("attio.com will show both **SaaS** and **Technology**") in [Step 4 of the import guide](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv).

Single-select on update is not explicitly documented, though the analogous statement in the bulk-update FAQ says "Updates made to attributes that support single values, such as User ID, will replace existing values." ([Bulk update FAQ](https://attio.com/help/reference/imports-exports/csv-imports/bulk-update-records-via-csv-import))

### The `Employee range` trap — check this before anything else

If your `Employee range` is **Attio's standard Companies attribute**, you cannot create options on it at all:

> **System attributes on Companies are not editable: their names, configuration, and options (for select and multi-select attributes) cannot be changed.**

and the table lists `Employee range | Estimated number of employees in a range | Enriched`.

— [Manage standard objects](https://attio.com/help/reference/managing-your-data/objects/manage-standard-objects)

Confirmed on the API side: "Company has several select attributes (they are mostly enriched attributes): `categories`, `estimated_arr_usd` and `employee_range`." — [Select attribute type](https://docs.attio.com/rest-api/attribute-types/attribute-types-select)

Consequence: on the standard attribute, "Create missing select options" cannot save us; our value must equal one of Attio's fixed option labels (case-insensitively). Attio does **not** publish that option list in its docs — enumerate it from your workspace with `GET /v2/objects/companies/attributes/employee_range/options` (path present in the OpenAPI spec as `/v2/{target}/{identifier}/attributes/{attribute}/options`). If instead our `Employee range` is a **custom** attribute we created, options are freely creatable and the dash question is entirely ours to settle by normalising before emit.

Related: deleting a select option is destructive and irreversible — "Deleting an option will also remove any existing data that uses it. This cannot be undone." ([Create and manage attributes](https://attio.com/help/reference/managing-your-data/attributes/create-manage-attributes))

---

## Other documented constraints worth encoding

### Limits
- 100,000 rows, 100 columns, 100 MB, `.csv` only, header row required. — [Import guide](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)
- Run one import at a time: "If multiple imports are started at once, or if a canceled import hasn't fully finished before starting another, an import may get stuck and fail to progress." — [Troubleshooting](https://attio.com/help/reference/imports-exports/csv-imports/troubleshooting-csv-imports)

### Empty cells on update
> **Empty values are skipped and won't overwrite existing data.**
> Only the attributes you map in your import will be updated while all others will remain unchanged.

— [Import guide, Step 2](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

Entirely blank rows are dropped: "Import cleaner data. The importer now skips blank records, so you don't end up with empty rows to delete later." — [Changelog (June 29, 2026)](https://attio.com/changelog/2026/changelog-june-29-2026)

There is **no documented way to clear a value via CSV import.**

### Date / number / timestamp formats
Chosen per column in the UI ("click the gear icon in the upper-right of the Review values step"), so each column must be internally consistent.

- **Number**: `9`, `9.00`, `1312313123.1233`. Stored as floats to 4 decimal places (extra digits dropped). No ±infinity. Decimal separator selected in the UI.
- **Currency**: exactly like numbers. "**Currency symbols are not supported**", one currency per attribute, no per-row currency.
- **Date**: ISO `YYYY-MM-DD`, or European (`14/07/2024`, `14-07-2024`, `14 Jul 2024`, `14th July, 2024`, …) or American (`07/14/2024`, `Jul 14, 2024`, `July 14th 2024`, …) if selected.
- **Timestamp**: default ISO8601, and any prefix of `2024-11-01T01:02:03.456789234Z` works (`2024-11-01` → `2024-11-01T00:00:00.000000000Z`).
- **Checkbox**: checked = `1`, `true`, `TRUE`, `#t`; unchecked = `0`, `false`, `FALSE`, `#f`; blank = unchecked.
- **Rating**: `1`–`5`; `0` = no value.
- **Text**: all text including line breaks; URLs render as clickable.
- **Location**: one column holding `City, State, Country` (or a subset), mapped to `Primary location`; Attio splits it.
- **Phone**: E.164, `+` country code then full number; hyphens optional; validated against real country/area-code rules and rejected if implausible.
- **Foundation date**: year only (`1984`); a full date is truncated to the year.
- **LinkedIn company** must start with `linkedin.com/company`; **LinkedIn person** must start with `linkedin.com/in`.
- **User attributes** (e.g. Deal owner) match in order: workspace membership ID → email address → full name → first name; zero or 2+ matches fails validation and must be fixed in Review values.
- **Status attributes** (e.g. Deal stage) match by stage label, case-insensitive, or by ID.

— all from the [CSV import formatting guide](https://attio.com/help/reference/imports-exports/csv-imports/csv-import-formatting-guide)

### Required attributes
Deals require **Deal name, Deal owner, Deal stage** on every row; a missing one produces "A required value was not provided". — [Import guide](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv) / [Troubleshooting](https://attio.com/help/reference/imports-exports/csv-imports/troubleshooting-csv-imports)

### Undo / rollback: none documented
The documented import states are Draft, In progress, Canceled, Failed; you can cancel an in-progress import from the ⋮ menu, and delete a draft. — [View and manage CSV imports](https://attio.com/help/reference/imports-exports/csv-imports/view-and-manage-csv-imports)

The only remedy after the fact is manual cleanup:

> Depending on the number of duplicates, it may make sense to navigate to the all records page […] bulk select the records created by the import, delete them, and then redo the import with a unique attribute. **Use the Created at attribute in filter and sort settings to help isolate the records created by the import for deletion.**

— [Troubleshooting](https://attio.com/help/reference/imports-exports/csv-imports/troubleshooting-csv-imports)

Nothing anywhere in the help centre or changelog describes an "undo import" / rollback feature.

### Not importable via CSV at all
Notes, tasks (FAQ: "It's not currently possible to import tasks or notes via CSV file. […] Notes and tasks can also be created using Attio's API"), comments ([attio.com/setup](https://attio.com/setup)), and call recordings (FAQ: "It's not currently possible to import call recordings into Attio"). — [Import guide FAQ](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv)

### Import state is durable
> You won't lose any changes if you click Back or move between steps during an import. If you close the window or navigate away, your import is saved automatically. You can pick up where you left off anytime from the Import history page in Settings.

— [Import guide FAQ](https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv). Drafts can also be shared with a teammate by link. — [View and manage CSV imports](https://attio.com/help/reference/imports-exports/csv-imports/view-and-manage-csv-imports)

---

## Where the docs are silent

Every item below is **not answered** by any Attio primary source I could find. Treat each as needing an experiment in a scratch workspace before we depend on it.

1. **Character encoding.** The docs never say UTF-8, never mention BOM handling, and never say what happens to Latin-1 / UTF-16 files. Our en-dash question makes this material. **[unverified]** — assume UTF-8 without BOM, and test one file containing `–`, `é`, and an emoji.
2. **Field delimiter.** Only "CSV" is stated. Semicolon-delimited files (common in European Excel exports) are never mentioned, and no delimiter picker is described in the UI flow. **[unverified]** — emit comma-delimited.
3. **Quoting / escaping rules.** Attio's own templates use RFC-4180 double-quoting with doubled inner quotes, and text attributes "support line breaks", implying quoted multi-line cells work — but no quoting spec is published. **[unverified]**
4. **Line endings** (LF vs CRLF). Never mentioned. **[unverified]**
5. **The auto-map algorithm.** "Analyze the headers and entries in every column" (blog) is the only description. Whether it is exact-name, case-insensitive, fuzzy/edit-distance, or content-based, and whether a wrong auto-map is silently kept, is undocumented. This is why header text cannot be treated as a contract.
6. **Whether select-option matching normalises anything beyond case** — trimming leading/trailing whitespace, collapsing internal whitespace, Unicode NFC/NFKC, dash equivalence (`-` vs `–` vs `—`). Only "not case sensitive" is documented. **This is the exact `51–200` / `51-200` question, and it is not answered.**
7. **The actual option labels of the standard Companies `Employee range` attribute.** Not published in the help centre or API docs. Enumerate via `GET /v2/objects/companies/attributes/employee_range/options`.
8. **Whether the importer can write to an enriched system select attribute at all** (as opposed to Attio's enrichment owning it). The docs say system attribute *options* can't be changed and mark `Employee range` "Enriched", but do not say whether an imported value is accepted, ignored, or later overwritten by enrichment. **[unverified]** — high-value experiment for us.
9. **Conflict resolution for single-value attributes when two rows in the same file share a unique key.** Attio says the rows are merged into one record but not which value wins (first row, last row, non-empty). **[unverified]**
10. **How a Full-name string is split into first/last** — middle names, particles (`van der`), compound surnames, mononyms. Undocumented.
11. **Whether a Person's `Company` relationship is replaced or appended** when a person already has a company and the import supplies a different one. The append-not-replace rule is stated for multi-select and "attributes that can hold multiple values"; `Company` on People is single-valued in the standard model, and its update behaviour on import is not spelled out. **[unverified]**
12. **Any way to clear a value via import.** Empty cells are documented as "skipped"; no sentinel (e.g. an explicit blank marker) is documented.
13. **Whether Deal rows can be matched on anything other than Record ID** — e.g. a custom unique attribute on Deals. Custom unique attributes are documented only for *custom* objects ("Custom required attributes can only be created on custom objects. They aren't supported on lists or the standard Companies, People, Deals, Workspaces, or Users objects" — [Create and manage attributes](https://attio.com/help/reference/managing-your-data/attributes/create-manage-attributes)), which reads as ruling it out for Deals, but the *unique* case is not stated as crisply as the *required* case. **[unverified]**
14. **Rate/throughput and how long a 100k-row import takes.** "Large files may take longer" is all there is.
15. **Whether the two-file (People, then Deals) sequence has an ordering requirement.** Deals reference companies by domain and people by email; whether running Deals first (creating stub companies/people) then People second yields the same result as the reverse is not documented. **[unverified]** — safest to run People first.

---

## Source index (all primary)

- https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv
- https://attio.com/help/reference/imports-exports/csv-imports/csv-import-formatting-guide
- https://attio.com/help/reference/imports-exports/csv-imports/bulk-update-records-via-csv-import
- https://attio.com/help/reference/imports-exports/csv-imports/troubleshooting-csv-imports
- https://attio.com/help/reference/imports-exports/csv-imports/view-and-manage-csv-imports
- https://attio.com/help/reference/attio-101/introduction-to-data-importing
- https://attio.com/help/reference/managing-your-data/objects/manage-standard-objects
- https://attio.com/help/reference/managing-your-data/attributes/create-manage-attributes
- https://attio.com/help/reference/imports-exports/migrate-data-from-another-crm
- https://attio.com/setup
- https://attio.com/blog/the-new-attio-importer-is-here
- https://attio.com/changelog/2024/importing-improvements
- https://attio.com/changelog/2026/changelog-june-29-2026
- https://docs.attio.com/rest-api/attribute-types/attribute-types-select
- https://docs.attio.com/rest-api/endpoint-reference/records/assert-a-record
- https://docs.attio.com/rest-api/endpoint-reference/openapi and the spec itself at https://api.attio.com/openapi/api
- Attio CSV templates: [People](https://a.storyblok.com/f/234930/x/175fdf6914/attio-csv-import-template-people.csv), [Companies](https://a.storyblok.com/f/234930/x/e998c0de2c/attio-csv-import-template-companies.csv), [Deals](https://a.storyblok.com/f/234930/x/23c0505bf7/attio-csv-import-template-deals.csv), [People and Companies](https://a.storyblok.com/f/234930/x/f7f2c5ee36/attio-csv-import-template-people-and-companies.csv), [Deals and Companies](https://a.storyblok.com/f/234930/x/8792194a4b/attio-csv-import-template-deals-and-companies.csv), [Deals, Domains, and Emails](https://a.storyblok.com/f/234930/x/61601e3176/attio-csv-import-template-deals-domains-and-emails.csv)
