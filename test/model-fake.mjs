/**
 * The notes screener's model, faked at the network.
 *
 * Same discipline as `notion-fake.mjs`, and it chains onto it: `globalThis.fetch`
 * is swapped for one that answers `api.openai.com` and delegates everything
 * else to whatever fetch it replaced. So a test can install both, and the app
 * under test is the app that ships — there is no seam in `src/` because a test
 * wanted one.
 */

import assert from "node:assert/strict";

/**
 * Installs the fake and returns the handle to it:
 *
 * - `calls` — what the model saw, oldest first: `{ model, effort, system, notes }`
 * - `reply` — `async (notes) => suspicion[]`, replaced per test. The default
 *   raises nothing, which is the correct and common answer for a row.
 * - `maxInFlight` — the most calls open at once, which is how a test tells
 *   eight parallel rows from eight sequential ones.
 * - `restore()` — puts back the fetch this replaced
 *
 * A `reply` may hold its call open, which is what makes `maxInFlight`
 * meaningful: the screener is only parallel if a call can still arrive while
 * an earlier one has not answered.
 */
export function fakeModel() {
  const inner = globalThis.fetch;
  const model = {
    calls: [],
    reply: () => [],
    inFlight: 0,
    maxInFlight: 0,
    restore: () => {
      globalThis.fetch = inner;
    },
  };

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== "https://api.openai.com") return inner(input, init);
    assert.equal(url.pathname, "/v1/responses");

    const body = JSON.parse(init.body);
    const [system, user] = body.input;
    const notes = user.content.replace(/^Research notes:\n\n/, "");
    model.calls.push({
      model: body.model,
      effort: body.reasoning?.effort,
      system: system.content,
      notes,
    });

    model.inFlight += 1;
    model.maxInFlight = Math.max(model.maxInFlight, model.inFlight);
    try {
      const suspicions = await model.reply(notes);
      // The Responses shape the screener reads: structured output arrives as
      // text, which it parses.
      return new Response(
        JSON.stringify({ output_text: JSON.stringify({ suspicions }) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } finally {
      model.inFlight -= 1;
    }
  };

  return model;
}
