# ADR-0009: The server keeps its own record of runs

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [What is the HTTP contract between the browser and the graph?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/16)
- **Renumbered:** from `0003` by [#48](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/48). It was drafted concurrently with [ADR-0003 (companies)](./0003-a-company-candidate-is-never-dropped-with-its-people.md) and the two shared a number; the decision, its date and its content are unchanged.

## Context

[#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) recorded a finding it was proud of: *"we persist nothing ourselves"*. A `SqliteSaver` checkpoint holds all the run state, `getState()` is the read model, and a fresh process was verified to resume from the file alone. It is a genuinely good property and it shaped several later decisions.

It has since eroded twice. [#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15) put a Connection row and a pending-authorisation row in the same SQLite file, because the OAuth `state` has nowhere else to live once cookies are gone. The claim survived in spirit — neither row is pipeline data.

Two facts from this ticket make it erode a third time.

**An unknown thread identifier returns empty state silently.** [#3](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/3) verified this by running it. So a typo in a run URL renders an empty candidate ledger rather than *"no such run"*. With the checkpoint as the only record, "unknown" and "known but not started" are indistinguishable.

**A run can be lost.** [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) requires the reviewer to leave after the CSV download, do step 5 in Attio by hand, and return minutes or hours later — possibly in a different browser — to confirm. [#15](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/15) made the run identifier the only thing a browser holds, and this ticket put it in the URL rather than `localStorage` precisely so a different browser can reach it.

That leaves a hole. If the tab closes and the link is not kept, the run is unreachable for ever. Not merely awkward: that run may have already put `deals.csv` into Attio, where [#2](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/2) found deals always create and cannot be undone. Its `CRM status` write-back would never fire, so the batch stays `Ready for CRM` and returns next week — the exact duplicate-deal failure [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) named the status flip to prevent.

## Decision

The server keeps a small table of runs — identifier, batch, created time — alongside the checkpoint, and exposes `GET /api/runs`.

The run identifier is a v4 UUID, and it is also the LangGraph `thread_id`. There is no second identifier to reconcile.

The rule from #3 is retired and replaced with a narrower one that is actually true:

> **We persist no candidate data of our own.** Every value the reviewer sees or edits lives in the checkpoint, and nowhere else.

## Consequences

**An unknown run identifier is a `404`.** A real lookup miss, not an inference from an empty checkpoint. #3's silent-empty trap stops being reachable from the HTTP surface.

**A lost link is recoverable.** The pre-run screen can list recent runs, so a reviewer who closed the tab can find the run awaiting their confirmation. This is the difference between a demo that survives its own narrative and one that only works if nobody closes anything.

**The table must hold nothing derivable.** Everything else — status, candidates, flags, files — is read from the checkpoint on every request. A `status` column would be a second source of truth for a value the checkpoint already knows, and the two would drift the first time a process died mid-run. The listing computes status the same way the snapshot does.

**A third non-LangGraph table joins the SQLite file.** Whatever the file is, it is no longer "LangGraph's checkpoint file". Any future cleanup must be per-table.

**The write-up loses a clean line and gains an honest one.** *"We persist nothing"* was a better sentence than *"we persist no candidate data"*. The narrower claim is the one that holds.

## Alternatives considered

**Keep the checkpoint as the only record.** Detect "unknown" by testing for an empty checkpoint and `404` on that. This preserves the original claim and costs nothing to build. Rejected because it does not close the lost-link hole at all — and that hole is worst in exactly the state where losing a run is most expensive, between the download and the confirmation.

**Put the run list in `localStorage`.** Cheap, no server state, and covers the reload case. Rejected for the same reason the identifier is not in `localStorage`: [#7](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/7) expects a return possibly in a different browser, which `localStorage` cannot survive. It would also make the recovery story depend on the one component we already decided holds nothing.

**Store the full run summary in the table and treat the checkpoint as an implementation detail.** Faster listings, and the API stops depending on LangGraph's read model. Rejected as a straightforward second source of truth, with no benefit at eight rows a week.
