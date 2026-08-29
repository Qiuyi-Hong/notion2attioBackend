# ADR-0004: The candidate set is frozen at the check pass

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [What happens when a reviewer edits a value the transform derived from?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/31)
- **Amends:** the `Reviewer edit` term introduced by [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) (see *What this amends*)

## Context

[#10](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/10) chose the **candidate ledger**, in which every candidate in the batch is on screen and every field is editable inline. That choice bets on trust: Maya must be able to check the whole output, not only the exceptions. It also makes a question live that could not be asked before the unit of review was settled — what happens to everything the pipeline calculated *from* a value the reviewer has just changed.

Three cases, in increasing order of severity.

A **derived display value**. A Deal candidate's name is its company's name plus `" — New business"`. Rename the company and the deal name is stale — but the deal name is also a field the reviewer can edit directly, so live re-derivation would let an edit in one place silently overwrite an edit in another.

A **repaired value the reviewer then edits**. The nine silent repairs are logged and shown in place. If a repaired value is edited afterwards, it is not obvious whether the log entry is still true.

**Candidate identity.** A Company candidate is keyed on its normalised domain and a Person candidate on its work email ([ADR-0001](0001-flags-attach-to-candidate-records.md)); [#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2) found these are also the two attributes Attio upserts on. Both were editable under #10. Editing a key does not change a value — it changes *which candidates exist*, and therefore which flags exist. Edit one Brightyard row's domain and one Company candidate becomes two, so the decision Warn asking "one deal or two?" applies to nothing. Edit two domains to match and a decision Warn appears that the reviewer never asked for.

The obvious answer — re-run `transform` and `check` on every edit — collides with a decision already taken. [#9](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/9) placed the pipeline's one model call inside `check` **precisely because** [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) found that an interrupted node re-runs from the top: in `review` it would be charged again on every resume and could change notices under the reviewer mid-decision. Re-deriving on edit reintroduces exactly that, one layer down.

The W34 batch supplies the other half of the argument. All eight source rows carry a website the S1 repair normalises cleanly — a `www.` prefix and trailing slash on Northbeam, a `/uk` path on Oriel, both Brightyard spellings, `www.alderfinch`, a trailing slash on Lattice. Exactly one row, Tern Mobility, has an empty `Work email`, and that gap already has a purpose-built control in the B1 Stop. **No row in the batch requires the reviewer to type an identity value.**

## Decision

Freeze fixes **which candidates exist** and **which flags exist**. It does not stop one value from following another.

The candidate set and the flag set are fixed the moment `check` completes. The ledger edits values on candidates; it is a draft of the handoff bundle, not a live view of a running transform. Nothing the reviewer types can create, destroy or re-key a candidate.

- **The two identity-bearing values are read-only.** A Company candidate's normalised domain and a Person candidate's work email cannot be typed in the table. Identity changes only ever happen through a flag's own control, as the B1 Stop already does. This narrows #10's "everything is editable" to *every field the files carry, except the two the identity is keyed on*.
- **The one identity change we allow is validated where it happens.** The B1 control checks the supplied work email against every other Person candidate in the batch and refuses a duplicate. This is input validation on one control at resume time, not a second check pass — but without it, freeze could knowingly emit two person lines that Attio would collapse onto one record, last line winning.
- **Values derive at export, and an override pins.** A **derived value** follows its source until the reviewer overrides it directly; after that it stops following anything. A value is overridden only when it differs from what the pipeline proposed.
- **A value lives in exactly one place.** A Person candidate holds a *reference* to its Company candidate, not a copy of its name, so `people.csv`'s `Company >` columns are resolved when the file is written. Rename Brightyard once and both person lines follow. The company name is never overridable per person.
- **Nothing rewrites a value the reviewer sends.** An override is taken exactly as typed and is never silently repaired. This widens [ADR-0002](0002-a-model-may-only-raise-a-flag.md)'s rule from *a model never writes a value the reviewer sends* to *nothing does*. File-level byte format ([#12](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/12): UTF-8, CRLF, RFC-4180 quoting) is encoding, not repair, and still applies.
- **A hold cascades down from a Company.** Holding a Company candidate holds its People and its Deal, because `people.csv` reaches into the Company object through the `Company >` relationship and a person line would create the company in Attio regardless. Holding a Person or a Deal reaches nothing else.
- **Provenance is one surface with three kinds.** [#10](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/10) put provenance on the value rather than in a log elsewhere. A value is marked **repaired** (the pipeline changed this, unasked), **derived** (this follows another value), or **overridden** (the reviewer set this). An override marker replaces a derived marker, which is what makes pinning visible instead of hidden.
- **A reviewer's correction never returns to Notion.** The connection has update capability ([#14](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/14)) and [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) uses it, but only for `CRM status`. A value typed to release an export is not a correction offered to the source of truth; they are different acts and only one of them was consented to.

The run therefore has two freeze points, and both are easy to state: **`check` completes and the candidates are fixed; export completes and the values are fixed.**

## What this amends

[#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) settled the HTTP contract while this ticket was open, and introduced the `CONTEXT.md` term **Reviewer edit** to carry a rule it needed: *editing a flagged value must not become a way to launder the flag away.* It expressed that rule as **"an edit is not a correction applied to the output — it is a new input"**, going *"back through the pipeline's checks"*, able to *"clear a flag"* and *"raise a new one"*. #16 also deferred explicitly: *"what gets re-derived is #31's."*

Taken literally, that sentence is the re-derivation this ADR rejects, and it re-enters `check` — the one node [#9](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/9) placed the model call inside precisely so it could not run under the reviewer.

The rule #16 actually needed survives; the mechanism it named does not. **An edit is validated, not re-checked.**

- **Validation runs on the edited value, where it lands.** A work email that does not parse, or that collides with another Person candidate in the batch, comes back as a flag in the ledger — #16's re-interrupt, kept exactly as specified. This is input validation on one control, not a second check pass.
- **`check` does not run again.** No new flag appears, no candidate is created or destroyed, and the model call is not repeated.
- **Laundering is structurally impossible rather than defended against.** A flag is cleared by *answering it*, through the flag's own control — never by editing a table cell near it. Since the flag set is frozen, editing around a flag cannot make it disappear.

One distinction the freeze depends on: what is frozen is **which flags exist**, not whether each is answered. Answering a Stop clears it — that is the entire point of the review. What cannot happen is a flag appearing on, or vanishing from, a candidate because of something the reviewer typed.

`Reviewer edit` stays the noun, since #16 shipped it; this ADR's own term **override** is folded into it as what an edit *does* to a derived value. Two nouns for one concept is what the glossary exists to prevent.

## Consequences

**The graph shape is unchanged, and item 5 of the ticket answers itself.** Overrides ride in `Command({ resume })` into `review`, which stays side-effect-free, and the graph remains `transform → check → review → emit` exactly as [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) found it. Nothing re-enters `transform` or `check`. `emit` computes the derived values and must stay pure so it can re-run.

**The resume payload must be sparse, and this is now forced rather than preferred.** [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) treats whole-rows-versus-patch as an open design call. It is not: a whole-row payload cannot distinguish a value the reviewer set from one the pipeline derived, so every `Deal name` would arrive pinned and the derived-until-overridden rule would never fire.

**Two of the ticket's questions stop existing.** A Warn the reviewer has answered can never be orphaned, because the candidate it sits on cannot cease to exist; and a re-check can never raise a Stop on a candidate already cleared, because there is no re-check. The convergence argument a live re-derivation loop would have needed is not made, because the loop is not built.

**The check pass stays a pure function of the source rows plus a small set of explicit answers.** That is a far easier claim to defend in the write-up than any account of what a re-derivation loop settles to.

**Locking at export makes cancelling a run load-bearing.** The file leaves our control at the moment of download and may already have been imported, so an editable ledger afterwards would misdescribe what Attio holds. But a reviewer who spots an error after downloading and before importing then has no way to correct it. Abandoning the run and starting a new one becomes the only escape, which promotes [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16)'s "reject / cancel" bullet from optional to required.

**The same question is answered every week, for ever.** Tern Mobility's row returns next batch with no work email and Stops again; an override is lost with the run that produced it, since nothing of ours persists between batches. The pipeline can fix the file it emits and cannot fix Notion. The write-up says so rather than quietly closing the gap.

**`CONTEXT.md` gains two terms, rewrites one, and loses one overstatement.** **Derived value** and **hold** are new; **reviewer edit** is rewritten as above. Candidate state was defined as derived from a candidate's flags and "never set directly" — untrue since #10 gave the reviewer a hold control on every candidate, and further untrue now that a Company's hold reaches its People. It is restated as *read off a candidate's flags and holds*.

**Three ADRs are numbered 0003.** [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) and [#29](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/29) each landed one concurrently, and this one was drafted as a third. It takes 0004; the remaining collision between the other two is left for whoever owns them, since renumbering a merged ADR breaks the links already pointing at it. [#48](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/48) took that on and repaired the links: #16's is now [ADR-0009](./0009-the-server-keeps-its-own-record-of-runs.md).

## Alternatives considered

**Re-derive on every edit.** The intuitive answer, and the one the ledger's "everything is editable" appears to promise. Rejected because it re-enters `check` — where [#9](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/9) deliberately put the model call so it could not run under the reviewer — and because it makes the flag set unstable while a human is answering it. Answering a Warn on a candidate that then dissolves is not an edge case under this design; it is Brightyard, the batch's headline case.

**Keep identity fields editable, and let an edit to a key raise its own flag.** Coherent, and it preserves #10's promise literally. Rejected on evidence rather than principle: no row in W34 needs a domain typed, and the single email gap already has a control. It builds a mechanism for a case the data does not contain, and every flag it could raise would be one the reviewer caused.

**Let `Deal name` always follow the company name, with no override.** Rejected because [#6](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6) established that the expensive error lives in the deals file — Attio always creates deals, with no undo — so the deal name is the most permanent value we emit and the reviewer must be able to set it.

**Allow a Company hold without cascading.** Rejected because it would be a control that does not do what its name says: `people.csv` creates the company from its `Company >` columns, so the held company reaches Attio anyway. [#6](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6)'s rule that we flag only what the reviewer can act on has a sibling — a control must do what it claims.

**Write corrected values back to Notion alongside `CRM status`.** Technically available and genuinely tempting, since it would end the weekly repetition above. Rejected because it makes the pipeline a second author of the source of truth on the strength of a value typed to unblock an export.
