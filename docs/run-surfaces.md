# The surfaces before and during a run

Settled on [#35](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/35). This is what `notion2attioFrontend` renders either side of the candidate ledger — the screens [#10](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/10) did not cover.

It is a specification, not an implementation. Nothing here is built yet.

## The decision

**The runs index is the front door.** There is no pre-run *screen*: the list of runs and the place a run is started are one surface, and the question it answers first is *what needs a human*, not *what would you like to start*.

Chosen over a launcher whose root is one Start button (runs demoted to a footnote), and over a single continuous surface where the app simply *is* a run and the list hides in a header dropdown. The bet: [ADR-0003](adr/0003-the-server-keeps-its-own-record-of-runs.md) exists because a run can be lost between the CSV download and the confirmation, holding Attio deals that [#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2) found cannot be undone. A surface that closes that hole by *accident* — a callout that happens to be on the page — is not the same as one that closes it by construction.

## Routes

Browser routes. Distinct from [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16)'s HTTP routes, which all sit under `/api` and `/auth`.

| Route | Renders |
| --- | --- |
| `/` | Redirects to `/runs`. Nothing else lives at the root. |
| `/runs` | The index: connection state, the start control, the table of runs. |
| `/runs/:runId` | One run, rendered per its status — see below. `404` for an unknown id, per ADR-0003. |

## The index

**Header.** Connection state on the left; the start control on the right — a `<select>` of `GET /api/batches` (`2026-W34 — 8 ready`) and a **Start run** button. The batch picker is a control, not a destination: with one batch ready it reads as a label, and that is acceptable.

The index opens before `GET /api/batches` answers, so the start control renders disabled until it does. That call is a live Notion query, which is why this screen is the first place a connection failure can appear.

**Sort order is by what needs a human, not by time:**

1. `awaiting_confirmation` — someone must act, and the cost of not acting is duplicate deals next week
2. `running` and `awaiting_review` — in flight
3. stopped — recoverable, but only by a person
4. `done`

Newest first within each group. Time is a column, never the ordering.

**Columns:** run id, batch, started (relative), state, action. One action per row, and at most one primary button on screen at a time.

| Status | State cell | Action |
| --- | --- | --- |
| `running` | the current step's name, with an elapsed clock | **Details** — expands the checklist in place |
| `awaiting_review` | Ready for review | **Review** → `/runs/:runId` |
| `awaiting_confirmation` | Waiting on you, plus the consequence line | **Confirm import** → `/runs/:runId` |
| `stalled`, `failed` | Stopped, plus *stopped at &lt;step&gt;* | **Continue** |
| `done` | Done | Open |

A row awaiting confirmation is pinned to the top on a warn ground with a coloured left border, and carries one sentence of consequence:

> files are made · Notion still says `Ready for CRM`

That sentence is the point of the row. "Waiting on you" says a person is needed; the consequence line says what happens if they are not.

## Two reviewer-facing state names collapse into one

[#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) already concedes that after a restart a `failed` run is indistinguishable from a `stalled` one, because we persist no failure record of our own. The reviewer's action is identical either way — **Continue** — so both read as **Stopped**, with the cause named in prose when we know it.

`status` stays six values on the wire. The reviewer sees five.

## While a run is running

**Node-level progress is free. Per-call progress is not.**

`snap.next` names the pending node — verified in [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) — so a four-step indicator is derived from the checkpoint and needs **no new persisted field**. ADR-0003's rule that the runs table holds nothing derivable survives untouched.

But the notes screener is **one node making up to eight model calls** ([#9](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/9)), and the checkpoint only moves at node boundaries:

| Step | Roughly | Moves? |
| --- | --- | --- |
| Reading the batch from Notion | 2–3s | ✓ |
| Building candidates | <1s | ✓ |
| Screening research notes | 20–30s | **nothing to report until all eight are back** |
| Running checks | ~1s | ✓ |

So the indicator sits still for most of the wait. **This is shown, not hidden.** During the screening step the row reads:

> Screening research notes — one call per row, nothing to report until all 8 are back

The alternatives were both rejected: splitting the screener into eight nodes so each row checkpoints shapes the graph around a progress bar and multiplies checkpoint writes by eight; a progress channel outside the checkpoint is exactly the second source of truth ADR-0003 refused.

A consequence worth stating plainly: with one honest transition per ~24 seconds, a progress bar, a step list and a spinner are the same object. The choice was never the widget — it was the sentence shown while nothing moves.

## The run's own page

`/runs/:runId` renders by status: the checklist while `running` or Stopped (with **Continue**), the candidate ledger at `awaiting_review`, the ledger with the files and the inline confirmation at `awaiting_confirmation` — [#10](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/10)'s surface, unchanged — and the ledger read-only when `done`.

## The URL does not change when a run starts

`POST /api/runs` returns `202` with a `runId` and the browser **stays on `/runs`**. The new run appears as a live row at the top of the table. The address bar changes only when a person opens a run to work it.

This reverses the reasoning in #16, which valued the run's URL being shareable before the work finishes. It is still shareable — the run's URL exists from the moment of the `202` and works from any browser. What changes is that **it is no longer the only handle**. The lost-link hole ADR-0003 named is closed structurally, by the index being the front door, rather than by hoping someone keeps a link. A URL you must remember is a worse recovery mechanism than a list you cannot miss.

## The connection, on this surface

[#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15)'s three failure states land here, because this is the first screen that touches Notion. Each shows as a banner above the table with the start control disabled — the table itself keeps rendering, since reading past runs needs no connection.

| State | What the banner says |
| --- | --- |
| Consent cancelled | Nothing was connected and nothing was stored. Offers Connect. |
| Connected, nothing shared | Names the workspace, says no databases were shared, links back to the connect flow. |
| Connection expired (401) | Names the cause, offers Connect. |

**One case is not merely cosmetic.** Confirming a run writes `CRM status` back to Notion, so **Confirm import** is disabled while there is no live connection — a run can reach `awaiting_confirmation` and then lose the connection under it, which #15's warning on `DELETE /api/connection` does not cover because a 401 arrives without warning. Disabling the button with its reason is the whole fix on this surface.

**A fourth state joins the three, and it is per-run rather than per-screen.** [#42](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/42) settled the case #35 parked: a connection naming a **different** workspace may not confirm a run at all ([ADR-0008](adr/0008-a-run-is-confirmed-only-through-the-connection-that-read-it.md)). The connection is live, so no banner fires and the start control stays enabled — a *new* run against the new workspace is perfectly legitimate. What is blocked is one particular run, so it shows on that run's row and on `/runs/:runId`, driven by the snapshot's `blocked` field:

> **This run read _Carpe Lab_. You are connected to _Demo Space_.** Connect to _Carpe Lab_ again to confirm it.

Naming both workspaces is the point — it turns a refusal into an instruction, and the repair is one click. The message is built from names the server supplies; the browser compares nothing.

**The dead end gets an exit.** If the original workspace is gone for good, that run's bundle is in Attio and its rows can never be marked. Cancelling would assert the files never reached Attio, which is false, so **Abandon write-back** is offered on this run alongside the message — the same control [#17](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/17) put behind a failed write, reachable here because the write can never begin. The app cannot know whether the workspace is gone for good, so it never withholds this exit — but it never leads with it either: reconnecting is the repair, abandoning is the admission that there is nothing left to reconnect to, and only the Reviewer knows which they are in. It sits below the message, not beside it.

## What this costs

**Someone arriving cold sees history first.** Maya runs this once a week; her front door is a table of past runs with the start control in the corner, rather than the one act she came to perform. That is the price of making *what needs you* structural, and it is worth one honest sentence in the write-up rather than a defence.

**A half-minute wait gets one row.** The in-flight run reports its step and elapsed time on a single line, expanding only on request. A launcher would have given the wait a whole screen. Given that nothing honest moves for most of it, one row is arguably the more truthful allocation — but it is a bet, not a free win.

## Deliberately not covered here

| Question | Ticket |
| --- | --- |
| Everything inside the ledger | [#10](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/10) |
| The HTTP contract these surfaces call | [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16) |
| ~~Confirming against a connection that did not read the run~~ — settled, see above | [#42](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/42) |
| What the write-back does when it half-fails | [#17](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/17) |
