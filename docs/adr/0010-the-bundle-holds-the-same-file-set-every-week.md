# ADR-0010: The bundle holds the same file set every week

- **Status:** Accepted
- **Date:** 2026-08-29
- **Amends:** [ADR-0003](0003-a-company-candidate-is-never-dropped-with-its-people.md)

## Context

[ADR-0003](0003-a-company-candidate-is-never-dropped-with-its-people.md) made
`1-companies.csv` **conditional**: emitted only when the batch holds a company
with no exported person, and absent otherwise. The reasoning was that
"emitting an empty companies file every week would train the reviewer to
ignore a file that occasionally matters".

The first time a batch took the other branch, the reviewer opened the ZIP,
found three files where the documentation and the committed W34 example both
show four, and could not tell which of two things had happened:

- no company needed a row this week, or
- a file was lost on the way into the archive.

Both readings are consistent with an absent file, and only one of them is
fine. Answering the question took reading `emit.ts`, ADR-0003 and the run's
stored checkpoint — because the artefact itself carried no evidence either
way.

That is the cost ADR-0003 did not price. Its own worry — a reviewer trained to
ignore the file — is about a file that is _present and empty_. But a
header-only CSV is not silent: it says _this was computed, and the answer was
none_. An **absent** file says nothing at all, and an absence is exactly what a
dropped write, a bad ZIP header or a filter bug also look like. The failure the
conditional guards against is a reviewer paying too little attention; the
failure it creates is a reviewer unable to distinguish correct output from a
bug. The second is worse, and `emit.ts` already said so about the other two
files: _"a missing file and a file with no rows say different things, and only
the first is a bug worth noticing."_ `1-companies.csv` was the one file exempt
from a rule the rest of the bundle already followed.

## Decision

**`1-companies.csv` is always emitted, empty of rows or not.**

The _rows_ are unchanged and still conditional: exactly those Company
candidates that are sent and have no row in `2-people.csv`. A batch where every
account has an exported contact produces the header and nothing under it.

Every file in the bundle is now unconditional, and the file set no longer
carries information. What varies between weeks is row counts, which
`handoff-notes.md` already tabulates.

## Consequences

- The bundle is four files, every week. A missing one is unambiguously a bug,
  which is what makes it worth noticing.
- Attio's own guidance — do not emit a companies file unless there are
  companies with no people — is still honoured where it matters. It is about
  what you _import_, and a header-only file imports nothing. A reviewer
  following `handoff-notes.md` sees `0` beside the file and skips it.
- ADR-0003's substance is untouched: a Company candidate's fate is still never
  decided by its People candidates. Only the conditional emission is reversed.
- The committed W34 example is unchanged — that batch holds Tern Mobility, so
  its companies file always had a row.
