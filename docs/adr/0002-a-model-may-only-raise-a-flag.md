# ADR-0002: A model may only raise a flag

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [Where does an LLM earn its place in this pipeline?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/9)

## Context

The brief comes from a company that sells AI for sales, and the obvious temptation is to put a model in the transform. The transform does not want one. The `Attio Upload` sheet has zero formula drift across all 50 rows: every mapping is a copy, a substring or a concatenation, and all of it is deterministic.

Three of the plausible jobs for a model turn out to be already closed:

- **Summarising the notes into a CRM field.** `Mappings` sends `Research notes` to Attio `Notes`, handled today by a person pasting the text in. Attio's CSV importer cannot import notes at all — *"It's not currently possible to import tasks or notes via CSV file"* — and the Attio API leg is out of scope. There is no field to write a summary into.
- **Splitting the person name.** Closed by [#6](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6): Attio accepts a single full-name column, so the sheet's first-space split is never performed.
- **Reading the notes for routing.** Brightyard's *"Treat this as a second contact at the existing account, not a second opportunity"* is already proven by rule W1, because both rows share one company domain after silent repair. The note corroborates a fact the pipeline holds; it does not supply one.

One job survives. [#6](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6) fixed two notice rules — N1, an earlier contact under a different email address (Heliograph Systems), and N2, a match with an earlier campaign (Lattice Forge) — and deferred *how* to detect them in free prose to this decision. Both are assertions about systems the pipeline never queries. They are suspicions, not proven duplicates, and no honest regular expression generalises them.

## Decision

A model output can never be a silent repair, and never writes a value the reviewer will send. It can only raise a flag.

The pipeline ships exactly one model call, in one job: read a source row's `Research notes` and raise the notice Warns N1 and N2. The contract is narrow by construction.

- **The kind is a closed list.** The model classifies into N1 or N2 and nothing else. An open list would let it fill the Warn list with true but unactionable observations, and a batch cannot export until every Warn is answered. A gate the reviewer learns to rubber-stamp is worse than no gate.
- **Every suspicion carries a verbatim quote**, checked programmatically as an exact substring of the source notes. A suspicion whose quote does not match is discarded. The model points at evidence; the pipeline checks the pointer.
- **The model never writes reviewer-facing prose.** The reviewer reads a fixed sentence for the kind, plus their own source text. The model selects. It does not narrate.
- **The reviewer always sees the full `Research notes`**, whether or not a notice was raised. The model does not control what is visible; it only forces an acknowledgement. It can add attention. It cannot remove it.

The call runs in the `check` node, before the interrupt, and its result is checkpointed. [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) established that an interrupted node re-runs from the top, so a model call in `review` would be charged again on every resume and could return different notices under the reviewer mid-decision.

## Consequences

**The demo depends on a third-party API, and degrades without one.** With no key the `check` node skips screening and the batch carries a notice-level batch flag — *"The research notes were not read"* — which the reviewer must acknowledge like any other Warn. The run completes. A missing key never silently produces a clean batch.

**A screening log joins the repair log.** It records the model, the prompt version, and every item returned, including items the quote check discarded. The same rule as silent repairs applies: not needing the reviewer's attention is not the same as being hidden.

**A recall failure is survivable; a precision failure is not free.** Because the notes are always on screen, a missed suspicion leaves the reviewer exactly where Maya's sheet leaves them. A false notice, by contrast, costs real attention on every batch. The contract is therefore biased toward precision, and the quote check exists to make an invented suspicion structurally impossible to surface.

**`Research notes` now reach nobody.** They are read for flags and then dropped, where Maya pastes them into Attio by hand today. This is a genuine regression against the manual process and the write-up says so. Restoring it needs the Attio API leg, which is out of scope.

**[#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3)'s streaming conclusion survives its reason.** That ticket declined to wire streaming because there was no model. There is now one, and streaming is still declined: the call is a small structured classification inside a graph node, not a user-facing token stream.

## Alternatives considered

**No model at all — LangGraph purely as a durable HITL state machine.** Honest and defensible: the transform genuinely does not need one, and N1/N2 could be dropped or approximated with keywords. Rejected because it declines the one problem in the data that deterministic rules cannot reach, and a keyword match on free prose would claim a rigour it does not have.

**Let the model resolve the suspicion rather than relay it.** Rejected on capability, not on principle. Resolving *"she previously spoke to the team under another email address"* requires reading Attio, and the pipeline never does. A model that reported Heliograph as resolved would be asserting a fact nobody holds.

**Let the model apply changes it is confident about, above a threshold.** Rejected because there is no principled place to put the threshold, and a confidence score invites one. The contract omits the field deliberately.
