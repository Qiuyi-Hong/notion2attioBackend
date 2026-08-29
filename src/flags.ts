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
  rule: z.enum(["B1", "W1", "D1"]),
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
export const BatchFlag = z.object({
  id: z.string(),
  rule: z.literal("P1+P2"),
  level: z.literal("warn"),
  kind: z.literal("decision"),
  stage: z.string(),
  ...answerable,
});
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
 * D1 reads *not Clear or answered* exactly as ADR-0005 writes it, so an
 * unanswered **Warn** on a sibling holds the Deal as surely as a Stop does.
 * That is inert today — no deterministic rule raises a Warn on a Person or a
 * Company — but the screener's N1 and N2 will, and Heliograph's and Lattice
 * Forge's Deals would then wait on a notice nobody has ticked yet. Whether a
 * notice should hold a Deal at all is a question for the ticket that brings
 * the screener; the batch cannot export with an unanswered Warn regardless, so
 * nothing reaches Attio either way.
 *
 * The rules the settled set also holds — B2, W2, W3, and the Stop on a Deal
 * whose `Owner` is empty — are not built. No W34 row reaches any of them, so
 * each would be a rule with nothing to answer for it.
 * ponytail: add one the week a batch first contains it.
 */
export function checkFlags(ledger: Ledger, stage: string): CheckedLedger {
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
            siblings: [],
            cleared: false,
            refused: null,
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
    const siblings = [
      ...peopleOn(deal.companyId),
      ...companies.filter((company) => company.id === deal.companyId),
    ].filter((sibling) => sibling.flags.length > 0);

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

  return {
    ...candidateState({ companies, people, deals }, new Set()),
    batchFlags: [
      {
        id: "P1+P2:batch",
        rule: "P1+P2",
        level: "warn",
        kind: "decision",
        stage,
        cleared: false,
        refused: null,
      },
    ],
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
 * own act. A hold is one of the three things read here, not the whole of it.
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
  const outstanding = (candidate: { held: boolean; flags: Flag[] }) =>
    candidate.held || candidate.flags.some((flag) => !flag.cleared);

  const companies = proposed.companies.map((company) => ({
    ...company,
    held: heldByReviewer.has(company.id) || stopped(company),
  }));

  const people = proposed.people.map((person) => ({
    ...person,
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
      held: heldByReviewer.has(deal.id) || !accountWhole || stopped({ flags }),
    };
  });

  return { companies, people, deals };
}
