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
 * reach — are attached here too (#55), from what the model returned in
 * `screener.ts`. Nothing in this file reads free prose: it is handed a kind per
 * candidate and never a quote, which is what keeps the model unable to narrate
 * (ADR-0002).
 */

import * as z from "zod";
import type {
  CompanyCandidate,
  DealCandidate,
  Ledger,
  PersonCandidate,
} from "./candidates.ts";
import type { Kind } from "./screener.ts";

/**
 * One problem found on one candidate. The reviewer reads a fixed sentence for
 * the `rule`, so no prose travels on the wire — which is also what keeps a
 * model, when one arrives, unable to narrate (ADR-0002).
 *
 * `siblings` names the candidates that *caused* the flag where that is not the
 * candidate carrying it, by id rather than by name: a person's name lives on
 * their own candidate and is never copied (ADR-0004). It is a list because one
 * flag is one *problem* — an account two People leave incomplete is still the
 * one problem *this account is not whole*, cleared by completing it.
 */
export const Flag = z.object({
  id: z.string(),
  /**
   * `N1+N2` is one notice carrying both kinds, named the way `P1+P2` is: one
   * flag is one *problem*, and the name carries every half the surface renders
   * a sentence for. The list stays closed, which is the point of a closed kind
   * list in the first place.
   * ponytail: two kinds make three names. A third would make seven, and the
   * kinds would want to leave the name for a field of their own.
   */
  rule: z.enum(["B1", "W1", "D1", "N1", "N2", "N1+N2"]),
  level: z.enum(["stop", "warn"]),
  /** A Warn is a decision or a notice. A Stop is neither. */
  kind: z.enum(["decision", "notice"]).nullable(),
  /**
   * Whether the reviewer may force past it — a question only a Stop asks,
   * since a Warn excludes nothing and so has nothing to force past. It is
   * `false` on every Warn, and on D1, the one Stop that can never be forced.
   */
  override: z.boolean(),
  siblings: z.array(z.string()),
});
export type Flag = z.infer<typeof Flag>;

/**
 * A flag that sits on the batch rather than on a candidate — asked once, in
 * one place, before the files are made.
 *
 * `P1+P2` is #6's two batch rules — `Deal owner` and `Deal stage` — merged by
 * #18 into the single question the reviewer answers once. The name says both
 * halves are asked here, because the payload alone would not: it carries
 * `stage` and no owner.
 *
 * That asymmetry is the two values' provenance, not an omission. `Deal stage`
 * has no Notion column, so its proposal comes from configuration
 * (`config.dealStage`). `Deal owner` does have one, and it is already on every
 * Deal candidate — copying it here would put a value in two places (ADR-0004).
 * Any count the surface shows beside the flag — *six deals to `Maya`* — is
 * likewise derived from those candidates as they stand, which is why no count
 * is stored here either.
 */
export const BatchFlag = z.discriminatedUnion("rule", [
  z.object({
    id: z.string(),
    rule: z.literal("P1+P2"),
    level: z.literal("warn"),
    kind: z.literal("decision"),
    stage: z.string(),
  }),
  /**
   * `N0` — the research notes were not read, because there was no model key.
   * A notice, so the Reviewer must acknowledge it like any other Warn: a
   * missing key never silently produces a batch that looks clean (ADR-0002).
   * It is the one flag raised by the *absence* of the screener, which is why
   * it sits on the batch and not on the eight candidates it did not read.
   */
  z.object({
    id: z.string(),
    rule: z.literal("N0"),
    level: z.literal("warn"),
    kind: z.literal("notice"),
  }),
]);
export type BatchFlag = z.infer<typeof BatchFlag>;

/** The ledger once checked: every candidate carrying the flags it earned. */
export interface CheckedLedger {
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
 *   One Stop, naming every sibling that caused it, offering **no** override;
 *   it is cleared by completing the account.
 *
 * D1 reads *not Clear or answered* exactly as ADR-0005 writes it — but a
 * **notice** is not one of the things it waits for, which is the question #53
 * left for the ticket that brought the screener. A notice asserts nothing
 * about the account: it relays a suspicion that this person may already exist
 * somewhere the pipeline cannot see, and the account is whole either way. A
 * Stop on Heliograph's and Lattice Forge's Deals would say *this account is not
 * whole* about two accounts that are, on exactly the two candidates already
 * carrying the most to think about. Nothing reaches Attio unread regardless:
 * the batch cannot export with an unanswered Warn.
 *
 * The rules the settled set also holds — B2, W2, W3, and the Stop on a Deal
 * whose `Owner` is empty — are not built. No W34 row reaches any of them, so
 * each would be a rule with nothing to answer for it.
 * ponytail: add one the week a batch first contains it.
 */
export function checkFlags(
  ledger: Ledger,
  stage: string,
  notices: Map<string, Kind[]> | null,
): CheckedLedger {
  const people = ledger.people.map((person) => {
    const flags: Flag[] = [];

    if (!person.email.trim()) {
      flags.push({
        id: `B1:${person.id}`,
        rule: "B1",
        level: "stop",
        kind: null,
        override: true,
        siblings: [],
      });
    }

    // One notice, carrying every kind the screener raised on this person. The
    // rule name is the whole of what travels: the Reviewer reads a fixed
    // sentence per kind and their own notes, never the model's words.
    const kinds = notices?.get(person.id);
    if (kinds?.length) {
      const rule = kinds.join("+") as Flag["rule"];
      flags.push({
        id: `${rule}:${person.id}`,
        rule,
        level: "warn",
        kind: "notice",
        override: false,
        siblings: [],
      });
    }

    return { ...person, flags };
  });

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
        siblings: [],
      });
    }

    // Every other candidate in the account. The Company is in that set even
    // though nothing flags one today, because ADR-0005 waits on *every*
    // candidate in the account and B2 would otherwise slip past. The Deal's
    // own W1 is not in it: the reviewer answering that flag is the whole point
    // of the review, and a flag cannot be its own reason to wait.
    // A notice is not among them: it says nothing about whether the account is
    // whole, and the export gate already has the Reviewer read it.
    const siblings = [
      ...peopleOn(deal.companyId),
      ...companies.filter((company) => company.id === deal.companyId),
    ].filter((sibling) => sibling.flags.some((flag) => flag.kind !== "notice"));

    // One Stop, however many siblings: the problem is *this account is not
    // whole*, and it is cleared once, by completing it.
    if (siblings.length > 0) {
      flags.push({
        id: `D1:${deal.id}`,
        rule: "D1",
        level: "stop",
        kind: null,
        override: false,
        siblings: siblings.map((sibling) => sibling.id),
      });
    }

    return { ...deal, flags };
  });

  const batchFlags: BatchFlag[] = [
    {
      id: "P1+P2:batch",
      rule: "P1+P2",
      level: "warn",
      kind: "decision",
      stage,
    },
  ];

  // No key, so nothing read the notes. The Reviewer is told so, rather than
  // handed a batch that looks clean (ADR-0002).
  if (!notices) {
    batchFlags.push({
      id: "N0:batch",
      rule: "N0",
      level: "warn",
      kind: "notice",
    });
  }

  return { companies, people, deals, batchFlags };
}
