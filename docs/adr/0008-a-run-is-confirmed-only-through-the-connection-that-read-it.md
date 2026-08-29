# ADR-0008: A run is confirmed only through a Connection naming the workspace that read it

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [Can a run be confirmed against a connection that did not read it?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/42)
- **Builds on:** [ADR-0007](./0007-the-write-back-completes-or-is-abandoned.md) — promotes one of its consequences to a rule, and **widens** its precondition on abandoning

> **Numbering note.** `main` still carries two ADRs numbered 0003, written concurrently on [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8) and [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16). That collision is still open. This takes 0008.

## Context

[#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15) established that a **Connection** is application-wide and that exactly one exists at a time. [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) established that a **Run**'s second pause can last hours: the Reviewer downloads the handoff bundle, does the Attio import by hand, and returns later to confirm.

Nothing joined those two facts. Between the download and the confirmation the Connection can be withdrawn and a new one granted — plausibly naming a **different Notion workspace**, since granting one is three clicks and the demo re-records the flow repeatedly. The run's checkpoint still holds page ids from the old workspace.

[#35](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/35) settled the *absent* case — **Confirm import** is disabled while no Connection is live — and explicitly parked the *different* case here.

[ADR-0007](./0007-the-write-back-completes-or-is-abandoned.md) had already reached for half of this from the other end, in a consequence rather than a rule: *"The run records the `workspace_id` it read the batch from; the write node refuses if the current Connection names a different one."* This ADR keeps that, gives it a home, and settles the four things it left unsaid — what identity means, where the fact lives, where the refusal surfaces, and how the Reviewer gets out.

### The danger is not the write

The obvious framing is that confirming against a foreign workspace writes `Imported` into a workspace that never held those rows. On the evidence, it does not.

Notion page ids are workspace-scoped UUIDs, so the pages simply are not there. ADR-0007's rule 1 makes the write node re-query `Batch = <batch> AND CRM status = Ready for CRM` and **intersect on page ids** with the rows this run handed off, so even a duplicated database carrying the same `Batch` values yields an empty intersection. The write-back writes nothing.

What a permissive path produces instead is a **bad message**. Eight per-row failures land in `writeBack.failed`, where they read as a transient Notion fault. The Reviewer clicks Retry, fails again, and abandons — which under ADR-0007 keeps the batch reserved and sends them to Notion to edit rows by hand. The true repair was one click: connect again to the original workspace.

So the refusal is justified by what it *tells the Reviewer*, not by a write it prevents. That distinction decides the rest of this ADR.

## Decision

**A run is confirmed only through a Connection naming the workspace that read its batch.**

**1. The identity is the `workspace_id`.** Notion's token response ([#14](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/14) recorded it live) carries `workspace_id`, `bot_id` and the granted pages. Only `workspace_id` survives the ordinary recovery path: a `401`, then the Reviewer connects again to the *same* workspace. Every re-authorisation mints a new grant, so a `bot_id` key would refuse precisely the case the guard exists to permit. The `data_source_id` is tighter still and would convert ADR-0007's *"a same-workspace reconnect with a narrower page selection degrades into the ordinary per-row failure path"* into a hard refusal.

**2. The fact lives in graph state, written by the node that reads the batch.** Not in the `runs` table: [ADR-0009](./0009-the-server-keeps-its-own-record-of-runs.md) does not forbid it — `workspace_id` is emphatically *not* derivable, since each authorisation overwrites the Connection — but the write node reads graph state, so putting it there means the guard needs no join, and it inherits [ADR-0004](./0004-the-candidate-set-is-frozen-at-the-check-pass.md)'s freeze for free.

**When** matters as much as where. `POST /api/runs` returns `202` and the graph runs afterwards, so the Connection can change between the two moments. The truthful value is the workspace that *actually served the batch query*, recorded by the node that made it — not one stamped at run creation.

The **workspace name** is recorded alongside it, and is for display only. Comparison is on the id.

**3. The refusal is both an error code and run state.** `POST /api/runs/:runId/confirm` returns a new `wrong_workspace` (`409`), which joins the closed list next to its neighbour `not_connected`. This does not breach [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16)'s *"no write-back outcome is ever an HTTP error"*, because the write-back never starts — this is a precondition, exactly as `not_connected` is.

The snapshot also carries the blocked state, so [#35](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/35)'s surface can disable **Confirm import** with its reason *before* the click. A disabled button is not a guard, and an error only visible after a click is not a screen; both are needed and neither substitutes for the other. `not_connected` is reported first when there is no Connection at all.

**The server decides; the browser compares nothing.** The snapshot carries the answer and the name to show, not the raw ids for the client to diff. The rule lives in one place — the place that enforces it.

**4. The guard reaches the confirmation only.** Nothing between `review` and `emit` touches Notion: the batch is already read, `check` has already run, and the files are built from checkpoint data. A Reviewer can work the whole candidate list against a foreign Connection with no harm done, and since the refusal is repairable by connecting again, stopping them early saves no work. `/review` stays unguarded.

**5. ADR-0007's write-node check stays.** The two overlap deliberately. The route check cannot cover a run left `stalled` at the write-back, because `POST /api/runs/:runId/continue` re-enters the node without passing the confirm route. The node check cannot produce the one clear message, which is the whole point of rule 3. The route check is the message; the node check is the guard of last resort. No check is added to `continue` itself — a run can stall at any node, and most of them never touch Notion.

**6. Abandoning the write-back becomes reachable when the wrong workspace blocks the run.** ADR-0007 accepts `{ abandoned: true }` **only** when `writeBack.failed` is non-empty, reasoning that *"there is nothing to abandon before a write-back has failed"*. That reasoning does not extend to a write-back which cannot start and cannot start later. Without this, a Reviewer whose original workspace is gone for good has two exits and both lie: **cancel** asserts the files never reached Attio, which is false, and doing nothing reserves the batch for ever.

This widens the precondition without touching the meaning. Abandon still says *"the files did reach Attio, and I am giving up on the Notion record"* — true here word for word — the batch stays reserved, and cancel stays correct for a Reviewer who did not import.

## Consequences

**Two exits now cover every case at `awaiting_confirmation`, and neither tells a lie.** Cancel for the bundle that never landed; abandon for the bundle that landed and cannot be recorded. Before rule 6 there was a reachable state with no honest exit.

**The message names both workspaces** — *"This run read **Carpe Lab**. You are connected to **Demo Space**."* — which is what turns a refusal into an instruction. The cost is a stored name that a rename in Notion can make stale. Accepted: the id keeps the comparison correct, and a stale name in a message is a smaller failure than an unnamed workspace the Reviewer must guess at.

**One more field in graph state, one more code on the closed list, one more field on the snapshot.** The `runs` table is untouched, so ADR-0009 stands exactly as written.

**The demo is the case this was built for, and it now survives being re-recorded.** Disconnect exists partly so [#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15) can re-record from clean; a take that reconnects to a re-seeded workspace mid-run now meets a sentence rather than eight failures.

**The write-up gains a small, specific line.** The pipeline never reads Attio, so `Imported` rests entirely on a human attestation — and an attestation is about *specific rows in a specific workspace*. Naming the workspace the attestation is about is the cheapest possible way to keep it from being made about the wrong one.

## Alternatives considered

**Allow it and let the write fail.** Costs nothing to build, and — as the Context establishes — is not actually dangerous, since the page ids do not exist there. Rejected because it converts a one-click repair into a permanent-looking dead end: the failures read as transient, the Reviewer retries, then abandons, and abandoning reserves the batch until someone edits Notion by hand.

**Key on the grant (`bot_id`).** A stricter reading of *"the connection that read it"*, and it is the literal answer to the ticket's title. Rejected because it refuses the ordinary `401` recovery — reconnecting the same workspace — which the map names as a path that must keep working.

**Key on `data_source_id`.** Tighter than the workspace, and it is what the page ids actually belong to. Rejected because it overturns ADR-0007's ruling that a narrower page selection degrades into the per-row failure path.

**Record the workspace at run creation.** Simpler — one write, in the route handler, before the graph starts. Rejected because `POST /api/runs` is a `202` and the graph runs afterwards, so the value could name a Connection that never served the query.

**Put the fact in the `runs` table.** Legitimate under ADR-0009, since the value is not derivable, and it would let `GET /api/runs` answer without opening a checkpoint. Rejected because the enforcer is the write node, which reads graph state; the table version needs a join to do what the state version does for free.

**Let the browser compare.** Expose the Run's `workspace_id` on the snapshot and the live one on `GET /api/connection`, and diff them client-side. Rejected on two counts: it puts the rule in two places that can disagree, and the route holds the true copy because the route enforces it.

**Guard `/review` as well.** Tells the Reviewer sooner, and avoids the feeling of finishing a triage only to be refused. Rejected because nothing in that half of the run touches Notion, and the refusal is repairable — so nothing is lost by meeting it later. Telling the Reviewer early is a screen question, not a guard question.

**Drop ADR-0007's write-node check now that the route refuses.** One check instead of two. Rejected: a `stalled` run re-entered through `continue` never passes the confirm route.
