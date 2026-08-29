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
 * What the reviewer's answer writes onto a flag (#54), candidate flag and
 * batch flag alike.
 *
 * `cleared` is what the freeze permits to move: ADR-0004 fixes *which* flags
 * exist at the check pass, not whether each is answered. A flag is cleared by
 * answering it through its own control — never by editing a value near it.
 * D1 has no control and clears itself, when the account it waits on is whole.
 *
 * `refused` names an answer that did not stand: the reviewer typed a work
 * email that does not parse, or one another Person candidate already holds, or
 * their batch-flag answer would have covered a Deal owner they had not been
 * shown. It sits on the flag, so the problem appears on the candidate in the
 * ledger where the reviewer is already working, rather than in a `400` on a
 * response they will never see again.
 */
const answerable = {
  cleared: z.boolean().default(() => false),
  refused: z
    .enum(["invalid_email", "duplicate_email", "new_owner"])
    .nullable()
    .default(() => null),
};

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
  ...answerable,
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
    ...answerable,
  }),
  /**
   * `N0` — the research notes were not read, because there was no model key.
   * A notice, so the Reviewer must acknowledge it like any other Warn: a
   * missing key never silently produces a batch that looks clean (ADR-0002).
   * It is the one flag raised by the *absence* of the screener, which is why
   * it sits on the batch and not on the eight candidates it did not read.
   *
   * It is answerable like every other flag and carries no control of its own:
   * `true` is the whole of what its answer can say.
   */
  z.object({
    id: z.string(),
    rule: z.literal("N0"),
    level: z.literal("warn"),
    kind: z.literal("notice"),
    ...answerable,
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
 * D1 reads *not Clear or answered* as ADR-0005 writes it, **less notices** —
 * the question #53 left for the ticket that brought the screener, answered in
 * that ADR's own amendment. Both failures it exists to prevent come from a
 * Person who is not sent, and a notice does not withhold one: a Warn excludes
 * nothing, so the account is whole and its Deal has someone to attach to. The
 * export gate is what still guarantees the notice was read, since the batch
 * cannot export with an unanswered Warn.
 *
 * The rules the settled set also holds — B2, W2, W3, and the Stop on a Deal
 * whose `Owner` is empty — are not built. No W34 row reaches any of them, so
 * each would be a rule with nothing to answer for it.
 * ponytail: add one the week a batch first contains it.
 *
 * `notices` is the screener's reading, keyed by the Person candidate that
 * carries it. `null` is not the same as empty: **empty** is *the notes were
 * read and raised nothing*, and `null` is *nothing read them*, which is the one
 * thing that raises the `N0` batch flag.
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
        cleared: false,
        refused: null,
      });
    }

    // One notice, carrying every kind the screener raised on this person. The
    // rule name is the whole of what travels: the Reviewer reads a fixed
    // sentence per kind and their own notes, never the model's words.
    const kinds = notices?.get(person.id);
    if (kinds?.length) {
      // Parsed rather than cast: the closed list this file argues for is
      // enforced at the one place a rule name is built rather than written.
      const rule = Flag.shape.rule.parse(kinds.join("+"));
      flags.push({
        id: `${rule}:${person.id}`,
        rule,
        level: "warn",
        kind: "notice",
        override: false,
        siblings: [],
        cleared: false,
        refused: null,
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
        cleared: false,
        refused: null,
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
        cleared: false,
        refused: null,
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
      cleared: false,
      refused: null,
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
      cleared: false,
      refused: null,
    });
  }

  return {
    ...candidateState({ companies, people, deals }, new Set()),
    batchFlags,
  };
}

/**
 * Candidate state, read off a candidate's flags and the reviewer's holds, and
 * written onto the candidate (`CONTEXT.md`, *Candidate state*). One function,
 * two callers — `check` raising the first flags, and the review applying the
 * reviewer's answers — so the rules below are stated once and the browser is
 * never asked to re-derive what the server enforces.
 *
 * Not named for the **Hold**, which the glossary reserves for the reviewer's
 * own act. A hold is one of the three things read here, not the whole of it —
 * and it is written back out as `heldByReviewer` beside the derived `held`,
 * because the reviewer's next decision document has to name every hold it
 * means to keep and the browser cannot tell the two apart from `held` alone.
 *
 * - A candidate carrying an uncleared **Stop** is Held.
 * - A Company's hold reaches its People and its Deal, because a person line
 *   would create the company in Attio anyway (ADR-0004).
 * - A **Deal** is the one candidate held by its *account* rather than by
 *   itself (ADR-0005): only the irreversible object waits. That reading is
 *   D1's, and it is applied here whether or not D1 was raised — the flag set
 *   is frozen, so a Person the reviewer holds *after* the check pass can raise
 *   no new Stop, and the Deal would otherwise reach Attio attached to nobody.
 *
 * D1 is therefore the one flag nothing answers: it is cleared here, by the
 * account becoming whole, which is exactly what `CONTEXT.md` says clears it.
 */
export function candidateState(
  proposed: Pick<CheckedLedger, "companies" | "people" | "deals">,
  heldByReviewer: ReadonlySet<string>,
): Pick<CheckedLedger, "companies" | "people" | "deals"> {
  const stopped = (candidate: { flags: Flag[] }) =>
    candidate.flags.some((flag) => !flag.cleared && flag.level === "stop");
  // A notice is not among what an account waits on — the same reading D1's
  // siblings are filtered by above (#55). It says nothing about whether the
  // account is whole, and the export gate already has the Reviewer read it.
  // Counting one here would hold a Deal that carries no D1 to say why.
  const outstanding = (candidate: { held: boolean; flags: Flag[] }) =>
    candidate.held ||
    candidate.flags.some((flag) => !flag.cleared && flag.kind !== "notice");

  const companies = proposed.companies.map((company) => ({
    ...company,
    heldByReviewer: heldByReviewer.has(company.id),
    held: heldByReviewer.has(company.id) || stopped(company),
  }));

  const people = proposed.people.map((person) => ({
    ...person,
    heldByReviewer: heldByReviewer.has(person.id),
    held:
      heldByReviewer.has(person.id) ||
      stopped(person) ||
      companies.some(
        (company) => company.id === person.companyId && company.held,
      ),
  }));

  /** ADR-0005's *account*: the Company and its People, never the Deal itself. */
  const whole = (companyId: string) =>
    [
      ...companies.filter((company) => company.id === companyId),
      ...people.filter((person) => person.companyId === companyId),
    ].every((sibling) => !outstanding(sibling));

  const deals = proposed.deals.map((deal) => {
    const accountWhole = whole(deal.companyId);
    const flags = deal.flags.map((flag) =>
      flag.rule === "D1" ? { ...flag, cleared: accountWhole } : flag,
    );
    return {
      ...deal,
      flags,
      heldByReviewer: heldByReviewer.has(deal.id),
      held: heldByReviewer.has(deal.id) || !accountWhole || stopped({ flags }),
    };
  });

  return { companies, people, deals };
}
