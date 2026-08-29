/**
 * The check pass: the deterministic rules, run over the ledger the transform
 * proposed (#53).
 *
 * A flag attaches to a **candidate**, never to a source row (ADR-0001) — which
 * is enforced here by shape rather than by convention, since a `Flag` has no
 * field a source row could go in and lives on the candidate it describes.
 *
 * Everything below is a pure function of the candidates. That is what makes
 * the freeze cheap to state: `check` runs once, and the candidate set and the
 * flag set are fixed the moment it completes (ADR-0004). What is frozen is
 * *which* flags exist, not whether each is answered.
 *
 * The screener's notice Warns — N1 and N2, the two suspicions no rule can
 * reach — join this node with the ticket that brings the model call
 * (ADR-0002). Nothing here reads free prose.
 */

import * as z from "zod";
import type {
  CompanyCandidate,
  DealCandidate,
  Ledger,
  PersonCandidate,
} from "./candidates.ts";

/**
 * One problem found on one candidate. The reviewer reads a fixed sentence for
 * the `rule`, so no prose travels on the wire — which is also what keeps a
 * model, when one arrives, unable to narrate (ADR-0002).
 *
 * `sibling` names the candidate that *caused* the flag where that is not the
 * candidate carrying it, by id rather than by name: a person's name lives on
 * their own candidate and is never copied (ADR-0004).
 */
export const Flag = z.object({
  id: z.string(),
  rule: z.enum(["B1", "W1", "D1"]),
  level: z.enum(["stop", "warn"]),
  /** A Warn is a decision or a notice. A Stop is neither. */
  kind: z.enum(["decision", "notice"]).nullable(),
  /** Whether the reviewer may force past it. D1 is the one Stop that cannot. */
  override: z.boolean(),
  sibling: z.string().nullable(),
});
export type Flag = z.infer<typeof Flag>;

/**
 * A flag that sits on the batch rather than on a candidate — asked once, in
 * one place, before the files are made.
 *
 * P1 carries `stage` because no Notion column holds it and we never read
 * Attio, so the proposal has to come from configuration (#18). It carries no
 * owner: Notion's `Owner` is already on every Deal candidate, and a value
 * lives in exactly one place. Any count the surface shows beside it — *six
 * deals to `Maya`* — is derived from those candidates as they stand, which is
 * why no count is stored here.
 */
export const BatchFlag = z.object({
  id: z.string(),
  rule: z.literal("P1"),
  level: z.literal("warn"),
  kind: z.literal("decision"),
  stage: z.string(),
});
export type BatchFlag = z.infer<typeof BatchFlag>;

/** The candidate arrays, each candidate now carrying the flags it earned. */
export interface Checked {
  companies: CompanyCandidate[];
  people: PersonCandidate[];
  deals: DealCandidate[];
  batchFlags: BatchFlag[];
}

/**
 * The deterministic rule set, in the order the last rule needs.
 *
 * - **B1** — a Person with no work email. Attio matches People on the email
 *   address, so one without it can never be matched again and every import
 *   makes another copy. The reviewer supplies one, or forces past it.
 * - **W1** — two or more People on one Company candidate. Attio merges the
 *   people itself, but Deals have no unique attribute and always create, so
 *   the reviewer confirms **one** opportunity rather than one per source row.
 *   The flag sits on the Deal because the Deal is what the answer changes.
 * - **D1** — a Deal whose account is not whole. Only the irreversible object
 *   waits (ADR-0005): a Company and a Person upsert safely and lose nothing by
 *   going early, while a Deal attached to nobody is a record no one can undo.
 *   This Stop names the sibling that caused it and offers **no** override; it
 *   is cleared by completing the account.
 *
 * The rules the settled set also holds — B2, W2, W3, and the Stop on a Deal
 * whose `Owner` is empty — are not built. No W34 row reaches any of them, so
 * each would be a rule with nothing to answer for it.
 * ponytail: add one the week a batch first contains it.
 */
export function checkFlags(ledger: Ledger, stage: string): Checked {
  const people = ledger.people.map((person) => ({
    ...person,
    flags: person.email.trim()
      ? []
      : [
          {
            id: `B1:${person.id}`,
            rule: "B1" as const,
            level: "stop" as const,
            kind: null,
            override: true,
            sibling: null,
          },
        ],
  }));

  // No deterministic rule raises a flag on a Company, so they pass through as
  // the transform proposed them — and a Company is never held by its People
  // (ADR-0003).
  const companies = ledger.companies;

  const peopleOn = (companyId: string) =>
    people.filter((person) => person.companyId === companyId);

  const deals = ledger.deals.map((deal) => {
    const flags: Flag[] = [];

    if (peopleOn(deal.companyId).length > 1) {
      flags.push({
        id: `W1:${deal.id}`,
        rule: "W1",
        level: "warn",
        kind: "decision",
        override: false,
        sibling: null,
      });
    }

    // Its own W1 is not a reason to hold it — the reviewer answering that flag
    // is the whole point of the review. A *sibling* the reviewer has yet to
    // deal with is.
    const siblings = [
      ...peopleOn(deal.companyId),
      ...companies.filter((company) => company.id === deal.companyId),
    ];
    for (const sibling of siblings.filter((one) => one.flags.length > 0)) {
      flags.push({
        id: `D1:${deal.id}:${sibling.id}`,
        rule: "D1",
        level: "stop",
        kind: null,
        override: false,
        sibling: sibling.id,
      });
    }

    return { ...deal, flags };
  });

  return {
    companies,
    people,
    deals,
    batchFlags: [
      {
        id: "batch:deal-defaults",
        rule: "P1",
        level: "warn",
        kind: "decision",
        stage,
      },
    ],
  };
}
