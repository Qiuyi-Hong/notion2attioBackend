/**
 * The reviewer's decision document, and what it does to the ledger (#54).
 *
 * One document carries all three acts — answers, holds and sparse edits — and
 * lands in one place. `docs/http-contract.md` owns its wire shape.
 *
 * Two rules from ADR-0004 are enforced here rather than documented:
 *
 * - **An edit is validated, not re-checked.** Nothing below re-enters `check`.
 *   No flag appears or disappears; a flag is cleared only by answering it
 *   through its own control, so editing a value near one launders nothing.
 * - **Nothing rewrites a value the reviewer sends.** An edit is taken exactly
 *   as typed, and pins — it is recorded in `overrides` so `emit` cannot later
 *   re-derive over it.
 *
 * Bad input gets two different answers, and the split is the reviewer's
 * surface, not our convenience. **Structural** — an unknown candidate or flag
 * id, a field that is not editable — is the browser sending something no
 * ledger could hold, and dies at the edge with `400`. **Semantic** — a work
 * email the reviewer typed that does not parse, or that another Person
 * candidate already holds — is the reviewer's own answer, and comes back on
 * the flag they answered, in the ledger they are already looking at.
 */

import * as z from "zod";
import type {
  CompanyCandidate,
  DealCandidate,
  PersonCandidate,
} from "./candidates.ts";
import {
  type BatchFlag,
  candidateState,
  type CheckedLedger,
  type Flag,
} from "./flags.ts";

/**
 * What one flag's own control sends back.
 *
 * `true` is the answer with nothing to supply: a Warn read or decided, or a
 * Stop the reviewer forces past knowing what it warned of. The two objects are
 * the two controls that carry a value — B1's work email, which is the one
 * identity change the freeze permits, and the batch flag's `Deal stage`, which
 * has no Notion column and so has nowhere else to come from.
 */
export const Answer = z.union([
  z.literal(true),
  z.strictObject({ email: z.string() }),
  z.strictObject({ stage: z.string() }),
]);
export type Answer = z.infer<typeof Answer>;

/**
 * `edits` is **sparse** — changed fields only — for a reason that is not about
 * size. Every silent repair is shown in place with its original on hover, so a
 * whole-candidate payload would leave the server unable to tell *the reviewer
 * retyped the same value* from *the reviewer never touched it*, and a repair
 * would either lose its marking or keep it falsely.
 *
 * `held` is complete rather than sparse, and replaces what came before: a hold
 * is a state the reviewer sets, and un-naming it is the only way they have to
 * take it back.
 *
 * `answers` **accumulate**. An answer is an act performed, not a state
 * re-asserted, so a document that does not repeat one does not undo it. See
 * `answeredFlag` below for why that is load-bearing rather than lenient.
 */
export const Decision = z.strictObject({
  edits: z
    .record(z.string(), z.record(z.string(), z.string()))
    .default(() => ({})),
  held: z.array(z.string()).default(() => []),
  answers: z.record(z.string(), Answer).default(() => ({})),
});
export type Decision = z.infer<typeof Decision>;

/**
 * Every field the files carry, except the two a candidate's identity is keyed
 * on: a Company's normalised domain and a Person's work email (ADR-0004).
 * Those are read-only because editing one does not change a value — it changes
 * *which candidates exist*, and Attio would upsert two person lines onto one
 * record, last line winning.
 */
const EDITABLE = {
  company: ["name", "segment", "primaryLocation"],
  person: ["name", "jobTitle", "linkedIn", "leadSource"],
  deal: ["owner"],
} as const;

/** The Attio object a candidate becomes — the contract's own noun for it.
 *  Not `kind`, which a `Flag` already uses for `decision` / `notice`. */
type AttioObject = keyof typeof EDITABLE;

/** Every candidate in the ledger, whichever object it becomes. */
const candidatesIn = (ledger: CheckedLedger) => [
  ...ledger.companies,
  ...ledger.people,
  ...ledger.deals,
];

/** Which flags a given answer is a control for. D1 is on no list: it has no
 *  control, and is cleared by the account becoming whole. */
const accepts = (flag: Flag | BatchFlag, answer: Answer): boolean => {
  if (answer === true) {
    return flag.level === "warn" || ("override" in flag && flag.override);
  }
  return "email" in answer ? flag.rule === "B1" : flag.rule === "P1+P2";
};

const objectsOf = (ledger: CheckedLedger): Map<string, AttioObject> =>
  new Map<string, AttioObject>([
    ...ledger.companies.map((one) => [one.id, "company"] as const),
    ...ledger.people.map((one) => [one.id, "person"] as const),
    ...ledger.deals.map((one) => [one.id, "deal"] as const),
  ]);

const flagsOf = (ledger: CheckedLedger): Map<string, Flag | BatchFlag> =>
  new Map(
    [
      ...candidatesIn(ledger).flatMap((one) => one.flags),
      ...ledger.batchFlags,
    ].map((flag) => [flag.id, flag]),
  );

/**
 * The structural half, checked against the ledger this run actually holds.
 * Returns the first thing wrong, or `null` when the document is one the ledger
 * could hold — which is not the same as one it will accept.
 */
export function structuralProblem(
  ledger: CheckedLedger,
  decision: Decision,
): string | null {
  const objects = objectsOf(ledger);

  for (const [candidateId, fields] of Object.entries(decision.edits)) {
    const becomes = objects.get(candidateId);
    if (!becomes) return `No candidate ${candidateId}.`;
    for (const field of Object.keys(fields)) {
      if (!(EDITABLE[becomes] as readonly string[]).includes(field)) {
        return `${field} is not editable on ${candidateId}.`;
      }
    }
  }

  for (const candidateId of decision.held) {
    if (!objects.has(candidateId)) return `No candidate ${candidateId}.`;
  }

  const flags = flagsOf(ledger);
  for (const [flagId, answer] of Object.entries(decision.answers)) {
    const flag = flags.get(flagId);
    if (!flag) return `No flag ${flagId}.`;
    if (!accepts(flag, answer)) return `${flagId} does not take that answer.`;
  }

  return null;
}

/**
 * The decision, applied to the ledger.
 *
 * Pure, and the whole of the review node. It runs again from the top on every
 * resume, and a refused answer sends the run back to the same pause with the
 * ledger as this left it — so the reviewer's other work survives the round
 * trip and the batch flag's next answer is judged against what they have by
 * then been shown.
 */
export function applyDecision(
  ledger: CheckedLedger,
  decision: Decision,
): CheckedLedger {
  /**
   * An edit differing from what the pipeline proposed pins the field; one that
   * matches it changes nothing, which is what sparse edits make knowable.
   *
   * ponytail: a second decision comparing against a value the first already
   * pinned cannot un-pin it by retyping the original. Nothing today derives a
   * value onto a candidate, so nothing yet notices.
   */
  const edited = <T extends { id: string; overrides: string[] }>(
    candidate: T,
  ): T => {
    const fields = decision.edits[candidate.id];
    if (!fields) return candidate;
    const overrides = new Set(candidate.overrides);
    const next: Record<string, unknown> = { ...candidate };
    for (const [field, value] of Object.entries(fields)) {
      if (next[field] === value) continue;
      next[field] = value;
      overrides.add(field);
    }
    return { ...next, overrides: [...overrides] } as T;
  };

  /** The work emails B1's control supplied, before any of them is believed. */
  const supplied = new Map<string, string>(
    ledger.people.flatMap((person) =>
      person.flags.flatMap((flag) => {
        const answer = decision.answers[flag.id];
        return flag.rule === "B1" &&
          answer &&
          answer !== true &&
          "email" in answer
          ? [[person.id, answer.email] as const]
          : [];
      }),
    ),
  );

  /**
   * What two addresses have to share to be one Person in Attio. Normalising
   * to compare asserts nothing and is not a repair to log — the same reading
   * `candidatesFrom` keys people on.
   */
  const key = (person: PersonCandidate) =>
    (supplied.get(person.id) ?? person.email).trim().toLowerCase();

  /**
   * Validated where it happens, against every other Person candidate in the
   * batch — because freeze would otherwise knowingly emit two person lines
   * that Attio collapses onto one record (ADR-0004).
   *
   * The string validated is the string that lands. Trimming it first would
   * check one value and store another, and a silent repair never applies to
   * what the reviewer typed (`CONTEXT.md`, *Silent repair*) — so an address
   * with a stray space is `invalid_email`, and the reviewer is told rather
   * than corrected.
   */
  const refusalOn = (person: PersonCandidate): Flag["refused"] => {
    const email = supplied.get(person.id);
    if (email === undefined) return null;
    if (!z.email().safeParse(email).success) return "invalid_email";
    return ledger.people.some(
      (other) => other.id !== person.id && key(other) === email.toLowerCase(),
    )
      ? "duplicate_email"
      : null;
  };

  /**
   * A flag is cleared by answering it, and by nothing else.
   *
   * An answer **stands**. A document that does not repeat one does not undo
   * it: an answer is an act the reviewer performed — a decision taken, or a
   * notice read — and a reviewer cannot un-read a notice. That is the whole
   * reason the pipeline records answers at all, where the working sheet could
   * not record that the question was asked and answered (`CONTEXT.md`,
   * *Reviewer*).
   *
   * It is also what keeps the batch flag's *"re-opens for one reason only"*
   * true. If an omitted answer re-opened its flag, every flag would re-open on
   * every round trip and the one documented re-open condition would mean
   * nothing.
   *
   * A **hold** is the opposite, and is replaced wholesale in `candidateState`:
   * it is a state the reviewer sets and takes back, and un-naming it is the
   * only way they have to take it back.
   */
  const answeredFlag = (flag: Flag, refused: Flag["refused"]): Flag => {
    const answer = decision.answers[flag.id];
    if (answer === undefined) return { ...flag, refused: null };
    if (flag.rule === "B1" && answer !== true && "email" in answer) {
      return { ...flag, cleared: flag.cleared || refused === null, refused };
    }
    return { ...flag, cleared: true, refused: null };
  };

  const answered = <T extends { flags: Flag[] }>(candidate: T): T => ({
    ...candidate,
    flags: candidate.flags.map((flag) => answeredFlag(flag, null)),
  });

  const companies: CompanyCandidate[] = ledger.companies.map((company) =>
    answered(edited(company)),
  );

  const people: PersonCandidate[] = ledger.people.map((person) => {
    const refused = refusalOn(person);
    const supply = refused === null ? supplied.get(person.id) : undefined;
    const next = edited(person);
    return {
      ...next,
      ...(supply !== undefined && { email: supply }),
      flags: next.flags.map((flag) => answeredFlag(flag, refused)),
    };
  });

  const deals: DealCandidate[] = ledger.deals.map((deal) =>
    answered(edited(deal)),
  );

  const placed = candidateState(
    { companies, people, deals },
    new Set(decision.held),
  );

  return { ...placed, batchFlags: batchFlagsAfter(ledger, decision, placed) };
}

/**
 * The batch flag, answered.
 *
 * Its answer covers the batch, not the candidates that happened to be sendable
 * when it was given, so a Deal that clears afterwards is covered by the same
 * answer and the flag does not re-open (#40). Any count beside it is derived
 * from the candidates and moves as the reviewer works; a count that moves is
 * not a reason to ask again.
 *
 * It re-opens for one reason: a Deal becomes sendable carrying an **owner the
 * answer does not name** — a name on a record Attio always creates and nobody
 * can undo. An owner the reviewer typed themselves in this same document is
 * one they have seen.
 */
function batchFlagsAfter(
  ledger: CheckedLedger,
  decision: Decision,
  placed: Pick<CheckedLedger, "deals">,
): BatchFlag[] {
  const seen = new Set([
    ...ledger.deals.filter((deal) => !deal.held).map((deal) => deal.owner),
    ...Object.values(decision.edits).flatMap((fields) =>
      fields.owner === undefined ? [] : [fields.owner],
    ),
  ]);
  const unseen = placed.deals.some(
    (deal) => !deal.held && !seen.has(deal.owner),
  );

  return ledger.batchFlags.map((flag) => {
    const answer = decision.answers[flag.id];
    const stage =
      answer !== undefined && answer !== true && "stage" in answer
        ? answer.stage
        : flag.stage;
    // Answered in this document, or standing from an earlier one. The re-open
    // is judged on both: a Deal that becomes sendable under an unseen owner
    // re-opens the flag whichever round its answer was given in.
    if (!(flag.cleared || answer !== undefined)) {
      return { ...flag, stage, cleared: false, refused: null };
    }
    return unseen
      ? { ...flag, stage, cleared: false, refused: "new_owner" as const }
      : { ...flag, stage, cleared: true, refused: null };
  });
}

/** Whether any answer in the ledger was refused — the review is not over. */
export const wasRefused = (ledger: CheckedLedger): boolean =>
  [
    ...candidatesIn(ledger).flatMap((candidate) => candidate.flags),
    ...ledger.batchFlags,
  ].some((flag) => flag.refused !== null);
