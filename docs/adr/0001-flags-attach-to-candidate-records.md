# ADR-0001: Flags attach to candidate records, not source rows

- **Status:** Accepted
- **Date:** 2026-08-29
- **Ticket:** [What does the pipeline flag for human review?](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6)

## Context

The Notion export is row-shaped: one row carries a company and a person together. Maya's working sheet keeps that shape end to end — its `Row check` column marks a row, and its `Attio Upload` tab is one row in, one row out.

Attio is not row-shaped. The `Mappings` sheet already spans three objects — Company, Person, Deal — and Attio's CSV importer takes one file per destination object.

The W34 sample makes the mismatch concrete. Brightyard appears on two source rows, and the research notes say plainly: *"Treat this as a second contact at the existing account, not a second opportunity."* That is one Company, two People and one Deal, out of two rows. A mark on a row can say "these two rows look related." It cannot say "one company, both people, one deal."

## Decision

The transform splits a batch into **candidate** Company, Person and Deal records before any checking happens. Flags attach to candidates. A source row may contribute to several candidates, and several source rows may contribute to one candidate.

`Row check` is retired along with the row as a unit of review.

## Consequences

**A parse step the sheet does not have.** Deriving candidates from rows is new work, and candidate identity has to be defined: a Company candidate is keyed on the normalised domain, a Person candidate on the work email address. That normalisation becomes load-bearing rather than cosmetic — Attio merges same-key rows within one file, so the two Brightyard rows collapse into one company only *because* both domains normalise identically.

**Flag rules become expressible.** "Two or more People share one Company domain, so confirm one Deal" has no row-level phrasing. Roughly half the rule set needs the candidate to exist first.

**Blast radius stops being all-or-nothing.** A Stop on Tern Mobility's Person leaves its Company and Deal untouched, because they are separate candidates. Verified achievable against Attio's docs: the Deals import carries `Associated company domain` and creates the company itself, so a held Person does not orphan its Company.

**A reviewer surface that is not a spreadsheet.** The reviewer sees candidates, not rows, which forecloses the cheapest possible UI — a table mirroring the source export.

## Alternatives considered

**Flag the source row, as the sheet does.** Cheaper, and it mirrors what Maya already reads. Rejected because it cannot express the Brightyard case at all — and Brightyard is the error Attio can never undo, since deals have no unique attribute and two deal rows mean two deals permanently.

**Flag the output file rows.** Deferred rather than rejected: which files exist is still open. Flags would then be scattered across files by object, and a Company appearing in both the People and Deals files would carry its flags twice.
