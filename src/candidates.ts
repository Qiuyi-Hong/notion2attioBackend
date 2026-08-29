/**
 * The transform: a batch of source rows becomes candidate Company, Person and
 * Deal records, before any checking happens (ADR-0001).
 *
 * A source row describes a company *and* a person together, and Attio is not
 * row-shaped. So one row contributes to several candidates, and several rows
 * contribute to one candidate — the two Brightyard rows are one Company with
 * two People and one Deal.
 *
 * Two rules the shape here enforces rather than documents:
 *
 * - **A value lives in exactly one place.** A Person holds a *reference* to
 *   its Company, never a copy of its name or domain, and a Deal holds no name
 *   at all — `<Company> — New business` is derived when the files are written
 *   (ADR-0004). Nothing here can go stale in one place and stay correct in
 *   another.
 * - **One Deal per Company candidate, never one per source row.** Deals always
 *   create in Attio and have no undo (#2), so this is the granularity that is
 *   expensive to get wrong.
 */

import * as z from "zod";
import { Flag } from "./flags.ts";
import type { SourceRow } from "./notion.ts";

/**
 * What the review writes onto every candidate, whichever object it becomes
 * (#54). Both are read off in the ledger, in place against the values they
 * describe, rather than in a decision log elsewhere.
 *
 * `held` is a **derived** field in ADR-0004's sense — read off the candidate's
 * flags and the reviewer's holds, never typed in. It is computed in one place,
 * `holds()`, and written here so the browser is never asked to re-derive a
 * rule the server enforces.
 *
 * `overrides` names the fields the reviewer pinned: an edit differing from
 * what the pipeline proposed stops following whatever it was derived from. It
 * is the third of ADR-0004's three provenance marks — repaired, derived,
 * overridden — and it is what stops `emit` re-deriving over a typed value.
 */
const reviewable = {
  held: z.boolean().default(() => false),
  /**
   * The reviewer's own hold, as against the `held` above that is read off it,
   * the candidate's Stops and its Company. It is on the wire because the
   * decision document's `held` is **not** sparse and replaces what came
   * before: a browser that reloaded the ledger and could not tell a reviewer's
   * hold from a cascaded one would post the reviewer's holds away on their
   * next edit. The reviewer's act is data; only the cascade is derived.
   */
  heldByReviewer: z.boolean().default(() => false),
  overrides: z.array(z.string()).default(() => []),
};

/**
 * Keyed on its normalised domain — which is what collapses two spellings of
 * one website into one company, and why the repair below is load-bearing
 * rather than cosmetic.
 */
export const CompanyCandidate = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  segment: z.string(),
  primaryLocation: z.string(),
  flags: z.array(Flag).default(() => []),
  ...reviewable,
});
export type CompanyCandidate = z.infer<typeof CompanyCandidate>;

/**
 * One source row's `Research notes`, verbatim, carried to the ledger that
 * shows them (#60).
 *
 * They sit on the Person because that is who they are written about — one
 * contact at one company — and a value lives in exactly one place (ADR-0004).
 * A Company and a Deal reach their account's notes through its People rather
 * than holding a copy that could go stale.
 *
 * A list, because two source rows sharing a work email collapse onto one
 * Person candidate and each brought its own notes. Each entry names the row it
 * came from, exactly as a `Repair` does, so a collapse stays attributable.
 *
 * A row whose notes are empty produces no entry, on the repair log's rule: the
 * absence is the honest reading, and the ledger says so where the list is
 * empty rather than rendering a blank quotation.
 */
export const ResearchNotes = z.object({
  sourceId: z.string(),
  text: z.string(),
});
export type ResearchNotes = z.infer<typeof ResearchNotes>;

/** Keyed on the work email address, and reaching its company by reference. */
export const PersonCandidate = z.object({
  id: z.string(),
  sourceId: z.string(),
  companyId: z.string(),
  name: z.string(),
  email: z.string(),
  jobTitle: z.string(),
  linkedIn: z.string(),
  leadSource: z.string(),
  notes: z.array(ResearchNotes).default(() => []),
  flags: z.array(Flag).default(() => []),
  ...reviewable,
});
export type PersonCandidate = z.infer<typeof PersonCandidate>;

/** Its name, its company and its participants all resolve at emit. */
export const DealCandidate = z.object({
  id: z.string(),
  companyId: z.string(),
  owner: z.string(),
  flags: z.array(Flag).default(() => []),
  ...reviewable,
});
export type DealCandidate = z.infer<typeof DealCandidate>;

/**
 * One silent repair, against the **candidate field** the repaired value sits on
 * — not the source property it came from — so the ledger marks it in place
 * rather than in an audit screen elsewhere. The original is kept because
 * *silent* means unremarkable, not hidden.
 *
 * One entry per source row repaired, so a candidate that several rows collapsed
 * onto carries one for each. That is not double-counting: it is what makes the
 * collapse legible, since the two originals are exactly what differed.
 */
export const Repair = z.object({
  sourceId: z.string(),
  candidateId: z.string(),
  field: z.string(),
  from: z.string(),
  to: z.string(),
});
export type Repair = z.infer<typeof Repair>;

/**
 * S1, the batch's one repair: a website becomes the bare domain Attio matches
 * companies on — lowercased, with the scheme, a leading `www.` and anything
 * from the first `/`, `?` or `#` removed. This is the **normalised domain** a
 * Company candidate is keyed on (ADR-0001).
 *
 * Deterministic and reformatting only. It asserts nothing the source row did
 * not already say, which is exactly what makes it silent rather than a flag.
 */
export const normalisedDomain = (website: string): string =>
  website
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");

/** Notion answers an empty property with `null`; a candidate field is text. */
const text = (row: SourceRow, property: string): string => row[property] ?? "";

/**
 * The Person candidate a source row lands on.
 *
 * The key is normalised so that two spellings of one address cannot become two
 * People that Attio would upsert onto one record — the same failure the domain
 * repair prevents. The *value* is left exactly as Notion gave it, so this
 * asserts nothing and is not a repair to log.
 *
 * Exported because the screener resolves a row's notice through it (#55):
 * matching a candidate's `sourceId` would lose the notice on the second of two
 * rows that collapsed onto one Person.
 */
export const personIdOf = (row: SourceRow): string =>
  `person:${text(row, "Work email").trim().toLowerCase() || text(row, "Source ID")}`;

/**
 * The three candidates one source row contributes to, by id.
 *
 * Both identity values fall back to the source row's own id where the row does
 * not carry one: a batch of rows with no website would otherwise collapse onto
 * a single nameless company, which is a merge nobody asked for. The fallback
 * keys the candidate; it never reaches the domain or email field, so a source
 * id can never be exported as a domain.
 *
 * Exported because the write-back asks *was every candidate this row became
 * exported?* (ADR-0007), and deriving those keys a second way there would let
 * two readings disagree about which rows are safe to mark `Imported`.
 */
export function candidateIdsOf(row: SourceRow): {
  companyId: string;
  personId: string;
  dealId: string;
} {
  const key = normalisedDomain(text(row, "Website")) || text(row, "Source ID");
  return {
    companyId: `company:${key}`,
    personId: personIdOf(row),
    dealId: `deal:${key}`,
  };
}

/**
 * What the candidate ledger renders (#10): every candidate on screen, with the
 * repair log shown in place against the values it changed. The wire splits the
 * two — `candidates` grouped by object, `repairs` beside it — because Attio
 * imports one file per object.
 */
export interface Ledger {
  companies: CompanyCandidate[];
  people: PersonCandidate[];
  deals: DealCandidate[];
  repairs: Repair[];
}

/** The batch, split. The candidate ids are `candidateIdsOf`'s, and only its. */
export function candidatesFrom(sourceRows: SourceRow[]): Ledger {
  const companies = new Map<string, CompanyCandidate>();
  const people = new Map<string, PersonCandidate>();
  const deals: DealCandidate[] = [];
  const repairs: Repair[] = [];

  for (const row of sourceRows) {
    const sourceId = text(row, "Source ID");
    const website = text(row, "Website");
    const domain = normalisedDomain(website);
    const { companyId, personId, dealId } = candidateIdsOf(row);

    if (website !== domain) {
      repairs.push({
        sourceId,
        candidateId: companyId,
        field: "domain",
        from: website,
        to: domain,
      });
    }

    if (!companies.has(companyId)) {
      companies.set(companyId, {
        id: companyId,
        name: text(row, "Account"),
        domain,
        segment: text(row, "Segment"),
        primaryLocation: text(row, "HQ"),
        flags: [],
        held: false,
        heldByReviewer: false,
        overrides: [],
      });
      // The first row of an account settles the values its siblings share —
      // and the one they disagree on, `Lead source`, is on the Person.
      deals.push({
        id: dealId,
        companyId,
        owner: text(row, "Owner"),
        flags: [],
        held: false,
        heldByReviewer: false,
        overrides: [],
      });
    }

    const email = text(row, "Work email");
    const notes = text(row, "Research notes").trim();
    const existing = people.get(personId);
    if (existing) {
      // A second row on one Person brought its own notes. Appending rather
      // than overwriting is the same rule the repair log follows: what makes
      // the collapse legible is that both originals are kept.
      if (notes) existing.notes.push({ sourceId, text: notes });
    } else {
      people.set(personId, {
        id: personId,
        sourceId,
        companyId,
        name: text(row, "Contact"),
        email,
        jobTitle: text(row, "Job title"),
        linkedIn: text(row, "LinkedIn"),
        leadSource: text(row, "Lead source"),
        notes: notes ? [{ sourceId, text: notes }] : [],
        flags: [],
        held: false,
        heldByReviewer: false,
        overrides: [],
      });
    }
  }

  return {
    companies: [...companies.values()],
    people: [...people.values()],
    deals,
    repairs,
  };
}
