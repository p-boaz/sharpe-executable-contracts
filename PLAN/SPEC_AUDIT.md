# Hackathon Spec Audit

Section-by-section comparison of this repo against the Sharpe Hackathon
executable-contracts track spec:
<https://github.com/hdubugras/sharpe-hackathon>

Last reviewed: 2026-04-12.

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

- Only 1 of 5 sample contracts present. Only
  `WesTex-VISA-credit-card-agreement.md` is in `contracts/`. Missing:
  ORBCOMM procurement, Galleria lease, Masterworks engagement letter,
  A-Plus Xodtec securities exchange.
- Not required to ship all 5, but `Generality (15%)` is scored on unseen
  `.md`, and the heuristic extractor is heavily credit-card-specific
  (see regex patterns at `src/pipeline/extract-ir.ts:190-410`).
- This is the biggest gap.

## Held-out evaluation

- `heuristicFallbackIr` is effectively a credit-card parser (`isCreditCard`
  branch, `/cardholder/`, `/New Balance/` regexes).
- On a lease or procurement contract with `--use-llm` off, the output
  degrades to one obligation clause and a title.
- The LLM path is the only generality backstop — it needs to be validated
  end-to-end on the other 4 sample types before submission.

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

- **Expressiveness (25%)** — narrow: APR, min payment, late/over-limit fee,
  default. No cross-references, multi-party, or amendments. Only 1 contract
  type truly modeled.
- **Executability (25%)** — strong: real numeric computation, breach
  detection, stateful monthly stepping.
- **Round-trip fidelity (25%)** — strong: deterministic, hashed, diffable.
- **Generality (15%)** — weakest axis: LLM extractor is the only generality
  mechanism; untested on other 4 samples.
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

1. Test the LLM pipeline on the other 4 contract types (lease, procurement,
   engagement, securities). Biggest `Generality` lever.
2. Add the other 4 sample `.md` files to `contracts/` so judges can
   reproduce the demo on each.
3. README demo steps: add Node version, English-step-only instructions,
   explicit determinism pass/fail check, writeup link.
4. Default to `--use-llm` when `OPENAI_API_KEY` is set — the spec treats
   LLM-scenario as required, not opt-in.
5. Surface unmodeled clauses in the English output with an explicit
   "unmodeled" marker (spec's "Partial coverage" design question).
