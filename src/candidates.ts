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

/**
 * The batch, split. Both identity values fall back to the source row's own id
 * where the row does not carry one: a batch of rows with no website would
 * otherwise collapse onto a single nameless company, which is a merge nobody
 * asked for. The fallback keys the candidate; it never reaches the domain or
 * email field, so a source id can never be exported as a domain.
 */
export function candidatesFrom(sourceRows: SourceRow[]): Ledger {
  const companies = new Map<string, CompanyCandidate>();
  const people = new Map<string, PersonCandidate>();
  const deals: DealCandidate[] = [];
  const repairs: Repair[] = [];

  for (const row of sourceRows) {
    const sourceId = text(row, "Source ID");
    const website = text(row, "Website");
    const domain = normalisedDomain(website);
    const key = domain || sourceId;
    const companyId = `company:${key}`;

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
        overrides: [],
      });
      // The first row of an account settles the values its siblings share —
      // and the one they disagree on, `Lead source`, is on the Person.
      deals.push({
        id: `deal:${key}`,
        companyId,
        owner: text(row, "Owner"),
        flags: [],
        held: false,
        overrides: [],
      });
    }

    const email = text(row, "Work email");
    const personId = personIdOf(row);
    if (!people.has(personId)) {
      people.set(personId, {
        id: personId,
        sourceId,
        companyId,
        name: text(row, "Contact"),
        email,
        jobTitle: text(row, "Job title"),
        linkedIn: text(row, "LinkedIn"),
        leadSource: text(row, "Lead source"),
        flags: [],
        held: false,
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
