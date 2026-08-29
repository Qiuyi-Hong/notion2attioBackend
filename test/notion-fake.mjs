/**
 * Notion, faked at the network.
 *
 * `globalThis.fetch` is swapped for one that answers `api.notion.com` from a
 * script and delegates everything else to the real one, so the app under test
 * is the app that ships. No seam exists in `src/` because a test wanted one.
 */

import assert from "node:assert/strict";

/**
 * Installs the fake and returns the handle to it:
 *
 * - `calls` — what Notion saw, oldest first: `{ path, method, auth, version, body }`
 * - `script` — `{ [path]: (body, call) => [status, json, headers?] }`, replaced
 *   per test. The third element is how a `429` carries its `Retry-After`, and
 *   `call` is the record just pushed, so a reply can answer on the method or
 *   the path it was reached by.
 * - `restore()` — puts the real `fetch` back
 *
 * A reply may be `async`, which is how a test holds a call open while it
 * asserts what the app did before Notion answered.
 *
 * An unscripted path fails the test rather than answering: a call the test did
 * not expect is a change in what the app asks Notion for.
 */
export function fakeNotion() {
  const realFetch = globalThis.fetch;
  const notion = {
    calls: [],
    script: {},
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== "https://api.notion.com") return realFetch(input, init);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const call = {
      path: url.pathname,
      method: init?.method,
      auth: init?.headers?.Authorization,
      version: init?.headers?.["Notion-Version"],
      body,
    };
    notion.calls.push(call);
    // The exact path, or the trailing-slash prefix that covers a family of
    // them — `/v1/pages/` is one page per request, so it cannot be a key.
    const reply =
      notion.script[url.pathname] ??
      notion.script[
        Object.keys(notion.script).find(
          (key) => key.endsWith("/") && url.pathname.startsWith(key),
        )
      ];
    assert.ok(
      reply,
      `the app called ${url.pathname}, which this test did not script`,
    );
    const [status, json, headers] = await reply(body, call);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  };

  return notion;
}
