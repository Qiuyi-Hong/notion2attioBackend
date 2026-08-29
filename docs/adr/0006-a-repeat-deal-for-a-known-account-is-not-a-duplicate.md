# ADR-0006: A repeat Deal for a known account is not a duplicate

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [How does week two avoid creating duplicate deals?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/13)

## Context

[#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2) established the fact this ticket exists for: Attio upserts Companies on `Domains` and People on `Email addresses`, but Deals have no natural unique attribute, so **every deal row is always a create**. Re-importing a deals file creates every deal in it a second time, permanently, with no undo.

Four decisions have since closed every path by which the pipeline could do that to itself.

- [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) writes `CRM status` = `Imported` after the reviewer confirms the handoff, so a confirmed batch leaves the filter and cannot be handed off twice.
- [#29](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/29) made the batch the unit of retry — the filter is `Batch` **and** `CRM status`, so a held row is never reached by the following week.
- [#29](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/29) also withholds a Deal candidate until its whole account is Clear, so a deal that was never emitted cannot be emitted twice.
- [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8) retired `Import state`, which had no formula in the working sheet and no destination in Attio.

That left one case the map handed to this ticket, and one nobody had named.

**The case the map named.** A person sets an imported row back to `Ready for CRM` under a later batch. The pipeline proposes a Deal for an account Attio already holds. We never read Attio, so we cannot see the first deal, and we cannot tell a deliberate act from a mistake.

**The case nobody named.** `POST /api/runs` takes `{ batch }` and has no guard whatsoever. A reviewer who starts a run, leaves it at `awaiting_confirmation`, and forgets it can start a second run over the same batch. Nothing has flipped to `Imported`, so the second run reads the same rows and emits the same deals. This is a same-batch duplicate, entirely within our reach, and it sits underneath the cross-week case the ticket was framed around.

The two are opposites, and the ticket's title conflates them. One is a repeat we should welcome. The other is a repeat we should refuse.

## Decision

**A repeat Deal that follows a re-qualification is correct, and the pipeline does nothing about it.** An Attio company holds many deals across its life. A person who moves a row back to `Ready for CRM` and stamps it with a later batch has asserted that this is another opportunity. The pipeline takes that assertion as given, as it takes every other value the source of truth gives it. `CONTEXT.md` gains **re-qualification** as a named, supported path.

**A batch is held by at most one live run.** `POST /api/runs` refuses a batch that another run still holds, with `409 batch_in_progress` and the existing run's identifier in `details`. Only a `done` run releases its batch; every other state — `running`, `awaiting_review`, `awaiting_confirmation`, `failed`, `stalled` — holds it.

**Cancelling a run after the files exist is an attestation.** `DELETE /api/runs/:runId` at `awaiting_confirmation` states *"these files did not reach Attio"*, in the same way `confirm` states that they did. A reviewer who has already imported and then finds a mistake **confirms** the run and corrects the records in Attio by hand.

## Consequences

**The ticket's title is answered by denying its premise.** Week two avoids duplicate deals in every case the pipeline controls, and in the one case it does not control, the second deal is the right outcome. The write-up gets a sharper line than a defence would have been: *we can tell you exactly which repeats we prevent, and exactly which one we welcome, and the difference is whether a human asserted it.*

**ADR-0004's escape becomes safe.** That ADR promoted "reject / cancel" from optional to required, as the sole escape once export locks the values, and described it as *"abandoning the run and starting a new one."* Followed literally after an import, that escape **is** the duplicate-deal error: the new run emits the same deals. The escape is now two escapes, chosen on a fact only the reviewer holds — cancel if the files never reached Attio, confirm if they did. ADR-0004's sentence is narrowed, not reversed.

**`failed` holds its batch.** This looks wrong and is not. The contract keeps no failure record of its own, so a `failed` run reads as `stalled` after a restart and is continuable; and a node can throw *after* the export, so a `failed` run may already have files a reviewer downloaded. Releasing on `failed` would hand the batch to a second run in exactly the state where that is most expensive.

**The error list gains a sixth code.** [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) declared a closed list of five. `wrong_stage` is about one run at the wrong pause; this is about a batch another run holds, and the browser must tell them apart to offer *"open the run that already exists"* rather than *"try again"*.

**`GET /api/runs` stops being only a recovery convenience.** #16 added it so a reviewer who closed the tab could find their run. It is now the thing a refusal points at, which is a better reason for it to exist.

**The reviewer can be locked out of a batch by their own abandoned run.** This is deliberate. The lock is not a dead end — the run is listed, and it can be confirmed or cancelled — but it does mean a person who neither confirms nor cancels cannot start again. That is the correct pressure: the unanswered question is *"did these files reach Attio?"*, and it is the only question that makes the next run safe.

**Nothing of ours remembers a deal across batches, on purpose.** See the first alternative below.

## Alternatives considered

**Detect a re-qualified row from our own history.** [ADR-0009](./0009-the-server-keeps-its-own-record-of-runs.md) narrowed #3's *"we persist nothing"* to *"we persist no candidate data of our own"* — but the LangGraph checkpoints are never swept, so the SQLite file does in fact hold every candidate of every past run, including every deal we ever emitted. Matching a new batch's company domains against them is cheap and needs no new store. Rejected on two grounds. It is **wrong** — Q1 settles that the second deal is correct, so the notice would fire on the supported path and train the reviewer to dismiss it. And it is **fragile in the one way that matters**: the evidence is local to one machine's SQLite file, so the same batch run from a second machine, or after the file is cleared, silently loses the memory. A check that is right only when nothing has moved is worse than no check, because it reads as a guarantee.

**Make `Source ID` a unique attribute on the Deal object.** The strongest available fix, raised by [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8) and deliberately left for this ticket to re-weigh. A unique key on Deals would turn re-import into an upsert and close the problem outright rather than defending against it. Rejected, and now for a second reason on top of #8's. #8's reason stands: [#12](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/12) established that no Attio workspace exists and none can be created, so the schema change cannot be tested end to end, and shipping an untestable schema dependency is the worse risk. The new reason is that it would be *actively wrong here*: an upsert key on Deals would silently collapse a legitimate re-qualification into an edit of the first deal, destroying the second opportunity the person asked for. It stays a write-up argument.

**Warn on a second run instead of refusing it.** Cheaper, and it never locks anyone out. Rejected because the entire failure mode is that the reviewer **does not know** the first run exists — a warning is addressed to knowledge the person does not have. It also asks them to make the import decision in the wrong place: the question is *"did the first run's files reach Attio?"*, which belongs on the first run, not in a dialog on the second.

**Put the batch in the Deal name — `Brightyard — New business (2026-W36)`.** It would let a salesperson tell two deals apart. Rejected because it writes our internal batch vocabulary into a customer-facing CRM field to solve a rare and legitimate case. [ADR-0004](./0004-the-candidate-set-is-frozen-at-the-check-pass.md) already makes `Deal name` a derived value the reviewer can override, so a reviewer opening a genuine second opportunity can name it at the one moment the right name exists.
