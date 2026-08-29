# ADR-0005: A Deal is emitted only when its whole account is Clear

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [What is the CRM status of a half-handed-off row?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/29)
- **Narrows:** [ADR-0001](./0001-flags-attach-to-candidate-records.md), and one sentence of [ADR-0003 (companies)](./0003-a-company-candidate-is-never-dropped-with-its-people.md)

> **Numbering note.** `main` already carries two ADRs numbered 0003 — one from [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8), one from [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) — written concurrently. This takes 0005 rather than 0004 so that 0004 stays free for whoever untangles that. [#48](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/48) untangled it: #16's is now [ADR-0009](./0009-the-server-keeps-its-own-record-of-runs.md).

## Context

[#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) writes `CRM status` = `Imported` back to Notion on the rows the app handed off. [ADR-0001](./0001-flags-attach-to-candidate-records.md) moved flags onto candidates, so a Stop excludes one candidate and leaves its siblings alone. Together those leave a source row that is only *partly* handed off, and `CRM status` has two values to describe it.

W34 is the case. Tern Mobility's row has no work email, so Amina Yusuf's Person candidate is Held while the Company and Deal candidates are Clear. Neither value is honest:

- `Imported` — the row never comes back and Amina is lost for good. The Stop becomes a silent delete.
- `Ready for CRM` — the row comes back and the deal is created a second time. [#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2) established that Deals have no unique attribute, always create, and have no undo.

### What actually reaches Attio

ADR-0001 assumed this was survivable: *"a held Person does not orphan its Company."* Two facts in [`docs/research/attio-csv-importer.md`](../research/attio-csv-importer.md) decide what a held Person really costs.

1. **Company attributes ride only in the people file.** Attio's guide for the three-object case says to strip company and person attributes from the Deals file, leaving `Associated company domain` alone. In a two-file bundle, holding an account's only Person left Attio creating a company from a bare domain — a stub with no name, location or LinkedIn.
2. **The deals file links people through `Associated people email addresses`, and empty values are skipped.** Amina has no email, so the cell is blank and the Deal is created **attached to nobody**, permanently.

[ADR-0003 (companies)](./0003-a-company-candidate-is-never-dropped-with-its-people.md), decided concurrently on [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8), **solves (1)** and solves it better than this ADR would have: Tern Mobility gets a real row in `1-companies.csv` rather than a stub, and `Clear` keeps its meaning. That half is settled and this ADR does not disturb it.

**(2) stands, and ADR-0003 accepts it explicitly:** *"The corresponding Deal candidate ships as usual in `3-deals.csv`, with an empty `Associated people email addresses` cell."* That single sentence is what this ADR overrules, because following it through produces the error the whole project exists to prevent:

> Run 1 — Amina held. The Deal ships with nobody attached. Per ADR-0003's own consequence, the row keeps `CRM status = Ready for CRM` and returns in a later run.
> Run 2 — the email is supplied. The Person ships. The Company matches on domain, exactly as ADR-0003 reasons. **And the Deal candidate is derived again and ships again.**
>
> Attio now holds two Tern Mobility deals. Deals always create. There is no undo.

ADR-0003 reasons carefully about the Company surviving the week and does not test the Deal against the same crossing. Its conclusion is right for Companies and wrong for Deals, and the difference is not a detail — it is the difference between a no-op and a permanent duplicate.

## Decision

**A Deal candidate is emitted only when every candidate in its account is Clear or answered.** Where it is not, the Deal candidate carries a Stop naming the sibling that caused it, and is Held — so, per the **Handoff bundle** rule, it is not in the files.

**`CRM status` = `Imported` means every candidate a source row feeds has landed in Attio.** Partial is not finished, so a partly handed-off row keeps `Ready for CRM`. No third `CRM status` option is added; the "no new options" call in [#5](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/5) / [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) stays closed.

**The Batch is the unit of retry.** The Notion filter is `Batch = 2026-W34` **and** `CRM status = Ready for CRM`, so a held W34 row does not appear in a W35 run at all — it is reached by running W34 again, which returns exactly the rows still `Ready for CRM`.

**This Stop has no "send anyway" override.** It is cleared by completing the account, not by forcing past it.

### Why Companies and Deals are treated differently

ADR-0003 objects in advance: letting a held Person decide a Clear candidate's fate is ADR-0001's rule *"leaking"*. That objection is correct for Companies and does not carry to Deals, because the two objects differ in the only way that matters here.

| | matched on | sending early | sending twice |
|---|---|---|---|
| Company | `Domains` | safe — upserts, and empty cells never clear a value | a no-op |
| Person | `Email addresses` | safe — same | a no-op |
| Deal | *nothing* | creates a record nobody can attach to | **a permanent duplicate** |

So the rule is not "a Stop now blocks its siblings". It is: **only the irreversible object waits.** ADR-0003's principle — a Company candidate's fate is never decided by its People — survives untouched. What it may not do is generalise from an upsertable object to the one object Attio cannot undo.

## Consequences

**The half-handed-off row stops being reachable in the dangerous direction.** Hold Amina and the Tern Deal is held too. The Company still ships in `1-companies.csv` per ADR-0003, so the account is in Attio the same week Maya qualified it. Nothing irreversible is emitted. Run W34 again once the email is supplied and the Deal is created exactly once.

**A row can stay `Ready for CRM` while some of its candidates are already in Attio.** Tern's Company lands while its row still reads `Ready for CRM`; Brightyard shows the other shape — hold Marta, and the Brightyard Deal is held, but Lewis's Person and the shared Company still go, and *both* rows keep `Ready for CRM`. Both come back on the next W34 run, the Person and Company upsert to no effect, and the one Deal is created once. The imprecision is always in the safe direction: `Imported` never overstates, and everything sent early is idempotent.

**The Reviewer's authority stops at one place.** [`CONTEXT.md`](../../CONTEXT.md) gives the Reviewer full authority to decide, and this takes some back: they cannot force a person-less Deal into `3-deals.csv`. They keep full authority over *facts* — per the **Reviewer edit** rule they may supply a work email, which goes back through the checks and clears the Stop. What they cannot do is make the pipeline emit a Deal it cannot describe. If that deal is wanted today, it is made in Attio by hand. A real cost, accepted, because the override reintroduces the exact permanent artifact the rule exists to prevent.

**A held Deal must be legible.** [#10](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/10) groups the ledger by Attio object, not by account, so a Deal vanishing from the Deals table would be a result with no visible cause. Expressing the rule as a Stop on the Deal candidate — *"Held. Amina Yusuf has no work email."* — puts the cause on screen without regrouping the ledger, and needs no new vocabulary: a flag exists only if the Reviewer can act on it, and they can.

**Most of [#13](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/13) falls out.** A deal that was never created cannot be duplicated by a retry, and the Batch filter keeps the retry scoped to the rows that were held.

## Alternatives considered

**Ship the Deal with an empty participants cell** — ADR-0003's position, and the status quo before this ADR. Rejected on the walkthrough above: it is not a lesser artifact, it is the duplicate-deal error on a two-run delay.

**Add a third `CRM status` option.** Rejected: it reopens the "no new options" call, and prescribes a schema change to Maya's real workspace to describe a state we can refuse to enter.

**Make "send anyway" the only exit from a Stop**, so a Reviewer may never leave one unanswered. Rejected: it costs the Reviewer the ability to defer across the whole review surface in order to fix one case.

**Hold the entire account whenever any candidate in it is flagged.** Rejected as too broad, and it would reverse ADR-0003 rather than narrow it. Holding Marta would deny Lewis's Person and the shared Company, which upsert safely and lose nothing by going early.

**Accept the data loss and write `Imported`.** Rejected: it turns a Stop into a delete, which is the one outcome a review step exists to prevent.
