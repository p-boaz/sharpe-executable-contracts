# Hackathon Spec Audit

Section-by-section comparison of this repo against the Sharpe Hackathon
executable-contracts track spec:
<https://github.com/hdubugras/sharpe-hackathon>

Last reviewed: 2026-04-12 (post-T13/T16 gap closure).

Repo now ships 7 sample contracts under `contracts/` (all 5 spec samples
plus OneAmerica MBSC service agreement and Sequa employment agreement),
each with a reproduced run artifact under `out/run-step*/`.

## Overview — "What you ship"

- Executable representation (`ir.json`) + deterministic IR→English path
  (`src/core/decompiler.ts`, 84 lines, no LLM imports).
- Matches the "executable representation + program that runs it + deterministic
  path back to English" requirement.

## Part 1: Contract → code

- **Input is Markdown.** `contracts/WesTex-VISA-credit-card-agreement.md` at
  repo root; pipeline reads `.md` via `runPipeline`.
- **Structured executable form.** `ContractIR` with clauses typed as
  `obligation | formula | fee | default` (`src/types/ir.ts`,
  `src/pipeline/extract-ir.ts:13-44`).
- **Run the logic.** `executeContract` in `src/core/executor.ts` (320 lines)
  computes APR, minimum payment, late/over-limit fees, breaches.
- **Scenario-based evaluation.** Implemented — `scenario.json` carries a
  timeline.
- **Stateful simulation / time-aware logic.** Partially — credit-card
  month-stepping exists; business days / grace periods / cure periods are
  not modeled even though `curePeriod` exists in the `Clause` type.
- **Execution data visibility.** `out/run/scenario.json` + `execution.json` +
  console prints ending balance and breach count.
- **LLM for scenario generation (required).** `generate-scenario.ts` has a
  `--use-llm` path via `callOpenAIJson`, with deterministic fallback.
  Compliant with the "required LLM step" rule.

## Part 2: Code → English

- **Deterministic, LLM-free.** `decompiler.ts` has zero LLM references;
  `main.ts` runs it twice and hashes output (`runDeterminismCommand`).
- **Completeness/fidelity.** Decompiler only handles the 4 clause kinds.
  Unmodeled clauses should surface clearly in English (spec's "Partial
  coverage" design question).
- **Round-trip demonstrated.** `pnpm run run` produces `english.txt` from IR.

## Example contracts

- All 5 spec samples are present in `contracts/`: WesTex VISA,
  ORBCOMM procurement, Galleria Atlanta lease, Masterworks engagement
  letter, A-Plus Xodtec securities exchange. Plus two extras
  (OneAmerica MBSC service agreement, Sequa employment agreement)
  exercise kinds the spec doesn't name.
- `Generality (15%)` is still the exposure: the heuristic fallback in
  `src/pipeline/extract-ir.ts:190-410` is credit-card-specific, so
  unseen `.md` on the `--use-llm=off` path degrades sharply.

## Held-out evaluation

- `heuristicFallbackIr` is effectively a credit-card parser (`isCreditCard`
  branch, `/cardholder/`, `/New Balance/` regexes).
- On a lease or procurement contract with `--use-llm` off, the output
  degrades to one obligation clause and a title.
- The LLM path has now been exercised end-to-end on all 7 samples
  (see `out/run-step*/`) — each produces a typed IR, executes, and
  round-trips to English. Judges running without an API key still hit
  the heuristic fallback, which is the real exposure.

## Requirements checklist

| Requirement | Status |
| --- | --- |
| Input is `.md` | ✅ |
| Runs on ≥1 sample | ✅ (WesTex VISA) |
| LLM scenario-data step | ✅ |
| Real execution on concrete data | ✅ |
| Deterministic LLM-free decompiler | ✅ |
| Round-trip demo | ✅ |
| Base demo <10 steps | ✅ (README "Quickstart" is 7 steps) |

## Judging criteria self-assessment

- **Expressiveness (25%)** — broadened: APR, min payment, late/over-limit
  fee, default, plus lease/procurement/engagement/securities/service/
  employment clauses via the LLM extractor. Still no cross-references,
  amendments, or deep multi-party obligation keying.
- **Executability (25%)** — strong: real numeric computation, breach
  detection, stateful monthly stepping.
- **Round-trip fidelity (25%)** — strong: deterministic, hashed, diffable.
- **Generality (15%)** — LLM extractor now validated on 7 sample types;
  heuristic fallback remains credit-card-only, so the no-key path is
  still the weakest axis.
- **Creativity (10%)** — neutral.

## Submission requirements

- GitHub repo ✅
- Demo command ✅
- <10-step README ✅
- Writeups: `DESIGN_DECISIONS.md`, `END_STATE.md`, `PLAN.md` ✅

## Optional stretch goals

- Traceability: partial — IR keeps `sourceText` per clause, but no explicit
  source→IR→English link dump.
- Multi-party: parties exist but obligations aren't deeply keyed to roles
  beyond the `actor` field.
- Amendments / counterfactuals / definitions resolution: not implemented.
- Property tests / invariants: not present.

## Rules

- All code written during hackathon. No LLM in decompiler. Dependencies:
  `zod` + `tsx` + `typescript`.

## "Base demo steps should include" (spec's 8 items)

Current README has 7 numbered steps. Gaps vs. spec's checklist:

- Step 1 doesn't state Node version (spec item 1: "language version").
  Add `node >=20`.
- No standalone "English generation only" invocation (spec item 6).
  English is produced as a side-effect of `run`. Either document that or
  add a `decompile` subcommand.
- Step 6 says "Verify determinism artifact" but doesn't say what to check.
  `englishStable: true, executionStable: true` lives in
  `determinism.json` — README should tell the judge to grep for that.
- No pointer to writeup (spec item 8). `DESIGN_DECISIONS.md` /
  `END_STATE.md` exist but aren't linked from README.

## Pitfalls scan

- Not "IR without runner" — runner works.
- Not "contract text only" — scenario is visible.
- "Hand fixtures only" risk if judges run without `--use-llm`; the
  deterministic fallback is hand-coded. Spec is explicit that LLM-generated
  scenarios are required for held-out. Default should probably be
  `--use-llm` when the key is present.
- No LLM in decompiler.
- `stableStringify` + `hashText` guard determinism.

## FAQ

- Preprocessing: none — reads raw `.md`.
- Byte-identical English: hashed.
- LLM ban scope: respected.

## Top gaps to close, ranked

1. ~~README demo steps: Node version, determinism pass/fail check,
   writeup link.~~ **Closed** by T10 — the 9-step README already
   lists Node version, exact stability keys to grep, and writeup
   links.
2. ~~Default to `--use-llm` when `OPENAI_API_KEY` is set.~~
   **Closed** by T16 — `parseArgs` in `src/main.ts` now defaults
   LLM mode on when the key is present, `--no-llm` forces fallback,
   and the stdout `LLM mode:` line names the mode *and* the reason.
3. ~~Surface unmodeled clauses in the English output with an explicit
   "unmodeled" marker.~~ **Closed** — `src/core/decompiler.ts:56`
   already prefixes unmodeled clauses with `[UNMODELED] `, and
   `tests/pipeline.test.ts` asserts honest modeled/unmodeled mix on
   the lease sample.
4. `web/` dossier (T11/T12/T14) — **deferred.** No `web/` shipped;
   judges inspect CLI artifacts under `out/<run>/`. Revisit if a
   browser dossier becomes a submission hard requirement.
5. ~~Heuristic fallback beyond credit-card regexes.~~ Partially
   closed by T16 — the CLI now prints a stderr banner under
   `--no-llm` / no key, naming credit-card and lease as the only
   covered families so degradation is visible at run time.
   Hardening the fallback past those two families is deferred
   (tracked under T15 scope guidance).
