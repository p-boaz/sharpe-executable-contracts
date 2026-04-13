# Sharpe Hackathon Post-Mortem

Scope: why the submission to the Sharpe *Executable Contracts* hackathon
(`hdubugras/sharpe-hackathon`) underperformed. This document is a direct,
unsparing read of what the spec asked for against what this repository
actually ships, anchored to concrete artifacts under `out/`, the
committed source, and the judging rubric (Expressiveness 25%,
Executability 25%, Round-trip 25%, Generality 15%, Creativity 10%).

---

## 1. Executive summary — what judges most likely saw

Judges evaluate every submission on the same **held-out** Markdown set.
Our pipeline's behavior on held-out inputs is dominated by the LLM
extractor's live output, not by the cached artifacts we committed to
the repo. A cross-contract audit (`out/_audit/*`) shows the held-out
regime we actually ship:

| Contract | Modeled clauses | Archetypes run | Obligation events |
|---|---|---|---|
| WesTex VISA credit card | 4 / 8 | 3 | 10 |
| Galleria Atlanta office lease | 2 / 3 | 2 | 5 |
| A-Plus / Xodtec securities exchange | **0 / 1** | 1 | 0 |
| Masterworks Reg-A engagement letter | **0 / 1** | 1 | 0 |
| OneAmerica MBSC service agreement | **0 / 3** | 1 | 0 |
| ORBCOMM AIS payload procurement | **0 / 1** | 1 | 0 |
| Sequa employment agreement | **0 / 3** | 1 | 0 |

On 5 of 7 audited contracts the extractor collapses the entire
agreement to a single `clause.unmodeled.summary` covering the first
260 characters of source text. Those runs produce zero obligations,
an empty ledger, a `baseline` execution, and an English output that
consists of boilerplate headings plus the words "unmodeled (see source
text)". A judge running our pipeline against a held-out contract in
the 1000–30,000-token range should expect that behavior by default,
not the polished credit-card demo.

Even on the two working families, the round-trip is not the round-trip
the spec asked for: the English is a sorted echo of `clause.sourceText`
(original Markdown), not a reconstruction from the IR. The spec
requires English to be a "function of your IR." Ours is a function of
the *source* that the extractor happens to carry along in the IR.

That is the core failure mode. Everything below expands on it.

---

## 2. Criterion-by-criterion analysis

### 2.1 Expressiveness (25%) — **weak**

**Spec asks.** How much of a real contract can the system capture:
obligations, conditions, deadlines, penalties, definitions,
cross-references?

**What we shipped.** A typed effect-union IR (`payment`, `obligation`,
`formula`, `accumulation`, `indemnification`, `default`, `unmodeled`)
with `semanticTag`, optional `condition`, `sourceSpan`, and
`definitions[]`. The shape is reasonable and could in principle hold
most of what the spec describes.

**Where it breaks.** Expressiveness is measured by what the extractor
*actually produces*, not by what the type system permits. The delta
between capacity and production is the problem:

- The production prompt used by the LLM is inlined in
  `src/pipeline/extract-ir.ts` at line 1065. The file
  `prompts/ir-extraction.md` — advertised in the README as *the*
  extraction prompt — is an 8-line placeholder that is never loaded
  (`grep -rn "ir-extraction\|prompts" src/` returns no `readFile`).
  The README is misleading about where extraction behavior lives, and
  nobody iterating on the prompt would have been editing the file we
  pointed at. **The same pattern holds for `prompts/scenario-
  generation.md`** (9 lines, also never loaded; real prompt inlined
  in `src/pipeline/generate-scenario.ts`). So both LLM prompts were
  written once to a stub file, never iterated, and the inlined
  versions are what actually runs. Prompt engineering was a
  systematic blind spot.
- The inlined prompt teaches `Expr` grammar well but says nothing
  about `semanticTag` discipline, definitions, cross-references,
  obligation recall, or partial-coverage posture. On held-out
  contracts the LLM either:
  - drops `semanticTag` entirely (`out/run/ir.json` has 29 clauses
    with 0 `semanticTag` fields — the executor then matches nothing
    because it dispatches on `semanticTag`), or
  - returns a single `unmodeled_summary` stub (every non-credit-card
    non-lease audit output).
- Definitions *are* extracted (5 for WesTex) but the IR never links
  defined terms to clause bodies — "the Card" in a clause does not
  resolve to `d3`. The README acknowledges this; the judging
  dimension just doesn't care whether it was acknowledged, only
  whether it was done.
- Cross-references ("as defined in Section 3.2", "subject to Article
  VII") are not modeled at all.

**Net.** The IR *could* express more than the extractor produces; the
extractor is what judges score.

### 2.2 Executability (25%) — **partial**

**Spec asks.** Does the computer actually *run* the representation?
Conditions, values, state, enforcement, or is it only data?

**What we shipped.** `src/core/executor.ts` (739 lines) with real
scenario-driven execution:

- APR-driven daily interest accrual (`isCreditCardScenario` branch),
- Minimum-payment formula evaluation and statement closing,
- Late-payment and over-limit fee firing with breach records,
- Monthly-rent execution (`isLeaseScenario` branch),
- A `generic` branch (`src/pipeline/archetypes.ts:baseline`) that
  records obligations for non-lease non-credit-card IRs.

For the credit-card demo, execution is genuine. The
`out/credit-card-agreement/executions/late-payment.json` ledger shows
interest accruing day-by-day, a statement closing, a payment posting
late, an obligation tagged `missed`, and a `late_payment` breach
record. That is the kind of artifact the spec is asking for.

**Where it breaks.**

- Executor branching is hard-coded on two families
  (`isLeaseScenario`, `isCreditCardScenario`). Everything else drops
  into a thin `generic` path that mostly records obligations from
  scenario events; it does not evaluate conditions, fees,
  accumulations, or defaults even if the IR encodes them.
- The executor dispatches on `semanticTag`
  (`findPaymentAmount(ir, "late_payment_fee")` etc.). When the LLM
  omits or drifts `semanticTag` — which is the common case on
  held-out input — the executor silently finds nothing and charges
  `$0.00`. See `out/run/english.txt`: "cl_fees_late_payment:
  late_payment fee is $0.00 when ." for the WesTex demo under live
  LLM. The executor is strictly as good as the extractor's
  semantic-tag discipline, which is currently poor.
- `TemporalRule` supports business-days, grace periods, and
  `curePeriod` in the type but the executor does not consume any of
  them (README acknowledges this). Every "within N business days"
  clause degrades to calendar days or does nothing.
- Obligation status logic has a minor correctness issue: in
  `out/run/executions/late-payment.json` an obligation has
  `amountPaid: 20, amountDue: 15` but status `missed` because the
  payment posted two days after due-date. This is *arguably* right
  (deadline missed) but the engine flags a `late_payment` breach at
  the same time — which double-counts the penalty and is easy for a
  judge to spot.

**Net.** A credible *credit-card* runner with real numbers and state,
surrounded by families the runner does not understand.

### 2.3 Round-trip fidelity (25%) — **most damaging finding**

**Spec asks.** "Does English from the executable preserve meaning and
completeness? Is executable → English deterministic and LLM-free, as
required?" And, load-bearing for this section: "**Completeness and
fidelity** means the English matches what your **executable encodes**."

**What we shipped.** `src/core/decompiler.ts` walks the IR and emits a
sorted English document with `[source:start-end]` markers. It
satisfies the letter of the rule: no LLM call, deterministic for the
same IR, stable-sorted output.

**Where it breaks — this is the kill shot.**

`decompiler.ts:125`:

```ts
const body = normalizeProse(clause.sourceText) ||
             normalizeProse(effectToText(clause.effect));
```

For every modeled clause, the "English" rendered for its body is the
**original Markdown snippet** that the extractor stored in
`clause.sourceText` — not a reconstruction from `clause.effect`. The
structured `effectToText(...)` renderer (which *does* read the IR)
only runs as a fallback when `sourceText` is empty. In every audited
artifact, `sourceText` is non-empty.

The round-trip requirement exists so judges can verify that the IR
captured the contract's meaning. If the English is `sourceText`
verbatim, the IR is unobservable in the output — the round-trip
verifies nothing except that the source was preserved. A judge
diffing the executable → English twice will see identical text
(deterministic ✓), but cannot tell from the English whether the
executor would have interpreted the clause correctly (fidelity ✗).

The explicit pivot to this behavior is commit `0e7e940`:
*"render english.txt as plain prose using clause sourceText"*. It was
a deliberate readability choice that discarded the round-trip's
actual value — and notably, it was the **second-to-last commit** on
the branch. The team had spent the final hours making the English
read nicely at the cost of making it verify nothing.

**A partial save: the execution half of the decompiler works.**
`decompileExecutionToEnglish` (`decompiler.ts:209`) reconstructs the
execution block genuinely — it reads `summary.endingBalance`,
`summary.totalInterestCharged`, obligation status, breach records,
and renders sentences like "Ending balance $X; total paid $Y;
interest charged $Z" and "the obligation was performed / was
missed". That portion is a real IR→English (well, state→English)
render, derives from the executor's output, and is genuinely
deterministic and LLM-free. For the credit-card run it carries real
signal: a judge reading the execution block for `late-payment.json`
can see the engine computed $1.74 of interest across 26 days at
7.9% APR and recorded a missed obligation bound to
`clause.obligation.minimum_payment` — that's fidelity that's
defensible.

So the 25% round-trip score isn't fully forfeit. The structure is
roughly: (a) clause-body rendering — the bulk of the text — echoes
source; (b) execution block — the smaller part — reconstructs
properly. The first dominates what a reader sees on most contracts
where the execution block is a few lines; the second is where the
remaining partial credit lives.

**Net.** We shipped a "round-trip" that is technically deterministic,
technically LLM-free, partially faithful (execution block) and
substantively a passthrough (clause bodies) of the input text.

### 2.4 Generality (15%) — **poor**

**Spec asks.** "Does it work across contract types, including
material not identical to the published samples?" Judges run each
submission on the same held-out Markdown set.

**What we shipped.**

- An LLM-based extractor that accepts arbitrary Markdown and emits
  the typed IR shape.
- An archetype layer that falls back to `baseline` for unknown
  families.
- A decompiler that walks the typed union (so "English is always
  produced").
- An audit harness (`out/_audit/*`) that ran the pipeline on the 5
  spec samples plus 2 extras.

**Where it breaks.**

The audit data above is the answer. On 5 of 7 real samples — which
are the **published** samples, i.e. strictly easier than the
held-out set — extraction collapses to one `unmodeled_summary`
clause and execution records no obligations. Generality is not
"pipeline doesn't crash"; generality is "pipeline produces a
meaningful executable representation and meaningful English on
inputs it hasn't seen." We achieve the first, not the second.

Two aggravating sub-issues:

- **Committed artifacts are unreproducible.**
  `out/credit-card-agreement/meta.json` shows
  `"mode": "heuristic_fallback"` and `"reason": "off (--no-llm)"`.
  The function `heuristicFallbackIr` at `extract-ir.ts:479` is still
  in the file but is never called from anywhere in `src/`; the
  `--no-llm` flag now throws (`main.ts:76`). A judge who clones the
  repo and runs `pnpm run run` on the credit-card contract does not
  get the artifact we committed — they get whatever the LLM produces
  that day, which (`out/run/`, same contract, same week) shows
  `cl_fees_late_payment: late_payment fee is $0.00 when .`. This is
  the "Demo drift" pitfall verbatim.
- **Test suite passes on cache, skips on live.** `pnpm test` runs 29
  tests, passes 24, skips 5. The skipped tests are exactly the ones
  that would catch the above: `extractor returns honest
  modeled/unmodeled mix on lease sample`, `scenario generation is
  archetype-driven`, `decompiler is deterministic for same IR`, `run
  command writes contract-keyed artifacts`, `determinism command
  compares independent runs`. They skip when `OPENAI_API_KEY` is
  unset, which is the default CI state. So nothing in the passing
  suite verifies the live pipeline — the suite verifies the cached
  fixtures, which were produced by dead code.

**Net.** The system was not exercised, end-to-end, on any input that
wasn't already cached.

### 2.5 Creativity (10%) — **thin but non-zero**

**Spec asks.** Novel approaches, clean design, ambitious scope.

**What we shipped, that was ambitious.**

- Archetype-keyed scenario generation with **post-condition
  validators** (`src/pipeline/archetype-check.ts`). After the LLM
  proposes a scenario and the executor runs it, an AND-form
  validator asserts that the scenario actually exercised the
  clauses it claimed to (e.g. `credit-card/late-payment` requires
  both a late payment event and a late-fee ledger entry bound to a
  modeled clause). This is a legitimately good idea — it converts
  the LLM scenario step into something with a pass/fail signal, not
  just hope.
- A `modeled: true | false` per-clause flag with explicit
  `[UNMODELED]` rendering in English. Honest partial coverage is
  the posture the spec recommends.
- `sourceSpan` offsets and `[source:start-end]` markers for
  traceability.

**Where it underdelivered.** The validator only has teeth for
credit-card and lease archetypes. The `generic/baseline` validator
just checks "at least one obligation is met" — which on contracts
where extraction produces zero modeled obligations is downgraded to
"no check" (`archetype-check.ts` intentionally skips the met-check
when the IR has no modeled obligations). So the cleverest piece of
the system — the validator loop — also no-ops on the 5 held-out-
adjacent contracts.

**Net.** The architecture has taste. It just doesn't land on most
inputs.

---

## 3. Root causes, ranked by impact

1. **Decompiler echoes `sourceText` instead of rendering from IR.**
   One-line design change (`decompiler.ts:125`) that forfeits most of
   the 25% round-trip score. Deliberately chosen for readability in
   commit `0e7e940`; the trade-off was not worth it because fidelity
   is the signal judges are grading.
2. **Extractor's real prompt is thin and inlined.** The 25% on
   Expressiveness and much of the 15% on Generality both bottleneck
   on the LLM extractor's recall. The prompt at
   `prompts/ir-extraction.md` is dead (8 lines, never loaded); the
   live prompt in `extract-ir.ts` explains `Expr` grammar but
   nothing about clause discovery, `semanticTag` discipline, or
   family-specific recall (e.g., "for a procurement contract, look
   for milestone payments, delivery acceptance windows, warranty
   periods"). Complex contracts collapse to one `unmodeled_summary`.
3. **Executor dispatches on `semanticTag` that the live extractor
   doesn't reliably emit.** Reliable dispatch on an unreliable field
   is the dominant reason the credit-card live run shows `$0.00`
   fees while the cached credit-card artifact shows correct numbers.
   The two audit passes (cached vs. live) on the *same contract*
   produce different-quality outputs.
4. **Committed artifacts were produced by dead code.** The
   `heuristic_fallback` extractor path that built
   `out/credit-card-agreement/` no longer exists. The README's
   "quickstart" appears to work because the artifacts are cached;
   a judge reproducing from a clean clone gets a worse run and may
   reasonably conclude we shipped a different system from the one
   the README describes. Demo drift.
5. **Test suite doesn't exercise the live pipeline.** The 5 skipped
   tests are the ones that would have caught every failure above
   during development. Skipping on missing API key was convenient;
   it also meant the regression signal that would have prompted a
   fix was never emitted.
6. **Two hard-coded families, no generalization path.** The executor
   has `isCreditCardScenario` and `isLeaseScenario` branches; the
   spec's table has 5 families on the public set and an unknown
   number on the held-out set. We did not ship an executor that
   could interpret an arbitrary IR; we shipped two interpreters and
   a stub.
7. **Definitions and cross-references unresolved.** `definitions[]`
   is populated and then ignored. Cross-references aren't modeled.
   Both are called out in the spec's "Design questions worth
   deciding early" — we noted them in the README and moved on.
8. **Temporal nuance typed but not executed.** Business-days, grace
   periods, cure periods are all in the type and none are consumed
   by the executor. Any "within 10 business days of receipt" clause
   degrades silently.
9. **Model choice was not revisited.** `OPENAI_MODEL` defaults to
   `gpt-5-mini`. Extraction recall is the bottleneck, and a
   higher-capacity model (e.g. `gpt-5` / `claude-opus-4-6`) on the
   LLM-only path would have cost a few cents per held-out contract
   at evaluation time and likely moved recall materially. There is
   no commit in the history experimenting with a stronger model.
10. **The planning doc explicitly deferred the biggest problem.**
    `docs/superpowers/plans/2026-04-12-scenario-obligation-binding.md`
    (the only committed implementation plan) states: *"The IR
    extractor currently emits generic `actor: "party"` and
    `action: "Perform obligation"` for many obligations, so the
    actor+verb+window fallback is unreliable. Explicit `clauseId`
    is the only path we can depend on today. Improving IR
    extraction so the fallback works is explicitly **out of scope**
    for this plan — it's a follow-up."* The plan correctly
    identifies the extractor as the root cause and then declares
    it out of scope. The follow-up never happened — the
    decompiler-sourceText commit landed instead.

Causes 1, 2, 3, and 10 together account for most of the score
gap. Cause 4 is what makes the README look better than the system.

---

## 4. What would have moved the needle

Ranked by expected score gain per engineering hour, at the point the
submission was made:

1. **Rewrite the decompiler to render from `clause.effect` first and
   use `sourceText` only as a citation annotation.** Small diff,
   direct hit on 25% Round-trip. The `effectToText` function already
   exists at line 77; it just needs to be the primary body.
2. **Expand the extractor system prompt.** Add: a full worked
   example per effect kind (we have one per numeric subtype, not per
   effect), explicit guidance to emit `semanticTag` from a small
   vocabulary aligned with the executor, and family-specific
   recall hints. Load it from `prompts/ir-extraction.md` so the
   README stops lying about where the prompt lives.
3. **Make `semanticTag` contract-enforced.** Either: (a) define a
   closed enum of tags the executor knows about and have the
   extractor return them, validated post-hoc, with a repair retry;
   or (b) move executor dispatch off `semanticTag` and onto
   structural shape (e.g. "any `payment` effect with trigger =
   `late_payment_event` is a late fee"). Today the executor and
   extractor disagree silently about the contract between them.
4. **Delete dead code, regenerate artifacts end-to-end, verify.**
   Remove `heuristicFallbackIr`, the `prompts/ir-extraction.md`
   stub, and every `out/*/meta.json` that says
   `"mode": "heuristic_fallback"`. Regenerate `out/credit-card-
   agreement/` and `out/galleria-atlanta-*/` with the live LLM. If
   the live output is worse than the cached — which it is today —
   fix that before shipping, don't paper over it with a cache.
5. **Turn the 5 skipped tests on in CI with a recorded-fixture
   mode** so the pipeline is continuously verified without needing
   an API key. The mocks can be recorded `callOpenAIJson` responses.
6. **A generic executor path that interprets `payment`,
   `obligation`, and `formula` effects without needing family
   detection.** Even a shallow version — "for each modeled
   obligation in the IR, instantiate one scenario event that
   satisfies it, run, report status" — would move 5 of the 7 sample
   contracts from 0 modeled outcomes to N, and makes the generality
   story honest.
7. **Resolve defined terms before execution.** One pass that
   replaces `the Card` / `the Premises` / `Tenant` etc. in clause
   bodies with their definition IDs. Low implementation cost, high
   Expressiveness signal.

Items 1–3 together would plausibly have lifted a submission that
scores near the floor on Round-trip and Generality to one that
scores near the middle on both. Items 4–5 are hygiene that make the
rest of the work visible. Items 6–7 are where real differentiation
would have come from.

---

## 5. Process view — where did the hours go?

`git log --reverse` shows 33 commits, all on 2026-04-12 (the
hackathon day). Grouping them by what they worked on:

| Area | Commits | Rubric weight it serves |
|---|---:|---|
| Initial MVP + determinism hardening + tests | 4 | Executability / Round-trip |
| Web viewer (`web/` app, routes, preload) | 5 | *(not in rubric)* |
| Scenario generation, archetype validators, clauseId binding | 10 | Creativity 10%, part of Executability |
| IR refactor to `semanticTag` + effect union | 1 | Expressiveness 25% |
| Pipeline plumbing, meta/dossier, gitignore, renames | 8 | *(none)* |
| README / docs / spec-audit docs | 4 | *(none)* |
| Decompiler "render as plain prose" (sourceText) | 1 | **Round-trip 25% (negatively)** |

Time distribution does not match score distribution:

- **Expressiveness (25%)** — one structural refactor commit (T23) and
  a couple of fee-extraction fixes. Most of the score here rides on
  the extractor prompt, which grew by zero commits; it was written
  once and never iterated. The file `prompts/ir-extraction.md`
  remained an 8-line placeholder throughout.
- **Executability (25%)** — mostly frontloaded in the first week
  (credit-card runner, lease runner). Later commits improved
  scenario binding but did not broaden the executor's family
  coverage or exercise `TemporalRule`.
- **Round-trip (25%)** — the decompiler was written early, then
  *changed at the end* to echo source text. The hours spent were
  hours against, not for, this criterion.
- **Generality (15%)** — implicit in the extractor/executor work;
  no commit explicitly addresses "what do we do on a contract family
  we've never seen." The `baseline` archetype was added and later
  softened (commit `097c83f`: "downgrade fee-shape asserts when IR
  lacks the clause", `14c03b4`: "baseline requires ≥1 met
  obligation") — i.e., we reduced the strictness of our own
  generality check rather than improving the extractor's recall.
- **Creativity (10%)** — disproportionate investment. Roughly a
  third of commits touch scenario validation and archetype
  machinery, which is a novel idea but graded at 10%.

The branch optimized for what was fun to build (scenario validators,
a Next.js viewer, clever IR shapes) and what was easy to verify
(determinism of the decompiler, archetype validator pass/fail),
at the expense of what was load-bearing on the rubric (extraction
recall, true IR→English reconstruction, cross-family execution).

---

## 6. Submission artifacts

Spec requires:

1. GitHub repo with source — **present**.
2. Working demo (live, recorded, or notebook) — **absent as a
   standalone artifact**. No `.mp4`, `.mov`, slide deck, or
   notebook is committed or linked from the README. The README
   describes how to run a demo; there is no captured demo.
3. Base demo in <10 numbered steps — **present in README** (9
   steps), but depends on `OPENAI_API_KEY` and, as shown in §2.4,
   produces different (worse) output than the committed cache on
   the same contract. A judge following the steps will not see
   what the README implies they will see.
4. Short writeup on approach, design choices, and limitations —
   **folded into README**. Acceptable per the spec ("repo or
   slides"), but interleaved with build instructions and
   therefore easy to miss.

Implication: the only artifact a judge has, other than running the
code themselves, is the repository. The repository's `out/*` cache
is the de facto "recorded demo" — and that cache was produced by
now-dead code.

### 6.1 What a judge sees on a failing contract

This is the complete `english.txt` for ORBCOMM (procurement
amendment, rated "High complexity" by the spec) as the pipeline
actually produces it today:

```
Contract: ORBCOMM Orbital amendment 1 AIS payload procurement 2006
Contract ID: orbcomm-orbital-amendment-1-ais-payload-procurement-2006
Currency: USD

Parties:
- counterparty (counterparty): Counterparty

Definitions:

Executable Clauses:
- [UNMODELED] clause.unmodeled.summary {unmodeled_summary}:
  unmodeled (see source text). [source:0-259]

Modeled coverage: 0/1 clause(s) modeled.

Execution Outcomes:
- Archetype baseline: Baseline review
  Scenario ID: scenario.generic.baseline
  Summary: ending balance $0.00, paid $0.00, interest $0.00,
  fees $0.00, breached=false.
  Obligation status: none.
  Breaches: none.
```

Two parties become one ("counterparty"). Zero definitions. One
"unmodeled_summary" clause covering the first 260 characters of a
multi-page procurement amendment. Zero ledger activity. This is
literally all a judge would see for this contract. Four of the
seven bundled samples produce an equivalently empty output. The
spec's Generality bar — "works across contract types, including
material not identical to the published samples" — is not reached
even on the *published* samples.

---

## 7. The team's own expectations checker fails

`scripts/check-expectations.ts` + `expectations/*.yaml` is a self-
assessment framework the team built: hand-authored "gold standard"
expectations per contract (intents, source quotes, required clause
shapes), and a script that compares them to extracted IR. Running it:

```
$ pnpm run check:expectations
...
[ERROR] expectations/a-plus-xodtec-...: OPENAI_API_KEY is required...
[ERROR] expectations/masterworks084-...: OPENAI_API_KEY is required...
[ERROR] expectations/oneamerica-...: OPENAI_API_KEY is required...
[ERROR] expectations/orbcomm-...: OPENAI_API_KEY is required...
[ERROR] expectations/sequa-...: OPENAI_API_KEY is required...
[ERROR] expectations/westex-visa-...: OPENAI_API_KEY is required...

galleria-atlanta-office-lease-american-safety-insurance-2006
  critical:   pass=0 weak=0 fail=4 total=4 score=0.0%
  supporting: pass=0 weak=0 fail=5 total=5 score=0.0%
  unmodeled coverage: 0/15
  findings:
    [FAIL] monthly-rent-step-1, monthly-rent-step-2,
           late-rent-fee, payment-default-trigger,
           lease-term, operating-expense-pass-through,
           security-deposit-payment, renewal-option,
           landlord-indemnification
           — all FAIL against the one clause the IR contains
             (clause.formula.monthly_rent)

Overall: contracts checked 1/7, result: FAIL
```

Two things to extract from this:

1. **Expectation contract IDs don't match cached-output directory
   names.** `westex-visa-credit-card-agreement.yaml` is looking for
   `out/westex-visa-credit-card-agreement/ir.json`, but the cached
   IR is at `out/credit-card-agreement/ir.json`. The framework
   can't find its own cache for 6 of 7 contracts. This is a
   naming-drift problem nobody caught because the checker was
   never run in CI (and would error without a key anyway).
2. **The single contract it can check scores 0%.** The lease
   expectations define 9 target clauses (monthly rent, late fee,
   default trigger, lease term, op-ex pass-through, security
   deposit, renewal option, indemnification). The cached IR
   contains 3 clauses — one formula, one obligation, one default.
   Every expectation fails because there is nothing to match
   against except the `monthly_rent` formula, which then fails all
   9 type comparisons.

The expectations framework was the right idea and was ignored by
the person iterating on extraction. A self-test with a 0% pass
rate against your own gold standard is actionable feedback — unless
you never run it.

---

## 8. What we did well — worth keeping

- The **effect-union IR** (`{semanticTag, condition?, effect}` with
  `effect.kind ∈ {payment, obligation, formula, accumulation,
  indemnification, default, unmodeled}`) is a good shape. It's open
  enough to accept new clause types without reshaping the tree and
  typed enough that the executor can dispatch cleanly.
- **Post-condition validators on scenarios** are a real idea. They
  turn "LLM produced some JSON" into "LLM produced JSON that made
  the executor do the thing we expected." If extraction were
  stronger, this validator layer would shine.
- **The credit-card run is a real run.** Daily APR accrual,
  statement closing, minimum-payment formula evaluation, late-fee
  firing, breach records — `out/credit-card-agreement/executions/
  late-payment.json` is the kind of artifact the spec asks for.
- **Source-span traceability** is implemented end-to-end. Every
  rendered sentence has `[source:start-end]` and the IR clauses
  carry the offsets. This was a stretch-goal hit.
- **`modeled: true | false` per clause** is the right posture for
  partial coverage and is surfaced honestly in the English output.

---

## 9. Lessons (team-level)

- **A spec with a weighted rubric deserves a weight-weighted
  engineering budget.** Round-trip was 25% and our implementation
  of it was the last thing we looked at. The effort distribution
  should match the score distribution.
- **"Deterministic" is necessary but not sufficient.** The spec
  wants determinism *and* fidelity. Optimizing the verifiable
  property (determinism) at the cost of the unverifiable property
  (fidelity) is a classic Goodhart substitution. Don't.
- **If the README describes a different system than the code
  produces, the README is wrong.** Reconcile before shipping, even
  if it means the README is less impressive.
- **Cache is not a demo.** Committing a good run and labeling it as
  the demo creates submission risk in any system where the
  producing code has moved on. The production path should be the
  demo path.
- **Tests that skip when a secret is missing are tests that don't
  run in CI.** Record fixtures.
