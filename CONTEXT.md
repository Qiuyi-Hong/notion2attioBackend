# Context: Notion → Attio CRM handoff

Glossary for the weekly handoff of qualified accounts from Notion into Attio. Terms only — no implementation detail.

## Batch

One week's worth of qualified accounts, identified by the Notion `Batch` value (e.g. `2026-W34`) and filtered to `CRM status = Ready for CRM`. The unit the reviewer works through, and the unit the files are made from.

A batch is also the unit of retry. Because it is identified by both its `Batch` value and `CRM status = Ready for CRM`, a row held back in review is not reached by the following week — it is reached by running the same batch again, which then returns exactly the rows still waiting.

## Connection

The permission a person grants that lets the pipeline read a Notion workspace and write back to it. A connection names one workspace, and covers only the pages that person chose to share — never the whole workspace. It is granted once and lasts until that person withdraws it.

There is one connection at a time. Without it there is no batch to read: the connection, not the batch, is what the pipeline needs before it can start.

## Run

One pass of the pipeline over one batch — read the batch, propose candidates, pause for the Reviewer, make the files, pause again, and write the outcome back to Notion.

A run is the unit that pauses and resumes; it can outlive the browser tab that started it, and the second pause is expected to last hours. A run is addressed by its own identifier, which is the only thing a browser has to remember. A run is not *only* reachable that way, though: a run that nobody remembers can still be found, because a run whose second pause is never answered leaves work already done in Attio and no record of it in Notion.

A batch may be attempted by more than one run, but only **one after another**. A batch that a run still holds cannot be started again: the second run would read the same rows and make the same Deals, and Attio would create every one of them twice. A run holds its batch until it finishes — either it confirms the handoff, or the reviewer cancels it.

## Cancelling a run

The reviewer's act of ending a run without a confirmed handoff, which releases the batch for another run.

After the files are made, cancelling is an **attestation**, in the same way confirming is: it states that the files did not reach Attio. It is not a way to undo an import, because nothing can undo one. A reviewer who has already imported the files and then finds a mistake confirms the run instead, and corrects the records in Attio by hand — confirming is what stops the batch being handed off a second time.

## Handoff bundle

What a run produces for the Reviewer to carry into Attio: the **import files**, and one **notes file**.

An import file holds candidates of one kind, and is imported by hand into the matching Attio object. The import files have an order, because a record cannot be linked to one that does not exist yet.

The notes file is for the Reviewer alone and is never imported. It carries what the CRM cannot be given by import, together with the record of what the run repaired and what the Reviewer decided.

A bundle is made only once every Warn is answered. It holds every Clear and answered candidate, and no Held one.

## Source row

One row of the Notion export. A source row describes a company **and** a person together. It is the pipeline's input and nothing else — it is not the unit of review, and it is not what goes into Attio.

## Candidate

A Company, Person or Deal that the pipeline proposes to create in Attio, derived from the batch. Candidates are the unit of review.

One source row contributes to several candidates. Several source rows contribute to one candidate — two rows naming the same company domain produce one Company candidate. Avoid saying "row" when the thing meant is a candidate.

## Account

One Company candidate together with the Person candidates and the Deal candidate derived alongside it. Notion's `Account` column names the same thing at source.

The account, not the source row, is the thing that has to be whole before a Deal is sent. Several source rows can feed one account — Brightyard is one account with two people and one opportunity.

## Silent repair

A change the pipeline makes to a value without asking anyone. A repair is silent only when it is deterministic, reversible, and asserts nothing new about the world — it reformats a value already given. Every silent repair is written to the repair log; *silent* means it does not need the reviewer's attention, not that it is hidden.

Anything that would create, merge or discard a candidate, or that would assert a fact the pipeline does not hold, is not a silent repair. It is a flag.

A silent repair never applies to a **reviewer edit**. The pipeline repairs what Notion gave it, not what the reviewer typed: a value that changed the instant it was entered has no earlier state to compare it with, so its history would say nothing.

A language model's reading of a value is never a silent repair. It is neither deterministic nor reversible, and it asserts something the pipeline was not given. A model can therefore only raise a flag. It never changes a value the reviewer will send.

## Flag

One problem found on one candidate, or on the batch. A flag exists only if the reviewer can act on it: a warning nobody can answer is noise, not a flag. Every flag has a level.

### Stop

A flag level. The candidate must not be sent until a person clears the flag. A Stop never blocks the batch.

A Stop usually comes from the candidate's own values. It can also come from a sibling in the same account, because a Deal is sent only when every candidate in its account is Clear — so a held Person holds its account's Deal. Such a Stop names the sibling that caused it, and is cleared by completing the account. It is the one flag with no way to force past it: a Deal Attio cannot attach to anyone is a record nobody can undo.

### Warn

A flag level. The candidate can be sent, but a person must answer or read the flag first. A Warn excludes nothing, and the batch cannot be exported while any Warn is unanswered.

Every Warn is one of two kinds:

- **Decision** — the reviewer's answer changes the files.
- **Notice** — nothing changes. The pipeline records that a human read it. A notice is what the pipeline produces when it can only relay a suspicion it cannot check.

One flag is one *problem*, not one piece of evidence. A notice may therefore carry more than one kind of evidence for the same suspicion, and one span of the source text may be evidence for two of them. Lattice Forge's notes name both an earlier email alias and a match with an earlier campaign; both point at the one thing the reviewer can act on — *this person may already exist in Attio* — so they reach the reviewer as a single notice to acknowledge once, not as two.

### Batch flag

A flag that sits on the batch rather than on a candidate. Asked once, in one place, before the files are made.

A flag is a batch flag because of *when the reviewer answers it*, not because of the shape of the answer. The answer covers the whole batch. It need not be one value — it may reach different candidates differently.

## Candidate state

Read off a candidate's flags and holds — never typed in as a value.

- **Clear** — no flags. Goes into the files.
- **Needs decision** — one or more Warns. Goes into the files once the reviewer has answered every Warn.
- **Held** — stays out of the files. A candidate is Held for any of three reasons: it carries a Stop; the reviewer held it; or its Company candidate is Held.

These replace the working sheet's `READY` and `CHECK`. `READY` becomes `Clear`. `CHECK` splits: a missing work email becomes `Held`; everything the old rule missed becomes `Needs decision`.

## Derived value

A value the pipeline calculates from another value rather than reading from a source row. A Deal candidate's name is derived from its Company candidate's name.

A derived value lives in exactly one place — on the candidate that owns it — and reaches the import files when they are written. It is never copied onto a second candidate, so it can never go stale in one place and stay correct in another.

## Hold

The reviewer's act of keeping a candidate out of the handoff bundle. Distinct from a Stop, which is the pipeline's judgement; a hold is the reviewer's, needs no reason, and is available on every candidate.

A hold on a Company candidate reaches its People and its Deal, because a person line would otherwise create the company in Attio anyway. A hold on a Person or a Deal candidate reaches nothing else.

## Reviewer

The one person who works through a batch's flags, with full authority to decide. The working sheet's escalation — *"if a match is uncertain, leave the row in CHECK and ask Maya"* — has no counterpart here; it existed because a spreadsheet cannot record that the question was asked and answered.

## Reviewer edit

A value the reviewer changes by hand while working a batch. The counterpart to a **silent repair**: a repair is what the pipeline changed without asking, an edit is what a human changed having been asked.

An edit changes the **output** — the candidate a file will be written from. It cannot create, destroy or re-key a candidate, and it cannot make a flag appear or disappear. Editing a flagged value is not a way to answer the flag: what clears a flag is answering it, through the flag's own control.

An edit is nonetheless **validated** where it lands, and a value that fails validation comes back as a flag in the ledger rather than reaching a file. That is what stops an edit bypassing a check.

An edit is taken exactly as typed, and it **overrides** whatever the value was derived from — pinning it, so that no later change elsewhere can overwrite it. A value counts as overridden only when it differs from what the pipeline proposed; re-typing the same value changes nothing.

The reviewer cannot edit the values a candidate's identity is keyed on: a Company candidate's normalised domain and a Person candidate's work email. Those change only through a flag's own control.

This is the reviewer-facing counterpart of the rule on silent repairs. The pipeline may not assert a fact it does not hold, and the reviewer may not assert one either without the pipeline looking at it.

## Proven duplicate

Two or more source rows in the same batch that resolve to one candidate on evidence the pipeline holds — a shared company domain after silent repair, or a shared work email address.

Contrast with a **suspicion**: an assertion in the `Research notes` about records outside the batch, which the pipeline cannot check because it never reads Attio. A suspicion can only ever become a notice.

## Re-qualification

A person setting an already-imported source row back to `Ready for CRM`, under a later batch. It happens in Notion, by hand; the pipeline neither performs it nor detects it.

A re-qualified row produces a second Deal candidate for an account Attio already holds, and Attio creates a second Deal. That deal is **not** a duplicate. A company has many opportunities over its life, and the person who re-qualified the row asserted that this is another one. The pipeline takes the assertion as given, exactly as it takes every other value the source of truth gives it.

This is the third member of the set above. A **proven duplicate** is a repeat the pipeline can see and resolve. A **suspicion** is a repeat the pipeline is told about and cannot check. A re-qualification is a repeat that is correct, and so needs neither.
