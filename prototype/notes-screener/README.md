# PROTOTYPE — notes screener

Throwaway. Lives on `worktree-wayfinder-notes-screener`, never on `main`.

Answers [#30](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/30): does the screener
[#9](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/9) specified actually catch
Heliograph and Lattice Forge, and stay silent on the six rows that tempt it?

## Run it

```sh
node prototype/notes-screener/run.mjs --dry-run          # prompt, bar and fixture — no key needed
node prototype/notes-screener/run.mjs                    # OPENAI_MODEL, effort low, prompt v2, 3 runs
node prototype/notes-screener/run.mjs --set adversarial  # the held-out boundary set
node prototype/notes-screener/run.mjs --prompt v1        # kind definitions alone, no exclusions
node prototype/notes-screener/run.mjs --effort medium    # the effort lever
node prototype/notes-screener/run.mjs --model gpt-5.6-sol # the family lever
node prototype/notes-screener/run.mjs --log              # write screening-log.json
```

Needs `OPENAI_API_KEY` in `.env` or the environment; `--model` defaults to `OPENAI_MODEL`.
Exit code 0 = cleared the bar.

**Every configuration that was run, and what it showed: [`RESULTS.md`](RESULTS.md).**

## What each file is

- `fixtures.json` — the 8 W34 rows with the labels they are graded against, and `why` for each
  label, so a later reader cannot quietly relabel a row to make a run pass.
- `screener.mjs` — the whole contract: kind sentences verbatim from
  [#6](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/6), two prompt versions, structured
  output with a closed kind enum and no confidence field, and the exact-substring quote check.
- `run.mjs` — the scorer. The bar is declared at the top of the file, before the run.

## Two prompt versions

Both ship #6's kind sentences **verbatim**, from one exported constant that the reviewer-facing
sentence will also read from — drift is meant to be structurally impossible, not merely discouraged.

- **v1** — the definitions alone. The honest test of whether one sentence per kind survives contact
  with this prose unaided.
- **v2** — the definitions plus the pipeline's standing exclusions. Each exclusion is a consequence
  of [ADR-0002](../../docs/adr/0002-a-model-may-only-raise-a-flag.md) or #6's flag table, not a rule
  invented to make this fixture pass.

If v1 clears the bar, v2's exclusions are unearned prompt weight. If only v2 clears it, the
exclusions are load-bearing and belong in the shipped prompt.

## The bar, fixed before the first run

- **Recall** — both targets raise at least one correct kind.
- **Precision** — zero of the six silent rows raise anything, and no target raises a kind it has no
  evidence for. This is the hard gate: a missed suspicion leaves the reviewer exactly where Maya's
  sheet leaves them, a false one costs attention on every batch.
- **Stability** — every run clears both gates. Clearing it once is not clearing it.
- **Quotes** — every kept suspicion quotes the notes exactly. Discards are logged, never hidden.

Lattice Forge's kinds are **reported, not gated** — whether one row may carry both is the ticket's
question 2, and the run is evidence for it rather than an assumption baked into the score.
