# ADR-0007: The write-back completes or is abandoned, and `Imported` is never retracted

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [What happens when the Notion write-back half-fails?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/17)
- **Builds on:** [ADR-0005](./0005-a-deal-is-emitted-only-when-its-account-is-clear.md), [ADR-0006](./0006-a-repeat-deal-for-a-known-account-is-not-a-duplicate.md)

> **Numbering note.** `main` carries two ADRs numbered 0003, written concurrently on [#8](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/8) and [#16](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16). 0004 was left free for whoever untangles that and then taken by [#31](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/31); 0006 is [#13](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/13)'s, in flight in [PR #39](https://github.com/Qiuyi-Hong/notion2attioBackend/pull/39). This takes 0007. The 0003 collision is still open.

## Context

[#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) put a second `interrupt()` in the graph. After the reviewer has imported the bundle into Attio by hand, they return — minutes or hours later — and confirm. A node then sets `CRM status` = `Imported` on the source rows the run handed off.

That node is the **only** place this system mutates anything outside itself, and Notion gives it no transaction. Rows are updated one page per request, at a documented average of 3 requests per second. A W34 run hands off eight rows, so the node makes eight sequential writes, any subset of which can fail.

The obvious framing is a spectrum from all-or-nothing to best-effort, with all-or-nothing unavailable. That framing is wrong, and the reason it is wrong is the whole of this decision.

### A half-flipped batch is not "some work left to do"

[ADR-0005](./0005-a-deal-is-emitted-only-when-its-account-is-clear.md) made the **batch the unit of retry**: you re-run W34, the rows that reached Attio are now `Imported` and filter out, and exactly the rows that were held come back. That is the designed recovery path, and it is correct for held rows.

It is not correct for rows whose flip failed, because the two are **indistinguishable in Notion** and mean opposite things:

| In Notion | Held row | Failed-flip row |
| --- | --- | --- |
| `Batch` | `2026-W34` | `2026-W34` |
| `CRM status` | `Ready for CRM` | `Ready for CRM` |
| Already in Attio? | **No** — never emitted | **Yes** — emitted, downloaded, imported |

Re-run W34 and both are re-emitted. For the held row that is the point. For the failed-flip row, its Deal candidate is emitted into `3-deals.csv` a second time — and [#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2) established that Deals have no unique attribute, always create, and have no undo.

So "5 of 8 flipped" is not five done and three to do. It is **three armed duplicate deals wearing the costume of three rows that need re-running** — the precise failure #7 named the status flip to prevent, arriving through the flip's own failure.

[ADR-0006](./0006-a-repeat-deal-for-a-known-account-is-not-a-duplicate.md) does not rescue this. It establishes that a **re-qualified** row's second deal is correct, because a person moved that row into a later batch and thereby asserted a new opportunity. Nothing asserts anything here: the batch is the same, the rows are the same, and the second deal records no second opportunity.

## Decision

**The write-back completes or is abandoned. There is no resting state in between, and `Imported` is never retracted.**

Four rules.

**1. The write node is idempotent against Notion, not against our own record.** Before writing, the node queries the data source for `Batch = <batch> AND CRM status = Ready for CRM` and intersects that with the rows the run handed off. It writes only what is still `Ready for CRM`.

This is the load-bearing rule, because it is three mechanisms at once:

- **Double-submit safety.** [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) found LangGraph has no concurrency control. A second write finds nothing left to write, so the guard needs no client cooperation and no checkpoint token — on top of the in-process lock and stage guard `docs/http-contract.md` already specifies.
- **Crash recovery.** Graph state is checkpointed at node boundaries, so a process dying after 5 of 8 writes never records the progress. The re-query reads it back out of Notion. No bookkeeping of ours could have survived that.
- **Retry.** It is what makes re-entering the node free.

**2. The run does not finish until every handed-off row reads `Imported`, or the reviewer abandons the write-back.** Inside the node, a `429` is retried honouring `Retry-After` and a `5xx` is retried twice; past that budget the node stops and routes back to the confirmation pause carrying the list of unwritten rows and their causes. The reviewer sees what failed and clicks Retry — which is the same `POST /api/runs/:runId/confirm` route with the same payload, accepted because the run is genuinely at that pause again.

The graph shape that follows:

```
transform → check → review → emit → confirm → writeback → END
                     (#16)            ▲          │
                                      └──────────┘
                                   rows still unwritten
```

`confirm` holds the second `interrupt()` and stays side-effect-free, so [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3)'s re-run-from-the-top costs nothing. `writeback` holds the only side effect in the system, and the conditional edge back to `confirm` is the entire retry mechanism — no second pause, no second route. On the return pass `confirm`'s interrupt value carries the failure list, which is what turns the confirmation panel into a retry panel.

**3. Abandoning is an attestation, and it is not cancelling.** Two exits from `awaiting_confirmation` assert opposite things about the same fact:

| Act | Asserts | Reachable |
| --- | --- | --- |
| **Cancel** ([ADR-0006](./0006-a-repeat-deal-for-a-known-account-is-not-a-duplicate.md)) | These files did **not** reach Attio | First pass |
| **Abandon** | They **did** reach Attio, and I am giving up on marking Notion | Only after a failed write |

An abandoned run ends in the state `abandoned`, which — unlike `done` — **does not release its batch**. The batch stays locked until a human sets the unwritten rows to `Imported` in Notion and deletes the run. That deletion is the explicit release.

**4. There is no Undo.** Nothing in the app ever writes `Ready for CRM` over `Imported`. The way back exists and is Notion itself, edited by hand.

## Consequences

**The batch lock does the protecting, not a warning.** An abandoned run cannot be followed by an accidental re-run of its batch, because the batch is not released. The reviewer must go to Notion. That is one deliberate extra act, and it is the same shape ADR-0005 chose when it preferred preventing the half-handed-off row to representing it.

**`Imported` stays a human attestation.** #7 built the second pause around the machine having no standing to assert that the import landed. A machine that can *retract* the assertion has quietly acquired that standing. Rule 4 keeps the asymmetry honest: the human tells the machine, and only the human can tell it otherwise — in Notion, where the claim lives.

**A `401` is a batch-wide outcome, not a per-row one.** A revoked or reconnected grant fails every remaining write, so the node stops on the first `401` rather than collecting seven identical errors, and reports one cause for the batch. [#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15)'s existing *connection no longer valid* state and its Connect button are the whole of the UI for it.

**A reconnect is allowed, but only to the same workspace.** The run records the `workspace_id` it read the batch from; the write node refuses if the current Connection names a different one. Without that check, a demo that disconnects and reconnects between takes could write `Imported` into a workspace that never produced the batch. A same-workspace reconnect with a narrower page selection degrades into the ordinary per-row failure path.

**Write failures are never HTTP errors.** `notion_failed` (`502`) narrows to the read side — the batch query and the data-source search. Every write outcome, `401` included, is run state on the run's own surface. This is the argument #16 used to make semantic validation failures re-interrupt rather than return `400`: the reviewer is looking at the ledger, not at the response to a POST they will never see again.

**The reviewer can still be wrong, and the cost is bounded.** Someone who clicks Confirm before the Attio import finished flips eight rows to `Imported` that are not. Nothing detects this; the recovery is the same manual edit in Notion. This is accepted — it is the residue of choosing a human attestation over a signal we cannot obtain, and the write-up should say so rather than imply the button is verified.

## Alternatives considered

**Best effort, then a warning.** Write what you can, end the run `done`, and put a sentence on the final panel: *3 rows could not be marked; re-running W34 will re-emit their deals.* Genuinely cheaper — no seventh state, no retry edge, no batch-lock rule — and it is what this ADR would have chosen if the failed rows were distinguishable from held ones. They are not, and the warning has to survive being read once by a tired person on the day, then acted on correctly by possibly someone else next week. Rejected for the same reason ADR-0005 rejected representing the half-handed-off row.

**Track per-page outcomes in graph state.** Cheaper than a re-query by one Notion request. Rejected because graph state checkpoints at node boundaries, so the record is lost by exactly the failure it exists to survive.

**Write every row every time, relying on per-page idempotency.** Setting a `status` to a fixed value is a no-op the second time, so this is nearly right. Rejected because it cannot report *what failed* — it has no notion of what still needed doing — and so cannot drive either the retry's stop condition or the final panel.

**Follow the documented retry policy verbatim** (six attempts, 30s cap). Rejected as a foreground operation: the reviewer has just clicked Confirm and is watching. #16 made `POST /api/runs` a `202` because 20–40 seconds was already too long to hold a request open; a node that silently retries for two minutes reads as a hang, and invites the double-click the concurrency guards exist to absorb. Past a short budget, **the Retry button is the backoff**, and it is honest about what is happening.

**Fold the pause and the write into one node.** Rule 1 makes the write node idempotent, which genuinely relaxes [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3)'s *the interrupted node re-runs from the top* — the constraint that originally forced `review` to be side-effect-free no longer forbids this. Rejected anyway: the reason to keep a pause and the system's only side effect in separate nodes outlives the constraint that first imposed it.

**An Undo button.** Rejected on three grounds, of which the middle is decisive. It re-arms the batch, so it is a duplicate-deal generator wearing a safety label; it hands the machine the power to retract a human attestation; and the way back already exists at the cost of one click in Notion, which is Maya's own database.

**Abandon as `DELETE /api/runs/:runId`.** The route exists and already warns. Rejected because deleting the run destroys the record of *which* rows went unflipped — the one thing the reviewer needs in order to go fix Notion, and the thing rule 4 sends them there with.

**`abandoned` folded into `done` or `failed`.** `done` releases the batch under ADR-0006, which hands the hazard straight back. `failed` means a node threw, degrades to `stalled` after a restart, and would offer a `continue` that re-enters a run the reviewer deliberately gave up on.
