// PROTOTYPE — throwaway. `node prototype/notes-screener/run.mjs`
//
// Runs the screener over the 8 W34 rows N times and scores it against a bar
// that is declared here, in the file, BEFORE the run — so the result cannot be
// rationalised afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenRow, PROMPTS, KINDS } from './screener.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// ---------------------------------------------------------------------------
// THE BAR. Fixed before the first run. Do not edit to make a run pass.
// ---------------------------------------------------------------------------
const BAR = {
  recall: 'Both targets raise at least one correct kind: Heliograph → N1, Lattice Forge → N1 and/or N2.',
  precision: 'Zero of the six silent rows raise anything, and no target raises a kind it has no evidence for.',
  stability: 'Every run clears both gates. A model that clears the bar once has not cleared it.',
  quotes: 'Every kept suspicion quotes the notes exactly. Discards are logged, never hidden.',
};

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const MODEL = arg('model', process.env.OPENAI_MODEL || readEnvFile('OPENAI_MODEL') || 'gpt-5.6-luna');
const EFFORT = arg('effort', 'low');
const PROMPT = arg('prompt', 'v2');
const RUNS = Number(arg('runs', '3'));
const SET = arg('set', 'w34');

const SETS = { w34: 'fixtures.json', adversarial: 'adversarial.json' };
if (!SETS[SET]) {
  console.error(`unknown set "${SET}" — have: ${Object.keys(SETS).join(', ')}`);
  process.exit(1);
}
const fixtures = JSON.parse(fs.readFileSync(path.join(HERE, SETS[SET]), 'utf8'));
const TARGETS = new Set(fixtures.rows.filter((r) => r.expect.length).map((r) => r.sourceId));

if (!PROMPTS[PROMPT]) {
  console.error(`unknown prompt version "${PROMPT}" — have: ${Object.keys(PROMPTS).join(', ')}`);
  process.exit(1);
}

if (flag('dry-run')) {
  console.log(`=== prompt ${PROMPT} ===\n`);
  console.log(PROMPTS[PROMPT]);
  console.log(`\n=== kind sentences (verbatim from #6) ===\n`);
  for (const [k, v] of Object.entries(KINDS)) console.log(`${k}  ${v}`);
  console.log(`\n=== the bar ===\n`);
  for (const [k, v] of Object.entries(BAR)) console.log(`${k.padEnd(10)} ${v}`);
  console.log(`\n=== fixture ===\n`);
  for (const r of fixtures.rows) {
    console.log(`${r.sourceId}  ${r.account.padEnd(24)} expect ${JSON.stringify(r.expect)}`);
  }
  process.exit(0);
}

const apiKey = process.env.OPENAI_API_KEY || readEnvFile('OPENAI_API_KEY');
if (!apiKey) {
  console.error(
    'No OPENAI_API_KEY. Put one in .env or the environment.\n' +
      'Run `node prototype/notes-screener/run.mjs --dry-run` to see the prompt, the bar and the fixture without one.'
  );
  process.exit(2);
}

console.log(`model=${MODEL}  effort=${EFFORT}  prompt=${PROMPT}  runs=${RUNS}\n`);

const runVerdicts = [];
const screeningLog = [];

for (let run = 1; run <= RUNS; run++) {
  console.log(`--- run ${run}/${RUNS} ---`);
  let falsePositives = 0;
  let recallHits = 0;
  const rowLines = [];

  for (const row of fixtures.rows) {
    let result;
    try {
      result = await screenRow({
        notes: row.notes,
        model: MODEL,
        effort: EFFORT,
        promptVersion: PROMPT,
        apiKey,
      });
    } catch (err) {
      console.error(`  ${row.sourceId} ${row.account}: CALL FAILED — ${err.message}`);
      process.exit(3);
    }

    screeningLog.push({
      run,
      model: MODEL,
      effort: EFFORT,
      prompt: PROMPT,
      sourceId: row.sourceId,
      returned: result.raw,
      discarded: result.discarded,
    });

    const got = result.kept.map((s) => s.kind);
    const expected = new Set(row.expect);
    const unfounded = got.filter((k) => !expected.has(k));
    const isTarget = TARGETS.has(row.sourceId);

    if (unfounded.length) falsePositives++;
    if (isTarget && got.some((k) => expected.has(k))) recallHits++;

    const mark = unfounded.length ? 'FALSE' : isTarget ? (got.length ? 'hit' : 'MISS') : 'ok';
    rowLines.push(
      `  ${mark.padEnd(6)} ${row.account.padEnd(24)} expect ${fmt(row.expect)}  got ${fmt(got)}` +
        (result.discarded.length ? `  [${result.discarded.length} discarded on quote check]` : '')
    );
    for (const s of result.kept) rowLines.push(`         ${s.kind} “${s.quote}”`);
    for (const s of result.discarded) rowLines.push(`         DISCARDED ${s.kind} “${s.quote}”`);
  }

  console.log(rowLines.join('\n'));

  const multiKind = screeningLog
    .filter((l) => l.run === run && new Set(l.returned.map((s) => s.kind)).size > 1)
    .map((l) => l.sourceId);
  const passed = falsePositives === 0 && recallHits === TARGETS.size;
  runVerdicts.push({ run, falsePositives, recallHits, multiKind, passed });
  console.log(
    `  → recall ${recallHits}/${TARGETS.size}, false positives ${falsePositives}/${fixtures.rows.length} — ${passed ? 'PASS' : 'FAIL'}\n`
  );
}

console.log('=== verdict ===');
for (const v of runVerdicts) {
  console.log(
    `run ${v.run}: recall ${v.recallHits}/${TARGETS.size}, false ${v.falsePositives}, two-kind rows ${fmt(v.multiKind)} — ${v.passed ? 'PASS' : 'FAIL'}`
  );
}
const allPass = runVerdicts.every((v) => v.passed);
console.log(
  `\n${MODEL} @ effort=${EFFORT}, prompt=${PROMPT}, set=${SET}: ${allPass ? 'CLEARS THE BAR' : 'MISSES THE BAR'}`
);
console.log(
  `co-occurrence: rows carrying both kinds — ${runVerdicts.map((v) => `run ${v.run} ${fmt(v.multiKind)}`).join(', ')}. Evidence for the ticket's question 2, not a pass/fail gate.`
);

if (flag('log')) {
  const out = path.join(ROOT, 'prototype/notes-screener/screening-log.json');
  fs.writeFileSync(out, JSON.stringify(screeningLog, null, 2));
  console.log(`\nscreening log → ${out}`);
}

process.exit(allPass ? 0 : 1);

function fmt(a) {
  return a.length ? `[${a.join(',')}]` : '[]';
}

function readEnvFile(key) {
  for (const p of [path.join(ROOT, '.env'), path.join(ROOT, '../../../.env')]) {
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}
