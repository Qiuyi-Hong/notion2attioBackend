/**
 * The committed W34 example is an exhibit the write-up links to, so its bytes
 * are part of the contract rather than incidental. Asserts the byte format
 * `docs/handoff-files.md` states was verified, against the committed fixture:
 *
 *   valid UTF-8, no BOM, CRLF only with zero bare LF, no trailing newline.
 *
 * Byte format from #12; the exhibit itself from #8. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLE_DIR = fileURLToPath(
  new URL("../docs/examples/handoff-2026-W34/", import.meta.url),
);

/** The three import files the bundle always carries. A fourth is not a failure. */
const IMPORT_FILES = ["1-companies.csv", "2-people.csv", "3-deals.csv"];

const files = readdirSync(EXAMPLE_DIR)
  .filter((name) => name.endsWith(".csv"))
  .sort();

test("the example holds the three import files", () => {
  for (const name of IMPORT_FILES) {
    assert.ok(files.includes(name), `${name} is missing from the example`);
  }
});

for (const name of files) {
  const bytes = readFileSync(join(EXAMPLE_DIR, name));

  test(`${name}: valid UTF-8`, () => {
    assert.doesNotThrow(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  });

  test(`${name}: no BOM`, () => {
    assert.notDeepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  });

  test(`${name}: CRLF only, no bare LF and no bare CR`, () => {
    const bare = { LF: 0, CR: 0 };
    for (const [i, byte] of bytes.entries()) {
      if (byte === 0x0a && bytes[i - 1] !== 0x0d) bare.LF++;
      if (byte === 0x0d && bytes[i + 1] !== 0x0a) bare.CR++;
    }
    assert.deepEqual(bare, { LF: 0, CR: 0 });
  });

  test(`${name}: no trailing newline`, () => {
    const last = bytes.at(-1);
    assert.ok(last !== 0x0a && last !== 0x0d, "file ends with a newline");
  });
}
