# Context: Notion → Attio CRM handoff

Glossary for the weekly handoff of qualified accounts from Notion into Attio. Terms only — no implementation detail.

## Batch

One week's worth of qualified accounts, identified by the Notion `Batch` value (e.g. `2026-W34`) and filtered to `CRM status = Ready for CRM`. The unit the reviewer works through, and the unit the files are made from.

## Source row

One row of the Notion export. A source row describes a company **and** a person together. It is the pipeline's input and nothing else — it is not the unit of review, and it is not what goes into Attio.

## Candidate

A Company, Person or Deal that the pipeline proposes to create in Attio, derived from the batch. Candidates are the unit of review.

One source row contributes to several candidates. Several source rows contribute to one candidate — two rows naming the same company domain produce one Company candidate. Avoid saying "row" when the thing meant is a candidate.

## Silent repair

A change the pipeline makes to a value without asking anyone. A repair is silent only when it is deterministic, reversible, and asserts nothing new about the world — it reformats a value already given. Every silent repair is written to the repair log; *silent* means it does not need the reviewer's attention, not that it is hidden.

Anything that would create, merge or discard a candidate, or that would assert a fact the pipeline does not hold, is not a silent repair. It is a flag.

## Flag

One problem found on one candidate, or on the batch. A flag exists only if the reviewer can act on it: a warning nobody can answer is noise, not a flag. Every flag has a level.

### Stop

A flag level. The candidate must not be sent until a person clears the flag. A Stop excludes only its own candidate; it never blocks the batch.

### Warn

A flag level. The candidate can be sent, but a person must answer or read the flag first. A Warn excludes nothing, and the batch cannot be exported while any Warn is unanswered.

Every Warn is one of two kinds:

- **Decision** — the reviewer's answer changes the files.
- **Notice** — nothing changes. The pipeline records that a human read it. A notice is what the pipeline produces when it can only relay a suspicion it cannot check.

### Batch flag

A flag that sits on the batch rather than on a candidate. Asked once, in one place, before the files are made.

A flag is a batch flag because of *when the reviewer answers it*, not because of the shape of the answer. The answer covers the whole batch. It need not be one value — it may reach different candidates differently.

## Candidate state

Derived from a candidate's flags — never set directly.

- **Clear** — no flags. Goes into the files.
- **Needs decision** — one or more Warns. Goes into the files once the reviewer has answered every Warn.
- **Held** — one or more Stops. Stays out of the files.

These replace the working sheet's `READY` and `CHECK`. `READY` becomes `Clear`. `CHECK` splits: a missing work email becomes `Held`; everything the old rule missed becomes `Needs decision`.

## Reviewer

The one person who works through a batch's flags, with full authority to decide. The working sheet's escalation — *"if a match is uncertain, leave the row in CHECK and ask Maya"* — has no counterpart here; it existed because a spreadsheet cannot record that the question was asked and answered.

## Proven duplicate

Two or more source rows in the same batch that resolve to one candidate on evidence the pipeline holds — a shared company domain after silent repair, or a shared work email address.

Contrast with a **suspicion**: an assertion in the `Research notes` about records outside the batch, which the pipeline cannot check because it never reads Attio. A suspicion can only ever become a notice.
