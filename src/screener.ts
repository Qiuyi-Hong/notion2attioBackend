/**
 * The notes screener: the pipeline's one model call (#55).
 *
 * A model may only raise a flag (ADR-0002). It never repairs a value, never
 * writes one the Reviewer will send, and never writes reviewer-facing prose —
 * so its reading can add attention but can never be mistaken for a fact.
 * Everything below exists to make that structural rather than hoped for:
 *
 * - **The kind is a closed list.** `N1` and `N2`, and nothing else. The model
 *   selects; the surface renders a fixed sentence for what it selected.
 * - **Every suspicion carries a verbatim quote**, checked here as an exact
 *   substring of the source notes. One that does not match is discarded and
 *   logged, so an invented suspicion cannot reach the Reviewer.
 * - **No confidence score.** There is no principled place to put a threshold,
 *   and a score invites one.
 *
 * The model and the prompt are #30's, settled on 28 scored runs: `gpt-5.6-sol`
 * at `low` effort with the standing exclusions in the prompt. Effort is **not**
 * a tuning knob — `low` → `medium` bought no recall there and cost a false
 * positive — which is why it is a constant here and `OPENAI_MODEL` is not.
 */

import * as z from "zod";
import { personIdOf } from "./candidates.ts";
import config from "./config/config.ts";
import type { SourceRow } from "./notion.ts";

/**
 * The two notice kinds, quoted **verbatim** from #6's rule table. One constant
 * feeds the prompt and is the sentence the surface renders, so the rule set and
 * the prompt cannot drift apart.
 */
export const KINDS = {
  N1: "Research notes mention an earlier contact under a different email address.",
  N2: "Research notes mention a match with an earlier campaign.",
} as const;

export type Kind = keyof typeof KINDS;

/** #30's finding, and not a lever: raising it bought no recall and cost precision. */
const EFFORT = "low";

/**
 * The pipeline's standing exclusions. Each is a consequence of ADR-0002 — the
 * note corroborates a fact the pipeline already holds, it does not supply one —
 * or of #6's flag table. #30 found them load-bearing on this model: without
 * them `gpt-5.6-sol` raised N2, in every run, on a note *denying* the match.
 */
const EXCLUSIONS = [
  "A note that restates a duplicate the pipeline can already prove from the data (two rows sharing one company domain, or one email address) is not a suspicion. The reviewer is already being asked about it.",
  "A note about a missing or absent value is not a suspicion. Missing data is caught deterministically elsewhere.",
  "A referral, introduction or recommendation by some other person or company is not a suspicion, unless the note also says this contact was reached before or matched to an earlier record.",
  "A suspicion is about THIS contact having been seen before. It is never about anyone else named in the note.",
];

/** Recorded in the screening log, so a change to the prompt is attributable. */
const PROMPT_VERSION = "v2";

const PROMPT = `You screen one row of a weekly sales handoff. You are reading the free-text "Research notes" a researcher wrote about one contact at one company.

Your only job is to decide whether the notes raise one of a closed list of suspicions that this contact may already exist in the destination CRM. You cannot check the CRM and neither can the pipeline. You are relaying a suspicion for a human to check, not resolving it.

The suspicion kinds, and there are no others:

- N1 — ${KINDS.N1}
- N2 — ${KINDS.N2}

These are NOT suspicions:

${EXCLUSIONS.map((exclusion) => `- ${exclusion}`).join("\n")}

For every suspicion you raise, return the kind and a \`quote\`: a span copied CHARACTER FOR CHARACTER from the notes you were given, which on its own is the evidence for that kind. The quote is checked mechanically as an exact substring; a suspicion whose quote does not match is discarded. Do not paraphrase, do not fix punctuation, do not join two separate sentences into one quote.

Return an empty list when the notes raise neither kind. Most rows raise neither. Raising nothing is the correct and common answer.

A missed suspicion costs the reviewer nothing — they read the full notes on screen regardless. A wrong suspicion costs them attention on every batch. When the notes do not plainly say it, say nothing.`;

/** Structured output, strict: the kind list is closed at the API as well. */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suspicions"],
  properties: {
    suspicions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "quote"],
        properties: {
          kind: { type: "string", enum: ["N1", "N2"] },
          quote: { type: "string" },
        },
      },
    },
  },
};

/**
 * One suspicion as the model returned it. The `quote` is the Reviewer's own
 * text, and it is a **check, not a display**: #30 found the same suspicion
 * comes back as a different span between identical runs, so the surface never
 * renders it (#60). It is kept because the log records what came back.
 */
export const Suspicion = z.object({
  kind: z.enum(["N1", "N2"]),
  quote: z.string(),
});
export type Suspicion = z.infer<typeof Suspicion>;

/**
 * The screening log, beside the repair log and on the same rule: *silent* means
 * it does not need the Reviewer's attention, not that it is hidden. It records
 * the three things that decide what the screener does — model, effort and
 * prompt version — and every item returned for every row, the ones the quote
 * check discarded included.
 */
export const Screening = z.object({
  model: z.string(),
  effort: z.string(),
  prompt: z.string(),
  entries: z.array(
    z.object({
      sourceId: z.string(),
      kept: z.array(Suspicion),
      discarded: z.array(Suspicion),
    }),
  ),
});
export type Screening = z.infer<typeof Screening>;

/**
 * Reads one row's notes.
 *
 * ponytail: a call that throws fails the run rather than degrading it. The
 * checkpoint before `check` survives, so the Reviewer resumes rather than
 * starting again — and a batch that quietly skipped a row is the one outcome
 * ADR-0002 refuses.
 */
async function screenRow(notes: string, apiKey: string): Promise<Suspicion[]> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.openai.model,
      reasoning: { effort: EFFORT },
      input: [
        { role: "system", content: PROMPT },
        { role: "user", content: `Research notes:\n\n${notes}` },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "notes_screening",
          strict: true,
          schema: SCHEMA,
        },
      },
    }),
  });

  const json = (await res.json()) as {
    error?: { message?: string };
    output_text?: string;
    output?: { content?: { text?: string }[] }[];
  };
  if (!res.ok) {
    throw new Error(
      `The notes screener was refused (${res.status}): ${json.error?.message ?? ""}`,
    );
  }

  const text =
    json.output_text ||
    json.output?.flatMap((item) => item.content ?? []).find((part) => part.text)
      ?.text;
  if (!text) throw new Error("The notes screener returned no text.");
  // Only `kind` and `quote` are read, so anything else the model volunteers —
  // a confidence score, a sentence of its own — is dropped here and can never
  // reach a flag.
  return z.object({ suspicions: z.array(Suspicion) }).parse(JSON.parse(text))
    .suspicions;
}

/**
 * The batch, screened. `null` when there is no key: the notes were not read,
 * and the batch says so with a notice-level batch flag rather than completing
 * clean.
 *
 * The rows go **in parallel** — they are independent calls, and #30 measured
 * ~1.5s each, which sequentially would put ~12s in front of W34's interrupt and
 * ~75s in front of the sheet's 50 rows. The node still returns once, so it
 * still checkpoints once and nothing moves until every row is back.
 */
export async function screenNotes(
  rows: SourceRow[],
): Promise<Screening | null> {
  const apiKey = config.openai.apiKey;
  if (!apiKey) return null;

  const entries = await Promise.all(
    rows.map(async (row) => {
      const notes = row["Research notes"] ?? "";
      const kept: Suspicion[] = [];
      const discarded: Suspicion[] = [];
      // The quote check. An exact substring, with no normalisation: the model
      // points at evidence, and the pipeline checks the pointer.
      for (const suspicion of await screenRow(notes, apiKey)) {
        (notes.includes(suspicion.quote) ? kept : discarded).push(suspicion);
      }
      return { sourceId: row["Source ID"] ?? "", kept, discarded };
    }),
  );

  return {
    model: config.openai.model,
    effort: EFFORT,
    prompt: PROMPT_VERSION,
    entries,
  };
}

/**
 * The kept suspicions, resolved onto the candidates that will carry them.
 *
 * One candidate carries **one** notice however many kinds it earned: a flag is
 * one *problem*, and both kinds point at the single thing the Reviewer can act
 * on — *this person may already exist in Attio*. #30 found the kinds neither
 * exclusive nor guaranteed to quote disjoint evidence, so two Warns would
 * double the export gate on exactly the candidate needing the most thought.
 *
 * A row reaches its candidate through `personIdOf` rather than by matching a
 * candidate's `sourceId`, because two rows sharing a work email collapse onto
 * one Person candidate and only the first row's id survives on it.
 */
export function noticesOf(
  rows: SourceRow[],
  screening: Screening,
): Map<string, Kind[]> {
  const notices = new Map<string, Kind[]>();
  for (const row of rows) {
    const entry = screening.entries.find(
      (screened) => screened.sourceId === (row["Source ID"] ?? ""),
    );
    if (!entry?.kept.length) continue;
    const personId = personIdOf(row);
    const kinds = new Set([
      ...(notices.get(personId) ?? []),
      ...entry.kept.map((suspicion) => suspicion.kind),
    ]);
    notices.set(personId, [...kinds].sort());
  }
  return notices;
}
