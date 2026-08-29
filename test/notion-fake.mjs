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
 * - `script` — `{ [path]: (body) => [status, json] }`, replaced per test
 * - `restore()` — puts the real `fetch` back
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
    notion.calls.push({
      path: url.pathname,
      method: init?.method,
      auth: init?.headers?.Authorization,
      version: init?.headers?.["Notion-Version"],
      body,
    });
    const reply = notion.script[url.pathname];
    assert.ok(
      reply,
      `the app called ${url.pathname}, which this test did not script`,
    );
    const [status, json] = reply(body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return notion;
}
