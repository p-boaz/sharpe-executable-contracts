# Sharpe Executable Contracts MVP

Standalone repo for the Sharpe hackathon track: `Markdown → executable IR → deterministic English`.

## What this does

1. Ingests a contract Markdown file.
2. Extracts an executable IR (`ir.json`) — an effect-union tree with
   `semanticTag`s, optional conditions, and `sourceSpan` offsets back into
   the Markdown.
3. Generates one scenario per detected archetype
   (`scenarios/<archetype>.json`) conditioned on both the contract and the
   IR, with post-condition validators.
4. Executes contract logic against each scenario
   (`executions/<archetype>.json`) — APR-driven balances, minimum
   payments, late/over-limit fees, breach flags, month-stepping for credit
   card; monthly-rent execution for lease.
5. Deterministically decompiles `(ir + scenario + execution)` back to
   English (`english.txt`), LLM-free, with `[source:start-end]` markers.
6. Verifies deterministic output (`determinism` command): `state → English`
   is stable across runs even though LLM stages are not.

## API key required

Every stage that runs the LLM needs `OPENAI_API_KEY`. The CLI fails fast if
it's missing. Here's exactly where it's needed and where it isn't:

| Stage | Needs `OPENAI_API_KEY`? | Where |
|---|---|---|
| IR extraction | yes | `src/core/extractor.ts` via `prompts/ir-extraction.md` |
| Scenario generation | yes | `src/core/scenario.ts` via `prompts/scenario-generation.md` |
| Execution (executor) | no | pure TypeScript, runs on extracted IR + scenario |
| Decompilation → English | no | pure TypeScript, deterministic |
| `pnpm run determinism` | yes (runs extract + scenario twice) | `scripts/` determinism driver |
| `pnpm run check:expectations` | only when cached IR is missing or `--extract` is passed | defaults to cached `out/<contractId>/ir.json` |
| `pnpm test` | no (LLM-dependent tests auto-skip when the key is unset) | see `tests/pipeline.test.ts` for which tests skip |
| Web "Process Contract" | yes | `web/app/api/run-contract/route.ts` shells out to the CLI |

`OPENAI_MODEL` defaults to `gpt-5-mini` (see `.env.example`). Cached
artifacts for the two executor-supported contracts (credit-card +
lease) are committed under `out/credit-card-agreement/` and
`out/galleria-atlanta-office-lease-american-safety-insurance-2006/` so
reviewers can inspect artifact shape and run the offline tests without
an OpenAI key. Other runs populate `out/` locally and are gitignored.

## Quickstart (9 steps)

1. `node -v` (≥20) and `pnpm install` at repo root.
2. `cp .env.example .env` and set `OPENAI_API_KEY`. LLM mode is required —
   the CLI exits early if the key is missing.
3. Run pipeline on the reference contract:
   `pnpm run run --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/run`.
4. Verify artifacts:
   - `out/run/ir.json`
   - `out/run/scenarios/<archetype>.json`
   - `out/run/executions/<archetype>.json`
   - `out/run/english.txt`
   - `out/run/meta.json` (`extractIr` + per-archetype `generateScenario`
     status)
5. Spot-check `english.txt` — modeled clauses render with computed numbers;
   unmodeled clauses are prefixed `[UNMODELED]`; `[source:start-end]`
   markers trace back into the Markdown.
6. Run determinism check:
   `pnpm run determinism --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/determinism`.
   In `out/determinism/determinism.json`: `irStable` / `scenarioStable` /
   `executionStable` are `null` by design (LLM nondeterminism is expected);
   `englishDecompilerStable` and `englishStable` are `true` (the actual
   guarantee).
7. (Optional) Run a second contract family (lease path):
   `pnpm run run --contract contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md --out out/lease-run`.
8. (Optional) `pnpm test` — Node's built-in test runner
   (`node --import tsx --test`) covers the executor, decompiler,
   archetype validators, and expression evaluators against committed
   cached fixtures. Tests that exercise live LLM extraction or scenario
   generation auto-skip when `OPENAI_API_KEY` is unset.
9. (Optional) `pnpm run check:expectations` — compares expectation YAMLs
   against cached IR at `out/<contractId>/ir.json`. When cached IR is
   missing (or `--extract` is passed), the script falls back to live
   extraction and requires `OPENAI_API_KEY`.

## Browser demo (optional)

A Next.js viewer lives in `web/`. Contract-first: the dropdown reads from
`contracts/*.md` (excluding `SOURCES.md`), and "Process Contract" POSTs to
`web/app/api/run-contract/route.ts`, which shells out to the same CLI
pipeline (`pnpm run run`) into `out/_web_runs/<contract-key>/`. A second
route (`web/app/api/upload-contract`) accepts held-out `.md` uploads;
`web/app/api/execute` re-runs execution only.

Layout is a four-step vertical flow that mirrors the pipeline:
**Step 1 · Contract → IR** (with a collapsible "Show intermediate
representation" drawer exposing the raw IR clauses),
**Step 2 · Generate and Pick a Scenario**,
**Step 3 · Run the contract** (executor, no LLM),
**Step 4 · Deterministic executable → English** (the regenerated
`english.txt`, produced from IR + scenario + execution). Hovering a
ledger row, an IR clause, or an English clause line highlights its
counterparts across the other steps.

1. `cd web && pnpm install`
2. Ensure the Next.js process sees `OPENAI_API_KEY` (inherit from your
   shell or drop it in `web/.env.local`).
3. `pnpm dev` → open `http://localhost:3000`.
4. Pick any bundled contract, click "Process Contract", then inspect
   scenarios and execution.
5. (Optional) upload a held-out `.md` in the UI and process it the same way.

## Design choices

- **`modeled: true|false` per clause.** Partial coverage is surfaced as
  `[UNMODELED]` in the regenerated English rather than hidden. Converts
  coverage gaps from a weakness into an explicit contract with the reader,
  and lets the decompiler stay total (every clause renders) while staying
  honest (nothing fake-executes). The brief warns against "a pretty parse
  tree that never evaluates" — the flag is the structural answer.
- **Determinism scoped to `state → English`.** LLM stages are allowed to
  drift across runs; the deterministic guarantee is only for the pure-TS
  decompiler. That's what `determinism.json` encodes, and it's what's
  actually testable.
- **Archetype-keyed scenarios with post-condition validators.** Per
  family, scenario generation loops over named archetypes — credit-card
  gets `on-time`, `late-payment`, `over-limit`; lease gets `on-time`,
  `partial-payment`; unknown families fall back to `baseline`. After
  the executor runs, `validateArchetype` checks AND-form post-conditions
  — e.g. `credit-card/late-payment` requires *both* a payment dated past
  due *and* a late-fee ledger entry whose `clauseId` maps to a modeled
  fee clause. Shape-only scenarios are rejected; failures are fail-fast.
  This turns the LLM scenario step into something with an observable
  pass/fail signal, which is what makes the generality claim meaningful.
- **Effect-union IR.** Clauses have `{ semanticTag, condition?, effect }`
  where `effect.kind ∈ { payment, obligation, formula, accumulation,
  indemnification, default, unmodeled }`. New clause families extend the
  effect set without reshaping the tree. `semanticTag` is an open string
  (`late_payment_fee`, `liquidated_damages`, `sales_commission`, …), so
  the IR isn't locked to any particular contract domain.
- **Fail-fast LLM stages.** No silent fallback path — if extraction or
  scenario generation fails, the CLI exits and the artifact is absent.
- **Source-span traceability.** IR clauses carry `sourceSpan` offsets and
  the decompiler emits `[source:start-end]` markers, so every rendered
  sentence is cross-linkable to the Markdown.
- **Deterministic `extractionHash`.** IR metadata includes a hash over
  contract markdown + extractor version, so cached IR can be invalidated
  when either changes.

## Generality posture (held-out contracts)

The brief is explicit that judges run every submission on the same
held-out Markdown set. Our posture:

1. **LLM extractor is the generality path.** `src/core/extractor.ts` emits
   the same typed IR shape regardless of contract family. Normalizers
   (`normalizeClause`, `normalizeExpr`, `normalizeBoolExpr`,
   `normalizeTemporalRule`) downgrade malformed clauses to
   `modeled: false` stubs instead of crashing.
2. **Archetype layer falls back to `baseline`** for unknown families, so
   execution still runs even if we can't name the family.
3. **Decompiler is family-agnostic** — it walks the typed clause union,
   not family-specific templates — so English is produced on contracts
   we've never seen.
4. **What we don't claim:** cross-run IR/scenario stability under LLM
   mode. The only stability guarantee is
   `executable-state → English`.

## Limitations

- **Execution depth varies by contract family.** Credit-card and lease
  are exercised most deeply (APR-driven balances, fees, breach flags for
  credit card; monthly-rent for lease). Other families
  (securities-exchange, amendment, employment, engagement-letter,
  service-agreement) extract and render cleanly with most clauses marked
  `modeled: true`, but the generated scenarios exercise fewer clauses
  end-to-end than the credit-card path.
- **Cross-references are captured but not resolved.** `definitions:
  Definition[]` is populated in IR (e.g. 5 definitions for WesTex), but
  clause bodies don't link to definition ids — "the Card" in a clause
  doesn't resolve to `d3`. Cross-clause references ("as defined in
  Section 3.2") are not wired either. Definitions are along for the ride
  in the decompiler, not consumed by the executor.
- **Temporal nuance is typed but not executed.** `TemporalRule` supports
  business-days, grace periods, and `curePeriod`, but the executor
  doesn't consume them — calendar-days is the only path exercised.
- **LLM extraction is nondeterministic.** IR/scenario/execution will
  drift run-to-run. Users who need stable IR should cache artifacts
  rather than re-extract.
- **Prompt quality is the recall bottleneck**, not IR expressiveness —
  the effect union can hold more than the extractor reliably produces.
- **Every fresh run has a non-trivial OpenAI bill** attached (extraction
  + scenario per archetype, ×2 for determinism).
- Hackathon-scoped. Not legal advice.

## Sample contracts and modeling depth

All 5 spec samples from the upstream Sharpe Hackathon repo are bundled,
plus 2 Law Insider extras for broader testing. See `contracts/SOURCES.md`
for provenance.

| File | Type | Modeling depth |
| --- | --- | --- |
| `WesTex-VISA-credit-card-agreement.md` | Credit card | Full — APR, min payment, late + over-limit fees, default, breach flags |
| `Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md` | Office lease | Monthly rent + obligation met/breached; rest extracts cleanly but executes shallowly |
| `ORBCOMM-Orbital-amendment-1-AIS-payload-procurement-2006.md` | Procurement amendment | LLM extraction + decompilation; `baseline` archetype execution |
| `Masterworks084-IndieBrokers-Regulation-A-engagement-letter.md` | Engagement letter | Same |
| `A-Plus-Xodtec-securities-exchange-agreement-2009.md` | Securities exchange | Same |
| `OneAmerica-MBSC-service-agreement-2015.md` | Service agreement (extra) | Same |
| `Sequa-employment-agreement-2005.md` | Employment (extra) | Same |

## Notes

- `executable-state → English` is deterministic and LLM-free
  (`src/core/decompiler.ts`).
- CLI auto-loads `.env` from the repo root before parsing args.
