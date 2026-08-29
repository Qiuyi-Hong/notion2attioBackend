# ADR-0003: A company candidate is never dropped with its people

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [What files does the user download, and what is in them?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8)

## Context

[#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2) established that Attio's CSV import is per-destination, and that a company is best created as a *side effect* of importing people: a `people.csv` row carrying `Company domain` makes Attio create or match the company and link it. Attio's own guidance follows from that — do not emit a separate companies file unless there are companies with no people.

That guidance quietly assumes every company in a batch has at least one exportable person. The very first batch breaks the assumption.

Tern Mobility (`QL-260819-003`) has no work email. [#6](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6) makes that a Stop, so its Person candidate is **Held** and stays out of the files. Because the company had no other route into Attio, holding the person would also delete the Company candidate and the Deal candidate. The whole account would leave a batch it had been qualified into, and nothing in the output would say so.

Two things make that unacceptable rather than merely unfortunate.

First, it contradicts the vocabulary. `CONTEXT.md` defines **Clear** as "no flags. Goes into the files." Tern Mobility's Company candidate carries no flag, so it is Clear — and it would not go into the files. [ADR-0001](0001-flags-attach-to-candidate-records.md) made candidates the unit of review precisely so that one source row's problem does not silently decide another candidate's fate. A Stop is defined to exclude "only its own candidate; it never blocks the batch". Letting a held Person delete a Clear Company is that rule leaking.

Second, it is the wrong outcome on the merits. A company and its opportunity are useful in a CRM before a named contact exists. Maya qualified the account at a summit; the missing item is an email address, not the account.

The alternative considered was to drop the account and let it return in a later batch once someone captures an email. It is simpler and it loses nothing permanently. It was rejected because it fixes the symptom by weakening the definition of Clear, and because the drop is invisible in the output — the reviewer sees seven companies on screen and imports six, with no artefact recording the seventh.

## Decision

**A Company candidate's fate is never decided by its People candidates.**

Concretely, the run emits `1-companies.csv` — a third import file, ahead of people and deals — containing exactly those Company candidates that are Clear or answered but have no row in `2-people.csv`. On W34 that is one row: Tern Mobility.

The file is **conditional**. Most batches will not produce one, and emitting an empty companies file every week would train the reviewer to ignore a file that occasionally matters.

The corresponding Deal candidate ships as usual in `3-deals.csv`, with an empty `Associated people email addresses` cell.

## Consequences

- The handoff bundle holds three import files, not two, and the numbered filenames now carry a three-step order: companies, then people, then deals.
- A company imported this way has no `Source ID`, because `Source ID` was placed on the Person object. There is no audit link from that Attio company back to its Notion row. Accepted and documented rather than solved; solving it would mean a second custom attribute on Companies, which [#12](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/12) leaves untestable.
- The held Person's Notion row keeps `CRM status = Ready for CRM` and returns in a later batch, per [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7). When it does, its `people.csv` row will carry the same `Company domain`, and Attio will match the company created here rather than creating a second one — so the domain repair stays load-bearing across weeks, not just within a batch.
- `Clear` keeps its meaning. The files changed; the vocabulary did not.
