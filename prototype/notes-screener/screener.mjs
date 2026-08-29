// PROTOTYPE — throwaway. Not production code, not on main.
//
// The notes screener as #9 / ADR-0002 fixed it: one model call per source row,
// a closed kind list, a verbatim quote checked as an exact substring, no
// confidence score. This file is the whole contract; run.mjs only scores it.

/**
 * The two notice kinds, quoted VERBATIM from #6's rule table.
 * These strings are the single source for both the prompt and the
 * reviewer-facing sentence, so the rule set and the prompt cannot drift.
 */
export const KINDS = {
  N1: 'Research notes mention an earlier contact under a different email address.',
  N2: 'Research notes mention a match with an earlier campaign.',
};

/**
 * The pipeline's standing exclusions. Not invented for this fixture — each one
 * is a direct consequence of ADR-0002 ("the note corroborates a fact the
 * pipeline already holds, it does not supply one") or of #6's flag table.
 */
const EXCLUSIONS = [
  'A note that restates a duplicate the pipeline can already prove from the data (two rows sharing one company domain, or one email address) is not a suspicion. The reviewer is already being asked about it.',
  'A note about a missing or absent value is not a suspicion. Missing data is caught deterministically elsewhere.',
  'A referral, introduction or recommendation by some other person or company is not a suspicion, unless the note also says this contact was reached before or matched to an earlier record.',
  'A suspicion is about THIS contact having been seen before. It is never about anyone else named in the note.',
];

const SHARED_HEAD = `You screen one row of a weekly sales handoff. You are reading the free-text "Research notes" a researcher wrote about one contact at one company.

Your only job is to decide whether the notes raise one of a closed list of suspicions that this contact may already exist in the destination CRM. You cannot check the CRM and neither can the pipeline. You are relaying a suspicion for a human to check, not resolving it.

The suspicion kinds, and there are no others:

- N1 — ${KINDS.N1}
- N2 — ${KINDS.N2}`;

const SHARED_TAIL = `For every suspicion you raise, return the kind and a \`quote\`: a span copied CHARACTER FOR CHARACTER from the notes you were given, which on its own is the evidence for that kind. The quote is checked mechanically as an exact substring; a suspicion whose quote does not match is discarded. Do not paraphrase, do not fix punctuation, do not join two separate sentences into one quote.

Return an empty list when the notes raise neither kind. Most rows raise neither. Raising nothing is the correct and common answer.

A missed suspicion costs the reviewer nothing — they read the full notes on screen regardless. A wrong suspicion costs them attention on every batch. When the notes do not plainly say it, say nothing.`;

/**
 * Two prompt versions, both shipping the kind definitions verbatim.
 * v1 is the definitions alone — the honest test of whether #6's one-sentence
 * rules survive contact with this prose unaided.
 * v2 adds the standing exclusions.
 */
export const PROMPTS = {
  v1: `${SHARED_HEAD}\n\n${SHARED_TAIL}`,
  v2: `${SHARED_HEAD}\n\nThese are NOT suspicions:\n\n${EXCLUSIONS.map((e) => `- ${e}`).join('\n')}\n\n${SHARED_TAIL}`,
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suspicions'],
  properties: {
    suspicions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'quote'],
        properties: {
          kind: { type: 'string', enum: ['N1', 'N2'] },
          quote: { type: 'string' },
        },
      },
    },
  },
};

/**
 * One model call for one row. Returns { raw, kept, discarded } —
 * `kept` survived the quote check, `discarded` did not. Both are logged:
 * the screening log records every item returned, including the discards.
 */
export async function screenRow({ notes, model, effort, promptVersion, apiKey }) {
  const body = {
    model,
    input: [
      { role: 'system', content: PROMPTS[promptVersion] },
      { role: 'user', content: `Research notes:\n\n${notes}` },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'notes_screening',
        strict: true,
        schema: SCHEMA,
      },
    },
  };
  if (effort) body.reasoning = { effort };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status} ${json?.error?.message ?? JSON.stringify(json)}`);
  }

  const text = extractText(json);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`model did not return JSON: ${String(text).slice(0, 300)}`);
  }

  const raw = parsed.suspicions ?? [];
  const kept = [];
  const discarded = [];
  for (const s of raw) {
    // The quote check. Exact substring, no normalisation — an invented
    // suspicion is structurally unable to surface.
    (notes.includes(s.quote) ? kept : discarded).push(s);
  }
  return { raw, kept, discarded, usage: json.usage };
}

function extractText(json) {
  if (typeof json.output_text === 'string' && json.output_text) return json.output_text;
  for (const item of json.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string' && c.text) return c.text;
    }
  }
  throw new Error(`no text in response: ${JSON.stringify(json).slice(0, 400)}`);
}
