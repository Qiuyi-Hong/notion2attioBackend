# Results — notes screener, 2026-08-29

Every configuration run for [#30](https://github.com/Qiuyi-Hong/notion2attioBackend/issues/30).
28 scored runs, 8 rows each. `effort` is the `reasoning` effort; `v1` is #6's kind sentences alone,
`v2` adds ADR-0002's standing exclusions.

| set | model | effort | prompt | runs | recall | false positives | verdict |
|---|---|---|---|---|---|---|---|
| W34 | luna | low | v1 | 3 | 2/2, 2/2, 2/2 | 0 | **PASS** |
| W34 | luna | low | v2 | 4 | 2/2 every run | 0 | **PASS** |
| W34 | luna | medium | v1 | 3 | 2/2, 2/2, 2/2 | 0 | **PASS** |
| W34 | sol | low | v2 | 3 | 2/2, 2/2, 2/2 | 0 | **PASS** |
| adversarial | luna | low | v1 | 3 | 2/3, 1/3, 1/3 | 0 | FAIL — recall |
| adversarial | luna | low | v2 | 3 | 2/3, 1/3, 1/3 | 0 | FAIL — recall |
| adversarial | luna | medium | v1 | 3 | 2/3, 2/3, 1/3 | **1** | FAIL — both |
| adversarial | sol | low | v1 | 3 | 3/3, 3/3, 3/3 | **1 every run** | FAIL — precision |
| adversarial | sol | low | v2 | 3 | 3/3, 3/3, 3/3 | 0 | **PASS** |

## The four findings

**1. `gpt-5.6-luna` clears the W34 bar, and clears it comfortably.** 13 runs on the real batch,
recall 2/2 every time, and not one false positive on any of the six silent rows — the Brightyard
duplicate-restatement and the Alder & Finch out-of-batch referral included. #9's model pick is
confirmed on the batch #30 named.

**2. Luna's recall is literal, not semantic — and that is invisible in production.** On held-out
prose it finds N2 in **0 of 9** runs. "the spring campaign" fires; "the Q1 outbound list" and "the
winter push" do not. W34 passes because W34's prose happens to sit close to #6's wording. A weekly
pipeline meets new prose every week, and a missed notice looks exactly like a clean batch.

**3. The effort lever is the wrong lever.** `low` → `medium` on luna bought **no** recall and cost a
false positive: it fired N2 on *"Their old agency contacted us last year about a similar project"* —
somebody else's agency, and not a campaign of ours. Raising effort made the model bolder without
making it better, degrading the one property ADR-0002 says is unforgiving.

**4. The failure mode picks the lever, and the two levers are not interchangeable.**

- **Recall failure is capability.** Only the family lever moved it: luna → **sol** took recall from
  1–2/3 to a flat 3/3, finding the N2 paraphrase luna never once found. The prompt could not.
- **Precision failure is a rule we never wrote down.** Sol at v1 fired N2, deterministically in all
  3 runs, on *"We ran a campaign into this segment in the spring; nobody from this account replied"* —
  quoting the clause that denies the match. No model change fixed it. **v2's exclusions did**, on
  the first try.

So the exclusions, which looked like unearned prompt weight on luna (v1 ≡ v2 across 6 runs on each
set), are load-bearing exactly where a model is capable enough to need them. They are insurance
whose premium is only paid by a model bold enough to reach.

## Two smaller observations

**The quote span is unstable and must never be shown.** Across runs the same suspicion came back as
`"replied from a newer email alias"`, `"Noor replied from a newer email alias."`, and
`"role match a person already researched in the spring campaign"`. All are exact substrings, so all
pass the check — but a reviewer would see the highlight move between identical runs. #9 already says
the reviewer reads a fixed sentence plus their own source text; this is why that matters. **The
quote is a check, not a display.**

**Two kinds can share one span.** On ADV-08 sol returned N1 and N2 with the *same* quote —
*"We emailed him at a previous address during the winter push and he never replied."* One clause,
two kinds. Whatever shape the notice takes, quotes cannot be assumed disjoint.

**Latency.** 8 rows sequentially in ~11.9s on sol, ~1.5s/row. Fine at W34's 8; the sheet's 50 rows
would be ~75s of dead wait in `check` before the interrupt. The calls are per-row independent, so
this parallelises trivially — a build note, not a decision.
